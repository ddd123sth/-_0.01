import { fingerprint, freeze, plainObject } from '../../common.mjs';
import { customerContext, customerContextKey, knownCustomerCell, sameCustomerContext } from './wire-facts.mjs';
import { officialActionContractId } from '../../official-version-profile.mjs';

// Static, version-locked inputs only. G480 OpenCtrl [261733,263310),
// SysOpenCtrl $mainTask@688390 / SDK channel+duration@689565 (UTF-8 bytes).
// c_open SHA256 2fb8bebd16b7344749daa58946e2acbabeb5f92998454fda700ace5c1aaee0eb:
// sys_orderCustomer has ONLY cnd=[['$mainTask','90001']]; static butler
// has lvl=35,closed=1. A supplied server row replaces the chosen static row.
const STATIC_SOURCE = Object.freeze({ gameVersion: '480.0.27', protocolVersion: '480.0.0',
  gameDecodedSha256: 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69',
  openTableSha256: '2fb8bebd16b7344749daa58946e2acbabeb5f92998454fda700ace5c1aaee0eb',
  mainTaskOperator: 'strict-greater-than', scope: 'observed-official-client-input-evaluation-not-server-absolute-permission' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const absent = cell => !cell || cell.presence === 'missing' || cell.presence === 'null';
const merge = (values, or = false) => values.length === 0 ? true : or
  ? values.some(value => value === true) ? true : values.every(value => value === false) ? false : null
  : values.some(value => value === false) ? false : values.every(value => value === true) ? true : null;

// Pure evaluation. No RPC, owner acquisition, automatic-executor assertion,
// reservation or current-write capability is created by this result.
export function evaluateCustomerEligibility({ context: supplied, view, clock, catalog = null, additionalOpenId = null } = {}) {
  const context = customerContext(supplied), inputs = view?.eligibilityInputs;
  const identity = view?.identity, sources = [], seenSources = new Set();
  const catalogIdentity = typeof catalog?.identity === 'function' ? catalog.identity() : null;
  const dynamic = catalogIdentity?.catalogId?.startsWith('official-public/data-snapshot/') === true;
  const sourceCurrent = source => !!context && source?.contextKey === customerContextKey(context) && source.connectionEpoch === context.connectionEpoch &&
    source.kind === 'response' && source.transport === 'answered' && positive(source.requestSequence) && typeof source.responseRef === 'string' && source.responseRef.length > 0 && source.responseRef.length <= 512 &&
    typeof source.method === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(source.method) &&
    typeof source.wireKey === 'string' && /^ws\|\d+\|[1-9]\d*$/.test(source.wireKey) && Number(source.wireKey.split('|').at(-1)) === source.requestSequence &&
    source.version?.source === 'normal-package-hop-and-matched-world-login/v1' &&
    source.version.gameVersion === (catalogIdentity?.indexVersion ?? STATIC_SOURCE.gameVersion) &&
    source.version.protocolVersion === (catalogIdentity?.protocolVersion ?? STATIC_SOURCE.protocolVersion) &&
    source.version.loginResponseRef === identity?.source?.responseRef && (!dynamic || source.version.dataSnapshotId === catalogIdentity.dataSnapshotId &&
      catalogIdentity.loginResponseRef === identity?.source?.responseRef);
  const addSource = source => {
    if (!source || seenSources.has(source.responseRef)) return;
    seenSources.add(source.responseRef);
    sources.push({ observationRef: source.observationRef || null, responseRef: source.responseRef, method: source.method,
      connectionEpoch: source.connectionEpoch, requestSequence: source.requestSequence, wireKey: source.wireKey || null });
  };
  const currentCell = cell => cell?.current === true && knownCustomerCell(cell) && sourceCurrent(cell.source);
  const identityCurrent = !!context && sameCustomerContext(context, view?.context) && identity?.verified === true &&
    currentCell(identity.uid) && positive(identity.uid.value) && sourceCurrent(identity.source) && identity.source.method === 'index.login';
  const scalar = cell => currentCell(cell) ? (addSource(cell.source), cell.value) : null;
  function optional(cell, validate, fallback = null) {
    if (absent(cell)) return { valid: true, value: fallback };
    return knownCustomerCell(cell) && validate(cell.value) ? { valid: true, value: cell.value } : { valid: false, value: null };
  }
  const threshold = value => nonnegative(value) ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) && nonnegative(Number(value)) ? Number(value) : null;
  function condition(value, depth = 0) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 64 || depth > 6) return null;
    if (value[0] === 'And' || value[0] === 'Or') return merge(value.slice(1).map(one => condition(one, depth + 1)), value[0] === 'Or');
    if (value.length !== 2) return null;
    const limit = threshold(value[1]);
    if (limit === null) return null;
    if (value[0] === '$mainTask') {
      const task = inputs.mainTask;
      if (!currentCell(task?.domain) || scalar(task.uid) !== identity.uid.value) return null;
      const current = scalar(task.curTaskId);
      return nonnegative(current) ? current > limit : null;
    }
    const cell = value[0] === '$lvl' ? inputs.profile?.level : value[0] === '$vip' ? inputs.profile?.vip : null;
    if (!cell || !currentCell(inputs.profile?.domain)) return null;
    const current = scalar(cell);
    return nonnegative(current) ? current >= limit : null;
  }
  function membership(cell) {
    if (absent(cell)) return { present: false, value: null };
    const value = cell.value;
    return knownCustomerCell(cell) && plainObject(value) && value.targetKnown === true && typeof value.matches === 'boolean' && nonnegative(value.total)
      ? { present: true, value: value.matches } : { present: true, value: null };
  }
  function pair(ext, white, black) {
    const allow = membership(ext[white]);
    if (allow.present) return allow.value;
    const deny = membership(ext[black]);
    return deny.present ? deny.value === null ? null : !deny.value : true;
  }
  function extension(cell) {
    if (absent(cell)) return true;
    if (!knownCustomerCell(cell) || !plainObject(cell.value)) return null;
    const ext = cell.value, values = [pair(ext, 'whiteUids', 'blackUids'), pair(ext, 'whiteChns', 'blackChns')];
    const close = membership(ext.closeChnId);
    values.push(close.present ? close.value === null ? null : !close.value : true);
    const duration = optional(ext.duration, value => Array.isArray(value) && value.length <= 2, []);
    if (!duration.valid) values.push(null);
    else if (duration.value.length === 2) {
      const start = threshold(duration.value[0]), end = threshold(duration.value[1]);
      if (start === null || end === null || start >= end || clock?.available !== true || clock.connectionEpoch !== context.connectionEpoch ||
          clock.source !== 'official-anchor-monotonic' || !Number.isFinite(clock.lowerBoundMs) || !Number.isFinite(clock.upperBoundMs)) values.push(null);
      else values.push(clock.lowerBoundMs >= start && clock.upperBoundMs < end ? true : clock.upperBoundMs < start || clock.lowerBoundMs >= end ? false : null);
    }
    // begin/end periods and extra unrecognised ext keys are NOT read by the
    // isOpen helper. They cannot create an invented gate or prove no hiring.
    return merge(values);
  }
  function open(name) {
    const unknown = reasonCode => ({ known: false, value: null, source: { ...STATIC_SOURCE, name }, reasonCode });
    if (!identityCurrent || !inputs) return unknown('CUSTOMER_ELIGIBILITY_CURRENT_LOGIN_UNVERIFIED');
    const listed = inputs.serverOpenMap?.entries;
    const mappedEntry = knownCustomerCell(listed) && listed.current === true && plainObject(listed.value?.[name])
      ? { ...listed.value[name], source: listed.source, current: listed.current } : null;
    const entry = inputs.serverOpenMap?.[name] ?? mappedEntry, map = inputs.serverOpenMap?.map;
    let row, sourceKind;
    if (sourceCurrent(entry?.source) && entry.presence !== 'missing') {
      addSource(entry.source);
      if (entry.current !== true || !knownCustomerCell(entry) || !plainObject(entry.value)) return unknown('CUSTOMER_SERVER_OPEN_OVERRIDE_UNREADABLE');
      row = entry.value; sourceKind = 'current-observed-server-override';
    } else {
      if (sourceCurrent(map?.source) && map.presence !== 'missing' && (map.current !== true || !knownCustomerCell(map))) return unknown('CUSTOMER_SERVER_OPEN_MAP_UNREADABLE');
      addSource(identity.source); if (currentCell(map)) addSource(map.source);
      sourceKind = 'fresh-client-empty-open-map-static-fallback';
      if (dynamic) {
        const rule = catalog?.open?.(name);
        if (!plainObject(rule) || rule.id !== name) return unknown('CUSTOMER_CURRENT_OPEN_CATALOG_RULE_UNREADABLE');
        row = Object.fromEntries([['lvl', 'level'], ['vip', 'vip'], ['isOr', 'isOr'], ['isCndOr', 'isCndOr'],
          ['cnd', 'conditions'], ['closed', 'closed'], ['ext', 'ext']].filter(([key]) => Object.hasOwn(rule, key))
          .map(([key, target]) => [target, { presence: 'present', state: 'known', value: rule[key] }]));
      } else {
        row = name === 'sys_orderCustomer' ? { conditions: { presence: 'present', state: 'known', value: [['$mainTask', '90001']] } }
          : { closed: { presence: 'present', state: 'known', value: 1 } };
      }
    }
    const action = name === 'sys_orderCustomer' ? 'customer.generate' : name === 'sys_waterwheel' || name === 'sys_freeWater' || name === additionalOpenId ? null : 'customer.finish';
    const proof = action === null ? null : catalogIdentity?.sourceProofs?.[action];
    if (dynamic && action !== null && (proof?.supported !== true || proof.actionContractId !== officialActionContractId(action) ||
        proof.sourceVersion !== catalogIdentity.indexVersion || proof.protocolVersion !== catalogIdentity.protocolVersion)) {
      return unknown('CUSTOMER_OPEN_ACTION_SOURCE_UNPROVEN');
    }
    const source = { ...(dynamic ? { gameVersion: catalogIdentity.indexVersion, protocolVersion: catalogIdentity.protocolVersion,
      dataSnapshotId: catalogIdentity.dataSnapshotId, tableSha256: catalogIdentity.tableSha256?.c_open,
      sourceProof: proof } : STATIC_SOURCE), name, kind: sourceKind, serverAbsoluteOpenProven: false,
      responseRef: sourceKind === 'current-observed-server-override' ? entry.source.responseRef : identity.source.responseRef };
    const finish = (value, reasonCode) => ({ known: value !== null, value, source, reasonCode });
    const closed = optional(row.closed, value => typeof value === 'boolean' || value === 0 || value === 1, false);
    if (!closed.valid) return finish(null, 'CUSTOMER_OPEN_CLOSED_FLAG_UNREADABLE');
    if (closed.value) return finish(false, 'CUSTOMER_OPEN_EXPLICITLY_CLOSED');
    const ext = extension(row.ext);
    if (ext === false) return finish(false, 'CUSTOMER_OPEN_CHANNEL_UID_OR_TIME_RESTRICTED');
    const isOr = optional(row.isOr, value => typeof value === 'boolean' || value === 0 || value === 1, false);
    const isCndOr = optional(row.isCndOr, value => typeof value === 'boolean' || value === 0 || value === 1, false);
    if (!isOr.valid || !isCndOr.valid) return finish(null, 'CUSTOMER_OPEN_CONDITION_OPERATOR_UNREADABLE');
    const checks = [];
    for (const [key, field] of [['level', '$lvl'], ['vip', '$vip']]) {
      if (!absent(row[key])) checks.push(knownCustomerCell(row[key]) ? condition([field, row[key].value]) : null);
    }
    if (!absent(row.conditions)) checks.push(knownCustomerCell(row.conditions) && Array.isArray(row.conditions.value)
      ? merge(row.conditions.value.map(one => condition(one)), !!isCndOr.value) : null);
    const result = merge([ext, merge(checks, !!isOr.value)]);
    return finish(result, result === true ? 'OBSERVED_OFFICIAL_CLIENT_INPUTS_OPEN' : result === false ? 'CUSTOMER_OPEN_CURRENT_CONDITION_NOT_MET' : 'CUSTOMER_OPEN_REQUIRED_DEPENDENCY_UNKNOWN');
  }
  const customerOpen = open('sys_orderCustomer'), butlerOpen = open('butler'), baseSources = [...sources];
  const waterwheelOpen = open('sys_waterwheel'), freeWaterOpen = open('sys_freeWater');
  const body = { version: 'customer-eligibility/480.0.27/v1', context, current: Boolean(identityCurrent), customerOpen, butlerOpen,
    automaticExecutionAbsent: { known: false, value: null, reasonCode: 'BUTLER_SETTINGS_OR_MISSING_SETTINGS_DO_NOT_PROVE_NO_CONCURRENT_EXECUTION' },
    readOnly: true, writeEligible: false, sources: baseSources,
    clockBasis: clock?.available === true && context && clock.connectionEpoch === context.connectionEpoch ? {
      source: typeof clock.source === 'string' ? clock.source.slice(0, 80) : null, revision: nonnegative(clock.revision) ? clock.revision : null, connectionEpoch: clock.connectionEpoch,
      lowerBoundMs: Number.isFinite(clock.lowerBoundMs) ? clock.lowerBoundMs : null, upperBoundMs: Number.isFinite(clock.upperBoundMs) ? clock.upperBoundMs : null } : null };
  const additionalOpen = typeof additionalOpenId === 'string' && additionalOpenId.length > 0 && additionalOpenId.length <= 64
    ? open(additionalOpenId) : null;
  return freeze({ ...body, proofFingerprint: fingerprint(body), waterwheelOpen: { ...waterwheelOpen,
    proofFingerprint: fingerprint(waterwheelOpen) }, freeWaterOpen: { ...freeWaterOpen, proofFingerprint: fingerprint(freeWaterOpen) },
    ...(additionalOpen ? { additionalOpen: { ...additionalOpen, proofFingerprint: fingerprint(additionalOpen) } } : {}) });
}
