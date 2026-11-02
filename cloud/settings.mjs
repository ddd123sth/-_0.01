// Settings table acts as a per-key override of the environment defaults.
function readSetting(store, key) {
  const row = store.get('SELECT value FROM settings WHERE key=?', key);
  return row ? row.value : undefined;
}
function writeSetting(store, key, value) {
  store.run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  key, String(value), store.nowIso());
}

export function getSettings(store, config) {
  const allowRaw = readSetting(store, 'allowRegistration');
  const allowRegistration = allowRaw === undefined ? true : allowRaw === 'true';
  const normalRaw = readSetting(store, 'retentionNormalDays');
  const errorRaw = readSetting(store, 'retentionErrorDays');
  const toInt = (raw, def) => {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 3650 ? value : def;
  };
  return {
    allowRegistration,
    retention: {
      normalDays: toInt(normalRaw, config.retentionNormalDays),
      errorDays: toInt(errorRaw, config.retentionErrorDays),
    },
  };
}

export function setAllowRegistration(store, value) { writeSetting(store, 'allowRegistration', value ? 'true' : 'false'); }
export function setRetention(store, retention) {
  if (retention.normalDays !== undefined) writeSetting(store, 'retentionNormalDays', retention.normalDays);
  if (retention.errorDays !== undefined) writeSetting(store, 'retentionErrorDays', retention.errorDays);
}
