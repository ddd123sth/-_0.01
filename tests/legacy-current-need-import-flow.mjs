import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, fingerprint, parseStored } from '../runtime/backend/common.mjs';
import { openBackendStore } from '../runtime/backend/persistence/store.mjs';
import { createMigrationReceiver } from '../runtime/backend/migration/receiver.mjs';
import { createLegacyConstraints } from '../runtime/backend/migration/legacy-constraints.mjs';
import { createCurrentIsolationEvidence } from '../runtime/backend/migration/current-isolation.mjs';
import { sourceDescriptor, sealMigrationPayload, signatureMessage } from '../runtime/backend/migration/crypto.mjs';
import { digestText } from '../runtime/backend/migration/crypto.mjs';
import { createDynamicStateCoordinator } from '../runtime/backend/facts/dynamic-state.mjs';
import { legacyConstraintHasClosedSourceOperation } from '../runtime/backend/features/land/runtime.mjs';
import { createMigrationComposition } from '../runtime/backend/migration/composition.mjs';
import { fixture as landFixture, BASE as LAND_BASE } from './helpers-land-current-need-fixture.mjs';

const sourceOwnerRef = 'source-software-owner';
const targetOwnerRef = 'target-software-owner';
const subjectRef = 'a'.repeat(64);
const context = { ownerRef: targetOwnerRef, accountRef: '7', subjectRef, ownerEpoch: 3, runEpoch: 2, connectionEpoch: 9 };
const sourceInfo = { appId: 'source.app', cloudRef: 'source-cloud', sourceVersion: 'source-v1', instanceRef: 'source-instance-1',
  softwareUserId: 21, installId: 'a'.repeat(32) };
const targetInfo = { appId: 'target.app', cloudRef: 'target-cloud', sourceVersion: 'target-v1' };
const sourceAuthentication = { signedIn: true, authorized: true, sourceOwnerRef, transport: 'authenticated-device-loopback',
  evidenceRef: 'source-software-session:21:source-instance-1', userId: 21, installId: sourceInfo.installId };
