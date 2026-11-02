import { canonical, clone, freeze, newId, parseStored, plainObject, problem, requireText } from '../common.mjs';
import { readLinuxProcessIdentity } from './native-executor-identity.mjs';

const VERSION = 'backend/readonly-inspection/v1';
const SYNC_TYPE = 'G.ISyncData';
const DEFAULT_PATHS = Object.freeze(['100.0.1', '100.1', '101.0', '7.0.32', '7.2.2', '7.2.0', '7.2.1', '7.3.flowerPlantTop.2.2']);
const ALIASES = Object.freeze({ 'land.reportedLandMap': '100.0.1', 'land.changedLandMap': '100.1',
  'land.harvestMap': '100.2', 'cultivation.reportedCultivateMap': '101.0', 'inventory.bag': '7.0.32',
  'inventory.absoluteUpdates': '7.2.2', 'inventory.gains': '7.2.0', 'inventory.spends': '7.2.1',
  'plant.topFlowerIds': '7.3.flowerPlantTop.2.2', 'profile.uid': '7.0.0', 'profile.nickname': '7.0.5',
  'profile.level': '7.0.34', 'profile.gold': '7.0.44', 'profile.yuanbao': '7.0.41', 'clock.serverMs': '2.3' });
const NUMERIC_PROFILE = Object.freeze({ uid: '0', level: '34', gold: '44', yuanbao: '41' });
const LAND_FIELDS = Object.freeze({ flowerId: '0', state: '1', level: '2', harvestCount: '3', nextTime: '5', elvesId: '6', plantTime: '7' });
const POSITIVE_KEY = /^[1-9]\d*$/;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'INSPECTION_FAILED';
const monotonic = () => Number(process.hrtime.bigint()) / 1000000;
const numericMap = value => plainObject(value) && Object.keys(value).every(key => POSITIVE_KEY.test(key) && positive(Number(key)));
const clippedName = value => value.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, '[已隐去]').slice(0, 80);

