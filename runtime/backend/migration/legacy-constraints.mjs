import { canonical, fingerprint, parseStored, plainObject, problem, requireText } from '../common.mjs';

const UNKNOWN_STATUSES = new Set(['prepared', 'may_have_sent', 'verifying', 'transport_unknown', 'business_unverified']);
const TERMINAL_STATUSES = new Set(['confirmed', 'accepted', 'rejected', 'cancelled']);
const nullableText = value => typeof value === 'string' ? value : null;
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const unresolved = row => UNKNOWN_STATUSES.has(row.status) || !TERMINAL_STATUSES.has(row.status)
  || ['unknown', 'unverified', 'business_unverified'].includes(row.business_verdict) || row.transport_state === 'unresolved';
const evidenceObject = (value, label) => {
  if (!plainObject(value) || !Object.keys(value).length) throw problem('LEGACY_ADMISSION_EVIDENCE_REQUIRED', label + '缺少明确依据', 400);
  return value;
};
const pageSize = size => {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw problem('LEGACY_PAGE_INVALID', '历史证据页大小无效', 400);
  return size;
};

// These are indexes of immutable archived observations, never imported live
// operations, slots or resource reservations. Domain admission owns all current
// conclusions; this module cannot turn an original unknown into success.
export function createLegacyConstraints({ store, cipher }) {
  if (typeof cipher?.decrypt !== 'function') throw new TypeError('Legacy constraints require the target archive cipher');
  const { all, get, run, transaction, nowIso } = store;
  const tableExists = name => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
  transaction(() => store.db.exec(`
CREATE TABLE IF NOT EXISTS backend_legacy_operation_index(
  operation_ref TEXT PRIMARY KEY,transfer_id TEXT NOT NULL,archive_id TEXT NOT NULL UNIQUE,
  owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
  source_origin_key TEXT NOT NULL,source_operation_id TEXT NOT NULL,source_subject_ref TEXT,
  source_version TEXT NOT NULL,source_fingerprint TEXT NOT NULL,semantic_key TEXT,
  feature_id TEXT,scope TEXT,method TEXT,status TEXT,transport_state TEXT,business_verdict TEXT,
  unresolved INTEGER NOT NULL,source_revision INTEGER,evidence_revision INTEGER,
  declared_target_ref TEXT,target_binding_state TEXT,target_member_count INTEGER,recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS backend_legacy_operation_subject ON backend_legacy_operation_index(owner_ref,subject_ref,unresolved);
CREATE INDEX IF NOT EXISTS backend_legacy_operation_origin ON backend_legacy_operation_index(source_origin_key);
CREATE TABLE IF NOT EXISTS backend_legacy_constraint_index(
  constraint_ref TEXT PRIMARY KEY,transfer_id TEXT NOT NULL,archive_id TEXT NOT NULL,
  operation_ref TEXT,source_operation_id TEXT NOT NULL,source_origin_key TEXT NOT NULL,
  owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('target','resource')),raw_ref TEXT,quantity REAL,
  raw_state TEXT,released_at TEXT,source_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS backend_legacy_constraint_subject ON backend_legacy_constraint_index(owner_ref,subject_ref,kind,raw_ref);
CREATE TABLE IF NOT EXISTS backend_legacy_admission_basis(
  basis_id INTEGER PRIMARY KEY AUTOINCREMENT,basis_key TEXT NOT NULL,
  owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,constraint_ref TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,conclusion TEXT NOT NULL CHECK(conclusion IN ('hold_current','permit_current','needs_evidence')),
  fact_basis_json TEXT NOT NULL,fact_basis_fingerprint TEXT NOT NULL,affected_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,reason_code TEXT NOT NULL,recorded_at TEXT NOT NULL,
  UNIQUE(owner_ref,constraint_ref,basis_key));
CREATE TRIGGER IF NOT EXISTS backend_legacy_op_index_no_update BEFORE UPDATE ON backend_legacy_operation_index
  BEGIN SELECT RAISE(ABORT,'legacy operation index is immutable'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_op_index_no_delete BEFORE DELETE ON backend_legacy_operation_index
  BEGIN SELECT RAISE(ABORT,'legacy operation index is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_constraint_no_update BEFORE UPDATE ON backend_legacy_constraint_index
  BEGIN SELECT RAISE(ABORT,'legacy constraint origin is immutable'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_constraint_no_delete BEFORE DELETE ON backend_legacy_constraint_index
  BEGIN SELECT RAISE(ABORT,'legacy constraint origin is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_basis_no_update BEFORE UPDATE ON backend_legacy_admission_basis
  BEGIN SELECT RAISE(ABORT,'legacy current-admission evidence is append only'); END;
CREATE TRIGGER IF NOT EXISTS backend_legacy_basis_no_delete BEFORE DELETE ON backend_legacy_admission_basis
  BEGIN SELECT RAISE(ABORT,'legacy current-admission evidence is append only'); END;
`));
  function archives(input, sourceTable) {
    const rows = [];
    let after = '';
    for (;;) {
      const page = all(`SELECT * FROM backend_legacy_archives WHERE transfer_id=? AND target_owner_ref=?
        AND target_account_ref=? AND target_subject_ref=? AND source_table=? AND archive_id>? ORDER BY archive_id LIMIT 500`,
      input.transferId, input.ownerRef, input.accountRef, input.subjectRef, sourceTable, after);
      for (const archive of page) {
        const original = parseStored(cipher.decrypt(archive.original_row_ciphertext), '迁移原始业务证据');
        if (!plainObject(original) || fingerprint(original) !== archive.source_row_fingerprint) throw problem('LEGACY_ARCHIVE_FINGERPRINT_INVALID', '原始历史证据无法完整核对，原资料已保留', 503);
        rows.push({ archive, original });
      }
      if (page.length < 500) break;
      after = page.at(-1).archive_id;
    }
    return rows;
  }
  function indexImport(input) {
    for (const key of ['transferId', 'ownerRef', 'accountRef', 'subjectRef']) requireText(input[key], key);
    for (const key of ['appId', 'cloudRef', 'ownerRef', 'sourceVersion']) requireText(input.source?.[key], 'source.' + key);
    return transaction(() => {
      const operationRows = archives(input, 'game_write_operations');
      const targetRows = archives(input, 'game_write_operation_targets');
      const holdRows = archives(input, 'game_write_holds');
      const operationRefs = new Map();
      const origin = (operationId, part = null) => fingerprint({ sourceAppId: input.source.appId, sourceCloudRef: input.source.cloudRef,
        sourceOwnerRef: input.source.ownerRef, sourceOperationId: operationId, part });
      for (const { archive, original } of operationRows) {
        requireText(original.operation_id, 'sourceOperationId');
        const operationRef = fingerprint(['legacy-operation', input.transferId, original.operation_id]);
        operationRefs.set(original.operation_id, operationRef);
        const existing = get('SELECT source_fingerprint FROM backend_legacy_operation_index WHERE operation_ref=?', operationRef);
        if (existing && existing.source_fingerprint !== archive.source_row_fingerprint) throw problem('LEGACY_INDEX_CONFLICT', '同一原操作快照不能换成另一内容', 409);
        if (!existing) run(`INSERT INTO backend_legacy_operation_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          operationRef, input.transferId, archive.archive_id, input.ownerRef, input.accountRef, input.subjectRef,
          origin(original.operation_id), original.operation_id, nullableText(original.subject_ref), archive.source_version, archive.source_row_fingerprint,
          nullableText(original.semantic_key), nullableText(original.feature_id), nullableText(original.scope), nullableText(original.method),
          nullableText(original.status), nullableText(original.transport_state), nullableText(original.business_verdict), Number(unresolved(original)),
          Number.isSafeInteger(original.revision) ? original.revision : null,
          Number.isSafeInteger(original.evidence_revision) ? original.evidence_revision : null,
          nullableText(original.target_ref), nullableText(original.target_binding_state),
          Number.isSafeInteger(original.target_member_count) ? original.target_member_count : null, nowIso());
      }
      const addConstraint = ({ archive, original }, kind, rawRef, amount, rawState, releasedAt) => {
        requireText(original.operation_id, 'sourceOperationId');
        const constraintRef = fingerprint(['legacy-constraint', input.transferId, archive.archive_id, kind]);
        const existing = get('SELECT source_fingerprint FROM backend_legacy_constraint_index WHERE constraint_ref=?', constraintRef);
        if (existing && existing.source_fingerprint !== archive.source_row_fingerprint) throw problem('LEGACY_INDEX_CONFLICT', '同一原资源或目标证据不能换成另一内容', 409);
        if (!existing) run('INSERT INTO backend_legacy_constraint_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', constraintRef, input.transferId,
          archive.archive_id, operationRefs.get(original.operation_id) || null, original.operation_id, origin(original.operation_id, { kind, rawRef }),
          input.ownerRef, input.accountRef, input.subjectRef, kind, rawRef, amount, rawState, releasedAt, archive.source_row_fingerprint, nowIso());
      };
      for (const target of targetRows) addConstraint(target, 'target', nullableText(target.original.target_ref), null, null, null);
      for (const hold of holdRows) addConstraint(hold, 'resource', nullableText(hold.original.resource_key), quantity(hold.original.quantity),
        nullableText(hold.original.state), nullableText(hold.original.released_at));
      return { operationCount: operationRows.length, unresolvedOperationCount: operationRows.filter(item => unresolved(item.original)).length,
        targetCount: targetRows.length, resourceFootprintCount: holdRows.length, liveOperationsImported: 0, originalVerdictsChanged: 0 };
    });
  }
  // Resource arithmetic needs exact archived holds, not every operation's
  // target/admission JSON. This is a footprint projection, never an allow gate.
  function resourceFootprints({ ownerRef, subjectRef, resourceBaselineRef = null, resourceRefs = null }) {
    requireText(ownerRef, 'ownerRef'); requireText(subjectRef, 'subjectRef');
    if (resourceBaselineRef !== null) requireText(resourceBaselineRef, 'resourceBaselineRef');
    if (resourceRefs !== null && (!Array.isArray(resourceRefs) || resourceRefs.length > 128 ||
        resourceRefs.some(ref => typeof ref !== 'string' || !/^item:[1-9][0-9]*$/.test(ref))))
      throw problem('LEGACY_RESOURCE_PROJECTION_INVALID', '旧资源读取需要有界准确物品编号', 400);
    const refs = resourceRefs === null ? null : [...new Set(resourceRefs)], linked = resourceBaselineRef !== null && tableExists('backend_legacy_resource_budget_baseline_links');
    return all(`SELECT c.*,o.unresolved AS operation_unresolved FROM backend_legacy_constraint_index c
      LEFT JOIN backend_legacy_operation_index o ON o.operation_ref=c.operation_ref
      WHERE c.owner_ref=? AND c.subject_ref=? AND c.kind='resource' AND (o.unresolved=1 OR o.operation_ref IS NULL OR c.released_at IS NULL)
      ${refs === null ? '' : refs.length ? `AND c.raw_ref IN (${refs.map(() => '?').join(',')})` : 'AND 0'}
      ${linked ? `AND NOT EXISTS(SELECT 1 FROM backend_legacy_resource_budget_baseline_links l WHERE l.constraint_ref=c.constraint_ref
        AND l.source_origin_key=c.source_origin_key AND l.raw_ref=c.raw_ref AND l.source_fingerprint=c.source_fingerprint)` : ''}
      ORDER BY c.constraint_ref`, ownerRef, subjectRef, ...(refs || []));
  }
  function currentAdmission({ ownerRef, subjectRef, factBasis = null, resourceBaselineRef = null,
    targetRefs = null, resourceKeys = null }) {
    requireText(ownerRef, 'ownerRef'); requireText(subjectRef, 'subjectRef');
    if (resourceBaselineRef !== null) requireText(resourceBaselineRef, 'resourceBaselineRef');
    const scoped = targetRefs !== null || resourceKeys !== null;
    for (const [name, values] of [['targetRefs', targetRefs], ['resourceKeys', resourceKeys]]) {
      if (values !== null && (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value))) {
        throw problem('LEGACY_CANDIDATE_BINDING_INVALID', name + '必须是非空字符串列表', 400);
      }
    }
    const operations = all('SELECT * FROM backend_legacy_operation_index WHERE owner_ref=? AND subject_ref=? AND unresolved=1 ORDER BY operation_ref', ownerRef, subjectRef);
    const hasResourceBaselineLinks = resourceBaselineRef !== null && tableExists('backend_legacy_resource_budget_baseline_links');
    const refs = scoped ? [...new Set([...(targetRefs || []), ...(resourceKeys || [])])] : null;
    const refFilter = scoped ? refs.length ? `AND c.raw_ref IN (${refs.map(() => '?').join(',')})` : 'AND 0' : '';
    const constraints = all(`SELECT c.*,o.unresolved AS operation_unresolved FROM backend_legacy_constraint_index c
      LEFT JOIN backend_legacy_operation_index o ON o.operation_ref=c.operation_ref
      WHERE c.owner_ref=? AND c.subject_ref=? AND (o.unresolved=1 OR o.operation_ref IS NULL OR c.kind='resource' AND c.released_at IS NULL)
      ${refFilter}
      ${hasResourceBaselineLinks ? `AND NOT (c.kind='resource' AND EXISTS(SELECT 1 FROM backend_legacy_resource_budget_baseline_links l
        WHERE l.constraint_ref=c.constraint_ref AND l.source_origin_key=c.source_origin_key AND l.raw_ref=c.raw_ref
          AND l.source_fingerprint=c.source_fingerprint))` : ''}
      ORDER BY c.constraint_ref`, ownerRef, subjectRef, ...(scoped ? refs : []));
    const constraintRefs = constraints.map(row => row.constraint_ref);
    const operationRefs = projectionOperationRefs(operations);
    const basisRefs = [...new Set([...constraintRefs, ...operationRefs])];
    const bases = basisRefs.length ? all(`SELECT b.* FROM backend_legacy_admission_basis b WHERE owner_ref=? AND subject_ref=?
      AND constraint_ref IN (${basisRefs.map(() => '?').join(',')}) AND NOT EXISTS(
      SELECT 1 FROM backend_legacy_admission_basis newer WHERE newer.owner_ref=b.owner_ref AND newer.constraint_ref=b.constraint_ref AND newer.basis_id>b.basis_id)
      ORDER BY b.basis_id`, ownerRef, subjectRef, ...basisRefs).map(row => ({ ...row,
      factBasis: parseStored(row.fact_basis_json, '旧账当前依据'), affected: parseStored(row.affected_json, '旧账作用范围'),
      evidence: parseStored(row.evidence_json, '旧账核对证据'),
      basisMatchesCurrentFacts: factBasis === null ? null : row.fact_basis_fingerprint === fingerprint(factBasis) })) : [];
    return { ownerRef, subjectRef, operations, targets: constraints.filter(row => row.kind === 'target'),
      resourceFootprints: constraints.filter(row => row.kind === 'resource'), bases,
      liveInFlightImported: false, originalUnknownPreserved: true,
      resourceBaselineRef: hasResourceBaselineLinks ? resourceBaselineRef : null,
      noteCode: 'LEGACY_FACTS_REQUIRE_SCOPED_DOMAIN_ADMISSION' };
  }
  function candidateProjection({ ownerRef, subjectRef, semanticKey = null, rawTargetRefs = [], rawResourceKeys = [], factBasis = null,
    candidateFingerprint = null, resourceBaselineRef = null }) {
    if (semanticKey !== null) requireText(semanticKey, 'semanticKey');
    if (!Array.isArray(rawTargetRefs) || !Array.isArray(rawResourceKeys) || [...rawTargetRefs, ...rawResourceKeys].some(value => typeof value !== 'string' || !value)) {
      throw problem('LEGACY_CANDIDATE_BINDING_INVALID', '旧账候选必须给准确目标和资源映射', 400);
    }
    const projection = currentAdmission({ ownerRef, subjectRef, factBasis, resourceBaselineRef,
      targetRefs: rawTargetRefs, resourceKeys: rawResourceKeys });
    const targets = new Set(rawTargetRefs), resources = new Set(rawResourceKeys);
    // Classification is global to each exact legacy operation, while the
    // returned candidates remain scoped to this target/resource. Otherwise an
    // operation mapped to a different target disappears from the candidate
    // subset and is incorrectly relabelled "unclassified" for every target.
    const operationRefs = projectionOperationRefs(projection.operations);
    const classified = operationRefs.length ? all(`SELECT DISTINCT operation_ref FROM backend_legacy_constraint_index
      WHERE owner_ref=? AND subject_ref=? AND operation_ref IN (${operationRefs.map(() => '?').join(',')})
        AND raw_ref IS NOT NULL AND raw_ref<>''`, ownerRef, subjectRef, ...operationRefs) : [];
    const bound = new Set(classified.map(row => row.operation_ref));
    const latest = new Map(projection.bases.filter(row => row.conclusion === 'permit_current' && row.basisMatchesCurrentFacts === true &&
      row.source_fingerprint && row.affected?.candidateFingerprint === candidateFingerprint)
      .map(row => [row.constraint_ref, row]));
    const separated = row => {
      const basis = latest.get(row.constraint_ref ?? row.operation_ref);
      return Boolean(basis && basis.source_fingerprint === row.source_fingerprint &&
        basis.affected?.candidateFingerprint === candidateFingerprint &&
        (basis.affected?.targetRef === undefined || targets.has(basis.affected.targetRef)));
    };
    const operationSeparated = operation => separated(operation) || projection.bases.some(basis => basis.constraint_ref === operation.operation_ref &&
      basis.conclusion === 'permit_current' && basis.basisMatchesCurrentFacts === true && basis.source_fingerprint === operation.source_fingerprint &&
      basis.affected?.candidateFingerprint === candidateFingerprint && (basis.affected?.targetRef === undefined || targets.has(basis.affected.targetRef)));
    const semanticMatches = semanticKey === null ? [] : projection.operations.filter(row => row.semantic_key === semanticKey && !operationSeparated(row));
    const matchedTargets = projection.targets.filter(row => targets.has(row.raw_ref) && !separated(row) && !operationSeparated(projection.operations.find(op => op.operation_ref === row.operation_ref) || {}));
    // A current-need target separation never clears a resource constraint.
    // Resource arithmetic has its own exact baseline-link proof and remains
    // active here until that link exists.
    const matchedResources = projection.resourceFootprints.filter(row => resources.has(row.raw_ref) && !separated(row));
    const declaredTargetMatches = projection.operations.filter(row => row.declared_target_ref && targets.has(row.declared_target_ref) && !operationSeparated(row));
    const unclassifiedOperations = projection.operations.filter(row => !bound.has(row.operation_ref) && !row.declared_target_ref && !operationSeparated(row));
    const activeOperations = projection.operations.filter(row => !operationSeparated(row));
    const history = { operations: projection.operations, targets: projection.targets, resourceFootprints: projection.resourceFootprints,
      semanticMatches: semanticKey === null ? [] : projection.operations.filter(row => row.semantic_key === semanticKey),
      matchedTargets: projection.targets.filter(row => targets.has(row.raw_ref)),
      matchedResources: projection.resourceFootprints.filter(row => resources.has(row.raw_ref)),
      declaredTargetMatches: projection.operations.filter(row => row.declared_target_ref && targets.has(row.declared_target_ref)),
      unclassifiedOperations: projection.operations.filter(row => !bound.has(row.operation_ref) && !row.declared_target_ref) };
    return { ...projection, history, operations: activeOperations, targets: matchedTargets, resourceFootprints: matchedResources,
      semanticMatches, matchedTargets, matchedResources, declaredTargetMatches, unclassifiedOperations,
      activeOperations,
      separatedOperations: projection.operations.filter(operationSeparated),
      activeTargets: matchedTargets, activeResources: matchedResources,
      // An empty match is not a generic allow certificate. Each feature still
      // proves its target/resource mapping, lifecycle and fact coverage.
    };
  }
  function validateResourceBaseline({ ownerRef, accountRef, subjectRef, baselineRef, currentSnapshot } = {}) {
    if (![ownerRef, accountRef, subjectRef, baselineRef].every(value => typeof value === 'string' && value.length)) return null;
    const row = get(`SELECT baseline_ref,owner_ref,account_ref,subject_ref,connection_epoch,request_sequence,response_ref,source_fingerprint,evidence_json
      FROM backend_resource_budget_baselines WHERE baseline_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?`,
    baselineRef, ownerRef, String(accountRef), subjectRef);
    if (!row) return null;
    const evidence = parseStored(row.evidence_json, '当前资源绝对基线');
    const login = evidence?.login;
    if (evidence?.version !== 'current-resource-baseline/closed-executor-complete-login-bag/v2' ||
      login?.absoluteBagComplete !== true || login?.officialUid !== currentSnapshot?.officialUid ||
      row.connection_epoch !== currentSnapshot?.connectionEpoch || row.response_ref !== currentSnapshot?.responseRef ||
      row.request_sequence !== currentSnapshot?.requestSequence || login?.sourceFingerprint !== row.source_fingerprint ||
      evidence?.accountingSeparation !== 'current-absolute-resource-accounting-only; does-not-prove-historical-success-or-consumption; does-not-authorize-replay') return null;
    return { baselineRef: row.baseline_ref, sourceFingerprint: row.source_fingerprint, connectionEpoch: row.connection_epoch,
      requestSequence: row.request_sequence, responseRef: row.response_ref, officialUid: login.officialUid,
      completeAbsoluteBag: true, accountingOnly: true };
  }
  function projectionOperationRefs(rows) {
    return [...new Set((Array.isArray(rows) ? rows : []).map(row => row?.operation_ref)
      .filter(value => typeof value === 'string' && value.length > 0))];
  }
  function appendBasis({ ownerRef, subjectRef, constraintRef, sourceFingerprint, basisKey, conclusion, factBasis, affected, evidence, reasonCode }) {
    for (const [key, value] of Object.entries({ ownerRef, subjectRef, constraintRef, sourceFingerprint, basisKey, reasonCode })) requireText(value, key);
    if (!['hold_current', 'permit_current', 'needs_evidence'].includes(conclusion)) throw problem('LEGACY_ADMISSION_CONCLUSION_INVALID', '旧账当前准入结论无效', 400);
    const factsJson = canonical(evidenceObject(factBasis, '当前事实'));
    const affectedJson = canonical(evidenceObject(affected, '准确作用范围'));
    const evidenceJson = canonical(evidenceObject(evidence, '直接证据'));
    if (affected.constraintRef !== constraintRef || conclusion === 'permit_current' && !/^[a-f0-9]{64}$/.test(affected.candidateFingerprint || '')) {
      throw problem('LEGACY_ADMISSION_SCOPE_INVALID', '允许当前候选必须绑定准确约束和候选指纹，不能整号解除历史未知', 400);
    }
    return transaction(() => {
      const original = get(`SELECT source_fingerprint FROM backend_legacy_constraint_index WHERE owner_ref=? AND subject_ref=? AND constraint_ref=?`, ownerRef, subjectRef, constraintRef)
        || get(`SELECT source_fingerprint FROM backend_legacy_operation_index WHERE owner_ref=? AND subject_ref=? AND operation_ref=?`, ownerRef, subjectRef, constraintRef);
      if (!original || original.source_fingerprint !== sourceFingerprint) throw problem('LEGACY_ADMISSION_ORIGIN_CHANGED', '旧账当前依据没有绑定准确原证据指纹', 409);
      const previous = get('SELECT * FROM backend_legacy_admission_basis WHERE owner_ref=? AND constraint_ref=? AND basis_key=?', ownerRef, constraintRef, basisKey);
      if (previous) {
        if (previous.source_fingerprint !== sourceFingerprint || previous.conclusion !== conclusion || previous.fact_basis_json !== factsJson
          || previous.affected_json !== affectedJson || previous.evidence_json !== evidenceJson || previous.reason_code !== reasonCode) throw problem('LEGACY_ADMISSION_BASIS_CONFLICT', '原准入依据身份不能覆盖另一份结论', 409);
        return { basisId: previous.basis_id, replayed: true };
      }
      const result = run('INSERT INTO backend_legacy_admission_basis(basis_key,owner_ref,subject_ref,constraint_ref,source_fingerprint,conclusion,fact_basis_json,fact_basis_fingerprint,affected_json,evidence_json,reason_code,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        basisKey, ownerRef, subjectRef, constraintRef, sourceFingerprint, conclusion, factsJson, fingerprint(factBasis), affectedJson, evidenceJson, reasonCode, nowIso());
      return { basisId: Number(result.lastInsertRowid), replayed: false };
    });
  }
  function operationsPage({ ownerRef, subjectRef, limit = 100, afterOperationRef = '' }) {
    requireText(ownerRef, 'ownerRef'); requireText(subjectRef, 'subjectRef');
    return all('SELECT * FROM backend_legacy_operation_index WHERE owner_ref=? AND subject_ref=? AND operation_ref>? ORDER BY operation_ref LIMIT ?',
      ownerRef, subjectRef, afterOperationRef, pageSize(limit));
  }
  return Object.freeze({ indexImport, currentAdmission, resourceFootprints, candidateProjection, validateResourceBaseline, appendBasis, operationsPage });
}
