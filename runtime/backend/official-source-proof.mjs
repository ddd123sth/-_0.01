import { auditedBusinessSourceVariant, BUSINESS_SOURCE_VARIANTS_SHA256 } from './official-business-source-variants.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { freeze } from './common.mjs';
import { officialActionContractId, officialActionContracts, OFFICIAL_CORE_CONTRACT, OFFICIAL_CORE_CONTRACT_ID } from './official-version-profile.mjs';

const BLOCK_FILE = new URL('./contracts/official-source-blocks-v1.json', import.meta.url);
const BLOCK_FILE_SHA256 = '4cd72558f01569ba088cfe03deed29d7814c34ecf18db46f032b9a812accff9f';
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceBlockContract = () => {
  const bytes = fs.readFileSync(BLOCK_FILE);
  if (sha256(bytes) !== BLOCK_FILE_SHA256) throw new Error('OFFICIAL_SOURCE_BLOCK_CONTRACT_INTEGRITY_FAILED');
  const document = JSON.parse(bytes.toString('utf8'));
  if (document?.schema !== 'official-runtime-source-blocks/v1' || !Array.isArray(document.blocks)) {
    throw new Error('OFFICIAL_SOURCE_BLOCK_CONTRACT_INVALID');
  }
  return document;
};

function publicJscKey(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('OFFICIAL_SOURCE_KEY_INVALID');
  if (!value.startsWith('a@')) return Buffer.from(value, 'utf8');
  const source = [...value.slice(2)];
  const middle = Math.ceil(source.length / 2);
  const decoded = new Array(source.length);
  for (let i = 0; i < middle; i += 1) decoded[i * 2] = source[i];
  for (let i = middle; i < source.length; i += 1) decoded[(i - middle) * 2 + 1] = source[i];
  return Buffer.from(decoded.join(''), 'utf8');
}

export function decodeOfficialJsc(raw, keyValue) {
  if (!Buffer.isBuffer(raw) || raw.length < 8 || raw.length > MAX_SOURCE_BYTES || raw.length % 4 !== 0) {
    throw new Error('OFFICIAL_SOURCE_CIPHER_SIZE_INVALID');
  }
  const keyBytes = publicJscKey(keyValue);
  const paddedKey = Buffer.alloc(16);
  keyBytes.copy(paddedKey, 0, 0, Math.min(16, keyBytes.length));
  const key = [0, 1, 2, 3].map(i => paddedKey.readUInt32LE(i * 4) >>> 0);
  const words = new Array(raw.length / 4);
  for (let i = 0; i < words.length; i += 1) words[i] = raw.readUInt32LE(i * 4);
  const n = words.length - 1;
  let sum = (Math.floor(6 + 52 / (n + 1)) * 0x9e3779b9) >>> 0;
  let y = words[0];
  while (sum !== 0) {
    const e = (sum >>> 2) & 3;
    for (let p = n; p >= 0; p -= 1) {
      const z = words[p === 0 ? n : p - 1];
      const mix = ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^
        ((sum ^ y) + (key[(p & 3) ^ e] ^ z))) >>> 0;
      words[p] = (words[p] - mix) >>> 0;
      y = words[p];
    }
    sum = (sum - 0x9e3779b9) >>> 0;
  }
  const flat = Buffer.allocUnsafe(words.length * 4);
  for (let i = 0; i < words.length; i += 1) flat.writeUInt32LE(words[i], i * 4);
  const length = words[n];
  if (!Number.isSafeInteger(length) || length < flat.length - 7 || length > flat.length - 4) {
    throw new Error('OFFICIAL_SOURCE_DECODE_LENGTH_INVALID');
  }
  let decoded = flat.subarray(0, length);
  if (decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
    decoded = zlib.gunzipSync(decoded, { maxOutputLength: MAX_SOURCE_BYTES });
  }
  if (!decoded.length || decoded.length > MAX_SOURCE_BYTES) throw new Error('OFFICIAL_SOURCE_DECODE_SIZE_INVALID');
  const text = decoded.toString('utf8');
  const roundTrip = Buffer.from(text, 'utf8');
  if (!roundTrip.equals(decoded)) throw new Error('OFFICIAL_SOURCE_UTF8_ROUNDTRIP_FAILED');
  return decoded;
}

