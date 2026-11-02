import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedReadMemo } from '../runtime/backend/persistence/verified-read-memo.mjs';

test('exact read dependencies invalidate on changed bytes, newly present rows and external validation key', () => {
  const rows = new Map([['proof', { ref: 'p', json: '{"value":1}' }]]);
  const store = { get: (sql, key) => rows.get(key) ?? null, all: () => [...rows.values()] };
  const cache = createVerifiedReadMemo(store); let calculations = 0;
  const check = key => cache.memo(key, () => {
    calculations++;
    const row = cache.store.get('proof SQL', 'proof'), absent = cache.store.get('missing SQL', 'later');
    cache.store.all('all SQL');
    return { allowed: JSON.parse(row.json).value === 1 && !absent };
  });
  assert.equal(check('validated:1').allowed, true); assert.equal(check('validated:1').allowed, true);
  assert.equal(calculations, 1);
  rows.set('proof', { ref: 'p', json: '{"value":2}' });
  assert.equal(check('validated:1').allowed, false); assert.equal(calculations, 2);
  rows.set('proof', { ref: 'p', json: '{"value":1}' }); rows.set('later', { ref: 'new', json: '{}' });
  assert.equal(check('validated:1').allowed, false); assert.equal(calculations, 3);
  check('validated:2'); assert.equal(calculations, 4);
  assert.throws(() => { check('validated:2').allowed = true; }, TypeError);
});

test('oversized results and thrown checks are never retained', () => {
  const cache = createVerifiedReadMemo({ get: () => null, all: () => [] }, { maxBytes: 200 }); let count = 0;
  for (let i = 0; i < 2; i++) cache.memo('big', () => { count++; return 'x'.repeat(300); });
  assert.equal(count, 2);
  for (let i = 0; i < 2; i++) assert.throws(() => cache.memo('bad', () => { count++; throw Error('corrupt'); }));
  assert.equal(count, 4);
});
