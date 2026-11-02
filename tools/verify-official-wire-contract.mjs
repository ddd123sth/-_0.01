import fs from 'node:fs';
import crypto from 'node:crypto';

const rangeSpec = JSON.parse(fs.readFileSync(new URL('../runtime/backend/contracts/official-wire-contract-v1.json', import.meta.url), 'utf8'));
const files = rangeSpec.sources.map(source => ({ ...source, bytes: fs.readFileSync(new URL('../' + source.path.replaceAll('\\', '/'), import.meta.url)) }));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const results = [];
for (const source of files) {
  if (sha(source.bytes) !== source.sha256) throw new Error('Source fingerprint mismatch: ' + source.label);
  for (const [name, start, end, expected] of rangeSpec.ranges) {
    const actual = sha(source.bytes.subarray(start, end));
    if (actual !== expected) throw new Error(`${source.label}:${name} range fingerprint mismatch`);
    results.push({ source: source.label, name, start, end, sha256: actual });
  }
}
for (let i = 0; i < rangeSpec.ranges.length; i += 1) {
  const left = files[0].bytes.subarray(rangeSpec.ranges[i][1], rangeSpec.ranges[i][2]);
  const right = files[1].bytes.subarray(rangeSpec.ranges[i][1], rangeSpec.ranges[i][2]);
  if (!left.equals(right)) throw new Error(`Sources differ at ${rangeSpec.ranges[i][0]}`);
}
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const contractId = 'sha256:' + sha(Buffer.from(canonical(rangeSpec.ranges.map(([name, start, end, sha256]) => ({ name, start, end, sha256 })))));
console.log(JSON.stringify({ checkedSources: files.map(({ label, path, sha256, bytes }) => ({ label, path, bytes: bytes.length, sha256 })),
  rangesChecked: results.length, byteIdenticalRanges: rangeSpec.ranges.length,
  contractId, evidence: results }, null, 2));