function occurrences(haystack, needle) {
  let count = 0, offset = -1, from = 0;
  while ((offset = haystack.indexOf(needle, from)) !== -1) { count += 1; from = offset + 1; }
  return count;
}

export function proveOfficialSourceActions({ gameVersion, protocolVersion, index, gameBytes, moBytes, indexSha256 } = {}) {
  const contract = sourceBlockContract();
  const unavailable = reasonCode => freeze(Object.fromEntries(Object.keys(officialActionContracts())
    .map(id => [id, { supported: false, reasonCode, sourceVersion: gameVersion ?? null }])));
  if (!index || index.version !== gameVersion || protocolVersion !== OFFICIAL_CORE_CONTRACT.protocolVersion ||
      !Buffer.isBuffer(gameBytes) || !Buffer.isBuffer(moBytes)) return unavailable('OFFICIAL_SOURCE_PROOF_INPUT_INVALID');
  const sources = [gameBytes, moBytes];
  const blocks = new Map(contract.blocks.map(block => [`${block.name}:${block.sha256}`, Buffer.from(block.base64, 'base64')]));
  const actionContracts = officialActionContracts();
  const coreRanges = new Map(OFFICIAL_CORE_CONTRACT.sourceRanges.map(range => [range.name, range]));
  const proofs = {};
  for (const [actionId, action] of Object.entries(actionContracts)) {
    if (!action.verifiedSourceRanges?.length) continue;
    const requiredCore = (action.requiredCoreRanges || []).map(name => coreRanges.get(name)).filter(Boolean);
    const required = [
      ...requiredCore.map(range => ({ name: range.name, sha256: range.sha256 })),
      ...(action.verifiedSourceRanges || []).map(([name, , , sha256]) => ({ name, sha256 })),
    ];
    const matches = [];
    let reasonCode = null;
    for (const one of required) {
      let needle = blocks.get(`${one.name}:${one.sha256}`);
      if (!needle || sha256(needle) !== one.sha256) { reasonCode = 'OFFICIAL_SOURCE_BLOCK_CONTRACT_MISSING'; break; }
      let selectedSha256 = one.sha256;
      if (sources.every(source => occurrences(source, needle) === 0)) {
        const variant = auditedBusinessSourceVariant({ actionId, blockName: one.name, baselineSha256: one.sha256,
          sourceVersion: gameVersion, gameBytes, moBytes });
        if (variant) { needle = variant.bytes; selectedSha256 = variant.sha256; }
      }
      const found = sources.map(source => occurrences(source, needle)).reduce((sum, count) => sum + count, 0);
      if (found !== 1) { reasonCode = found === 0 ? 'OFFICIAL_SOURCE_BLOCK_NOT_FOUND' : 'OFFICIAL_SOURCE_BLOCK_AMBIGUOUS'; break; }
      matches.push({ name: one.name, sha256: selectedSha256, byteLength: needle.length });
    }
    proofs[actionId] = freeze({ supported: reasonCode === null, reasonCode,
      actionContractId: officialActionContractId(actionId),
      coreContractId: OFFICIAL_CORE_CONTRACT_ID, sourceVersion: gameVersion, protocolVersion,
      indexSha256: typeof indexSha256 === 'string' ? indexSha256 : null,
      gameSha256: sha256(gameBytes), moSha256: sha256(moBytes),
      matchedBlocks: reasonCode === null ? matches : [] });
  }
  return freeze(proofs);
}

export function sourceProofContractBytesHash() { return sha256(Buffer.from(BLOCK_FILE_SHA256 + ':' + BUSINESS_SOURCE_VARIANTS_SHA256)); }
