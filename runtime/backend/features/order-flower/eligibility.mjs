import { fingerprint, freeze, plainObject } from '../../common.mjs';
import { knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey, sameOrderFlowerContext } from './wire-facts.mjs';

const VERSION = 'order-flower-eligibility/current-source-contract/v2';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const absent = cell => !cell || cell.presence === 'missing' || cell.presence === 'null';
const boolLike = value => typeof value === 'boolean' || value === 0 || value === 1;
const merge = (values, or = false) => values.length === 0 ? true : or
  ? values.some(value => value === true) ? true : values.every(value => value === false) ? false : null
  : values.some(value => value === false) ? false : values.every(value => value === true) ? true : null;
const scalarCell = value => ({ presence: 'present', state: 'known', value });
const threshold = value => nonnegative(value) ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) && nonnegative(Number(value)) ? Number(value) : null;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Order eligibility ports must be synchronous'); } return value; };
const actionFor = kind => ({ resident: 'order.resident', satin: 'order.satin', decorate: 'order.decorate' })[kind];

// OpenCtrl/SysOpenCtrl evaluation follows the independently audited customer
// evaluator's flags/boolean order. This module adds only the two proven order
// predicates; it changes no customer default and emits no write capability.
export function evaluateOrderFlowerEligibility({ context: supplied, view, catalog, clock } = {}) {
  const context = orderFlowerContext(supplied), inputs = view?.eligibilityInputs, identity = view?.identity,
    sources = [], seen = new Set();
  catalog = catalog?.forContext?.(context, view?.identity?.source?.version) ?? catalog;
  const catalogIdentity = typeof catalog?.identity === 'function' ? sync(catalog.identity()) : null;
  const dynamic = catalogIdentity?.catalogId?.startsWith('official-public/data-snapshot/') === true && typeof catalogIdentity?.dataSnapshotId === 'string';
  const catalogKnown = !!catalogIdentity && catalogIdentity.protocolVersion === '480.0.0' &&
    (dynamic ? catalogIdentity.dataSchemaContractId && ['resident', 'satin', 'decorate'].some(kind => catalog.definition?.(kind))
      : catalogIdentity.gameVersion === '480.0.27');
  const sourceBase = { gameVersion: catalogIdentity?.gameVersion ?? null, protocolVersion: catalogIdentity?.protocolVersion ?? null,
    dataSnapshotId: catalogIdentity?.dataSnapshotId ?? null,
    sourceProofs: dynamic ? Object.fromEntries(Object.entries(catalogIdentity.sourceProofs || {}).map(([kind, proof]) => [kind,
      { actionContractId: proof?.actionContractId ?? null, gameSha256: proof?.gameSha256 ?? null, moSha256: proof?.moSha256 ?? null }])) : null,
    scope: 'observed-current-official-client-open-inputs-not-server-absolute-permission' };
  const sourceCurrent = source => !!context && source?.contextKey === orderFlowerContextKey(context) && source.kind === 'response' &&
    source.transport === 'answered' && source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) &&
    reference(source.responseRef) && typeof source.wireKey === 'string' && /^ws\|\d+\|[1-9]\d*$/.test(source.wireKey) &&
    Number(source.wireKey.split('|').at(-1)) === source.requestSequence &&
    source.version?.source === 'normal-package-hop-and-matched-world-login/v1' && source.version.gameVersion === catalogIdentity?.gameVersion &&
    source.version.protocolVersion === catalogIdentity?.protocolVersion && source.version.loginResponseRef === identity?.source?.responseRef &&
    (!dynamic || source.version.dataSnapshotId === catalogIdentity.dataSnapshotId);
  const currentCell = cell => cell?.current === true && knownOrderFlowerCell(cell) && sourceCurrent(cell.source);
  const identityCurrent = !!context && sameOrderFlowerContext(context, view?.context) && view.current === true && identity?.verified === true &&
    currentCell(identity.uid) && positive(identity.uid.value) && sourceCurrent(identity.source) && identity.source.method === 'index.login';
  const addSource = source => {
    if (!source || seen.has(source.responseRef)) return;
    seen.add(source.responseRef); sources.push({ responseRef: source.responseRef, observationRef: source.observationRef || null,
      method: source.method, connectionEpoch: source.connectionEpoch, requestSequence: source.requestSequence, wireKey: source.wireKey });
  };
  const scalar = cell => currentCell(cell) ? (addSource(cell.source), cell.value) : null;
  const optional = (cell, validate, fallback = null) => absent(cell) ? { valid: true, value: fallback }
    : knownOrderFlowerCell(cell) && validate(cell.value) ? { valid: true, value: cell.value } : { valid: false, value: null };
  function condition(value, depth = 0) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 64 || depth > 6) return null;
    if (value[0] === 'And' || value[0] === 'Or') return merge(value.slice(1).map(one => condition(one, depth + 1)), value[0] === 'Or');
    if (value.length !== 2) return null;
    const limit = threshold(value[1]); if (limit === null) return null;
    if (value[0] === '$cultivatedNum') {
      const group = inputs?.cultivated, count = scalar(group?.map);
      if (!currentCell(group?.domain) || !plainObject(count) || !nonnegative(count.observedCultivatedNum)) return null;
      // A partial provided map can prove >= using enough explicit current own
      // rows. Its missing members can never prove a total of zero or < limit.
      if (count.observedCultivatedNum >= limit) return true;
      return count.populationComplete === true && count.decodedComplete === true ? false : null;
    }
    if (value[0] === '$fashionCoinNum') {
      const group = inputs?.fashionHistory;
      if (!currentCell(group?.domain) || scalar(group?.uid) !== identity.uid.value || scalar(group?.type) !== 4) return null;
      const map = scalar(group?.valueMap);
      if (!plainObject(map) || map.sourceProvidedPropertyComplete !== true || typeof map.has1106 !== 'boolean') return null;
      // Only absence inside this actually supplied, valid valueMap has the
      // client's ||0 meaning. Missing rcdMap/row/property is still unknown.
      const amount = map.has1106 ? map.value1106 : 0;
      return nonnegative(amount) ? amount >= limit : null;
    }
    if (value[0] === '$mainTask') {
      const group = inputs?.mainTask;
      if (!currentCell(group?.domain) || scalar(group.uid) !== identity.uid.value) return null;
      const id = scalar(group.curTaskId); return nonnegative(id) ? id > limit : null;
    }
    const cell = value[0] === '$lvl' ? inputs?.profile?.level : value[0] === '$vip' ? inputs?.profile?.vip : null;
    if (!cell || !currentCell(inputs?.profile?.domain) || scalar(inputs.profile.uid) !== identity.uid.value) return null;
    const amount = scalar(cell); return nonnegative(amount) ? amount >= limit : null;
  }
  function membership(cell) {
    if (absent(cell)) return { present: false, value: null };
    const value = cell.value;
    return knownOrderFlowerCell(cell) && plainObject(value) && value.targetKnown === true && typeof value.matches === 'boolean' && nonnegative(value.total)
      ? { present: true, value: value.matches } : { present: true, value: null };
  }
  function pair(ext, white, black) {
    const allow = membership(ext[white]); if (allow.present) return allow.value;
    const deny = membership(ext[black]); return deny.present ? deny.value === null ? null : !deny.value : true;
  }
  function extension(cell) {
    if (absent(cell)) return true;
    if (!knownOrderFlowerCell(cell) || !plainObject(cell.value)) return null;
    const ext = cell.value, checks = [pair(ext, 'whiteUids', 'blackUids'), pair(ext, 'whiteChns', 'blackChns')], close = membership(ext.closeChnId);
    checks.push(close.present ? close.value === null ? null : !close.value : true);
    const duration = optional(ext.duration, value => Array.isArray(value) && value.length <= 2, []);
    if (!duration.valid) checks.push(null);
    else if (duration.value.length === 2) {
      const start = threshold(duration.value[0]), end = threshold(duration.value[1]);
      if (start === null || end === null || start >= end || clock?.available !== true || clock.source !== 'official-anchor-monotonic' ||
        clock.connectionEpoch !== context.connectionEpoch || !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs) || clock.lowerBoundMs > clock.upperBoundMs) checks.push(null);
      else checks.push(clock.lowerBoundMs >= start && clock.upperBoundMs < end ? true : clock.upperBoundMs < start || clock.lowerBoundMs >= end ? false : null);
    }
    return merge(checks);
  }
  function staticRow(name) {
    if (typeof catalog?.open !== 'function') return null;
    const row = sync(catalog.open(name)); if (!plainObject(row) || row.id !== name) return null;
    const out = {};
    for (const [from, to] of [['lvl', 'level'], ['vip', 'vip'], ['isOr', 'isOr'], ['isCndOr', 'isCndOr'], ['cnd', 'conditions'], ['closed', 'closed']]) {
      if (Object.hasOwn(row, from)) out[to] = scalarCell(row[from]);
    }
    // The audited order/butler static rows have no ext. Future/unreviewed static ext
    // is unknown; it cannot silently become an unrestricted static fallback.
    if (Object.hasOwn(row, 'ext')) out.ext = { presence: 'present', state: 'unreadable', value: null };
    return out;
  }
  function open(openId) {
    const kind = openId === 'sys_orderSatins' || openId === 'share_orderSatins' ? 'satin'
      : openId === 'sys_orderDecorate' || openId === 'share_orderDecorate' ? 'decorate' : 'resident';
    const actionSource = { ...sourceBase, openId }, unknown = reasonCode => ({ known: false, value: null, context,
      officialUid: identityCurrent ? identity.uid.value : null, openId, source: actionSource, reasonCode, proofRef: null });
    if (!identityCurrent || !inputs) return unknown('ORDER_OPEN_CURRENT_LOGIN_REQUIRED');
    const actionProof = catalogIdentity?.sourceProofs?.[actionFor(kind)];
    if (!catalogKnown || !catalog?.definition?.(kind) || dynamic && (!actionProof || actionProof.supported !== true ||
      actionProof.sourceVersion !== catalogIdentity.gameVersion || actionProof.protocolVersion !== catalogIdentity.protocolVersion)) return unknown('ORDER_OPEN_CATALOG_SOURCE_UNPROVEN');
    const entry = inputs.serverOpenMap?.[openId], map = inputs.serverOpenMap?.map;
    let row, sourceKind, responseRef;
    if (sourceCurrent(entry?.source) && entry.presence !== 'missing') {
      addSource(entry.source);
      if (entry.current !== true || !knownOrderFlowerCell(entry) || !plainObject(entry.value)) return unknown('ORDER_OPEN_SERVER_OVERRIDE_UNREADABLE');
      row = entry.value; sourceKind = 'current-observed-server-override'; responseRef = entry.source.responseRef;
      if (!absent(row.name) && (!knownOrderFlowerCell(row.name) || row.name.value !== openId)) return unknown('ORDER_OPEN_SERVER_NAME_CONFLICT');
    } else {
      if (sourceCurrent(map?.source) && map.presence !== 'missing' && (map.current !== true || !knownOrderFlowerCell(map))) return unknown('ORDER_OPEN_SERVER_MAP_UNREADABLE');
      row = staticRow(openId); if (!row) return unknown('ORDER_OPEN_STATIC_RULE_NOT_AUDITED');
      sourceKind = 'fresh-client-empty-open-map-static-fallback'; responseRef = identity.source.responseRef;
      addSource(identity.source); if (currentCell(map)) addSource(map.source);
    }
    const finish = (value, reasonCode) => {
      const body = { known: value !== null, value, context, officialUid: identity.uid.value, openId,
        source: { ...actionSource, kind: sourceKind, responseRef, serverAbsoluteOpenProven: false }, reasonCode };
      return { ...body, proofRef: 'order-open-proof:' + fingerprint(body) };
    };
    const closed = optional(row.closed, boolLike, false);
    if (!closed.valid) return finish(null, 'ORDER_OPEN_CLOSED_FLAG_UNREADABLE');
    if (closed.value) return finish(false, 'ORDER_OPEN_EXPLICITLY_CLOSED');
    const ext = extension(row.ext);
    if (ext === false) return finish(false, 'ORDER_OPEN_CHANNEL_UID_OR_TIME_RESTRICTED');
    const isOr = optional(row.isOr, boolLike, false), isCndOr = optional(row.isCndOr, boolLike, false);
    if (!isOr.valid || !isCndOr.valid) return finish(null, 'ORDER_OPEN_CONDITION_OPERATOR_UNREADABLE');
    const checks = [];
    for (const [key, conditionId] of [['level', '$lvl'], ['vip', '$vip']]) if (!absent(row[key])) checks.push(knownOrderFlowerCell(row[key]) ? condition([conditionId, row[key].value]) : null);
    if (!absent(row.conditions)) checks.push(knownOrderFlowerCell(row.conditions) && Array.isArray(row.conditions.value)
      ? merge(row.conditions.value.map(one => condition(one)), !!isCndOr.value) : null);
    const value = merge([ext, merge(checks, !!isOr.value)]);
    return finish(value, value === true ? 'ORDER_OBSERVED_OFFICIAL_CLIENT_INPUTS_OPEN' : value === false ? 'ORDER_OPEN_CURRENT_CONDITION_NOT_MET' : 'ORDER_OPEN_REQUIRED_DEPENDENCY_UNKNOWN');
  }
  const body = { version: VERSION, context, current: !!identityCurrent, officialUid: identityCurrent ? identity.uid.value : null,
    resident: open('sys_orderFlower'), satin: open('sys_orderSatins'), decorate: open('sys_orderDecorate'),
    video: { resident: open('share_Order'), satin: open('share_orderSatins'), decorate: open('share_orderDecorate') },
    butlerOpen: open('butler'), sources, automaticExecutionAbsent: { known: false, value: null,
      reasonCode: 'OPEN_FLAGS_DO_NOT_PROVE_NO_OFFICIAL_BUTLER_CONCURRENCY' }, readOnly: true, writeEligible: false };
  return freeze({ ...body, proofFingerprint: fingerprint(body) });
}

export function createOrderFlowerEligibility({ catalog, isCurrent, clock = null } = {}) {
  for (const fn of [catalog?.open, catalog?.identity, isCurrent]) if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Order eligibility requires synchronous catalog/current ports');
  if (clock !== null && (typeof clock !== 'function' || clock.constructor?.name === 'AsyncFunction')) throw new TypeError('Order eligibility clock port must be synchronous');
  return Object.freeze({ evaluate(input = {}) {
    const context = orderFlowerContext(input.context), active = !!context && sync(isCurrent(context)) === true;
    const result = evaluateOrderFlowerEligibility({ ...input, context, catalog, view: active ? input.view : { ...input.view, current: false },
      clock: input.clock ?? (context && clock ? sync(clock(context.subjectRef)) : null) });
    if (!context || sync(isCurrent(context)) !== true) return evaluateOrderFlowerEligibility({ ...input, context, catalog, view: { ...input.view, current: false } });
    return result;
  } });
}
