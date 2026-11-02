import { canonical, parseStored, problem } from '../common.mjs';

// Device route is an encrypted setting. It never carries login or business
// policy, and the public DTO deliberately contains no proxy authentication.
export function createDeviceEgress({ store, cipher, assertStopped }) {
  function parse(value) {
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw problem('EGRESS_CONFIG_INVALID', '出口地址格式不正确', 400);
    const text = value.trim();
    if (!text) return { proxy: '', parsed: null };
    try {
      const url = new URL(text.includes('://') ? text : 'http://' + text);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || url.pathname !== '/') throw new Error();
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
      return { proxy: url.href, parsed: url };
    } catch { throw problem('EGRESS_CONFIG_INVALID', '请填写HTTP或HTTPS CONNECT出口地址，清空表示本机直连', 400); }
  }
  function read() {
    const row = store.get("SELECT value_cipher,updated_at FROM backend_device_settings WHERE key='egress'");
    if (!row) return { proxy: '', parsed: null, hasOverride: false, updatedAt: null };
    try {
      const value = parseStored(cipher.decrypt(row.value_cipher), '出口密文');
      if (value.schemaVersion !== 1 || typeof value.proxy !== 'string' || Object.keys(value).some(key => !['schemaVersion', 'proxy'].includes(key))) throw new Error();
      return { ...parse(value.proxy), hasOverride: true, updatedAt: row.updated_at };
    } catch { throw problem('EGRESS_STORED_UNREADABLE', '出口密文无法读取，连接已保留停止状态，请重新保存出口设置', 503); }
  }
  function view(value) {
    return { hasOverride: value.hasOverride, configured: Boolean(value.proxy), routing: value.proxy ? 'proxy' : 'direct',
      display: value.parsed ? value.parsed.protocol + '//' + value.parsed.hostname + ':' + (value.parsed.port || (value.parsed.protocol === 'https:' ? 443 : 80)) : '',
      updatedAt: value.updatedAt };
  }
  function save(input) {
    if (!input || Array.isArray(input) || typeof input.proxy !== 'string' || Object.keys(input).some(key => key !== 'proxy')) throw problem('EGRESS_CONFIG_INVALID', '出口设置格式不正确', 400);
    const value = parse(input.proxy);
    return store.transaction(() => {
      assertStopped();
      const updatedAt = store.nowIso(), ciphertext = cipher.encrypt(canonical({ schemaVersion: 1, proxy: value.proxy }));
      store.run(`INSERT INTO backend_device_settings VALUES('egress',?,?) ON CONFLICT(key) DO UPDATE SET value_cipher=excluded.value_cipher,updated_at=excluded.updated_at`, ciphertext, updatedAt);
      return view({ ...value, hasOverride: true, updatedAt });
    });
  }
  return Object.freeze({ proxy: () => read().proxy, publicSettings: () => view(read()), save });
}
