// Static source inventory only: it does not load the runtime, databases or devices.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as legacySchema from '../vendor/garden-engine/server/src/schema.js';
import { cardMetadata } from '../runtime/presentation-metadata.mjs';
import { flowerArtOptions } from '../vendor/garden-engine/server/src/game/flower-art-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const sha = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
const coveragePath = 'docs/android-backend-execution-20261024/coverage.json';
const coverage = JSON.parse(read(coveragePath));
const definitions = {
  source: { path: coveragePath, sha256: sha(coveragePath), baselineCommit: '41caed1', evidence: 'static-inventory-not-behavior-contract' },
  modules: coverage.modules.map(row => ({ moduleId: row.path, label: row.label, group: row.group, fieldPaths: row.allFieldPaths, phase: row.phase,
    implementation: 'unimplemented', release: 'unreleased', sourcePointer: row.sourcePointer })),
  fields: coverage.fields.map(row => ({ fieldId: row.fieldId, path: row.path, moduleId: row.module, type: row.type, label: row.label,
    phase: row.phase, desiredDefault: null, historicalDefault: row.sourceDeclaredDefault, historicalDefaultIsContract: false,
    heldReason: row.heldReason, compatibleDtoField: row.compatibleDtoField, sourcePointer: row.sourcePointer })),
  scopes: coverage.scopes.map(row => ({ scope: row.scope, methods: row.methods, moduleIds: row.schemaOwners, phase: row.phase,
    implementation: 'unimplemented', release: 'unreleased' })),
  referenceActions: coverage.referenceActions.map(row => ({ sourceId: row.sourceId, method: row.canonicalMethod, offset: row.offset,
    scopes: row.officialScopes, existenceOnly: true })),
  referenceConfigurations: coverage.referenceConfigurations.map(row => ({ sourceId: row.sourceId, literal: row.literal, offset: row.offset,
    candidatePaths: row.officialCandidatePaths, bindingIsProven: false })),
  systems: coverage.supportingSystems.map(row => ({ systemId: row.id, domain: row.domain, implementation: 'unimplemented', release: 'unreleased' })),
  historicalPaths: coverage.historicalParkedPathsWithoutDefinition,
  heldPaths: coverage.held,
  retainedCandidates: { dottedCount: 473, partialCount: 15, source: coveragePath, pointer: '/retainedReferenceCandidates' },
};
if (definitions.modules.length !== 77 || definitions.fields.length !== 478 || definitions.scopes.length !== 123 ||
    new Set(definitions.scopes.flatMap(row => row.methods)).size !== 107 || definitions.referenceActions.length !== 157 || definitions.referenceConfigurations.length !== 88) {
  throw new Error('Coverage baseline changed; review the new source before generating runtime inventory.');
}
const output = path.join(root, 'runtime/backend/registry/inventory.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(definitions, null, 2) + '\n');

// Extract only the existing presentation projection. The new runtime never
// imports the old config conversions, schema's pacing policy, or planners.
const metadata = cardMetadata(legacySchema);
const flowers = JSON.parse(read('vendor/garden-engine/server/data/flowers.json')).filter(row => Number.isSafeInteger(row.value) && row.value > 0 && row.label && row.label !== '0')
  .map(row => ({ id: row.value, name: row.label, quality: row.quality }));
const flowerArts = flowerArtOptions().map(row => ({ id: row.value, name: row.name, label: row.label, flowers: [...row.flowers] }));
const catalogPath = path.join(root, 'runtime/backend/compat/catalog.json');
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
fs.writeFileSync(catalogPath, JSON.stringify({ flowers, groupSizes: metadata.groupSize.options, plantModes: metadata.plantMode.options,
  qualities: metadata.qualities, flowerArts, metadata, source: {
    kind: 'current-presentation-catalog-not-qualification', generatedBy: 'tools/backend-contract-inventory.mjs',
    flowersSha256: sha('vendor/garden-engine/server/data/flowers.json'), schemaSha256: sha('vendor/garden-engine/server/src/schema.js'),
    configPresentationSha256: sha('runtime/presentation-metadata.mjs'), artCatalogSha256: sha('vendor/garden-engine/server/src/game/flower-art-catalog.js'),
    officialArtSha256: sha('vendor/garden-engine/server/data/official-cfg/c_flowerArt.json'), officialItemSha256: sha('vendor/garden-engine/server/data/official-cfg/c_item.json') } }, null, 2) + '\n');

const sourcePaths = ['ui/index.html', ...fs.readdirSync(path.join(root, 'ui/moon')).filter(name => name.endsWith('.js')).map(name => 'ui/moon/' + name),
  'ui/app.js', 'runtime/backend/server.mjs', 'runtime/software-api.mjs', 'runtime/presentation-metadata.mjs',
  'app/src/main/java/online/ainiannian/garden/MainActivity.java', 'app/src/main/java/online/ainiannian/garden/EngineService.java'];
const sites = [];
for (const sourcePath of sourcePaths) {
  read(sourcePath).split(/\r?\n/).forEach((line, index) => {
    const kinds = [];
    if (/\b(?:api|softwareCall)\(/.test(line) && !/function (?:api|softwareCall)/.test(line)) kinds.push('ui-local-request');
    if (/fetch\(/.test(line)) kinds.push('http-transport');
    if (/AndroidBridge|GardenHost|bridgeCall\(|onGarden[A-Z]/.test(line)) kinds.push('native-or-host-bridge');
    if (/request\.method|route ===|operation ===|const match =/.test(line) && sourcePath.startsWith('runtime/')) kinds.push('service-route');
    if (/@JavascriptInterface/.test(line)) kinds.push('native-export');
    if (kinds.length) sites.push({ sourcePath, line: index + 1, kinds, excerpt: line.trim() });
  });
}
const report = {
  generatedAt: new Date().toISOString(), baselineCommit: '41caed1', kind: 'static-candidate-callsite-inventory',
  limitations: ['Regex candidates require manual scene and dynamic-path binding; not proof of runtime branch coverage.',
    'No device, credential, runtime database or network accessed. Historical production sources retained.'],
  sources: sourcePaths.map(sourcePath => ({ path: sourcePath, sha256: sha(sourcePath) })), sites,
};
const reportPath = path.join(root, 'docs/android-backend-implementation-20261024/frontend-callsite-inventory.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ kind: 'static-preparation', modules: definitions.modules.length, fields: definitions.fields.length,
  scopes: definitions.scopes.length, sourceFiles: sourcePaths.length, candidateCallsites: sites.length }));
