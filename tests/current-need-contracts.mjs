import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDeclaredCurrentNeed } from '../runtime/backend/execution/gateway.mjs';
import { createFeatureRegistry } from '../runtime/backend/registry/index.mjs';

test('operation declarations require a claimed need when required and allow declared land/auxiliary paths', () => {
  assert.throws(() => validateDeclaredCurrentNeed({ proposal: { method: 'orderCustomer.finishOrder' },
    declaration: { path: 'customer.currentNeed', required: true } }), { code: 'WRITE_CURRENT_NEED_REQUIRED' });
  assert.throws(() => validateDeclaredCurrentNeed({ proposal: { art: { currentNeed: { necessary: true } } },
    declaration: { path: 'customer.currentNeed', required: true } }), { code: 'WRITE_CURRENT_NEED_CONTRACT_CONFLICT' });
  assert.deepEqual(validateDeclaredCurrentNeed({ proposal: { method: 'usrLand.plant' },
    declaration: { path: 'land.currentNeed', required: false } }), null);
  assert.deepEqual(validateDeclaredCurrentNeed({ proposal: { method: 'orderFlower.enter', orderFlowerEnter: { currentNeed: { necessary: true } } },
    declaration: { path: 'orderFlowerEnter.currentNeed', required: false } }), { necessary: true });
});

test('registry rejects missing, asynchronous, and undeclared current-need consumers', () => {
  const makeRegistry = () => createFeatureRegistry();
  const definition = overrides => ({ featureId: 'art.make', label: 'test', phase: 'test', release: 'validation-only',
    implementationVersion: 'test/v1', contractRef: 'test/current-need', methods: ['flowerArt.makeFlowerArt'],
    scopes: ['flower-art-make'], consumedDomains: ['art-inputs'], assess() {}, qualify() {}, verify() {},
    currentNeedContracts: { 'flowerArt.makeFlowerArt': { path: 'art.currentNeed', required: true } }, ...overrides });
  assert.throws(() => makeRegistry().register(definition({})), { code: 'FEATURE_CURRENT_NEED_CONTRACT_INVALID' });
  assert.throws(() => makeRegistry().register(definition({ consumeCurrentNeed: async () => ({ accepted: true }) })),
    { code: 'FEATURE_CURRENT_NEED_CONTRACT_INVALID' });
  assert.throws(() => makeRegistry().register(definition({ currentNeedContracts: { 'orderFlower.enter': { path: 'art.currentNeed', required: true },
    'flowerArt.makeFlowerArt': { path: 'art.currentNeed', required: true } }, consumeCurrentNeed() {} })),
    { code: 'FEATURE_CURRENT_NEED_CONTRACT_INVALID' });
  assert.doesNotThrow(() => makeRegistry().register(definition({ consumeCurrentNeed() {} })));
  assert.throws(() => makeRegistry().register(definition({ currentNeedContracts: { 'flowerArt.makeFlowerArt': { path: 'art.currentNeed', required: false } },
    consumeCurrentNeed: async () => null })), { code: 'FEATURE_CURRENT_NEED_CONTRACT_INVALID' });
});
