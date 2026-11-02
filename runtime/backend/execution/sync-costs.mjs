const labels = new Set(['gateway.check','gateway.context','gateway.source','gateway.descriptor','gateway.reservation',
  'gateway.factBasis','gateway.factHash','gateway.admission','gateway.qualification','delivery.root-hit','delivery.historical-source']);
const byStore = new WeakMap();
export function measureSyncCost(store, label, action) {
  if (process.env.GARDEN_DEBUG_TOOLS !== '1' || !labels.has(label)) return action();
  const start = process.hrtime.bigint();
  try { return action(); }
  finally {
    let costs = byStore.get(store); if (!costs) { costs = new Map(); byStore.set(store, costs); }
    const row = costs.get(label) || { label, calls: 0, totalMs: 0, maximumMs: 0 }, ms = Number(process.hrtime.bigint() - start) / 1e6;
    row.calls++; row.totalMs += ms; row.maximumMs = Math.max(row.maximumMs, ms); costs.set(label, row);
  }
}
export function syncCosts(store, reset = false) {
  const rows = [...(byStore.get(store)?.values() || [])].map(row => ({ ...row,
    totalMs: Math.round(row.totalMs * 1000) / 1000, maximumMs: Math.round(row.maximumMs * 1000) / 1000 }));
  if (reset) byStore.delete(store);
  return { version: 'bounded-sync-costs/v1', labelLimit: labels.size, rows, reset };
}
