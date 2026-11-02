import { clone, freeze, parseStored, plainObject, problem, requireText } from '../common.mjs';

const COLUMNS = 'account_id,owner_ref,subject_ref,server_id,profile_json,removed_at,created_at,updated_at';
const VIEWS = Object.freeze({
  logs: ['limit', 'beforeLocalId', 'beforeBusinessId', 'category', 'day'],
  'legacy-logs': ['limit', 'afterEventRef', 'transferId'],
  'migration-digests': [],
  writes: ['limit', 'afterOperationRef', 'beforePreparedAt', 'beforeOperationId'],
  configSnapshot: [],
});

function accountId(value, field) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw problem('ARCHIVED_ACCOUNT_ID_INVALID', field + '格式不正确', 400);
  }
  return text;
}
const positiveUid = profile => Number.isSafeInteger(profile.uid) && profile.uid > 0 ? profile.uid : null;
function profileOf(row) {
  const profile = parseStored(row.profile_json, '归档游戏号资料');
  if (!plainObject(profile)) throw problem('ARCHIVED_ACCOUNT_PROFILE_INVALID', '归档资料格式无法核实，原资料已保留', 503);
  return profile;
}
function compatibleIdentity(left, right) {
  if (left.owner_ref !== right.owner_ref || left.subject_ref !== right.subject_ref || left.server_id !== right.server_id) return false;
  const leftUid = positiveUid(profileOf(left)), rightUid = positiveUid(profileOf(right));
  return leftUid === null || rightUid === null || leftUid === rightUid;
}

