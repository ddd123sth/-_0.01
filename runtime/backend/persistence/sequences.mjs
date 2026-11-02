// Counters are recovery roots, not caches. Seed from legacy history only once,
// then allocate within the caller's transaction so rollback also rolls back IDs.
export function createDurableSequences(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_durable_sequences(
    namespace TEXT NOT NULL,scope_key TEXT NOT NULL,value INTEGER NOT NULL
    CHECK(value>=0 AND value<=9007199254740991),PRIMARY KEY(namespace,scope_key))`);
  function current(namespace, scope, legacySeed = () => 0) {
    const key = JSON.stringify(scope);
    let row = store.get('SELECT value FROM backend_durable_sequences WHERE namespace=? AND scope_key=?', namespace, key);
    if (!row) {
      const seed = legacySeed();
      if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError('Invalid durable sequence seed');
      store.run('INSERT OR IGNORE INTO backend_durable_sequences VALUES(?,?,?)', namespace, key, seed);
      row = store.get('SELECT value FROM backend_durable_sequences WHERE namespace=? AND scope_key=?', namespace, key);
    }
    return row.value;
  }
  function next(namespace, scope, legacySeed) {
    return store.transaction(() => {
      const value = current(namespace, scope, legacySeed);
      if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new RangeError('Durable sequence exhausted');
      store.run('UPDATE backend_durable_sequences SET value=? WHERE namespace=? AND scope_key=?', value + 1, namespace, JSON.stringify(scope));
      return value + 1;
    });
  }
  return Object.freeze({ current, next });
}
