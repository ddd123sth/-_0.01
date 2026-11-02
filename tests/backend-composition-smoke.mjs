import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../runtime/backend/bootstrap.mjs';
import { REWARD_CARDS } from '../runtime/backend/features/rewards/catalog.mjs';
import { SPECIAL_ORDER_DEFINITIONS } from '../runtime/backend/features/special-orders/rpc-contract.mjs';

test('backend composition builds the shared dynamic coordinator and all registered feature adapters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-backend-compose-'));
  const dataDir = path.join(root, 'data'), deviceProfilePath = path.join(root, 'device-profile.json');
  fs.writeFileSync(deviceProfilePath, '{}', { mode: 0o600 });
  const backend = createBackend({ dataDir, deviceProfilePath, credentialKey: '0'.repeat(64), baseUrl: 'https://service.example.invalid/backend-v2' });
  try {
    const features = backend.registry.definitions().filter(feature => feature.implementation === 'implemented');
    assert.ok(features.length > 0);
    assert.ok(features.every(feature => backend.registry.get(feature.featureId)));
    // The independent deliveries share registration and runtime routing. Keep
    // both families in the real composition, including their precise scopes.
    for (const card of REWARD_CARDS) {
      assert.ok(backend.registry.get(card.featureId), card.featureId);
      for (const [method, scope] of Object.entries(card.methodScopes)) {
        assert.equal(backend.registry.permits(card.featureId, scope, method), true, `${card.featureId}:${method}`);
        assert.equal(backend.registry.permits('order.palace', scope, method), false);
      }
    }
    for (const definition of Object.values(SPECIAL_ORDER_DEFINITIONS)) {
      assert.equal(backend.registry.permits(definition.featureId, definition.scope, definition.method), true);
      assert.equal(backend.registry.permitsRead({ featureId: definition.featureId, scope: definition.scope,
        writeMethod: definition.method, readKind: 'after-close-login', readMethod: 'index.login',
        readContractId: 'special-orders/after-close-login/v1',
        evidenceRef: 'special-orders/independent-order-and-inventory/v1' }), true);
    }
    for (const featureId of ['plant', 'water', 'harvest']) {
      const feature = backend.registry.get(featureId);
      assert.equal(Object.values(feature.currentNeedContracts || {})[0]?.path, 'land.currentNeed');
      assert.equal(Object.values(feature.currentNeedContracts || {})[0]?.required, true);
    }
    const customer = backend.registry.get('order.customer');
    assert.deepEqual(Object.fromEntries(customer.scheduleUnits.map(unit => [unit.scheduleKey, unit.allowedMethods])), {
      'order.customer:delivery': ['orderCustomer.finishOrder'],
      'order.customer:reject': ['orderCustomer.rejectOrder'],
      'order.customer:generation': ['orderCustomer.genOrder'],
    });
    assert.deepEqual(Object.fromEntries(customer.scheduleUnits.map(unit => [unit.scheduleKey, unit.allowedScopes])), {
      'order.customer:delivery': ['order-customer'], 'order.customer:reject': ['order-reject'],
      'order.customer:generation': ['order-customer-gen'],
    });
    const resident = backend.registry.get('order.resident');
    assert.equal(resident.primaryActionKey, 'order.resident:delivery', 'the parent state follows its declared ordinary delivery action');
    assert.equal(resident.currentNeedContracts['orderFlower.enter'].path, 'orderFlowerEnter.currentNeed');
    assert.equal(resident.currentNeedContracts['usr.share'].path, 'orderFlowerVideo.currentNeed');
    for (const method of ['orderFlower.finishOrder', 'orderFlower.enter', 'orderFlower.recvOrderRwd', 'taskAch.recv', 'usr.share']) {
      assert.equal(resident.currentNeedContracts[method]?.required, true, `${method} must consume the shared current-need claim`);
    }
    assert.equal(typeof resident.consumeCurrentNeed, 'function', 'the composed producer delegates all methods to a real shared consumer');
    assert.deepEqual(Object.fromEntries(resident.scheduleUnits.map(unit => [unit.scheduleKey, unit.allowedMethods])), {
      'order.resident:delivery': ['orderFlower.finishOrder'], 'order.resident:enter': ['orderFlower.enter'],
      'order.resident:stage-reward': ['orderFlower.recvOrderRwd'], 'order.resident:achievement': ['taskAch.recv'],
      'order.resident:video': ['usr.share'],
    });
    const ownerRef = 'fixture:primary-action-owner', accountRef = '3', subjectRef = 'fixture:primary-action-subject';
    backend.config.migrate({ ownerRef, accountRef, subjectRef, legacyDocument: {} });
    const saved = backend.config.read({ ownerRef, accountRef });
    backend.config.accept({ ownerRef, accountRef, revision: saved.savedRevision, actorRef: 'fixture:primary-action' });
    const planBase = { ownerRef, accountRef, subjectRef, revision: saved.savedRevision, featureId: 'order.resident',
      primaryActionKey: resident.primaryActionKey };
    backend.config.recordPlan({ ...planBase, actionKey: 'order.resident:stage-reward', state: 'waiting-facts',
      reasonCode: 'AUXILIARY_FACTS_PENDING', evidenceRef: 'fixture:aux-before-primary' });
    let parentPlan = backend.config.read({ ownerRef, accountRef }).byFeature['order.resident'];
    assert.equal(parentPlan.state, 'waiting-facts');
    assert.equal(parentPlan.reasonCode, 'PRIMARY_ACTION_PENDING');
    backend.config.recordPlan({ ...planBase, actionKey: resident.primaryActionKey, state: 'cap-wait',
      reasonCode: 'ORDER_FLOWER_DAILY_LIMIT_REACHED', evidenceRef: 'fixture:primary-cap' });
    parentPlan = backend.config.read({ ownerRef, accountRef }).byFeature['order.resident'];
    assert.equal(parentPlan.state, 'cap-wait');
    assert.equal(parentPlan.actions['order.resident:stage-reward'].state, 'waiting-facts');
    const context = { ownerRef, accountRef, subjectRef, ownerEpoch: 1, runEpoch: 1, connectionEpoch: 1 }, now = backend.store.nowIso();
    const wake = (featureId, reasonCode) => backend.store.run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,
      config_revision,official_due_ms,device_due_ms,clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
      VALUES(?,?,?,?,?,NULL,NULL,NULL,?,'{}','cap-wait',?,1,?)`, ownerRef, subjectRef, featureId, featureId, saved.savedRevision, 1, reasonCode, now);
    wake('order.resident:delivery', 'ORDER_FLOWER_DAILY_LIMIT_REACHED');
    wake('order.resident:stage-reward', 'AUXILIARY_FACTS_PENDING');
    wake('order.resident:retired', 'RETIRED_OLD_UNIT');
    const plannedWakes = backend.scheduler.snapshot(context);
    assert.equal(plannedWakes.some(row => row.actionKey === 'order.resident:retired'), false, 'unregistered historical unit rows stay out of current projection');
    assert.equal(plannedWakes.find(row => row.actionKey === 'order.resident:delivery')?.featureKey, 'order.resident');
    assert.equal(plannedWakes.find(row => row.actionKey === 'order.resident:stage-reward')?.featureKey, 'order.resident:stage-reward');
    assert.ok(backend.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_dynamic_domain_heads'"));
    assert.ok(backend.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_period_suspensions'"));
    assert.ok(backend.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_art_cost_observation_attempts'"));
    for (const name of ['backend_art_cost_attempt_lookup', 'backend_art_cost_attempt_identity_immutable', 'backend_art_cost_attempt_no_delete']) {
      assert.ok(backend.store.get('SELECT 1 FROM sqlite_master WHERE name=?', name), `art observation schema object ${name} is installed`);
    }
    assert.equal(backend.supervisor.suspendOwner instanceof Function, true);
  } finally {
    await backend.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native recovery import preserves typed health diagnostics through the local log schema and stays idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-native-recovery-import-'));
  const deviceProfilePath = path.join(root, 'device-profile.json');
  fs.writeFileSync(deviceProfilePath, '{}', { mode: 0o600 });
  const backend = createBackend({ dataDir: path.join(root, 'data'), deviceProfilePath, credentialKey: '0'.repeat(64), baseUrl: 'https://service.example.invalid/backend-v2' });
  try {
    const event = { eventId: 'a98f3431-1893-481f-9d36-6dbecc7ea13e', cause: 'health_http_invalid', attempt: 2,
      eventTimeMs: 1793019000000, oldGeneration: '88716f3a-38bf-4d85-a801-26d9edb3884d', ownerRef: 'owner:test',
      eventState: 'incomplete', phase: '官服账号认证', method: 'GET', sourceNamespace: 'engine-health', httpStatus: 503,
      readFailureKind: 'SocketTimeoutException', retryAtMs: 1793019030000 };
    assert.deepEqual(backend.importNativeRecoveryEvents([event]), { acceptedIds: [event.eventId] });
    const row = backend.store.get("SELECT detail_json FROM backend_local_logs WHERE event_ref=?", `native-recovery:${event.eventId}`);
    const detail = JSON.parse(row.detail_json);
    assert.deepEqual({ eventState: detail.eventState, phase: detail.phase, method: detail.method,
      sourceNamespace: detail.sourceNamespace, httpStatus: detail.httpStatus, readFailureKind: detail.readFailureKind,
      retryAtMs: detail.retryAtMs }, { eventState: 'incomplete', phase: 'v5-account-auth', method: 'GET',
      sourceNamespace: 'engine-health', httpStatus: 503, readFailureKind: 'SocketTimeoutException', retryAtMs: 1793019030000 });
    assert.deepEqual(backend.importNativeRecoveryEvents([event]), { acceptedIds: [event.eventId] });
    const legacy = { eventId: 'fa20f89e-6b19-4ca3-af9d-17f50667cbcf', cause: 'health_mismatch', attempt: 1,
      eventTimeMs: 1793019001000, oldGeneration: 'a8aef18e-35a6-44da-9311-1cd125f2d2c7', ownerRef: 'owner:test' };
    assert.deepEqual(backend.importNativeRecoveryEvents([legacy]), { acceptedIds: [legacy.eventId] });
    const legacyRow = backend.store.get("SELECT detail_json FROM backend_local_logs WHERE event_ref=?", `native-recovery:${legacy.eventId}`);
    const legacyDetail = JSON.parse(legacyRow.detail_json);
    for (const key of ['eventState','phase','method','sourceNamespace']) assert.equal(Object.hasOwn(legacyDetail, key), false);
  } finally {
    await backend.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
