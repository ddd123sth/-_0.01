import { plainObject, problem } from '../../common.mjs';
import { hashLedgerBytes } from '../../persistence/json-contract.mjs';
import { decodeEvidenceJson, encodeEvidenceJson } from '../../persistence/evidence-codec.mjs';

export const LAND_PUBLIC_JSON_VERSION = 'land-public-json-text/v1';
const FIELDS = ['tables','sourceProofs','validatedBundle','tableHashes'];
const ROOTS = { policy: ['binding','versionEvidence'], compatibility: ['authorizedVersionEvidence'] };
const MAX_BYTES = 64 * 1024 * 1024;
const fail = () => { throw problem('LAND_PUBLIC_TEXT_INVALID', '土地公共证据原文字节或引用校验失败', 500); };
const whitespace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
function stringEnd(text, start) {
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') at++;
    else if (text[at] === '"') return at + 1;
  }
  fail();
}
function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let at = start; while (at < text.length && !whitespace(text[at]) && !',}]'.includes(text[at])) at++;
    return at;
  }
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === '"') { at = stringEnd(text, at) - 1; continue; }
    if (text[at] === '{' || text[at] === '[') depth++;
    else if ((text[at] === '}' || text[at] === ']') && --depth === 0) return at + 1;
  }
  fail();
}
function spans(text, kind) {
  const root = ROOTS[kind]; if (!root) fail();
  const targets = FIELDS.map(field => [...root, field]), found = [];
  const white = start => { let at = start; while (whitespace(text[at])) at++; return at; };
  const visit = (start, path) => {
    if (text[start] !== '{') return;
    let at = white(start + 1);
    while (text[at] !== '}') {
      if (text[at] !== '"') fail();
      const endKey = stringEnd(text, at), key = JSON.parse(text.slice(at, endKey));
      at = white(endKey); if (text[at] !== ':') fail(); at = white(at + 1);
      const nextPath = [...path, key], end = valueEnd(text, at);
      if (targets.some(target => target.length === nextPath.length && target.every((part, index) => part === nextPath[index])))
        found.push({ path: nextPath, start: at, end });
      else if (targets.some(target => nextPath.every((part, index) => part === target[index]))) visit(at, nextPath);
      at = white(end); if (text[at] === '}') break; if (text[at] !== ',') fail(); at = white(at + 1);
    }
  };
  visit(white(0), []); return found.sort((a, b) => a.start - b.start);
}

// Unlike JSON.stringify, raw spans preserve mixed legacy member ordering,
// whitespace and string escapes. Only four explicit public subtrees qualify.
export function packLandPublicJsonText(text, kind, encodePublicObject = encodeEvidenceJson) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail();
  const receipt = JSON.parse(text);
  if (!ROOTS[kind] || !plainObject(receipt) || receipt.version !==
      (kind === 'policy' ? 'land-source-policy/v1' : 'land-domain-compatibility-revalidation/v1')) fail();
  const selected = spans(text, kind).filter(one => ['{','['].includes(text[one.start]) && Buffer.byteLength(text.slice(one.start, one.end)) >= 512);
  if (new Set(selected.map(one => JSON.stringify(one.path))).size !== selected.length) return { receiptJson: text, objects: [] };
  if (!selected.length) return { receiptJson: text, objects: [] };
  const objects = [], detached = []; let template = '', cursor = 0;
  for (const one of selected) {
    const original = text.slice(one.start, one.end), objectRef = 'sha256:' + hashLedgerBytes(original);
    template += text.slice(cursor, one.start);
    detached.push({ path: one.path, offset: template.length, objectRef }); template += 'null'; cursor = one.end;
    objects.push({ objectRef, objectJson: encodePublicObject(original) });
  }
  template += text.slice(cursor);
  return { receiptJson: JSON.stringify({ storageVersion: LAND_PUBLIC_JSON_VERSION, kind, offsetUnit: 'utf16-code-units',
    originalBytes: Buffer.byteLength(text), originalSha256: hashLedgerBytes(text), template, detached }), objects };
}

export function readLandPublicJsonText(store, value, kind) {
  if (!plainObject(value) || value.storageVersion !== LAND_PUBLIC_JSON_VERSION || value.kind !== kind || !ROOTS[kind] ||
      value.offsetUnit !== 'utf16-code-units' || typeof value.template !== 'string' || Buffer.byteLength(value.template) > MAX_BYTES ||
      !Number.isSafeInteger(value.originalBytes) || value.originalBytes < 1 || value.originalBytes > MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(value.originalSha256 || '') || !Array.isArray(value.detached) || !value.detached.length || value.detached.length > FIELDS.length) fail();
  // Validate the complete template grammar and every declared null location.
  JSON.parse(value.template);
  const locations = spans(value.template, kind), seen = new Set();
  let restored = '', cursor = 0;
  for (const one of value.detached) {
    const key = JSON.stringify(one?.path), location = locations.find(entry => JSON.stringify(entry.path) === key);
    if (!location || seen.has(key) || one.offset !== location.start || location.start < cursor ||
        value.template.slice(location.start, location.end) !== 'null' || !/^sha256:[a-f0-9]{64}$/.test(one.objectRef || '')) fail();
    seen.add(key);
    const row = store.get('SELECT object_json FROM backend_land_policy_public_objects WHERE object_ref=?', one.objectRef);
    const original = row && decodeEvidenceJson(row.object_json);
    if (typeof original !== 'string' || !['{','['].includes(original[0]) || 'sha256:' + hashLedgerBytes(original) !== one.objectRef) fail();
    restored += value.template.slice(cursor, location.start) + original; cursor = location.end;
    if (Buffer.byteLength(restored) > value.originalBytes) fail();
  }
  restored += value.template.slice(cursor);
  if (Buffer.byteLength(restored) !== value.originalBytes || hashLedgerBytes(restored) !== value.originalSha256) fail();
  return restored;
}