function at(value, path) {
  let node = value;
  for (const key of path.split('.')) {
    if (!plainObject(node) || !Object.hasOwn(node, key)) return { state: 'absent', value: null };
    node = node[key];
  }
  return { state: node === null ? 'null' : 'present', value: node };
}
function timestamp(value) {
  if (positive(value)) return { state: 'read', value };
  if (value === 0) return { state: 'zero', value: 0 };
  if (value === null) return { state: 'null', value: null };
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    const parsed = Date.parse(value);
    if (positive(parsed) && new Date(parsed).toISOString() === value) return { state: 'read', value: parsed };
  }
  return { state: 'unreadable', value: null };
}
function field(row, key, validator = nonnegative, date = false) {
  if (!Object.hasOwn(row, key)) return { state: 'absent', value: null };
  if (row[key] === null) return { state: 'null', value: null };
  return date ? timestamp(row[key]) : validator(row[key]) ? { state: 'read', value: row[key] } : { state: 'unreadable', value: null };
}
function landRow(id, row) {
  if (!plainObject(row)) return { landId: Number(id), state: 'unreadable', fields: null };
  const fields = {};
  for (const [name, key] of Object.entries(LAND_FIELDS)) fields[name] = field(row, key,
    name === 'state' ? value => nonnegative(value) && value <= 3 : nonnegative, name === 'nextTime' || name === 'plantTime');
  return { landId: Number(id), state: 'read', emptyObject: Object.keys(row).length === 0, fields };
}
function boundedMap(map, limit, projector) {
  if (!numericMap(map)) return { state: 'unreadable', value: null };
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  return { state: 'read', value: { total: keys.length, returned: Math.min(limit, keys.length), truncated: keys.length > limit,
    reportedEmpty: keys.length === 0, coverageKind: 'provided-map-only', entries: keys.slice(0, limit).map(key => projector(key, map[key])) } };
}
function countMap(map, limit = 256) {
  return boundedMap(map, limit, (id, value) => ({ itemId: Number(id), state: nonnegative(value) ? 'read' : 'unreadable', value: nonnegative(value) ? value : null }));
}
function allowedPath(path) {
  return DEFAULT_PATHS.includes(path) || ['100.2', '7.0.0', '7.0.5', '7.0.34', '7.0.44', '7.0.41', '2.3'].includes(path)
    || /^(100\.0\.1|100\.1)\.[1-9]\d*(\.[0123567])?$/.test(path)
    || /^101\.0\.[1-9]\d*(\.[124])?$/.test(path)
    || /^(7\.0\.32|7\.2\.[012])\.[1-9]\d*$/.test(path)
    || /^100\.2\.[1-9]\d*(\.[1-9]\d*)?$/.test(path);
}
function normalizePaths(paths) {
  const values = paths === undefined ? [...DEFAULT_PATHS] : paths;
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) throw problem('INSPECTION_PATHS_INVALID', '只读检查须选择1至16个已登记安全路径', 400);
  const result = [];
  for (const input of values) {
    const path = ALIASES[input] || input;
    if (typeof path !== 'string' || path.length > 100 || !allowedPath(path)
      || path.split('.').some(key => /^\d+$/.test(key) && !nonnegative(Number(key)))) throw problem('INSPECTION_PATH_NOT_ALLOWED', '请求路径未登记为公开只读事实', 400);
    if (!result.includes(path)) result.push(path);
  }
  return result;
}
function projectPath(value, path) {
  const found = at(value, path);
  if (found.state !== 'present') return found;
  const raw = found.value;
  if (path === '100.0.1' || path === '100.1') return boundedMap(raw, 64, landRow);
  if (/^(100\.0\.1|100\.1)\.[1-9]\d*$/.test(path)) return { state: plainObject(raw) ? 'read' : 'unreadable', value: plainObject(raw) ? landRow(path.split('.').at(-1), raw) : null };
  if (path === '101.0') return boundedMap(raw, 256, (id, row) => ({ flowerId: Number(id), state: plainObject(row) ? 'read' : 'unreadable',
    fields: plainObject(row) ? { flowerId: field(row, '1', positive), level: field(row, '2', positive), status: field(row, '4') } : null }));
  if (/^101\.0\.[1-9]\d*$/.test(path)) return { state: plainObject(raw) ? 'read' : 'unreadable', value: plainObject(raw)
    ? { flowerId: field(raw, '1', positive), level: field(raw, '2', positive), status: field(raw, '4') } : null };
  if (path === '100.2') return boundedMap(raw, 64, (id, counts) => ({ landId: Number(id), protocolRole: 'unverified-harvest-map', ...countMap(counts, 32) }));
  if (/^100\.2\.[1-9]\d*$/.test(path)) return { ...countMap(raw, 32), protocolRole: 'unverified-harvest-map' };
  if (['7.0.32', '7.2.0', '7.2.1', '7.2.2'].includes(path)) return countMap(raw);
  if (path === '7.3.flowerPlantTop.2.2') {
    const valid = Array.isArray(raw) && raw.every(positive);
    return { state: valid ? 'read' : 'unreadable', value: valid ? { total: raw.length, returned: Math.min(256, raw.length),
      truncated: raw.length > 256, reportedEmpty: raw.length === 0, flowerIds: raw.slice(0, 256) } : null };
  }
  if (path === '7.0.5') return { state: typeof raw === 'string' ? 'read' : 'unreadable', value: typeof raw === 'string' ? clippedName(raw) : null };
  if (path === '7.0.0' || path === '2.3' || /^101\.0\.[1-9]\d*\.[12]$/.test(path)) return { state: positive(raw) ? 'read' : 'unreadable', value: positive(raw) ? raw : null };
  if (/^(100\.0\.1|100\.1)\.[1-9]\d*\.[57]$/.test(path)) return timestamp(raw);
  if (/^(100\.0\.1|100\.1)\.[1-9]\d*\.1$/.test(path)) return { state: nonnegative(raw) && raw <= 3 ? 'read' : 'unreadable', value: nonnegative(raw) && raw <= 3 ? raw : null };
  return { state: nonnegative(raw) ? 'read' : 'unreadable', value: nonnegative(raw) ? raw : null };
}
function diagnostic(error, stage) {
  const out = { stage, code: safeCode(error?.code) };
  if (Number.isSafeInteger(error?.remoteCode)) out.remoteCode = error.remoteCode;
  if (typeof error?.remoteKey === 'string' && /^\$?[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.remoteKey)) out.remoteKey = error.remoteKey;
  if (typeof error?.envelopeReason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.envelopeReason)) out.envelopeReason = error.envelopeReason;
  return out;
}

