// Shared RAM budget for immutable source views, never admission or outcomes.
// Clients must read their durable source and live context afresh before every
// get, then provide the exact primitive source signature. A miss is ordinary
// reconstruction; eviction cannot change business state or send permission.
const caches = new WeakMap();
const GLOBAL_BYTES = 128 * 1024 * 1024, SUBJECT_BYTES = 40 * 1024 * 1024, MAX_ENTRIES = 96, MAX_SUBJECTS = 32;

function cacheFor(store) {
  let state = caches.get(store);
  if (!state) { state = { entries: new Map(), scopes: new Map(), clients: new Map(), bytes: 0, nextClient: 0 }; caches.set(store, state); }
  return state;
}
function remove(state, key) {
  const row = state.entries.get(key);
  if (!row) return;
  state.entries.delete(key); state.bytes -= row.bytes;
  const remaining = state.scopes.get(row.scope) - row.bytes;
  if (remaining > 0) state.scopes.set(row.scope, remaining); else state.scopes.delete(row.scope);
}
export function createSnapshotCacheClient(store, name) {
  const state = cacheFor(store), id = ++state.nextClient, metrics = { name, hits: 0, misses: 0, oversize: 0 };
  state.clients.set(id, metrics); let disposed = false;
  const dropScope = scope => { for (const [key, row] of state.entries) if (row.client === id && row.scope === scope) remove(state, key); };
  function get(key, signature) {
    if (disposed) return null;
    const fullKey = id + ':' + key, row = state.entries.get(fullKey);
    if (!row || signature.length !== row.signature.length || signature.some((value, index) => value !== row.signature[index])) {
      if (row) remove(state, fullKey); metrics.misses++; return null;
    }
    state.entries.delete(fullKey); state.entries.set(fullKey, row); metrics.hits++; return row.value;
  }
  function put({ key, scope, signature, sourceBytes, value }) {
    if (disposed) return;
    if (typeof key !== 'string' || typeof scope !== 'string' || !Array.isArray(signature) || signature.some(one =>
      one !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof one)) || !Number.isSafeInteger(sourceBytes) || sourceBytes < 0 ||
        !value || typeof value !== 'object' || !Object.isFrozen(value)) throw new TypeError('Immutable snapshot cache contract is invalid');
    // Conservative estimate for retained strings and expanded object graph.
    const bytes = sourceBytes * 6 + 1024;
    dropScope(scope); // One view per client and real subject, across aliases.
    if (bytes > SUBJECT_BYTES) { metrics.oversize++; return; }
    for (const [oldKey, row] of state.entries) {
      if ((state.scopes.get(scope) || 0) + bytes <= SUBJECT_BYTES) break;
      if (row.scope === scope) remove(state, oldKey);
    }
    while (state.entries.size && (state.bytes + bytes > GLOBAL_BYTES || state.entries.size >= MAX_ENTRIES ||
        !state.scopes.has(scope) && state.scopes.size >= MAX_SUBJECTS)) remove(state, state.entries.keys().next().value);
    state.entries.set(id + ':' + key, { client: id, scope, signature: [...signature], value, bytes });
    state.bytes += bytes; state.scopes.set(scope, (state.scopes.get(scope) || 0) + bytes);
  }
  function dispose() {
    for (const [key, row] of state.entries) if (row.client === id) remove(state, key);
    state.clients.delete(id); disposed = true;
  }
  return Object.freeze({ get, put, dropScope, dispose });
}
export function snapshotCacheStats(store) {
  const state = caches.get(store);
  return { limits: { globalEstimatedBytes: GLOBAL_BYTES, perSubjectEstimatedBytes: SUBJECT_BYTES, entries: MAX_ENTRIES, subjects: MAX_SUBJECTS },
    estimatedBytes: state?.bytes || 0, entries: state?.entries.size || 0, subjects: state?.scopes.size || 0,
    largestSubjectEstimatedBytes: state ? Math.max(0, ...state.scopes.values()) : 0,
    clients: state ? [...state.clients.entries()].map(([id, metrics]) => ({ ...metrics,
      entries: [...state.entries.values()].filter(row => row.client === id).length })) : [] };
}