const subjectAlias = { subjectRef, basis: 'normal-game-identity', identityVersion: 'game-identity/v1', sourceRef: 'source-alias-proof' };

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-legacy-current-need-import-'));
  const store = openBackendStore({ dataDir: dir });
  const cipher = { encrypt: value => 'test-cipher:' + value, decrypt: value => value.slice('test-cipher:'.length) };
  store.db.exec(`CREATE TABLE backend_migration_pairings(pairing_ref TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,source_authentication_json TEXT NOT NULL,target_authentication_ref TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE backend_executor_isolation(subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL UNIQUE,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
    CREATE TABLE backend_accounts(owner_ref TEXT NOT NULL,account_id INTEGER NOT NULL,subject_ref TEXT NOT NULL,server_id INTEGER NOT NULL,
      profile_json TEXT NOT NULL,verification_ref TEXT,migration_key TEXT,source_json TEXT,removed_at TEXT,PRIMARY KEY(owner_ref,account_id));
    CREATE TABLE backend_account_official_identities(identity_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      server_id INTEGER NOT NULL,official_uid INTEGER NOT NULL,evidence_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL);
    CREATE TABLE backend_run_intents(owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,desired_running INTEGER NOT NULL,
      run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE backend_subject_owners(subject_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,executor_ref TEXT NOT NULL,active INTEGER NOT NULL);`);
  const signer = crypto.generateKeyPairSync('ed25519');
  const sourceDescriptorValue = sourceDescriptor({ sourceInfo, sourceOwnerRef,
    signerPublicKey: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  const pairingRef = 'paired-source-install';
  store.run('INSERT INTO backend_migration_pairings VALUES(?,?,?,?,?,?,?)', pairingRef, targetOwnerRef, sourceOwnerRef,
    canonical(sourceDescriptorValue), canonical(sourceAuthentication), 'target-authentication-ref', store.nowIso());
  const login = { source: 'response', transport: 'answered', method: 'index.login', dsName: 'G.ISyncData', envelopeOk: true,
    rejected: false, connectionEpoch: context.connectionEpoch, requestSequence: 12, responseRef: 'current-login-12', wireKey: 'ws|3|12',
    receivedDeviceMs: 1792920000000, value: { '7': { '0': { '0': 987654 } } } };
  const loginVersion = { gameVersion: '480.0.27', protocolVersion: '480.0.0' };
  store.run(`INSERT INTO backend_accounts(owner_ref,account_id,subject_ref,server_id,profile_json,verification_ref,migration_key,source_json,removed_at)
    VALUES(?,?,?,?,?,?,?,?,NULL)`, targetOwnerRef, 7, subjectRef, 12, canonical({ uid: 987654 }), 'verified-current-login', null, canonical({ kind: 'normal' }));
  store.run('INSERT INTO backend_account_official_identities VALUES(?,?,?,?,?,?,?,?)', 'current-identity-ref', targetOwnerRef, '7', subjectRef,
    12, 987654, login.responseRef, context.connectionEpoch);
  store.run('INSERT INTO backend_run_intents VALUES(?,?,?,?,?,?)', targetOwnerRef, '7', subjectRef, 1, context.runEpoch, context.connectionEpoch);
  store.run('INSERT INTO backend_subject_owners VALUES(?,?,?,?,1)', subjectRef, targetOwnerRef, context.ownerEpoch, 'current-executor');
  createDynamicStateCoordinator({ store, isCurrent: () => true });
  store.run(`INSERT INTO backend_dynamic_login_identity_anchors(owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,
    response_ref,request_sequence,official_uid,game_version,protocol_version,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  targetOwnerRef, '7', subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, login.responseRef, login.requestSequence,
  987654, loginVersion.gameVersion, loginVersion.protocolVersion, store.nowIso());
  const legacy = createLegacyConstraints({ store, cipher });
  const readLegacyConstraint = input => {
    const archive = store.get(`SELECT source_row_fingerprint,source_primary_key_json,original_row_ciphertext FROM backend_legacy_archives
      WHERE archive_id=? AND transfer_id=? AND target_owner_ref=? AND target_account_ref=? AND target_subject_ref=? AND source_table=?`,
    input.archiveId, input.transferId, input.ownerRef, String(input.accountRef), input.subjectRef, input.sourceTable);
    if (!archive || archive.source_row_fingerprint !== input.expectedFingerprint ||
        canonical(parseStored(archive.source_primary_key_json, 'fixture primary key')) !== canonical(input.expectedPrimaryKey)) return null;
    return parseStored(cipher.decrypt(archive.original_row_ciphertext), 'fixture constraint row');
  };
  const receiver = createMigrationReceiver({ store, cipher, targetInfo,
    authorizeOwnerMapping: () => ({ authorized: true, sourceOwnerRef, targetOwnerRef, mappingRef: pairingRef,
      sourceAuthenticationRef: sourceAuthentication.evidenceRef, targetAuthenticationRef: 'target-authentication-ref' }),
    assertOwnerCurrent: () => true,
    verifyAndAdd: async input => {
      const stopProof = input.stopProofs[1];
      store.run('INSERT INTO backend_executor_isolation VALUES(?,?,?,?,?)', subjectRef,
        'signed-migration:' + input.migrationKey + ':' + subjectRef, 'source:' + input.sourceInfo.instanceRef,
        canonical(stopProof), store.nowIso());
      store.run('UPDATE backend_subject_owners SET executor_ref=? WHERE subject_ref=?', 'current-executor', subjectRef);
      return { ownerRef: targetOwnerRef, accountRef: '7', subjectRef, credentialStored: true, verificationRef: 'verified-current-login' };
    },
    onImported: input => { legacy.indexImport(input); } });
  const isolationEvidence = createCurrentIsolationEvidence({ store, isCurrent: () => true,
    readCurrentLogin: () => ({ ...login, value: { '7': { '0': { '0': 987654 } } } }), readLegacyConstraint });
  return { dir, store, signer, sourceDescriptorValue, pairingRef, receiver, legacy, isolationEvidence, login, loginVersion };
}

function migrationEnvelope(h, { includeOperation = true } = {}) {
  const sourceAccount = { id: 44, username: 'garden-source', panel_token: sourceOwnerRef, server_id: 12, script_config: '{}' };
  const operation = { operation_id: 'old-game-write-1', subject_ref: subjectRef, semantic_key: 'old-semantics', feature_id: 'order.customer',
    scope: 'order-customer', method: 'orderCustomer.finishOrder', status: 'unknown', transport_state: 'unknown',
    business_verdict: 'unknown', revision: 1, evidence_revision: 1, target_ref: 'customer-order:' + subjectRef + ':91',
    target_binding_state: 'unknown', target_member_count: 1 };
  const target = { operation_id: operation.operation_id, target_ref: operation.target_ref };
  const hold = { id: 1, operation_id: operation.operation_id, resource_key: 'item:23001', quantity: 2, state: 'unknown', released_at: null };
  const evidence = { id: 1, operation_id: operation.operation_id, kind: 'transport-unknown', payload_json: '{}' };
  const tables = [
    { table: 'accounts', status: 'read', primaryKey: ['id'], rows: [sourceAccount] },
    { table: 'game_write_operations', status: 'read', primaryKey: ['operation_id'], rows: includeOperation ? [operation] : [] },
    { table: 'game_write_operation_targets', status: 'read', primaryKey: ['operation_id', 'target_ref'], rows: [target] },
    { table: 'game_write_holds', status: 'read', primaryKey: ['id'], rows: [hold] },
    { table: 'write_evidence_events', status: 'read', primaryKey: ['id'], rows: [evidence] },
  ];
  const offerData = undefined;
  return { sourceAccount, operation, target, hold, tables, offerData };
}

test('signed receiver import and production indexer yield an exact legacy source-fence proof', async () => {
  const h = harness();
  try {
    const offer = await h.receiver.createOffer({ targetOwnerRef: targetOwnerRef, sourceOwnerRef, sourceAppId: sourceInfo.appId,
      sourceCloudRef: sourceInfo.cloudRef, commandId: 'migration-command-1', sourceDescriptor: h.sourceDescriptorValue,
      authenticationRef: h.pairingRef });
    const data = migrationEnvelope(h), sourceAccount = data.sourceAccount;
    const payload = { protocolVersion: 1, transferId: 'signed-transfer-1', commandId: 'source-command-1',
      source: { ...sourceInfo, ownerRef: sourceOwnerRef, accountId: sourceAccount.id, exportedAt: '2026-10-26T01:00:00.000Z' },
      target: { ownerRef: targetOwnerRef, appId: targetInfo.appId, cloudRef: targetInfo.cloudRef, sessionId: offer.sessionId,
        fingerprint: offer.targetFingerprint }, account: sourceAccount, loginCredential: { username: sourceAccount.username, password: 'discarded-test-password' },
      aliases: [subjectAlias], stopProofs: [0, 1].map(index => ({ stopped: true, currentInFlight: false, sourceFenceCommitted: true,
        sourceOwnerRef, targetSessionId: offer.sessionId, fenceRef: 'signed-source-fence-' + index, evidenceRef: 'source-stop-and-fence:signed-source-fence-' + index,
        readAt: '2026-10-26T01:00:00.000Z' })), tables: data.tables,
      manifest: data.tables.map(item => ({ table: item.table, status: item.status, rowCount: item.rows.length, fingerprint: digestText(canonical(item)) })) };
    const sealed = sealMigrationPayload(offer, payload);
    const envelopeFingerprint = digestText(canonical(sealed));
    const signedAt = '2026-10-26T01:00:00.000Z';
    const signature = crypto.sign(null, signatureMessage({ envelopeFingerprint, offer, signedAt,
      sourceAuthenticationRef: sourceAuthentication.evidenceRef }), h.signer.privateKey).toString('base64');
    const envelope = { ...sealed, sourceAttestation: { envelopeFingerprint, sourceOwnerRef, targetOwnerRef, sessionId: offer.sessionId,
      targetFingerprint: offer.targetFingerprint, sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint,
      sourceSignerFingerprint: offer.sourceSignerFingerprint, sourceAuthenticationRef: sourceAuthentication.evidenceRef, signedAt, signature } };
    const imported = await h.receiver.importEnvelope({ targetOwnerRef, envelope, commandId: 'import-command-1', authenticationRef: h.pairingRef });
    assert.equal(imported.state, 'imported');
    const indexed = h.legacy.candidateProjection({ ownerRef: targetOwnerRef, subjectRef, rawTargetRefs: [data.target.target_ref], rawResourceKeys: [] });
    assert.equal(indexed.operations.length, 1);
    assert.equal(indexed.operations[0].business_verdict, 'unknown');
    const proof = h.isolationEvidence.read({ context, legacyOperationRef: indexed.operations[0].operation_ref });
    assert.equal(proof.available, true, JSON.stringify(proof));
    assert.equal(proof.previousExecution.kind, 'legacy-signed-migration-fence');
    assert.equal(proof.previousExecution.executionClosed, true);
    assert.equal(proof.original.sourceFingerprint, indexed.operations[0].source_fingerprint);
    assert.equal(h.store.get('SELECT business_verdict FROM backend_legacy_operation_index WHERE operation_ref=?', indexed.operations[0].operation_ref).business_verdict,
      'unknown', 'signed closure/indexing does not rewrite historical outcome');
    h.store.run('UPDATE backend_accounts SET profile_json=? WHERE owner_ref=? AND account_id=?', canonical({ uid: 987655 }), targetOwnerRef, 7);
    const mismatchedIdentity = h.isolationEvidence.read({ context, legacyOperationRef: indexed.operations[0].operation_ref });
    assert.equal(mismatchedIdentity.available, false, 'known current UID conflict cannot be covered by a signed source fence');
    h.store.run('UPDATE backend_accounts SET profile_json=? WHERE owner_ref=? AND account_id=?', canonical({ uid: 987654 }), targetOwnerRef, 7);
    assert.equal(h.isolationEvidence.read({ context, legacyOperationRef: indexed.operations[0].operation_ref }).available, true);
  } finally { h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('orphan legacy resource constraint uses its exact signed source fence without inventing a parent operation', async () => {
  const h = harness();
  try {
    const offer = await h.receiver.createOffer({ targetOwnerRef, sourceOwnerRef, sourceAppId: sourceInfo.appId,
      sourceCloudRef: sourceInfo.cloudRef, commandId: 'orphan-migration-command', sourceDescriptor: h.sourceDescriptorValue,
      authenticationRef: h.pairingRef });
    const data = migrationEnvelope(h, { includeOperation: false });
    const payload = { protocolVersion: 1, transferId: 'orphan-transfer', commandId: 'orphan-source-command',
      source: { ...sourceInfo, ownerRef: sourceOwnerRef, accountId: data.sourceAccount.id, exportedAt: '2026-10-26T01:00:00.000Z' },
      target: { ownerRef: targetOwnerRef, appId: targetInfo.appId, cloudRef: targetInfo.cloudRef, sessionId: offer.sessionId,
        fingerprint: offer.targetFingerprint }, account: data.sourceAccount,
      loginCredential: { username: data.sourceAccount.username, password: 'discarded-test-password' }, aliases: [subjectAlias],
      stopProofs: [0, 1].map(index => ({ stopped: true, currentInFlight: false, sourceFenceCommitted: true,
        sourceOwnerRef, targetSessionId: offer.sessionId, fenceRef: 'orphan-fence-' + index, evidenceRef: 'source-stop-and-fence:orphan-fence-' + index,
        readAt: '2026-10-26T01:00:00.000Z' })), tables: data.tables,
      manifest: data.tables.map(item => ({ table: item.table, status: item.status, rowCount: item.rows.length, fingerprint: digestText(canonical(item)) })) };
    const sealed = sealMigrationPayload(offer, payload), envelopeFingerprint = digestText(canonical(sealed)), signedAt = '2026-10-26T01:00:00.000Z';
    const signature = crypto.sign(null, signatureMessage({ envelopeFingerprint, offer, signedAt,
      sourceAuthenticationRef: sourceAuthentication.evidenceRef }), h.signer.privateKey).toString('base64');
    const envelope = { ...sealed, sourceAttestation: { envelopeFingerprint, sourceOwnerRef, targetOwnerRef, sessionId: offer.sessionId,
      targetFingerprint: offer.targetFingerprint, sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint,
      sourceSignerFingerprint: offer.sourceSignerFingerprint, sourceAuthenticationRef: sourceAuthentication.evidenceRef, signedAt, signature } };
    assert.equal((await h.receiver.importEnvelope({ targetOwnerRef, envelope, commandId: 'orphan-import-command', authenticationRef: h.pairingRef })).state, 'imported');
    const admission = h.legacy.currentAdmission({ ownerRef: targetOwnerRef, subjectRef });
    assert.equal(admission.operations.length, 0);
    assert.equal(admission.resourceFootprints.length, 1);
    assert.equal(admission.resourceFootprints[0].operation_ref, null);
    const proof = h.isolationEvidence.read({ context, legacyConstraintRef: admission.resourceFootprints[0].constraint_ref });
    assert.equal(proof.available, true, JSON.stringify(proof));
    assert.equal(proof.original.kind, 'legacy-constraint');
    assert.equal(proof.original.rawRef, 'item:23001');
    assert.equal(proof.previousExecution.executionClosed, true);
    assert.equal(proof.outcomeProven, false);
    const constraint = admission.resourceFootprints[0];
    assert.equal(legacyConstraintHasClosedSourceOperation(constraint, proof, context), true,
      'the land baseline-link predicate accepts this exact orphan constraint proof');
    assert.equal(legacyConstraintHasClosedSourceOperation({ ...constraint, source_fingerprint: 'f'.repeat(64) }, proof, context), false,
      'a different constraint fingerprint cannot reuse the closure proof');
  } finally { h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('signed orphan resource import is separated by the real land budget baseline path', async () => {
  const f = landFixture();
  try {
    const signer = crypto.generateKeyPairSync('ed25519');
    const sourceOwner = 'signed-source-owner';
    const sourceInstall = 'b'.repeat(32);
    const source = { appId: 'signed.source', cloudRef: 'source-cloud', sourceVersion: 'source-v1', instanceRef: 'signed-source-instance',
      softwareUserId: 27, installId: sourceInstall };
    const descriptor = sourceDescriptor({ sourceInfo: source, sourceOwnerRef: sourceOwner,
      signerPublicKey: signer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
    const authenticationRef = 'source-authenticated-loopback';
    const verificationRef = 'fixture-normal-official-verification';
    const migration = createMigrationComposition({ store: f.store, cipher: f.isolationCipher,
      targetInfo: { appId: 'fixture.app', cloudRef: 'fixture-cloud', sourceVersion: 'fixture-build' },
      accounts: { add: async () => {
        f.store.run('UPDATE backend_accounts SET verification_ref=? WHERE owner_ref=? AND account_id=? AND subject_ref=?',
          verificationRef, LAND_BASE.ownerRef, Number(LAND_BASE.accountRef), LAND_BASE.subjectRef);
        return { accountRef: String(LAND_BASE.accountRef), subjectRef: LAND_BASE.subjectRef, evidenceRef: verificationRef };
      },
        row: () => ({ owner_ref: LAND_BASE.ownerRef, account_id: Number(LAND_BASE.accountRef), subject_ref: LAND_BASE.subjectRef,
          source_json: canonical({}), verification_ref: verificationRef, migration_key: 'unused', credential_cipher: 'present' }) },
      software: { authorize: () => true },
      authorizeOwnerMapping: () => ({ authorized: true, sourceOwnerRef: sourceOwner, targetOwnerRef: LAND_BASE.ownerRef,
        mappingRef: 'fixture-pairing', sourceAuthenticationRef: authenticationRef, targetAuthenticationRef: 'fixture-target-auth',
        sourceSoftwareUserId: 27, sourceInstallId: sourceInstall }),
      assertOwnerCurrent: () => true, legacy: f.legacy, legacyLogging: { onImported() {} }, legacyHistory: { onImported() {} }, log() {} });
    const offer = await migration.createOffer({ targetOwnerRef: LAND_BASE.ownerRef, sourceOwnerRef: sourceOwner,
      sourceAppId: source.appId, sourceCloudRef: source.cloudRef, commandId: 'land-orphan-offer', sourceDescriptor: descriptor,
      authenticationRef });
    f.store.run('INSERT INTO backend_migration_pairings VALUES(?,?,?,?,?,?,?)', authenticationRef, LAND_BASE.ownerRef, sourceOwner,
      canonical(descriptor), canonical({ signedIn: true, authorized: true, sourceOwnerRef: sourceOwner,
        transport: 'authenticated-device-loopback', evidenceRef: authenticationRef, userId: 27, installId: sourceInstall }),
      'fixture-target-auth', f.store.nowIso());
    const sourceAccount = { id: 44, username: 'source-fixture', panel_token: sourceOwner, server_id: 1, script_config: '{}' };
    const operationId = 'land-orphan-source-operation';
    const hold = { id: 902, operation_id: operationId, resource_key: 'item:23001', quantity: 2, state: 'unknown', released_at: null };
    const tables = [
      { table: 'accounts', status: 'read', primaryKey: ['id'], rows: [sourceAccount] },
      { table: 'game_write_operations', status: 'read', primaryKey: ['operation_id'], rows: [] },
      { table: 'game_write_holds', status: 'read', primaryKey: ['id'], rows: [hold] },
      { table: 'write_evidence_events', status: 'read', primaryKey: ['id'], rows: [{ id: 902, operation_id: operationId,
        kind: 'transport-unknown', payload_json: '{}' }] },
    ];
    const payload = { protocolVersion: 1, transferId: 'land-orphan-transfer', commandId: 'land-orphan-source-command',
      source: { ...source, ownerRef: sourceOwner, accountId: sourceAccount.id, exportedAt: '2026-10-26T01:00:00.000Z' },
      target: { ownerRef: LAND_BASE.ownerRef, appId: 'fixture.app', cloudRef: 'fixture-cloud', sessionId: offer.sessionId,
        fingerprint: offer.targetFingerprint }, account: sourceAccount,
      loginCredential: { username: sourceAccount.username, password: 'discarded-fixture-password' },
      aliases: [{ subjectRef: LAND_BASE.subjectRef, basis: 'normal-game-identity', identityVersion: 'game-identity/v1', sourceRef: 'fixture-alias' }],
      stopProofs: [0, 1].map(index => ({ stopped: true, currentInFlight: false, sourceFenceCommitted: true,
        sourceOwnerRef: sourceOwner, targetSessionId: offer.sessionId, fenceRef: `land-orphan-fence-${index}`,
        evidenceRef: `source-stop-and-fence:land-orphan-fence-${index}`, readAt: '2026-10-26T01:00:00.000Z' })), tables,
      manifest: tables.map(item => ({ table: item.table, status: item.status, rowCount: item.rows.length,
        fingerprint: digestText(canonical(item)) })) };
    const sealed = sealMigrationPayload(offer, payload), envelopeFingerprint = digestText(canonical(sealed)), signedAt = '2026-10-26T01:00:00.000Z';
    const signature = crypto.sign(null, signatureMessage({ envelopeFingerprint, offer, signedAt,
      sourceAuthenticationRef: authenticationRef }), signer.privateKey).toString('base64');
    const envelope = { ...sealed, sourceAttestation: { envelopeFingerprint, sourceOwnerRef: sourceOwner, targetOwnerRef: LAND_BASE.ownerRef,
      sessionId: offer.sessionId, targetFingerprint: offer.targetFingerprint, sourceDescriptorFingerprint: offer.sourceDescriptorFingerprint,
      sourceSignerFingerprint: offer.sourceSignerFingerprint, sourceAuthenticationRef: authenticationRef, signedAt, signature } };
    assert.equal((await migration.importEnvelope({ targetOwnerRef: LAND_BASE.ownerRef, envelope,
      commandId: 'land-orphan-import', authenticationRef })).state, 'imported');
    const constraint = f.legacy.currentAdmission({ ownerRef: LAND_BASE.ownerRef, subjectRef: LAND_BASE.subjectRef }).resourceFootprints[0];
    assert.ok(constraint?.constraint_ref);
    assert.equal(constraint.operation_ref, null);
    assert.equal(constraint.source_origin_key, fingerprint({ sourceAppId: source.appId, sourceCloudRef: source.cloudRef,
      sourceOwnerRef: sourceOwner, sourceOperationId: operationId, part: { kind: 'resource', rawRef: 'item:23001' } }));
    const sourceRow = f.store.get('SELECT source_fingerprint FROM backend_legacy_constraint_index WHERE constraint_ref=?', constraint.constraint_ref);
    const archiveBefore = f.store.get(`SELECT source_row_fingerprint,original_row_ciphertext FROM backend_legacy_archives
      WHERE transfer_id=? AND source_table='game_write_holds'`, 'land-orphan-transfer');
    const beforeLogin = f.seedLogin(f.active, 1, 1);
    const baseline = f.recordCurrentResourceBaseline(beforeLogin);
    assert.equal(baseline.recorded, true, JSON.stringify(baseline));
    const account = f.store.get('SELECT profile_json FROM backend_accounts WHERE owner_ref=? AND account_id=?', LAND_BASE.ownerRef,
      Number(LAND_BASE.accountRef));
    f.store.run('UPDATE backend_accounts SET profile_json=? WHERE owner_ref=? AND account_id=?', canonical({ uid: 77124 }),
      LAND_BASE.ownerRef, Number(LAND_BASE.accountRef));
    const conflictingBudget = f.landRuntime.resources.budget({ context: f.active, itemId: 23001, quantity: 1, keep: 0 });
    assert.equal(conflictingBudget.available, 0, 'known current UID conflict keeps the imported footprint reserved');
    assert.equal(f.store.all('SELECT * FROM backend_legacy_resource_budget_baseline_links WHERE constraint_ref=?', constraint.constraint_ref).length,
      0, 'known identity conflict cannot create a baseline separation link');
    f.store.run('UPDATE backend_accounts SET profile_json=? WHERE owner_ref=? AND account_id=?', account.profile_json,
      LAND_BASE.ownerRef, Number(LAND_BASE.accountRef));
    const signedFence = f.store.get('SELECT * FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?',
      LAND_BASE.subjectRef, 'signed-migration:land-orphan-transfer:' + LAND_BASE.subjectRef);
    assert.ok(signedFence, 'the production migration path persisted the signed source fence');
    f.store.run('DELETE FROM backend_executor_isolation WHERE subject_ref=? AND evidence_ref=?',
      LAND_BASE.subjectRef, signedFence.evidence_ref);
    const noFenceBudget = f.landRuntime.resources.budget({ context: f.active, itemId: 23001, quantity: 1, keep: 0 });
    assert.equal(noFenceBudget.available, 0, 'a current login and baseline cannot separate an imported hold without its signed source fence');
    assert.equal(f.store.all('SELECT * FROM backend_legacy_resource_budget_baseline_links WHERE constraint_ref=?', constraint.constraint_ref).length,
      0, 'missing signed fence creates no budget link');
    f.store.run('INSERT INTO backend_executor_isolation VALUES(?,?,?,?,?)', signedFence.subject_ref, signedFence.evidence_ref,
      signedFence.source_ref, signedFence.proof_json, signedFence.created_at);
    const balanceBefore = f.landRuntime.resources.balance({ context: f.active, itemId: 23001 });
    const budget = f.landRuntime.resources.budget({ context: f.active, itemId: 23001, quantity: 1, keep: 0 });
    assert.equal(balanceBefore.base.value, 1);
    assert.equal(budget.known, true);
    assert.equal(budget.available, 1, JSON.stringify({ budget,
      proof: f.isolationEvidence.read({ context: f.active, legacyConstraintRef: constraint.constraint_ref }) }));
    const links = f.store.all('SELECT * FROM backend_legacy_resource_budget_baseline_links WHERE constraint_ref=?', constraint.constraint_ref);
    assert.equal(links.length, 1, 'real resource admission appends one exact constraint/baseline link');
    assert.equal(links[0].source_fingerprint, sourceRow.source_fingerprint);
    assert.deepEqual(f.store.get(`SELECT source_row_fingerprint,original_row_ciphertext FROM backend_legacy_archives
      WHERE transfer_id=? AND source_table='game_write_holds'`, 'land-orphan-transfer'), archiveBefore,
    'baseline separation leaves the archived unknown hold bytes unchanged');
    assert.equal(f.store.get('SELECT source_fingerprint FROM backend_legacy_constraint_index WHERE constraint_ref=?', constraint.constraint_ref)
      .source_fingerprint, sourceRow.source_fingerprint);
    assert.equal(f.legacy.currentAdmission({ ownerRef: LAND_BASE.ownerRef, subjectRef: LAND_BASE.subjectRef,
      resourceBaselineRef: baseline.baselineRef }).resourceFootprints.length, 0);
  } finally { await f.close(); }
});
