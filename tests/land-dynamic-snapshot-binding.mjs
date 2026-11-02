import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, makeObservation, BASE, VERSION } from './helpers-land-current-need-fixture.mjs';
import { officialDataSnapshotForSourceVersion } from '../runtime/backend/official-data-snapshot.mjs';
import { OFFICIAL_GDATA_SCHEMA_CONTRACT_ID } from '../runtime/backend/official-public-data.mjs';
import { OFFICIAL_CORE_CONTRACT_ID } from '../runtime/backend/official-version-profile.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = relative => JSON.parse(fs.readFileSync(path.resolve(root, relative), 'utf8'));

test('matched login binds the activated snapshot and replay keeps the same connection proof', async () => {
  const f = fixture();
  try {
    const context = f.currentContext();
    const responseRef = 'fixture:matched-login:snapshot-bind';
    const sourceSnapshot = officialDataSnapshotForSourceVersion(VERSION.gameVersion);
    const versionEvidence = { source: 'normal-package-hop-and-matched-world-login/v1', ...VERSION,
      loginResponseRef: responseRef, profileBinding: { dataSnapshotId: sourceSnapshot.dataSnapshotId } };
    const login = makeObservation(context, { sequence: 1, responseRef, landState: 1, method: 'index.login' });
    login.versionEvidence = versionEvidence;

    const first = f.landRuntime.ingest({ context, observation: login });
    assert.equal(first.sourcePolicy.supported, true);
    const tables = {
      c_item: load('../runtime/backend/catalogs/official-land-480.0.27/c_item.json'),
      c_farmLand: load('../runtime/backend/catalogs/official-land-480.0.27/c_farmLand.json'),
      c_flower: load('../runtime/backend/catalogs/official-land-480.0.27/c_flower.json'),
      c_flowerLvl: load('../runtime/backend/catalogs/official-land-480.0.27/c_flowerLvl.json'),
      c_flowerLvlCfg: load('../runtime/backend/catalogs/official-land-480.0.27/c_flowerLvlCfg.json'),
      c_flowerArt: load('../runtime/backend/catalogs/official-customer-480.0.27/c_flowerArt.json'),
    };
    const snapshot = { ...sourceSnapshot, protocolVersion: VERSION.protocolVersion, tables,
      tableHashes: sourceSnapshot.tableHashes, contractId: OFFICIAL_CORE_CONTRACT_ID,
      dataSchemaContractId: OFFICIAL_GDATA_SCHEMA_CONTRACT_ID, resourceSha256: 'fixture:real-static-source' };
    const bound = f.landRuntime.bindDataSnapshot({ context, snapshot, versionEvidence, loginResponseRef: responseRef });
    assert.ok(bound, 'the current executionContext projection has no nested connection object');
    assert.equal(bound.identity().dataSnapshotId, sourceSnapshot.dataSnapshotId);
    assert.equal(f.landRuntime.catalogForContext(context).identity().loginResponseRef, responseRef);

    const replay = f.landRuntime.ingest({ context, observation: login });
    assert.equal(replay.sourcePolicy.supported, true);
    assert.equal(replay.sourcePolicy.reasonCode, null);
  } finally {
    await f.close();
  }
});