// Discovery and dispatch only. No SQL writes, cipher, credentials, supervisor,
// account mutation, connection or configuration-save dependency is accepted.
// Reader callbacks must be synchronous, already-redacted view projections.
export function createArchivedAccountReader({ store, authorizeOwner, readers = {} } = {}) {
  if (typeof store?.get !== 'function' || typeof store?.all !== 'function' || typeof authorizeOwner !== 'function' || !plainObject(readers)) {
    throw new TypeError('Archived account reads require an explicit read store and synchronous owner authorization');
  }
  for (const [view, reader] of Object.entries(readers)) {
    if (!Object.hasOwn(VIEWS, view) || typeof reader !== 'function' || reader.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Unsupported or asynchronous archived account view');
    }
  }
  const registeredReaders = Object.freeze({ ...readers });
  const { get, all } = store;
  function authorize({ ownerRef, expectedIdentityEpoch = null }) {
    requireText(ownerRef, 'ownerRef');
    const proof = authorizeOwner({ ownerRef, purpose: 'read-archived-account', expectedIdentityEpoch });
    if (proof?.then || proof !== true && (proof?.authorized !== true || proof.ownerRef !== ownerRef)) {
      throw problem('ARCHIVED_ACCOUNT_OWNER_REQUIRED', '历史资料需要当前正常软件归属', 403);
    }
    if (expectedIdentityEpoch !== null && (!Number.isSafeInteger(expectedIdentityEpoch) || expectedIdentityEpoch < 0
      || proof?.identityEpoch !== expectedIdentityEpoch)) {
      throw problem('ARCHIVED_ACCOUNT_OWNER_CHANGED', '历史资料读取的软件身份代际已变化', 403);
    }
  }
  function currentAccount(ownerRef, reference) {
    const id = accountId(reference, 'currentAccountRef');
    const row = get('SELECT ' + COLUMNS + ' FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS NULL', ownerRef, Number(id));
    if (!row) throw problem('ARCHIVED_CURRENT_ACCOUNT_MISSING', '当前游戏号已变化，请重新选择日志来源', 404);
    return row;
  }
  function archivedAccount(ownerRef, reference) {
    const id = accountId(reference, 'archivedAccountRef');
    const row = get('SELECT ' + COLUMNS + ' FROM backend_accounts WHERE owner_ref=? AND account_id=? AND removed_at IS NOT NULL', ownerRef, Number(id));
    if (!row) throw problem('ARCHIVED_ACCOUNT_NOT_FOUND', '找不到当前软件身份下的归档游戏号', 404);
    return row;
  }
  function project(row) {
    const profile = profileOf(row), id = String(row.account_id);
    const links = all('SELECT ' + COLUMNS + ' FROM backend_accounts WHERE owner_ref=? AND subject_ref=? AND server_id=? AND removed_at IS NULL ORDER BY account_id',
      row.owner_ref, row.subject_ref, row.server_id).filter(current => compatibleIdentity(row, current));
    return { kind: 'archived-account', sourceRef: 'archive:' + id, archivedAccountRef: id,
      accountRef: id, subjectRef: row.subject_ref, serverId: row.server_id, uid: positiveUid(profile),
      name: profile.remark || profile.nickname || '游戏号 ' + id,
      nickname: typeof profile.nickname === 'string' ? profile.nickname : '',
      remark: typeof profile.remark === 'string' ? profile.remark : '',
      maskedUsername: typeof profile.maskedUsername === 'string' ? profile.maskedUsername : '',
      removedAt: row.removed_at, createdAt: row.created_at, updatedAt: row.updated_at,
      currentAccountRefs: links.map(current => String(current.account_id)), readOnly: true,
      availableViews: Object.keys(registeredReaders), identityBasis: 'same-owner-stable-subject-server-compatible-known-uid' };
  }
  function resolve(input = {}) {
    authorize(input);
    const archived = archivedAccount(input.ownerRef, input.archivedAccountRef);
    if (input.currentAccountRef !== null && input.currentAccountRef !== undefined) {
      const current = currentAccount(input.ownerRef, input.currentAccountRef);
      if (!compatibleIdentity(archived, current)) {
        throw problem('ARCHIVED_ACCOUNT_SUBJECT_MISMATCH', '历史来源与当前游戏主体、区服或已知官服身份不一致', 403);
      }
    }
    const source = project(archived);
    authorize(input);
    return freeze({ ownerRef: input.ownerRef, accountRef: String(archived.account_id), subjectRef: archived.subject_ref,
      includeRemoved: true, readOnlyArchive: true, source });
  }
  function list({ ownerRef, currentAccountRef = null, afterArchivedAccountRef = null, limit = 50, expectedIdentityEpoch = null } = {}) {
    const context = { ownerRef, expectedIdentityEpoch };
    authorize(context);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw problem('ARCHIVED_ACCOUNT_PAGE_INVALID', '历史来源分页大小不正确', 400);
    const current = currentAccountRef === null ? null : currentAccount(ownerRef, currentAccountRef);
    const after = afterArchivedAccountRef === null ? 0 : Number(accountId(afterArchivedAccountRef, 'afterArchivedAccountRef'));
    const predicates = ['owner_ref=?', 'removed_at IS NOT NULL', 'account_id>?'], params = [ownerRef, after];
    if (current) { predicates.push('subject_ref=?', 'server_id=?'); params.push(current.subject_ref, current.server_id); }
    const rows = all('SELECT ' + COLUMNS + ' FROM backend_accounts WHERE ' + predicates.join(' AND ') + ' ORDER BY account_id LIMIT ?', ...params, limit + 1);
    const selected = rows.slice(0, limit);
    // Incompatible known UID observations remain preserved and separately
    // discoverable in owner-wide history, never linked to the current subject.
    const sources = selected.filter(row => !current || compatibleIdentity(row, current)).map(project);
    authorize(context);
    return freeze({ sources, readOnly: true, currentAccountRef: current ? String(current.account_id) : null,
      page: { limit, hasMore: rows.length > limit, afterArchivedAccountRef: selected.length ? String(selected.at(-1).account_id) : afterArchivedAccountRef } });
  }
  function read({ view, query = {}, ...input } = {}) {
    if (!Object.hasOwn(VIEWS, view)) throw problem('ARCHIVED_ACCOUNT_ACTION_FORBIDDEN', '归档游戏号仅允许读取历史资料', 405);
    if (!plainObject(query) || Object.keys(query).some(key => !VIEWS[view].includes(key))) {
      throw problem('ARCHIVED_ACCOUNT_QUERY_INVALID', '历史资料读取参数不正确', 400);
    }
    const scope = resolve(input), reader = registeredReaders[view];
    if (!reader) throw problem('ARCHIVED_ACCOUNT_VIEW_UNAVAILABLE', '这项历史资料读取尚未接入', 501);
    const result = reader(freeze({ ...clone(query), ...scope }));
    if (result?.then || !plainObject(result)) throw problem('ARCHIVED_ACCOUNT_READER_INVALID', '历史资料读取须返回同步只读投影', 500);
    authorize(input);
    return freeze({ ...clone(result), archiveSource: scope.source, readOnly: true });
  }
  return Object.freeze({ list, resolve, read });
}
