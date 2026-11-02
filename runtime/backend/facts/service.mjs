import { canonical, clone, freeze, integer, newId, parseStored, problem, requireText } from '../common.mjs';
import { createDurableSequences } from '../persistence/sequences.mjs';

const STATES = new Set(['read', 'absent', 'unreadable']);
const SOURCES = new Set(['login', 'official-response', 'official-sync', 'official-read']);

// Current heads own these source cells. Operation admission snapshots contain
// their complete values and sources; historical fact IDs are not lookup ports.
// An old connection cannot become the active head of a newer connection.
export function createFactService({ store, isConnectionCurrent, appendOutbox, deviceNow = () => Date.now() }) {
  const { run, get, all, transaction } = store;
  const sequences = createDurableSequences(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_fact_cells(
    fact_id TEXT PRIMARY KEY,subject_ref TEXT NOT NULL,domain TEXT NOT NULL,semantic_path TEXT NOT NULL,
    state TEXT NOT NULL,value_json TEXT,verified_empty INTEGER NOT NULL,source_json TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL,arrival_sequence INTEGER NOT NULL,fact_revision INTEGER NOT NULL,
    observed_device_ms INTEGER NOT NULL,observed_official_ms INTEGER,clock_revision INTEGER,
    decode_version TEXT NOT NULL,coverage_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_fact_cells_subject_revision
      ON backend_fact_cells(subject_ref,fact_revision);
    CREATE TABLE IF NOT EXISTS backend_fact_cell_heads(
    subject_ref TEXT NOT NULL,domain TEXT NOT NULL,semantic_path TEXT NOT NULL,fact_id TEXT NOT NULL,
    PRIMARY KEY(subject_ref,domain,semantic_path));
    CREATE TABLE IF NOT EXISTS backend_official_clocks(
    subject_ref TEXT PRIMARY KEY,connection_epoch INTEGER NOT NULL,revision INTEGER NOT NULL,
    official_ms INTEGER NOT NULL,device_ms INTEGER NOT NULL,monotonic_ms REAL NOT NULL,
    uncertainty_ms INTEGER NOT NULL,source_json TEXT NOT NULL,valid INTEGER NOT NULL);`);
  store.db.exec('CREATE INDEX IF NOT EXISTS backend_fact_cell_heads_ref ON backend_fact_cell_heads(fact_id)');
  store.db.exec('CREATE INDEX IF NOT EXISTS backend_fact_retirement_order ON backend_fact_cells(subject_ref,fact_revision,fact_id)');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_fact_retirement_progress(
    subject_ref TEXT PRIMARY KEY,last_revision INTEGER NOT NULL,last_fact_id TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
  const processClocks = new Map();
  let retirementSubject = '', nextRetirementAt = 0;

  // One subject and one short transaction per maintenance slice. Current heads
  // stay intact, including stopped/deleted-account subjects. Seed the independent
  // revision root before removing any legacy row, even if that subject never ran
  // on this build. This does not retire operation originals or their snapshots.
  function retireSuperseded({ limit = 64 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Fact retirement slice is out of bounds');
    const at = monotonic();
    if (at < nextRetirementAt) return { scanned: 0, retired: 0 };
    nextRetirementAt = at + 1000;
    let subject = get('SELECT subject_ref FROM backend_fact_cells WHERE subject_ref>? ORDER BY subject_ref,fact_revision LIMIT 1', retirementSubject)?.subject_ref;
    if (!subject) subject = get('SELECT subject_ref FROM backend_fact_cells ORDER BY subject_ref,fact_revision LIMIT 1')?.subject_ref;
    if (!subject) return { scanned: 0, retired: 0 };
    retirementSubject = subject;
    return transaction(() => {
      sequences.current('fact-revision', [subject], () =>
        Number(get('SELECT COALESCE(MAX(fact_revision),0) AS revision FROM backend_fact_cells WHERE subject_ref=?', subject).revision));
      const cursor = get('SELECT last_revision,last_fact_id FROM backend_fact_retirement_progress WHERE subject_ref=?', subject);
      const rows = all(`SELECT fact_id,fact_revision FROM backend_fact_cells c WHERE subject_ref=?
        AND (fact_revision,fact_id)>(?,?)
        ORDER BY fact_revision,fact_id LIMIT ?`, subject, cursor?.last_revision ?? 0, cursor?.last_fact_id ?? '', limit);
      if (!rows.length) return { subjectRef: subject, scanned: 0, retired: 0 };
      const result = run(`DELETE FROM backend_fact_cells WHERE subject_ref=? AND fact_id IN (${rows.map(() => '?').join(',')})
        AND NOT EXISTS(SELECT 1 FROM backend_fact_cell_heads h WHERE h.fact_id=backend_fact_cells.fact_id)`, subject, ...rows.map(row => row.fact_id));
      const last = rows.at(-1);
      run(`INSERT INTO backend_fact_retirement_progress VALUES(?,?,?,?) ON CONFLICT(subject_ref)
        DO UPDATE SET last_revision=excluded.last_revision,last_fact_id=excluded.last_fact_id,updated_at=excluded.updated_at`,
      subject, last.fact_revision, last.fact_id, store.nowIso());
      return { subjectRef: subject, scanned: rows.length, retired: Number(result.changes) };
    });
  }

  function observe(input) {
    requireText(input.subjectRef, 'subjectRef'); requireText(input.domain, 'domain');
    requireText(input.semanticPath, 'semanticPath'); requireText(input.decodeVersion, 'decodeVersion');
    integer(input.connectionEpoch, 'connectionEpoch', 1); integer(input.arrivalSequence, 'arrivalSequence', 1);
    if (!STATES.has(input.state) || !SOURCES.has(input.source?.kind) || !input.source?.method || !input.source?.responseRef) {
      throw problem('BACKEND_FACT_SOURCE_INVALID', '官服事实缺少有效状态或来源', 400);
    }
    if (input.state === 'read' && !Object.hasOwn(input, 'value')) throw problem('BACKEND_FACT_VALUE_MISSING', '已读事实缺少值', 400);
    if (!Array.isArray(input.coverage) || input.coverage.some(path => typeof path !== 'string')) throw problem('BACKEND_FACT_COVERAGE_INVALID', '事实覆盖格式不正确', 400);
    const observed = input.observedDeviceMs ?? deviceNow(); integer(observed, 'observedDeviceMs');
    const official = input.observedOfficialMs ?? null;
    if (official !== null) integer(official, 'observedOfficialMs');
    const valueJson = input.state === 'read' ? canonical(input.value) : null;
    const verifiedEmpty = input.state === 'read' && input.verifiedEmpty === true;
    const isEmpty = input.state === 'read' && input.value && typeof input.value === 'object' && Object.keys(input.value).length === 0;
    if (isEmpty && !verifiedEmpty) throw problem('BACKEND_FACT_EMPTY_UNVERIFIED', '空集合必须由解码合同明确确认，不能由缺字段补造', 400);
    if (verifiedEmpty && !(Array.isArray(input.value) && input.value.length === 0 || input.value && typeof input.value === 'object' && Object.keys(input.value).length === 0)) {
      throw problem('BACKEND_FACT_EMPTY_INVALID', '已证空集合与实际读取不一致', 400);
    }
    return transaction(() => {
      if (!isConnectionCurrent(input.subjectRef, input.connectionEpoch)) throw problem('BACKEND_FACT_OLD_CONNECTION', '旧连接事实不覆盖当前状态');
      const previous = get(`SELECT c.* FROM backend_fact_cell_heads h JOIN backend_fact_cells c ON c.fact_id=h.fact_id
        WHERE h.subject_ref=? AND h.domain=? AND h.semantic_path=?`, input.subjectRef, input.domain, input.semanticPath);
      const previousSource = previous ? parseStored(previous.source_json, '事实来源') : null;
      const requestSequence = input.source.requestSequence;
      if (previous && previous.connection_epoch === input.connectionEpoch && Number.isSafeInteger(previousSource?.requestSequence) &&
          (!Number.isSafeInteger(requestSequence) || requestSequence <= previousSource.requestSequence)) {
        return { accepted: false, reasonCode: 'FACT_CAUSAL_SEQUENCE_OLD', factRevision: previous.fact_revision };
      }
      if (previous && previous.connection_epoch === input.connectionEpoch && previous.arrival_sequence >= input.arrivalSequence) {
        return { accepted: false, reasonCode: 'FACT_SEQUENCE_OLD', factRevision: previous.fact_revision };
      }
      const revision = sequences.next('fact-revision', [input.subjectRef], () =>
        Number(get('SELECT COALESCE(MAX(fact_revision),0) AS revision FROM backend_fact_cells WHERE subject_ref=?', input.subjectRef).revision));
      const id = newId();
      const source = { ...input.source, connectionEpoch: input.connectionEpoch, arrivalSequence: input.arrivalSequence };
      run('INSERT INTO backend_fact_cells VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, input.subjectRef, input.domain, input.semanticPath,
        input.state, valueJson, Number(verifiedEmpty), canonical(source), input.connectionEpoch, input.arrivalSequence,
        revision, observed, official, input.clockRevision ?? null, input.decodeVersion, canonical(input.coverage));
      run(`INSERT INTO backend_fact_cell_heads VALUES(?,?,?,?) ON CONFLICT(subject_ref,domain,semantic_path) DO UPDATE SET fact_id=excluded.fact_id`,
        input.subjectRef, input.domain, input.semanticPath, id);
      const changed = !previous || previous.connection_epoch !== input.connectionEpoch || previous.state !== input.state ||
        previous.value_json !== valueJson || previous.verified_empty !== Number(verifiedEmpty) || previous.coverage_json !== canonical(input.coverage);
      if (changed) appendOutbox?.({ ownerRef: input.ownerRef, subjectRef: input.subjectRef, type: 'FactsChanged',
        payload: { domain: input.domain, semanticPath: input.semanticPath, factId: id, factRevision: revision, connectionEpoch: input.connectionEpoch } });
      if (previous) run(`DELETE FROM backend_fact_cells WHERE fact_id=?
        AND NOT EXISTS(SELECT 1 FROM backend_fact_cell_heads h WHERE h.fact_id=backend_fact_cells.fact_id)`, previous.fact_id);
      return { accepted: true, changed, factId: id, factRevision: revision };
    });
  }

  function snapshot(subjectRef, requirements = []) {
    const cells = [], missing = [];
    for (const requirement of requirements) {
      for (const path of requirement.semanticPaths) {
        const row = get(`SELECT c.* FROM backend_fact_cell_heads h JOIN backend_fact_cells c ON c.fact_id=h.fact_id
          WHERE h.subject_ref=? AND h.domain=? AND h.semantic_path=?`, subjectRef, requirement.domain, path);
        let state = row?.state || 'unobserved';
        let reasonCode = row ? null : 'FACT_NOT_OBSERVED';
        const source = row ? parseStored(row.source_json, '事实来源') : null;
        if (row && !isConnectionCurrent(subjectRef, row.connection_epoch)) { state = 'stale'; reasonCode = 'FACT_CONNECTION_OLD'; }
        if (row && requirement.allowedSources && !requirement.allowedSources.includes(source.kind)) { state = 'unreadable'; reasonCode = 'FACT_SOURCE_NOT_ACCEPTED'; }
        // Each feature supplies its own freshness policy. There is no global TTL.
        if (row && typeof requirement.isFresh === 'function' && !requirement.isFresh({ row: clone(row), deviceNowMs: deviceNow() })) {
          state = 'stale'; reasonCode = 'FACT_POLICY_STALE';
        }
        if (row?.verified_empty && requirement.acceptVerifiedEmpty !== true) { state = 'unreadable'; reasonCode = 'FACT_EMPTY_NOT_ACCEPTED'; }
        const cell = { domain: requirement.domain, semanticPath: path, state, reasonCode,
          value: state === 'read' ? parseStored(row.value_json, '事实值') : null,
          verifiedEmpty: row?.verified_empty === 1, factId: row?.fact_id ?? null, factRevision: row?.fact_revision ?? null,
          source, observedDeviceMs: row?.observed_device_ms ?? null, observedOfficialMs: row?.observed_official_ms ?? null,
          coverage: row ? parseStored(row.coverage_json, '事实覆盖') : [], decodeVersion: row?.decode_version ?? null };
        cells.push(cell);
        if (state !== 'read' && !(state === 'absent' && requirement.acceptAbsent === true)) missing.push({ domain: cell.domain, semanticPath: path, state, reasonCode });
      }
    }
    return freeze({ subjectRef, available: missing.length === 0, cells, missing });
  }

  function calibrateClock({ subjectRef, connectionEpoch, officialMs, uncertaintyMs, source }) {
    integer(officialMs, 'officialMs', 1); integer(uncertaintyMs, 'uncertaintyMs');
    if (!isConnectionCurrent(subjectRef, connectionEpoch)) throw problem('BACKEND_CLOCK_OLD_CONNECTION', '旧连接不能校准当前官服时钟');
    if (!source?.method || !source?.responseRef) throw problem('BACKEND_CLOCK_SOURCE_MISSING', '官服时钟缺少来源', 400);
    const deviceMs = deviceNow(), monotonicMs = monotonic();
    const revision = transaction(() => {
      const previous = get('SELECT revision,connection_epoch,source_json FROM backend_official_clocks WHERE subject_ref=?', subjectRef);
      const previousSource = previous ? parseStored(previous.source_json, '时钟来源') : null;
      if (previous?.connection_epoch === connectionEpoch && Number.isSafeInteger(previousSource?.requestSequence) &&
          (!Number.isSafeInteger(source.requestSequence) || source.requestSequence <= previousSource.requestSequence)) return null;
      const next = Number(previous?.revision || 0) + 1;
      const sourced = { ...source, connectionEpoch, receivedDeviceMs: deviceMs, receivedMonotonicMs: monotonicMs };
      run(`INSERT INTO backend_official_clocks VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(subject_ref) DO UPDATE SET
        connection_epoch=excluded.connection_epoch,revision=excluded.revision,official_ms=excluded.official_ms,
        device_ms=excluded.device_ms,monotonic_ms=excluded.monotonic_ms,uncertainty_ms=excluded.uncertainty_ms,source_json=excluded.source_json,valid=1`,
        subjectRef, connectionEpoch, next, officialMs, deviceMs, monotonicMs, uncertaintyMs, canonical(sourced));
      return next;
    });
    if (revision !== null) processClocks.set(subjectRef, { connectionEpoch, officialMs, monotonicMs, revision, uncertaintyMs,
      source: { ...source, connectionEpoch, receivedDeviceMs: deviceMs, receivedMonotonicMs: monotonicMs } });
    return clock(subjectRef);
  }
  function clock(subjectRef) {
    const anchor = processClocks.get(subjectRef);
    if (!anchor || !isConnectionCurrent(subjectRef, anchor.connectionEpoch)) return { available: false, reasonCode: 'OFFICIAL_CLOCK_NOT_CALIBRATED', nowMs: null };
    const nowMs = Math.floor(anchor.officialMs + monotonic() - anchor.monotonicMs);
    return { available: true, source: 'official-anchor-monotonic', revision: anchor.revision,
      evidence: anchor.source ? { ...anchor.source } : null,
      connectionEpoch: anchor.connectionEpoch, nowMs, lowerBoundMs: Math.max(0, nowMs - anchor.uncertaintyMs),
      upperBoundMs: nowMs + anchor.uncertaintyMs, uncertaintyMs: anchor.uncertaintyMs,
      anchorMs: anchor.officialMs, anchorLowerBoundMs: Math.max(0, anchor.officialMs - anchor.uncertaintyMs),
      anchorUpperBoundMs: anchor.officialMs + anchor.uncertaintyMs, anchorMonotonicMs: anchor.monotonicMs };
  }
  function invalidateConnection(subjectRef) { processClocks.delete(subjectRef); }
  return Object.freeze({ observe, snapshot, calibrateClock, clock, invalidateConnection, retireSuperseded,
    heads: subjectRef => all('SELECT domain,semantic_path,fact_id FROM backend_fact_cell_heads WHERE subject_ref=?', subjectRef) });
}
