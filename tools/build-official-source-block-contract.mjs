import fs from 'node:fs';
import crypto from 'node:crypto';
import { officialContracts, officialActionContracts } from '../runtime/backend/official-version-profile.mjs';

const input = process.argv[2];
const output = process.argv[3];
const moInput = process.argv[4] || null;
if (!input || !output) throw new Error('usage: node tools/build-official-source-block-contract.mjs <audited-baseline-decoded-game.js> <output.json> [audited-baseline-decoded-mo.js]');
const bytes = fs.readFileSync(input), moBytes = moInput ? fs.readFileSync(moInput) : null;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const core = Object.values(officialContracts())[0];
const rangesByAction = officialActionContracts();
const blocks = new Map();
const add = (name, start, end, expectedSha) => {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error(`invalid range: ${name}`);
  const source = name.startsWith('day-mo-') ? moBytes : bytes;
  if (!source) throw new Error(`missing audited source module for: ${name}`);
  const block = source.subarray(start, end);
  if (sha(block) !== expectedSha) throw new Error(`reviewed source range mismatch: ${name}`);
  const key = `${name}:${expectedSha}`;
  const previous = blocks.get(key);
  if (previous && !Buffer.from(previous.base64, 'base64').equals(block)) throw new Error(`ambiguous contract block: ${name}`);
  blocks.set(key, { name, byteLength: block.length, sha256: expectedSha, base64: block.toString('base64') });
};
for (const range of core.sourceRanges) add(range.name, range.start, range.end, range.sha256);
for (const action of Object.values(rangesByAction)) {
  for (const [name, start, end, digest] of action.verifiedSourceRanges || []) add(name, start, end, digest);
}
const document = { schema: 'official-runtime-source-blocks/v1', baselineSourceSha256: sha(bytes),
  ...(moBytes ? { baselineMoSha256: sha(moBytes) } : {}),
  sourceEncoding: 'UTF-8 decoded game/mo JavaScript bytes; block name prefix identifies mo module', blocks: [...blocks.values()] };
fs.writeFileSync(output, JSON.stringify(document, null, 2) + '\n');
console.log(JSON.stringify({ sourceBytes: bytes.length, baselineSourceSha256: document.baselineSourceSha256, blockCount: blocks.size,
  outputBytes: fs.statSync(output).size, outputSha256: sha(fs.readFileSync(output)) }, null, 2));