export function createReadOnlyInspection({ store, authorizeOwner, assertSubjectStoppedAndIsolated, connectGame,
  credentials, proxy = () => '', deviceProfilePath, onObservation = null, cleanupTimeoutMs = 12000 } = {}) {
  if (!store?.transaction || !store?.run || !store?.get || !store?.all || !store?.db?.exec
    || [authorizeOwner, assertSubjectStoppedAndIsolated, connectGame, credentials, proxy, deviceProfilePath].some(fn => typeof fn !== 'function')
    || onObservation !== null && typeof onObservation !== 'function' || !positive(cleanupTimeoutMs) || cleanupTimeoutMs > 60000) {
    throw new TypeError('Read-only inspection requires explicit owner, isolation and private connection dependencies');
  }
  const { run, get, all, transaction, nowIso } = store;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS backend_read_inspections(
      inspection_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
      identity_epoch INTEGER NOT NULL,connection_epoch INTEGER,stage TEXT NOT NULL,code TEXT,
      summary_json TEXT NOT NULL,isolation_json TEXT,cleanup_complete INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT);
    CREATE INDEX IF NOT EXISTS backend_read_inspection_owner ON backend_read_inspections(owner_ref,account_ref,started_at);
    CREATE TABLE IF NOT EXISTS backend_read_inspection_slots(
      subject_ref TEXT PRIMARY KEY,inspection_id TEXT NOT NULL UNIQUE,instance_ref TEXT NOT NULL,pid INTEGER NOT NULL,
      process_start_token TEXT,created_at TEXT NOT NULL,process_boot_id TEXT);
    CREATE TABLE IF NOT EXISTS backend_subject_connection_epochs(subject_ref TEXT PRIMARY KEY,connection_epoch INTEGER NOT NULL);`);
  // Preserve existing slots when upgrading the initial schema. Their unknown
  // tokens remain NULL; neither a timeout nor a new PID may fill that evidence.
  if (!all('PRAGMA table_info(backend_read_inspection_slots)').some(column => column.name === 'process_start_token')) {
    run('ALTER TABLE backend_read_inspection_slots ADD COLUMN process_start_token TEXT');
  }
  if (!all('PRAGMA table_info(backend_read_inspection_slots)').some(column => column.name === 'process_boot_id')) {
    run('ALTER TABLE backend_read_inspection_slots ADD COLUMN process_boot_id TEXT');
  }
  const processIdentity = readLinuxProcessIdentity(process.pid), instanceRef = newId(),
    processStartToken = processIdentity.state === 'present' ? processIdentity.startToken : null,
    processBootId = processIdentity.state === 'present' ? processIdentity.bootId : null, active = new Map();

  function authorize(input, expected = null) {
    const authorization = authorizeOwner({ ownerRef: input.ownerRef, accountRef: input.accountRef, subjectRef: input.subjectRef ?? null,
      inspectionId: input.inspectionId ?? null, purpose: 'read-only-inspection', expectedIdentityEpoch: expected?.identityEpoch ?? null });
    if (authorization && typeof authorization.then === 'function') throw problem('INSPECTION_AUTH_MUST_BE_SYNC', '只读检查归属栅栏必须同步核实', 500);
    if (!plainObject(authorization) || authorization.authorized !== true || authorization.ownerRef !== input.ownerRef
      || !nonnegative(authorization.identityEpoch) || expected && authorization.identityEpoch !== expected.identityEpoch) {
      throw problem('INSPECTION_OWNER_REVOKED', '只读检查的软件归属或身份代际已改变', 403);
    }
    return { ownerRef: input.ownerRef, identityEpoch: authorization.identityEpoch };
  }
  function account(ownerRef, accountRef) {
    const row = get(`SELECT account_id,owner_ref,subject_ref,server_id,profile_json FROM backend_accounts
      WHERE owner_ref=? AND account_id=? AND removed_at IS NULL`, ownerRef, Number(accountRef));
    if (!row) throw problem('ACCOUNT_NOT_FOUND', '找不到这个软件身份下的游戏号', 404);
    return row;
  }
  function assertNoActor(subjectRef) {
    if (get('SELECT 1 FROM backend_run_intents WHERE subject_ref=? AND desired_running=1 LIMIT 1', subjectRef)
      || get('SELECT 1 FROM backend_subject_owners WHERE subject_ref=? AND active=1', subjectRef)) {
      throw problem('INSPECTION_SUBJECT_NOT_STOPPED', '这个游戏主体尚未停止，不能另建只读检查连接');
    }
  }
  function current(item) {
    if (item.controller.signal.aborted || active.get(item.subjectRef) !== item || item.finished) return false;
    try {
      authorize(item, item.authorization); assertNoActor(item.subjectRef);
      if (!get('SELECT 1 FROM backend_accounts WHERE owner_ref=? AND account_id=? AND subject_ref=? AND removed_at IS NULL', item.ownerRef, Number(item.accountRef), item.subjectRef)) return false;
      if (item.connectionEpoch !== null && get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', item.subjectRef)?.connection_epoch !== item.connectionEpoch) return false;
      return true;
    } catch { return false; }
  }
  function update(item, stage, code = null) {
    item.summary.stage = stage; item.summary.code = code;
    run('UPDATE backend_read_inspections SET stage=?,code=?,summary_json=?,updated_at=? WHERE inspection_id=?',
      stage, code, canonical(item.summary), nowIso(), item.inspectionId);
  }
  function finish(item, cleanupComplete) {
    item.summary.cleanupComplete = cleanupComplete;
    item.summary.transportClosed = cleanupComplete;
    item.summary.completedAt = nowIso();
    item.summary.allRequestedPathsRead = item.paths.every(path => item.summary.facts.some(entry => entry.path === path && entry.state === 'read'));
    item.summary.partial = !item.summary.allRequestedPathsRead;
    item.summary.ok = cleanupComplete && !item.controller.signal.aborted && !item.summary.code
      && positive(item.summary.profile.uid) && item.summary.coverage.refresh?.state === 'read';
    item.summary.stage = cleanupComplete ? item.controller.signal.aborted ? 'cancelled' : item.summary.ok ? 'completed' : 'failed' : 'cleanup_pending';
    transaction(() => {
      run('UPDATE backend_read_inspections SET stage=?,code=?,summary_json=?,cleanup_complete=?,updated_at=?,completed_at=? WHERE inspection_id=?',
        item.summary.stage, item.summary.code, canonical(item.summary), Number(cleanupComplete), nowIso(), item.summary.completedAt, item.inspectionId);
      if (cleanupComplete) run('DELETE FROM backend_read_inspection_slots WHERE subject_ref=? AND inspection_id=?', item.subjectRef, item.inspectionId);
    });
    if (cleanupComplete) {
      item.finished = true; item.connection = null;
      if (active.get(item.subjectRef) === item) active.delete(item.subjectRef);
    }
    return freeze(clone(item.summary));
  }
  async function close(item) {
    if (!item.connection) return true; // Audited connectGame rejects only after its own transport cleanup.
    if (!item.closing) item.closing = Promise.resolve().then(() => item.connection.close()).then(result => result?.closed === true, () => false);
    let timer;
    const proof = await Promise.race([item.closing, new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); })]);
    clearTimeout(timer);
    if (!proof) {
      // A timed out cleanup retains its slot. A later real close can retire only
      // this inspection; it cannot restore intent, open another socket or write.
      item.closing.then(closed => { if (closed && !item.finished) finish(item, true); }).catch(() => {});
    }
    return proof;
  }
  async function observe(item, observation, stage) {
    const source = { method: stage === 'login' ? 'index.login' : 'usrLand.refresh', responseRef: null,
      wireKey: null, connectionEpoch: item.connectionEpoch, receivedDeviceMs: null, serverRespondedMs: null };
    if (typeof observation?.responseRef === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(observation.responseRef)) source.responseRef = observation.responseRef;
    if (typeof observation?.wireKey === 'string' && /^ws\|\d+\|\d+$/.test(observation.wireKey)) source.wireKey = observation.wireKey;
    if (positive(observation?.receivedDeviceMs)) source.receivedDeviceMs = observation.receivedDeviceMs;
    if (positive(observation?.serverRespondedMs)) source.serverRespondedMs = observation.serverRespondedMs;
    const valid = observation?.envelopeOk === true && observation.dsName === SYNC_TYPE && plainObject(observation.value)
      && observation.rejected !== true && !(observation.messagePresent === true && observation.noticeOnly !== true);
    item.summary.coverage[stage] = { state: valid ? 'read' : 'unreadable', source,
      code: valid ? null : 'INSPECTION_OFFICIAL_ENVELOPE_UNCONFIRMED' };
    if (!valid) {
      item.summary.diagnostics.push(diagnostic({ code: 'INSPECTION_OFFICIAL_ENVELOPE_UNCONFIRMED', remoteCode: observation?.remoteCode,
        remoteKey: observation?.remoteKey, envelopeReason: observation?.envelopeReason }, stage));
      return false;
    }
    const value = observation.value;
    const officialUid = at(value, '7.0.0');
    if (officialUid.state === 'present' && positive(officialUid.value)) {
      if (item.expectedUid !== null && item.expectedUid !== officialUid.value
        || item.observedUid !== null && item.observedUid !== officialUid.value) {
        item.summary.coverage[stage] = { state: 'unreadable', code: 'INSPECTION_SUBJECT_UID_MISMATCH', source };
        item.summary.code = 'INSPECTION_SUBJECT_UID_MISMATCH';
        return false;
      }
      item.observedUid = officialUid.value;
    }
    for (const [name, key] of Object.entries(NUMERIC_PROFILE)) {
      const entry = at(value, '7.0.' + key);
      if (entry.state === 'present' && (name === 'uid' ? positive(entry.value) : nonnegative(entry.value))) {
        item.summary.profile[name] = entry.value;
        item.summary.profileCoverage[name] = { state: 'read', source };
      } else if (entry.state !== 'absent') {
        item.summary.profile[name] = null;
        item.summary.profileCoverage[name] = { state: entry.state === 'present' ? 'unreadable' : entry.state, source };
      }
    }
    const nickname = at(value, '7.0.5');
    if (nickname.state === 'present' && typeof nickname.value === 'string') {
      item.summary.profile.nickname = clippedName(nickname.value); item.summary.profileCoverage.nickname = { state: 'read', source };
    } else if (nickname.state !== 'absent') {
      item.summary.profile.nickname = null;
      item.summary.profileCoverage.nickname = { state: nickname.state === 'present' ? 'unreadable' : nickname.state, source };
    }
    for (const waterPath of ['7.0.32.7', '7.2.2.7']) {
      const water = at(value, waterPath);
      if (water.state === 'present' && nonnegative(water.value)) {
        item.summary.profile.water = water.value; item.summary.profileCoverage.water = { state: 'read', source, path: waterPath };
      } else if (water.state !== 'absent') {
        item.summary.profile.water = null;
        item.summary.profileCoverage.water = { state: water.state === 'present' ? 'unreadable' : water.state, source, path: waterPath };
      }
    }
    const landUid = at(value, '100.0.0');
    const trustedUid = item.observedUid ?? item.expectedUid;
    const landOwnerConflict = landUid.state !== 'absent' && (landUid.state !== 'present' || !positive(landUid.value)
      || trustedUid !== null && landUid.value !== trustedUid);
    for (const path of item.paths) {
      const projected = landOwnerConflict && path.startsWith('100.')
        ? { state: 'unreadable', value: null, code: 'INSPECTION_LAND_OWNER_MISMATCH' } : projectPath(value, path);
      const previous = item.summary.facts.find(entry => entry.path === path);
      // A sparse refresh does not erase login coverage. Record its absence
      // separately; never replace a failed read by a zero or an empty map.
      item.summary.coverage[stage][path] = projected.state;
      if (projected.state === 'absent' && previous?.state === 'read') continue;
      const entry = { path, ...projected, source, decodeVersion: VERSION };
      if (previous) item.summary.facts[item.summary.facts.indexOf(previous)] = entry;
      else item.summary.facts.push(entry);
    }
    if (landOwnerConflict) {
      item.summary.code = 'INSPECTION_LAND_OWNER_MISMATCH';
      item.summary.diagnostics.push({ stage, code: 'INSPECTION_LAND_OWNER_MISMATCH' });
    }
    const serverMs = positive(observation.serverMs) ? observation.serverMs : source.serverRespondedMs;
    if (serverMs !== null) {
      const rttKnown = positive(observation.sentDeviceMs) && source.receivedDeviceMs !== null && source.receivedDeviceMs >= observation.sentDeviceMs;
      item.clockAnchor = { officialMs: serverMs, monotonicMs: monotonic() };
      item.summary.clock = { available: true, officialMs: serverMs, observedDeviceMs: source.receivedDeviceMs,
        uncertaintyMs: rttKnown ? source.receivedDeviceMs - observation.sentDeviceMs : null,
        source, basis: rttKnown ? 'server-anchor-with-request-bound' : 'server-anchor-rtt-unknown' };
    }
    update(item, stage === 'login' ? 'logged_in' : 'read');
    if (onObservation && current(item)) {
      try { await onObservation(freeze({ ownerRef: item.ownerRef, accountRef: item.accountRef, subjectRef: item.subjectRef,
        inspectionId: item.inspectionId, connectionEpoch: item.connectionEpoch }), freeze(clone({ profile: item.summary.profile,
        profileCoverage: item.summary.profileCoverage, coverage: item.summary.coverage[stage], clock: item.summary.clock,
        facts: item.summary.facts, stage, decodeVersion: VERSION }))); }
      catch { item.summary.diagnostics.push({ stage: 'observation', code: 'INSPECTION_OBSERVATION_CALLBACK_FAILED' }); }
    }
    return true;
  }
  async function perform(item) {
    let credential = null;
    try {
      if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
      const previousSlot = get('SELECT * FROM backend_read_inspection_slots WHERE subject_ref=?', item.subjectRef);
      const proof = await assertSubjectStoppedAndIsolated({ ownerRef: item.ownerRef, accountRef: item.accountRef, subjectRef: item.subjectRef,
        inspectionId: item.inspectionId, signal: item.controller.signal, previousInspection: previousSlot ? {
          inspectionId: previousSlot.inspection_id, instanceRef: previousSlot.instance_ref, pid: previousSlot.pid,
          processStartToken: previousSlot.process_start_token ?? null, processBootId: previousSlot.process_boot_id ?? null } : null });
      if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
      if (proof?.stopped !== true || proof.isolated !== true || proof.subjectRef !== item.subjectRef
        || typeof proof.evidenceRef !== 'string' || !proof.evidenceRef || proof.evidenceRef.length > 256
        || typeof proof.sourceRef !== 'string' || !proof.sourceRef || proof.sourceRef.length > 256) {
        throw problem('INSPECTION_ISOLATION_UNPROVEN', '尚未取得这个主体停止与隔离的证据');
      }
      const isolation = { stopped: true, isolated: true, subjectRef: item.subjectRef, evidenceRef: proof.evidenceRef, sourceRef: proof.sourceRef };
      transaction(() => {
        assertNoActor(item.subjectRef); authorize(item, item.authorization);
        const old = get('SELECT * FROM backend_read_inspection_slots WHERE subject_ref=?', item.subjectRef);
        if (old) {
          if (proof.previousInspectionClosed?.inspectionId !== old.inspection_id || proof.previousInspectionClosed?.transportClosed !== true
            || typeof proof.previousInspectionClosed.evidenceRef !== 'string' || !proof.previousInspectionClosed.evidenceRef) {
            throw problem('INSPECTION_PREVIOUS_CLEANUP_REQUIRED', '上一只读连接尚未确认关闭，本次不接管');
          }
          run('UPDATE backend_read_inspections SET cleanup_complete=1,stage=?,code=?,updated_at=?,completed_at=? WHERE inspection_id=?',
            'retired_with_close_proof', 'INSPECTION_RETIRED_WITH_PROOF', nowIso(), nowIso(), old.inspection_id);
          run('DELETE FROM backend_read_inspection_slots WHERE subject_ref=? AND inspection_id=?', item.subjectRef, old.inspection_id);
          isolation.previousInspectionClosed = { inspectionId: old.inspection_id, transportClosed: true,
            pid: old.pid, processStartToken: old.process_start_token ?? null, evidenceRef: proof.previousInspectionClosed.evidenceRef };
        }
        run(`INSERT INTO backend_read_inspection_slots(subject_ref,inspection_id,instance_ref,pid,process_start_token,created_at,process_boot_id)
          VALUES(?,?,?,?,?,?,?)`, item.subjectRef, item.inspectionId, instanceRef, process.pid, processStartToken, nowIso(), processBootId);
        const epoch = Number(get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', item.subjectRef)?.connection_epoch || 0) + 1;
        if (!positive(epoch)) throw problem('INSPECTION_CONNECTION_EPOCH_INVALID', '当前连接代际无法安全递增', 500);
        run('INSERT INTO backend_subject_connection_epochs VALUES(?,?) ON CONFLICT(subject_ref) DO UPDATE SET connection_epoch=excluded.connection_epoch', item.subjectRef, epoch);
        item.connectionEpoch = epoch; item.summary.connectionEpoch = epoch;
        run('UPDATE backend_read_inspections SET connection_epoch=?,isolation_json=?,updated_at=? WHERE inspection_id=?', epoch, canonical(isolation), nowIso(), item.inspectionId);
      });
      update(item, 'connecting');
      let supplied = await credentials({ ownerRef: item.ownerRef, accountRef: item.accountRef, subjectRef: item.subjectRef, signal: item.controller.signal });
      if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
      if (!plainObject(supplied) || typeof supplied.username !== 'string' || !supplied.username || typeof supplied.password !== 'string'
        || !supplied.password || supplied.serverId !== item.serverId) throw problem('INSPECTION_CREDENTIAL_BINDING_INVALID', '受保护凭据与当前区服绑定不一致');
      // Own a mutable, minimal in-memory copy. Clearing it must never throw on
      // an injected frozen credential object and skip transport cleanup.
      credential = { username: supplied.username, password: supplied.password, serverId: supplied.serverId,
        ...(typeof supplied.passwordEncoded === 'boolean' ? { passwordEncoded: supplied.passwordEncoded } : {}) };
      supplied = null;
      const route = proxy(), profilePath = deviceProfilePath();
      if (typeof route !== 'string' || typeof profilePath !== 'string') throw problem('INSPECTION_DEVICE_CONTEXT_INVALID', '当前设备或出口上下文无效');
      item.connection = await connectGame({ account: credential, proxy: route, deviceProfilePath: profilePath,
        connectionEpoch: item.connectionEpoch, signal: item.controller.signal, isCurrent: () => current(item) });
      if (!item.connection || typeof item.connection.close !== 'function' || typeof item.connection.read !== 'function') {
        throw problem('INSPECTION_CONNECTION_CONTRACT_INVALID', '只读连接没有形成受控门面', 500);
      }
      if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
      if (item.connection.context?.serverId !== item.serverId) throw problem('INSPECTION_SERVER_MISMATCH', '官服当前连接区服与资料绑定不一致');
      const login = item.connection.context?.loginObservation;
      if (!await observe(item, login, 'login')) throw problem('INSPECTION_LOGIN_UNCONFIRMED', '官服登录事实尚未核实');
      if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
      update(item, 'reading');
      try {
        const refreshed = await item.connection.read('usrLand.refresh', {});
        if (!current(item)) throw problem('INSPECTION_CANCELLED', '只读检查已取消');
        if (!await observe(item, refreshed, 'refresh')) throw problem('INSPECTION_READ_UNCONFIRMED', '官服本次读取没有形成可核实事实');
      } catch (error) {
        item.summary.coverage.refresh ||= { state: 'unreadable', code: safeCode(error?.code) };
        item.summary.diagnostics.push(diagnostic(error, 'refresh')); item.summary.code ||= safeCode(error?.code);
      }
      if (!positive(item.summary.profile.uid)) item.summary.code ||= 'OFFICIAL_PROFILE_UNREADABLE';
      if (item.expectedUid !== null && item.summary.profile.uid !== item.expectedUid) item.summary.code = 'INSPECTION_SUBJECT_UID_MISMATCH';
    } catch (error) {
      item.summary.code = item.controller.signal.aborted ? 'INSPECTION_CANCELLED' : item.summary.code || safeCode(error?.code);
      item.summary.diagnostics.push(diagnostic({ code: item.summary.code, remoteCode: error?.remoteCode,
        remoteKey: error?.remoteKey, envelopeReason: error?.envelopeReason }, item.summary.stage));
    } finally {
      if (credential) { credential.username = ''; credential.password = ''; }
      if (item.clockAnchor) item.summary.clock.snapshotNowMs = Math.floor(item.clockAnchor.officialMs + monotonic() - item.clockAnchor.monotonicMs);
      item.summary.code ||= item.controller.signal.aborted ? 'INSPECTION_CANCELLED' : null;
      // A failed checkpoint must not skip the actual socket close.
      try { update(item, 'closing', item.summary.code); }
      catch { item.summary.code = 'INSPECTION_CHECKPOINT_FAILED'; }
      const cleaned = await close(item);
      if (!current(item) && !item.summary.code) item.summary.code = item.controller.signal.aborted ? 'INSPECTION_CANCELLED' : 'INSPECTION_CONTEXT_REVOKED';
      item.externalSignal?.removeEventListener('abort', item.abort);
      try { return finish(item, cleaned); }
      catch { throw Object.assign(problem('INSPECTION_CHECKPOINT_FAILED', '只读连接已进入清理，持久检查点尚未确认', 500), { transportClosed: cleaned, cleanupComplete: false }); }
    }
  }
  function begin({ ownerRef, accountRef, paths, signal } = {}) {
    requireText(ownerRef, 'ownerRef');
    accountRef = String(accountRef);
    if (!POSITIVE_KEY.test(accountRef) || !positive(Number(accountRef))) throw problem('ACCOUNT_NOT_FOUND', '游戏号标识无效', 404);
    const authorization = authorize({ ownerRef, accountRef }), row = account(ownerRef, accountRef), selected = normalizePaths(paths);
    if (active.has(row.subject_ref)) throw problem('INSPECTION_SUBJECT_BUSY', '这个游戏主体已有只读检查连接');
    assertNoActor(row.subject_ref);
    const savedProfile = parseStored(row.profile_json, '游戏号安全资料');
    const controller = new AbortController(), inspectionId = newId();
    const item = { ownerRef, accountRef, subjectRef: row.subject_ref, serverId: row.server_id, inspectionId, authorization,
      expectedUid: positive(savedProfile?.uid) ? savedProfile.uid : null, observedUid: null, controller, externalSignal: signal, connectionEpoch: null,
      connection: null, closing: null, finished: false, clockAnchor: null, paths: selected, promise: null,
      summary: { inspectionId, accountRef, subjectRef: row.subject_ref, connectionEpoch: null, mode: 'read-only', stage: 'authorizing',
        code: null, ok: false, cleanupComplete: false, transportClosed: false, startedAt: nowIso(), completedAt: null,
        profile: { serverId: row.server_id, uid: null, nickname: null, level: null, water: null, gold: null, yuanbao: null },
        profileCoverage: {}, coverage: {}, clock: { available: false, officialMs: null, uncertaintyMs: null }, facts: [], diagnostics: [],
        identityContinuity: positive(savedProfile?.uid) ? 'saved-official-uid' : 'stored-login-identity-only', decodeVersion: VERSION } };
    item.abort = () => controller.abort(problem('INSPECTION_CANCELLED', '只读检查已取消'));
    signal?.addEventListener('abort', item.abort, { once: true });
    if (signal?.aborted) item.abort();
    run('INSERT INTO backend_read_inspections VALUES(?,?,?,?,?,NULL,?,NULL,?,NULL,0,?,?,NULL)', inspectionId, ownerRef, accountRef,
      row.subject_ref, authorization.identityEpoch, 'authorizing', canonical(item.summary), nowIso(), nowIso());
    active.set(item.subjectRef, item);
    item.promise = Promise.resolve().then(() => perform(item));
    return Object.freeze({ inspectionId, completion: item.promise });
  }
  function inspect(input) { return begin(input).completion; }
  function latest({ ownerRef, accountRef }) {
    const authorization = authorize({ ownerRef, accountRef: String(accountRef) }); account(ownerRef, accountRef);
    const row = get('SELECT * FROM backend_read_inspections WHERE owner_ref=? AND account_ref=? ORDER BY started_at DESC,rowid DESC LIMIT 1', ownerRef, String(accountRef));
    if (!row) return null;
    const summary = parseStored(row.summary_json, '只读检查点');
    return freeze({ ...summary, identityEpoch: row.identity_epoch, historical: row.identity_epoch !== authorization.identityEpoch,
      stage: row.stage, code: row.code, cleanupComplete: row.cleanup_complete === 1,
      transportClosed: row.cleanup_complete === 1, completedAt: row.completed_at });
  }
  async function cancelAll(ownerRef = null) {
    if (ownerRef !== null) requireText(ownerRef, 'ownerRef');
    const selected = [...active.values()].filter(item => ownerRef === null || item.ownerRef === ownerRef);
    for (const item of selected) item.abort();
    let timer;
    await Promise.race([Promise.allSettled(selected.map(item => item.promise)), new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]);
    clearTimeout(timer);
    const remaining = [...active.values()].filter(item => ownerRef === null || item.ownerRef === ownerRef);
    return { cancelled: selected.length, pending: remaining.length, cleanupComplete: remaining.length === 0,
      checks: remaining.map(item => ({ inspectionId: item.inspectionId, cleanupComplete: false })) };
  }
  return Object.freeze({ begin, inspect, latest, cancelAll,
    activeCount: ownerRef => [...active.values()].filter(item => ownerRef === undefined || item.ownerRef === ownerRef).length,
    hasSubject: subjectRef => active.has(subjectRef),
    pendingCheckpoints: ownerRef => all('SELECT inspection_id,account_ref,subject_ref,stage,code FROM backend_read_inspections WHERE owner_ref=? AND cleanup_complete=0', ownerRef)
      .map(row => ({ inspectionId: row.inspection_id, accountRef: row.account_ref, subjectRef: row.subject_ref, stage: row.stage, code: row.code })) });
}
