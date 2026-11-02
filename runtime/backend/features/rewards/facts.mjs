import { canonical, fingerprint, freeze, problem } from '../../common.mjs';
import { CLAIM_WIRE } from './wire.mjs';

const STATUS_METHODS = new Set(['index.login', 'mail.getList', 'mail.pickOneKey', 'benefitBox.draw', 'taskDly.recv',
  'taskDly.recvBox', 'taskWeek.recv', 'usr.share', 'taskMain.recv', 'storyMain.unlock', 'fml.bld', 'fmlLand.harvestAll',
  'fmlLand.plant', 'fmlLand.unlock', 'fmlLand.upgrade', 'cultivate.upgrade', 'shopCultivate.buy', 'shopCultivate.refresh']);

export function createRewardClaimFacts({ store, isCurrent, officialUidForContext } = {}) {
  const { run, get, all, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_reward_claim_receipts(
    response_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    method TEXT NOT NULL,operation_id TEXT,domains_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
    received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_reward_claim_receipts_no_update BEFORE UPDATE ON backend_reward_claim_receipts
      BEGIN SELECT RAISE(ABORT,'reward claim receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_reward_claim_receipts_no_delete BEFORE DELETE ON backend_reward_claim_receipts
      BEGIN SELECT RAISE(ABORT,'reward claim receipts are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_reward_claim_heads(
      owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,domain_key TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,
      source_method TEXT NOT NULL,request_sequence INTEGER NOT NULL,value_json TEXT NOT NULL,value_fingerprint TEXT NOT NULL,
      received_device_ms INTEGER NOT NULL,received_monotonic_ms REAL NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,domain_key));
    CREATE TRIGGER IF NOT EXISTS backend_reward_claim_heads_no_delete BEFORE DELETE ON backend_reward_claim_heads
      BEGIN SELECT RAISE(ABORT,'reward claim heads are retained'); END;`);
  const domains = Object.keys(CLAIM_WIRE);
  function decode(observation, expectedUid) {
    if (!observation || observation.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
        observation.dsName !== 'G.ISyncData' || !STATUS_METHODS.has(observation.method) || !Number.isSafeInteger(observation.requestSequence) ||
        observation.requestSequence < 1 || typeof observation.responseRef !== 'string' || !observation.responseRef) return null;
    const values = {}, presence = [];
    for (const domain of domains) {
      let decoded;
      try { decoded = CLAIM_WIRE[domain](observation.value); } catch { continue; }
      if (!decoded?.present) continue;
      presence.push(domain);
      if (domain === 'reward-mail' && !decoded.listPresent) continue;
      if (domain === 'reward-tasks' && !decoded.daily && !decoded.weekly && !decoded.main) continue;
      values[domain] = decoded;
    }
    if (!presence.length) return null;
    const source = { method: observation.method, responseRef: observation.responseRef, requestSequence: observation.requestSequence,
      wireKey: observation.wireKey ?? null, connectionEpoch: observation.connectionEpoch,
      receivedDeviceMs: observation.receivedDeviceMs, receivedMonotonicMs: observation.receivedMonotonicMs,
      operationId: observation.operationId ?? null, officialUid: expectedUid ?? null };
    return { values, presence, valueFingerprint: fingerprint(values), source };
  }
  function ingest({ context, observation, officialUid = null } = {}) {
    const uid = Number.isSafeInteger(officialUid) && officialUid > 0 ? officialUid : officialUidForContext?.(context);
    const decoded = decode(observation, uid);
    const src = decoded?.source;
    if (!decoded || !context || !isCurrent(context) || src.connectionEpoch !== context.connectionEpoch ||
        !Number.isSafeInteger(src.requestSequence) || src.requestSequence <= 0 || !Number.isSafeInteger(src.receivedDeviceMs) ||
        !Number.isFinite(src.receivedMonotonicMs)) return { accepted: false, changed: false, reasonCode: 'REWARD_SOURCE_NOT_CURRENT' };
    const domainsJson = canonical(decoded.values), prior = get('SELECT * FROM backend_reward_claim_receipts WHERE response_ref=?', src.responseRef);
    if (prior && (prior.owner_ref !== context.ownerRef || prior.account_ref !== String(context.accountRef) || prior.subject_ref !== context.subjectRef ||
        prior.owner_epoch !== context.ownerEpoch || prior.run_epoch !== context.runEpoch || prior.connection_epoch !== context.connectionEpoch ||
        prior.request_sequence !== src.requestSequence || prior.method !== src.method || prior.value_fingerprint !== decoded.valueFingerprint))
      throw problem('REWARD_RECEIPT_CONFLICT', '同一官服回包引用对应了不同奖励事实', 409);
    const before = {};
    for (const domain of Object.keys(decoded.values)) before[domain] = get('SELECT * FROM backend_reward_claim_heads WHERE owner_ref=? AND subject_ref=? AND domain_key=?',
      context.ownerRef, context.subjectRef, domain);
    transaction(() => {
      run(`INSERT OR IGNORE INTO backend_reward_claim_receipts(response_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,
        connection_epoch,request_sequence,method,operation_id,domains_json,value_fingerprint,received_device_ms,received_monotonic_ms,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, src.responseRef, context.ownerRef, String(context.accountRef), context.subjectRef,
      context.ownerEpoch, context.runEpoch, context.connectionEpoch, src.requestSequence, src.method, src.operationId, domainsJson,
      decoded.valueFingerprint, src.receivedDeviceMs, src.receivedMonotonicMs, nowIso());
      for (const [domain, value] of Object.entries(decoded.values)) {
        const old = before[domain];
        const newer = !old || old.account_ref !== String(context.accountRef) || old.owner_epoch !== context.ownerEpoch ||
          old.run_epoch !== context.runEpoch || old.connection_epoch < context.connectionEpoch ||
          old.connection_epoch === context.connectionEpoch && old.request_sequence < src.requestSequence;
        if (!newer) continue;
        run(`INSERT INTO backend_reward_claim_heads(owner_ref,account_ref,subject_ref,domain_key,owner_epoch,run_epoch,connection_epoch,
          response_ref,source_method,request_sequence,value_json,value_fingerprint,received_device_ms,received_monotonic_ms,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,domain_key) DO UPDATE SET
          account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,connection_epoch=excluded.connection_epoch,
          response_ref=excluded.response_ref,source_method=excluded.source_method,request_sequence=excluded.request_sequence,
          value_json=excluded.value_json,value_fingerprint=excluded.value_fingerprint,received_device_ms=excluded.received_device_ms,
          received_monotonic_ms=excluded.received_monotonic_ms,updated_at=excluded.updated_at`, context.ownerRef, String(context.accountRef),
        context.subjectRef, domain, context.ownerEpoch, context.runEpoch, context.connectionEpoch, src.responseRef, src.method,
        src.requestSequence, canonical(value), fingerprint(value), src.receivedDeviceMs, src.receivedMonotonicMs, nowIso());
      }
    });
    const changed = Object.keys(decoded.values).some(domain => {
      const old = before[domain];
      if (!old) return true;
      return old.value_fingerprint !== fingerprint(decoded.values[domain]);
    });
    return { accepted: true, changed, domains: Object.keys(decoded.values), responseRef: src.responseRef };
  }
  function read(context, { maxAgeMs = 120000 } = {}) {
    if (!context || !isCurrent(context)) return { current: false, reasonCode: 'REWARD_CONTEXT_STALE', values: {}, sources: {} };
    const rows = all('SELECT * FROM backend_reward_claim_heads WHERE owner_ref=? AND subject_ref=? ORDER BY domain_key',
      context.ownerRef, context.subjectRef);
    const values = {}, sources = {};
    const now = Number(process.hrtime.bigint()) / 1_000_000;
    for (const row of rows) {
      if (row.account_ref !== String(context.accountRef) || row.owner_epoch !== context.ownerEpoch ||
          row.run_epoch !== context.runEpoch || row.connection_epoch !== context.connectionEpoch ||
          now - row.received_monotonic_ms > maxAgeMs) continue;
      let value;
      try { value = JSON.parse(row.value_json); } catch { return { current: false, reasonCode: 'REWARD_FACTS_INVALID', values: {}, sources: {} }; }
      if (fingerprint(value) !== row.value_fingerprint) return { current: false, reasonCode: 'REWARD_FACTS_INVALID', values: {}, sources: {} };
      values[row.domain_key] = value;
      sources[row.domain_key] = { responseRef: row.response_ref, method: row.source_method, connectionEpoch: row.connection_epoch,
        requestSequence: row.request_sequence, receivedDeviceMs: row.received_device_ms, receivedMonotonicMs: row.received_monotonic_ms };
    }
    if (!Object.keys(sources).length) return { current: false, reasonCode: 'REWARD_FACTS_NOT_CURRENT', values: {}, sources: {} };
    return freeze({ current: true, values, sources, fingerprint: fingerprint({ values, sources }) });
  }
  return Object.freeze({ ingest, read, domains: Object.freeze(domains) });
}