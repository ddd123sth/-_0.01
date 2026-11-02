import { fingerprint, plainObject } from '../common.mjs';
import { officialDateMs, decodeOfficialLandObservation, knownCell } from '../features/land/wire-facts.mjs';
import { isNormalSyncMethod } from './normal-sync-contract.mjs';
import { officialAbsoluteBagPatch } from '../resources/official-items.mjs';

const semanticValue = value => {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['source', 'lastSource', 'sourceRef', 'responseRef', 'observationRef', 'current', 'revision', 'semanticVersion', 'context', 'coverage'].includes(key))
    .map(([key, child]) => [key, semanticValue(child)]));
  return value;
};

function currentLoginMissingCustomerOpenOverride(context, observation, view) {
  if (observation?.method !== 'index.login' || observation.source !== 'response' || observation.transport !== 'answered' ||
      observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' || !observation.responseRef ||
      !Number.isSafeInteger(observation.requestSequence) || observation.requestSequence <= 0 ||
      !Number.isSafeInteger(observation.receivedDeviceMs) || !Number.isFinite(observation.receivedMonotonicMs) ||
      view?.current !== true || view.identity?.verified !== true ||
      !view.context || ['ownerRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
        .some(key => view.context[key] !== context[key]) || String(view.context.accountRef) !== String(context.accountRef) ||
      view.identity.uid?.presence !== 'present' || view.identity.uid.state !== 'known' || view.identity.uid.current !== true ||
      !Number.isSafeInteger(view.identity.uid.value) || view.identity.uid.value <= 0 || view.identity.uid.source?.responseRef !== observation.responseRef ||
      view.identity.source?.responseRef !== observation.responseRef || view.versionBinding?.loginResponseRef !== observation.responseRef) return null;

  const serverOpenMap = view.eligibilityInputs?.serverOpenMap;
  const map = serverOpenMap?.map, entries = serverOpenMap?.entries;
  const sameLoginSource = cell => cell?.presence === 'present' && cell.state === 'known' && cell.current === true &&
    cell.source?.responseRef === observation.responseRef && cell.source?.method === 'index.login' &&
    cell.source?.connectionEpoch === context.connectionEpoch && cell.source?.requestSequence === observation.requestSequence &&
    cell.source?.receivedDeviceMs === observation.receivedDeviceMs &&
    cell.source?.receivedMonotonicMs === observation.receivedMonotonicMs;
  if (!sameLoginSource(map) || !sameLoginSource(entries) || !plainObject(map.value) || !plainObject(entries.value)) return null;

  const user = observation.value?.['7'], rawOpenMap = plainObject(user) ? user['9'] : null;
  if (!plainObject(rawOpenMap) || Object.hasOwn(rawOpenMap, 'sys_orderCustomer') || Object.hasOwn(entries.value, 'sys_orderCustomer')) return null;
  const rawKeys = Object.keys(rawOpenMap).sort(), projectedKeys = Object.keys(entries.value).sort(), total = rawKeys.length;
  if (total > 4096 || rawKeys.length !== projectedKeys.length || rawKeys.some((key, index) => key !== projectedKeys[index]) ||
      map.value.total !== total || entries.total !== total || map.value.reportedEmpty !== (total === 0) ||
      entries.reportedEmpty !== (total === 0)) return null;

  const direct = serverOpenMap.sys_orderCustomer;
  if (direct?.current === true && direct.presence !== 'missing') return null;
  return { presence: 'missing', state: 'unobserved', value: null, current: true,
    reasonCode: 'CUSTOMER_OPEN_OVERRIDE_NOT_LISTED_IN_CURRENT_LOGIN', source: entries.source };
}

const sameCausalSource = (source, observation) => !!source &&
  source.sourceRef === observation.responseRef && source.method === observation.method &&
  source.requestSequence === observation.requestSequence && source.connectionEpoch === observation.connectionEpoch &&
  source.observedAtMs === observation.receivedDeviceMs && source.observedMonotonicMs === observation.receivedMonotonicMs;

// Non-admission post-write diagnostics for the single-target land actions.
// REVIEW 03: these objects never clear a barrier. They report which fields are
// proven by this exact matched response and which are still missing. Inventory
// is limited to water's contract-fixed item 7 bag value; plant/harvest impact
// sets remain UNPROVEN and itemExt fields can never be derived from bd.
export function postWriteCoverage({ domainId, item, observation, target } = {}) {
  if (!item || !observation || !target || item.domainId !== domainId) return null;
  if (observation.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
      observation.dsName !== 'G.ISyncData' || observation.rejected === true || !Number.isSafeInteger(observation.requestSequence) ||
      observation.requestSequence <= 0 || typeof observation.responseRef !== 'string' || !observation.responseRef) return null;
  for (const value of [observation.value?.['7'], observation.value?.['100'], observation.value?.['101'],
      observation.value?.['7']?.['0'], observation.value?.['7']?.['2'], observation.value?.['7']?.['3']])
    if (value !== undefined && !plainObject(value)) return null;
  const causal = path => sameCausalSource(item.cellSources?.[path], observation);
  const proven = [], gaps = [];
  const rawFrame = target.context ? decodeOfficialLandObservation({ context:target.context, observation }) : null;
  const requirePath = (path, rawCell = null, explicitEmptyReplacement = false) => {
    if (!item.paths.includes(path) || !Object.hasOwn(item.semanticValue,path) || !causal(path)) { gaps.push(path); return false; }
    if (!rawCell || !['present','null',...(explicitEmptyReplacement?['missing']:[])].includes(rawCell.presence) || rawCell.presence==='present' && !knownCell(rawCell)) {
      gaps.push(path+':raw-value-unproven'); return false;
    }
    const rawValue = knownCell(rawCell) ? semanticValue(rawCell.value) : {presence:rawCell.presence};
    if (fingerprint(rawValue)!==fingerprint(item.semanticValue[path])) { gaps.push(path+':raw-value-mismatch'); return false; }
    proven.push(path); return true;
  };
  if (domainId === 'land') {
    const changes = knownCell(rawFrame?.landChanges) ? rawFrame.landChanges.value : knownCell(rawFrame?.landBase) ? rawFrame.landBase.value : null;
    const member = changes?.[String(target.landId)];
    // A PROVIDED {} is the audited land member-replacement/empty shape. Bind
    // its missing-valued cells as absence, never fabricate state/flower/count
    // zeros. Omitted members and ordinary partial rows still cannot do this.
    const before = target.workset?.before;
    const explicitHarvestEmpty = target.featureId==='harvest' && member?.valid===true && member.explicitEmptyObject===true &&
      before?.landId===target.landId && before.status==='occupied' && Number.isSafeInteger(before.flowerId) && before.flowerId>0 &&
      typeof before.cropRef==='string' && before.cropRef.length>0;
    if (!changes || [rawFrame?.landChanges,rawFrame?.landBase].some(map=>knownCell(map) &&
        Object.keys(map.value).some(id=>id!==String(target.landId)))) gaps.push('LAND_RESPONSE_IMPACT_SET_UNPROVEN');
    const checks = target.fields.map(field => requirePath(`land.lands.${target.landId}.fields.${field}`,member?.fields?.[field],explicitHarvestEmpty));
    const complete = checks.every(Boolean) && gaps.length===0;
    return Object.freeze({ domainId, basis: explicitHarvestEmpty?'land-post-write-explicit-empty/v1':'land-post-write-target/v1', admission: 'none', proven: complete,
      paths: [...new Set(proven)].sort(), gaps: [...new Set(gaps)].sort() });
  }
  const usrFields = observation.value?.['7']?.['0'];
  const profileFlow = observation.value?.['7']?.['2'];
  const unchangedProfileFlow = profileFlow === undefined || plainObject(profileFlow) &&
    Object.keys(profileFlow).every(key => ['0','1','2'].includes(key)) &&
    officialAbsoluteBagPatch(observation.value).available === true &&
    ['0','1','2'].every(key => !['1','2','3','11'].some(id => Object.hasOwn(profileFlow[key] ?? {}, id)));
  const unchangedDomain = domainId === 'profile' && unchangedProfileFlow && (usrFields === undefined || plainObject(usrFields) &&
      Object.keys(usrFields).every(key => ['32','33'].includes(key))) &&
      !['1','2','3','11'].some(id => Object.hasOwn(observation.value?.['7']?.['2']?.['2'] ?? {}, id)) ||
    domainId === 'cultivation' && rawFrame?.cultivates?.presence === 'missing' ||
    domainId === 'land-top' && rawFrame?.top?.presence === 'missing';
  if (['plant','water'].includes(target.featureId) && unchangedDomain && item.complete === true)
    return Object.freeze({ domainId, basis: domainId + '-no-update/v1', admission: 'none', proven: true,
      paths: [...item.paths].sort(), gaps: [] });
  if (domainId === 'cultivation') {
    if (target.featureId !== 'plant' || !Number.isSafeInteger(target.flowerId) || target.flowerId <= 0) return null;
    const checks = [`cultivation.cultivates.${target.flowerId}.fields.lvl`,
      `cultivation.cultivates.${target.flowerId}.fields.status`].map(path => requirePath(path,
      rawFrame?.cultivates?.value?.[String(target.flowerId)]?.fields?.[path.split('.').at(-1)]));
    const complete = checks.every(Boolean);
    return Object.freeze({ domainId, basis: 'cultivation-post-write-target/v1', admission: 'none', proven: complete,
      paths: [...new Set(proven)].sort(), gaps: [...new Set(gaps)].sort() });
  }
  if (domainId === 'land-top') {
    const complete = requirePath('land-top.top',rawFrame?.top);
    return Object.freeze({ domainId, basis: 'land-top-post-write/v1', admission: 'none', proven: complete,
      paths: [...new Set(proven)].sort(), gaps: [...new Set(gaps)].sort() });
  }
  if (domainId !== 'inventory') return null;
  const unproven = gaps => Object.freeze({ domainId, basis: 'inventory-impact-set-unproven/v1', admission: 'none',
    proven: false, paths: [], gaps: Object.freeze([...new Set(gaps)]), detail: Object.freeze(effectSource) });
  // Keep the raw effect inventory beside the verdict. Sparse maps are not a
  // complete effect set, even when one absolute balance is already proven.
  const rawEffects = Object.fromEntries(['bag', 'itemExt', 'bi', 'bo', 'bd', 'harvestMap'].map(name => {
    const cell = rawFrame?.[name];
    return [name, { presence: cell?.presence ?? 'missing', state: cell?.state ?? 'unobserved',
      fingerprint: knownCell(cell) ? fingerprint(cell.value) : null,
      members: knownCell(cell) && plainObject(cell.value) ? Object.keys(cell.value).sort().slice(0, 16) : [] }];
  }));
  const effectSource = { responseRef: observation.responseRef, requestSequence: observation.requestSequence,
    connectionEpoch: observation.connectionEpoch, method: observation.method, wireKey: observation.wireKey ?? null,
    rawValueFingerprint: fingerprint(observation.value), rawEffects };
  if (target.featureId === 'plant' && observation.method === 'usrLand.plant' && item.complete === true &&
      ['bag','itemExt','bi','bo','bd','harvestMap'].every(name => rawFrame?.[name]?.presence === 'missing'))
    return Object.freeze({ domainId, basis: 'inventory-plant-no-update/v1', admission: 'none', proven: true,
      paths: [...item.paths].sort(), gaps: [], detail: Object.freeze(effectSource) });
  if (target.featureId !== 'water') return unproven(['INVENTORY_IMPACT_SET_UNPROVEN_FOR_ACTION']);
  if (item.complete !== true) return unproven(['INVENTORY_BASELINE_INCOMPLETE']);
  const rawFlow = observation.value?.['7']?.['2'], rawExtension = observation.value?.['7']?.['0']?.['33'];
  if (!plainObject(rawFlow) || Object.keys(rawFlow).some(key => !['0','1','2'].includes(key)) ||
      !plainObject(rawExtension) || Object.values(rawExtension).some(row => !plainObject(row) ||
        Object.keys(row).some(key => !['0','1','2','3','4','5'].includes(key))))
    return unproven(['WATER_EFFECT_UNKNOWN_WIRE_FIELDS']);
  const patch = officialAbsoluteBagPatch(observation.value);
  if (patch.available !== true) return unproven([patch.reasonCode || 'OFFICIAL_BAG_ABSOLUTE_PATCH_UNAVAILABLE']);
  if (!Object.hasOwn(patch.bd, '7')) return unproven(['WATER_ITEM7_ABSOLUTE_MISSING']);
  if (patch.described.length > 16 || patch.described.some(id => ['1','2','3','11'].includes(id)))
    return unproven(['WATER_NON_BAG_OR_OVERSIZE_EFFECT_SET']);
  if (!knownCell(rawFrame?.bo) || rawFrame.bo.value['7'] !== 1 ||
      Object.keys(rawFrame.bo.value).some(id => id !== '7') ||
      !knownCell(rawFrame?.bi) || Object.hasOwn(rawFrame.bi.value, '7') || rawFrame.bag.presence !== 'missing')
    return unproven(['WATER_EXACT_EFFECT_FLOW_UNPROVEN']);
  for (const id of patch.described) {
    const path = 'inventory.bag.items.' + id;
    if (!item.paths.includes(path) || !causal(path) || item.semanticValue[path] !== patch.bd[id]) gaps.push(path);
    else proven.push(path);
  }
  const causalBag = item.paths.filter(path => path.startsWith('inventory.bag.items.') && causal(path)).sort();
  const expectedBag = patch.described.map(id => 'inventory.bag.items.' + id).sort();
  if (fingerprint(causalBag) !== fingerprint(expectedBag)) gaps.push('WATER_BAG_EFFECT_SET_MISMATCH');
  // The existing catalog declares a PROVIDED IUsr.itemExtMap as a complete
  // property replacement. Bind its exact membership and every field, including
  // explicit semantic absence within a provided row. No zero is manufactured.
  const ext = rawFrame?.itemExt;
  if (!knownCell(ext) || !plainObject(ext.value) || !ext.value['7'] ||
      Object.keys(ext.value).length > 16 || !item.replaceCollections?.includes('inventory.itemExt.items') ||
      !causal('inventory.itemExt.complete')) gaps.push('WATER_ITEM_EXT_REPLACEMENT_UNPROVEN');
  const expectedExt = [];
  if (knownCell(ext)) for (const [id, row] of Object.entries(ext.value)) {
    if (row.valid !== true) { gaps.push('WATER_ITEM_EXT_ROW_INVALID:' + id); continue; }
    for (const [name, cell] of Object.entries(row.fields)) {
      const path = 'inventory.itemExt.items.' + id + '.fields.' + name;
      expectedExt.push(path); requirePath(path, cell, true);
    }
  }
  const actualExt = item.paths.filter(path => path.startsWith('inventory.itemExt.items.')).sort();
  if (fingerprint(actualExt) !== fingerprint(expectedExt.sort())) gaps.push('WATER_ITEM_EXT_MEMBERSHIP_MISMATCH');
  return Object.freeze({ domainId, basis: 'inventory-water-absolute-effects/v1', admission: 'none', proven: gaps.length === 0,
    paths: [...new Set(proven)].sort(), gaps: [...new Set(gaps)].sort(),
    detail: Object.freeze({ ...effectSource, effectItems: patch.described, absoluteBalances: patch.bd,
      extensionMembershipFingerprint: knownCell(ext) ? fingerprint(ext.value) : null }) });

}

export function buildTypedDynamicCoverage(context, observation, accepted = {}) {
  if (accepted?.land?.accepted !== true && accepted?.land?.coverageReplay !== true && accepted?.customer?.accepted !== true && accepted?.flowerOrders?.accepted !== true &&
      accepted?.flowerAuxiliary?.current !== true && accepted?.officialClock?.available !== true && accepted?.waterwheel !== true && accepted?.freeWater !== true &&
      accepted?.flowerRack?.accepted !== true && accepted?.customer?.accepted !== true && accepted?.specialOrders?.accepted !== true && accepted?.rewardClaims?.current !== true) return [];
  const entries = [], sourceRef = observation.responseRef, epoch = context.connectionEpoch;
  for (const kind of accepted.specialOrders?.kinds || []) {
    const snapshot = accepted.specialOrderViews?.[kind], domainId = 'special-order-' + kind;
    if (!['palace','team'].includes(kind) || snapshot?.current !== true || snapshot.source?.responseRef !== sourceRef) continue;
    const typed = {};
    for (const [key, cell] of Object.entries(snapshot.fields)) if (cell.state === 'known' && cell.source?.responseRef === sourceRef &&
      cell.source.connectionEpoch === epoch && cell.source.requestSequence === observation.requestSequence) typed[domainId + '.' + key] = cell.value;
    const paths = Object.keys(typed).sort(); if (!paths.length) continue;
    const source = { sourceRef, method: observation.method, connectionEpoch: epoch, requestSequence: observation.requestSequence,
      observedAtMs: observation.receivedDeviceMs, observedMonotonicMs: observation.receivedMonotonicMs };
    entries.push({ domainId, complete: Object.hasOwn(typed, domainId + '.uid'), paths, semanticValue: typed,
      cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(typed), observedAtMs: observation.receivedDeviceMs });
  }
  const cellsFrom = (value, prefix, output = {}, includePriorSource = false) => {
    if (!value || typeof value !== 'object') return output;
    if (value.presence && value.state && Object.hasOwn(value, 'value')) {
      const source = value.source;
      const hasTypedMeaning = value.presence === 'present' && value.state === 'known' && value.value !== undefined ||
        ['missing', 'null'].includes(value.presence);
      const semanticCell = value.presence === 'present' && value.state === 'known' ? semanticValue(value.value)
        : ['missing', 'null'].includes(value.presence) ? { presence: value.presence } : null;
      if (hasTypedMeaning && value.current !== false &&
          (includePriorSource || source?.responseRef === sourceRef) && source?.connectionEpoch === epoch && Number.isSafeInteger(source.receivedDeviceMs) &&
          Number.isFinite(source.receivedMonotonicMs)) {
          output[prefix] = { value: semanticCell, observedAtMs: source.receivedDeviceMs, observedMonotonicMs: source.receivedMonotonicMs, sourceRef: source.responseRef,
          requestSequence: source.requestSequence, connectionEpoch: source.connectionEpoch, method: source.method || null };
      }
      return output;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['source', 'lastSource', 'context', 'identity', 'current', 'revision', 'coverage'].includes(key)) continue;
      cellsFrom(child, prefix ? prefix + '.' + key : key, output, includePriorSource);
    }
    return output;
  };
  const requiredCurrent = (selected, path) => {
    let value = selected;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
      value = value[part];
    }
    if (!value || typeof value !== 'object' || value.current === false) return false;
    if (value.presence !== undefined || value.state !== undefined) {
      return value.presence === 'present' && value.state === 'known' && value.current === true &&
        (value.complete === undefined || value.complete === true) && (value.returnedComplete === undefined || value.returnedComplete === true);
    }
    return value.known === true;
  };
  const add = (domainId, model, selector = value => value, requiredPaths = []) => {
    if (!model) return;
    const selected = selector(model);
    const landNoUpdate = ['usrLand.plant','usrLand.water'].includes(observation.method) &&
      observation.source === 'response' && observation.transport === 'answered' && observation.envelopeOk === true &&
      observation.rejected !== true && ['profile','cultivation','land-top'].includes(domainId);
    const cells = cellsFrom(selected, domainId, {}, landNoUpdate), paths = Object.keys(cells).sort();
    // Completeness is a property of the accepted merged model. Coverage only
    // publishes cells supplied by this response, retaining each older cell's
    // original source and age in the coordinator.
    if (!paths.length) return;
    const complete = requiredPaths.every(path => requiredCurrent(selected, path)) &&
      (!['art-album', 'art-share'].includes(domainId) || requiredPaths.every(path => Object.hasOwn(cells, domainId + '.' + path)));
    const semanticValue = Object.fromEntries(paths.map(key => [key, cells[key].value]));
    entries.push({ domainId, complete, paths, semanticValue, cellSources: Object.fromEntries(paths.map(key => [key, {
      sourceRef: cells[key].sourceRef, method: cells[key].method, connectionEpoch: cells[key].connectionEpoch,
      requestSequence: cells[key].requestSequence, observedAtMs: cells[key].observedAtMs, observedMonotonicMs: cells[key].observedMonotonicMs }])), semanticFingerprint: fingerprint(semanticValue),
      observedAtMs: Math.min(...Object.values(cells).map(cell => cell.observedAtMs)) });
  };
  // `tasks`/`counters` are declared dynamic domains (every land write marks them
  // dirty), so they need a real publisher from the sync frame. Without it a
  // single write leaves the subject refreshing forever and blocks every feature.
  if (accepted?.taskCounters && plainObject(accepted.taskCounters.cells)) {
    const source = accepted.taskCounters.source;
    const usable = source && typeof source.responseRef === 'string' && source.connectionEpoch === epoch &&
      Number.isInteger(source.requestSequence) && Number.isSafeInteger(source.receivedDeviceMs) &&
      Number.isFinite(source.receivedMonotonicMs);
    if (usable) {
      for (const [domainId, groups] of Object.entries(accepted.taskCounters.cells)) {
        const cells = {}, cellSources = {};
        for (const [path, value] of Object.entries(groups)) {
          const fullPath = domainId + '.' + path;
          cells[fullPath] = value;
          cellSources[fullPath] = { sourceRef: source.responseRef, method: source.method || 'index.login',
            connectionEpoch: epoch, requestSequence: source.requestSequence,
            observedAtMs: source.receivedDeviceMs, observedMonotonicMs: source.receivedMonotonicMs };
        }
        const paths = Object.keys(cells).sort();
        if (!paths.length) continue;
        entries.push({ domainId, complete: true, paths, semanticValue: cells, cellSources,
          semanticFingerprint: fingerprint(cells), observedAtMs: source.receivedDeviceMs });
      }
    }
  }
  if (accepted?.rewardClaims?.current === true && plainObject(accepted.rewardClaims.values)) try {
    for (const [domainId, value] of Object.entries(accepted.rewardClaims.values)) {
      const source = accepted.rewardClaims.sources?.[domainId];
      if (!plainObject(value) || !source || typeof source.responseRef !== 'string' ||
          source.connectionEpoch !== epoch || !Number.isInteger(source.requestSequence)) continue;
      const path = domainId + '.state';
      const cellSource = { sourceRef: source.responseRef, method: source.method || 'index.login', connectionEpoch: epoch,
        requestSequence: source.requestSequence, observedAtMs: source.receivedDeviceMs, observedMonotonicMs: source.receivedMonotonicMs };
      entries.push({ domainId, complete: true, paths: [path], semanticValue: { [path]: value },
        cellSources: { [path]: cellSource }, semanticFingerprint: fingerprint({ [path]: value }),
        observedAtMs: source.receivedDeviceMs });
    }
  } catch { /* Reward coverage is optional: other domains remain publishable. */ }
  if (accepted.waterwheel === true && (['index.login', 'waterwheel.enter', 'waterwheel.recv', 'waterwheel.skip'].includes(observation.method) ||
      observation.method === 'usr.share') && observation.dsName === 'G.ISyncData') {
    const officialUid = accepted.landView?.current === true && accepted.landView.identity?.verified === true &&
      accepted.landView.identity.uid?.presence === 'present' && accepted.landView.identity.uid.state === 'known'
      ? accepted.landView.identity.uid.value : null;
    const sync = observation.value, raw = sync && typeof sync === 'object' ? (sync['114'] ?? sync.waterwheel) : null;
    if (Number.isSafeInteger(officialUid) && officialUid > 0 && raw && typeof raw === 'object' && !Array.isArray(raw) &&
        (raw.uid ?? raw['0']) === officialUid) {
      const names = { uid: '0', count: '1', advList: '2', rTime: '3', uTime: '4', cTime: '5', offlineNum: '6', calcTime: '7', maxNumTime: '8' };
      const values = {};
      let valid = true;
      for (const [name, index] of Object.entries(names)) {
        const value = Object.hasOwn(raw, name) ? raw[name] : raw[index];
        if (value === undefined) continue;
        if (['advList'].includes(name)) {
          if (!Array.isArray(value) || value.length > 128 || value.some(one => !Number.isSafeInteger(one) &&
              !(one && typeof one === 'object' && !Array.isArray(one) && Object.keys(one).length <= 8 &&
                Object.values(one).every(child => Number.isSafeInteger(child) || typeof child === 'boolean')))) { valid = false; break; }
          values[name] = value;
        } else if (value === null && ['rTime', 'uTime', 'cTime', 'calcTime', 'maxNumTime'].includes(name)) values[name] = null;
        else if (['rTime', 'uTime', 'cTime', 'calcTime', 'maxNumTime'].includes(name) && typeof value === 'string' && officialDateMs(value) !== null)
          values[name] = officialDateMs(value);
        else if (Number.isSafeInteger(value) && value >= 0) values[name] = value;
        else { valid = false; break; }
      }
      if (valid && Number.isSafeInteger(values.count) && Array.isArray(values.advList)) {
        const typed = Object.fromEntries(Object.entries(values).map(([key, value]) => [`waterwheel.fields.${key}`, value]));
        const user = sync && typeof sync === 'object' ? (sync['7'] ?? sync.usrTot) : null;
        const openMap = user && typeof user === 'object' ? (user.openMap ?? user['9']) : null;
        const open = openMap && typeof openMap === 'object' ? openMap.butler : null;
        const ext = open && typeof open === 'object' ? (open.ext ?? open['10']) : null;
        const settingTotal = sync && typeof sync === 'object' ? (sync['175'] ?? sync.butlerTot) : null;
        const settings = settingTotal && typeof settingTotal === 'object' ? (settingTotal.butlerSetting ?? settingTotal['0']) : null;
        const setting = settings && typeof settings === 'object' ? settings['1'] : null;
        const buyMap = setting && typeof setting === 'object' ? (setting.buyPeriodMap ?? setting['5']) : null;
        const closed = open && typeof open === 'object' ? (open.closed ?? open['9']) : undefined;
        const begins = Array.isArray(ext?.beginTime) && ext.beginTime.length <= 128 ? ext.beginTime.map(officialDateMs) : null;
        const ends = Array.isArray(ext?.endTime) && ext.endTime.length <= 128 ? ext.endTime.map(officialDateMs) : null;
        if ((closed === true || closed === false || closed === 0 || closed === 1) && begins && ends && begins.length === ends.length &&
            begins.every(Number.isSafeInteger) && ends.every(Number.isSafeInteger)) {
          typed['waterwheel.fields.hire.closed'] = closed === true || closed === 1;
          typed['waterwheel.fields.hire.beginMs'] = begins;
          typed['waterwheel.fields.hire.endMs'] = ends;
          const uid = setting?.uid ?? setting?.['0'], type = setting?.type ?? setting?.['1'];
          if (Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(type) && type > 0 && buyMap && typeof buyMap === 'object' && !Array.isArray(buyMap) &&
              Object.keys(buyMap).length <= 1024 && Object.entries(buyMap).every(([key, amount]) => /^\d{1,16}$/.test(key) &&
                Number.isSafeInteger(Number(key)) && Number.isSafeInteger(amount) && amount >= 0)) {
            typed['waterwheel.fields.hire.uid'] = uid; typed['waterwheel.fields.hire.type'] = type;
            typed['waterwheel.fields.hire.bought'] = buyMap;
          }
        }
        const paths = Object.keys(typed).sort(), source = { sourceRef, method: observation.method, connectionEpoch: epoch,
          requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
          observedMonotonicMs: observation.receivedMonotonicMs };
        entries.push({ domainId: 'waterwheel', complete: true, paths, semanticValue: typed,
          cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(typed),
          observedAtMs: observation.receivedDeviceMs });
      }
    }
    // Video eligibility is the distinct IShare.shareCnt field.  Publish only
    // an actual row-9 response; absence from a sparse map is not zero-count
    // evidence.  uTime is required so the feature can apply the official-day
    // reset rule without consulting device-local time.
    const shareTotal = sync && typeof sync === 'object' ? (sync['31'] ?? sync.shareTot) : null;
    const shareMap = shareTotal && typeof shareTotal === 'object' ? (shareTotal.map ?? shareTotal['0'] ?? null) : null;
    const share9 = shareMap && typeof shareMap === 'object' ? shareMap['9'] : null;
    if (share9 && typeof share9 === 'object' && !Array.isArray(share9)) {
      const read = (name, index) => Object.hasOwn(share9, name) ? share9[name] : share9[index];
      const shareCnt = read('shareCnt', '2'), rawUTime = read('uTime', '6'), uTime = rawUTime === null ? null : officialDateMs(rawUTime);
      if (Number.isSafeInteger(shareCnt) && shareCnt >= 0 && Number.isSafeInteger(uTime) && uTime >= 0) {
        const typed = { 'waterwheel-share.share9.present': true, 'waterwheel-share.share9.uid': read('uid', '0'),
          'waterwheel-share.share9.tmpId': read('tmpId', '1'), 'waterwheel-share.share9.shareCnt': shareCnt,
          'waterwheel-share.share9.uTime': uTime };
        const wheelUid = raw && typeof raw === 'object' ? (raw.uid ?? raw['0']) : null;
        if (Number.isSafeInteger(typed['waterwheel-share.share9.uid']) && typed['waterwheel-share.share9.uid'] === wheelUid &&
            typed['waterwheel-share.share9.tmpId'] === 9) {
          const paths = Object.keys(typed).sort(), source = { sourceRef, method: observation.method, connectionEpoch: epoch,
            requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
            observedMonotonicMs: observation.receivedMonotonicMs };
          entries.push({ domainId: 'waterwheel-share', complete: true, paths, semanticValue: typed,
            cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(typed),
            observedAtMs: observation.receivedDeviceMs });
        }
      }
    }
    const usrTotal = sync && typeof sync === 'object' ? (sync['7'] ?? sync.usrTot) : null;
    const usr = usrTotal && typeof usrTotal === 'object' ? (usrTotal.usr ?? usrTotal['0']) : null;
    const usrUid = usr && typeof usr === 'object' ? (usr.uid ?? usr['0']) : null;
    const bag = usr && typeof usr === 'object' ? (usr.bag ?? usr['32']) : null;
    const item7 = bag && typeof bag === 'object' ? bag['7'] : null;
    const wheelUid = raw && typeof raw === 'object' ? (raw.uid ?? raw['0']) : null;
    if (Number.isSafeInteger(usrUid) && usrUid > 0 && usrUid === wheelUid && Number.isSafeInteger(item7) && item7 >= 0) {
      const typed = { 'waterwheel-item.item7.balance': item7 };
      const paths = Object.keys(typed), source = { sourceRef, method: observation.method, connectionEpoch: epoch,
        requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
        observedMonotonicMs: observation.receivedMonotonicMs };
      entries.push({ domainId: 'waterwheel-item', complete: true, paths, semanticValue: typed,
        cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(typed),
        observedAtMs: observation.receivedDeviceMs });
    }
  }
  if (accepted.freeWater === true && ['index.login', 'freeWater.recv', 'usr.share'].includes(observation.method) && observation.dsName === 'G.ISyncData') {
    const officialUid = accepted.landView?.current === true && accepted.landView.identity?.verified === true &&
      accepted.landView.identity.uid?.presence === 'present' && accepted.landView.identity.uid.state === 'known'
      ? accepted.landView.identity.uid.value : null;
    const sync = observation.value && typeof observation.value === 'object' ? observation.value : null;
    const row = sync?.['117'] ?? sync?.freeWater;
    if (Number.isSafeInteger(officialUid) && officialUid > 0 && row && typeof row === 'object' && !Array.isArray(row) &&
        (row.uid ?? row['0']) === officialUid && Array.isArray(row.recvIdx ?? row['1']) &&
        (row.recvIdx ?? row['1']).length <= 2 && new Set(row.recvIdx ?? row['1']).size === (row.recvIdx ?? row['1']).length &&
        (row.recvIdx ?? row['1']).every(idx => Number.isSafeInteger(idx) && (idx === 0 || idx === 1))) {
      const value = { 'free-water.fields.uid': officialUid, 'free-water.fields.recvIdx': row.recvIdx ?? row['1'] };
      for (const [name, index] of [['rTime','2'],['uTime','3'],['cTime','4']]) {
        const rawTime = row[name] ?? row[index];
        if (rawTime === null) value['free-water.fields.' + name] = null;
        else if (rawTime !== undefined && officialDateMs(rawTime) !== null) value['free-water.fields.' + name] = officialDateMs(rawTime);
      }
      const source = { sourceRef, method: observation.method, connectionEpoch: epoch, requestSequence: observation.requestSequence,
        observedAtMs: observation.receivedDeviceMs, observedMonotonicMs: observation.receivedMonotonicMs };
      const paths = Object.keys(value).sort();
      entries.push({ domainId: 'free-water', complete: true, paths, semanticValue: value,
        cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(value), observedAtMs: observation.receivedDeviceMs });
      const shareTotal = sync?.['31'] ?? sync?.shareTot, shareMap = shareTotal && typeof shareTotal === 'object' ? (shareTotal.map ?? shareTotal['0']) : null;
      const share = shareMap && typeof shareMap === 'object' ? shareMap['13'] : null;
      if (share && typeof share === 'object' && (share.uid ?? share['0']) === officialUid && (share.tmpId ?? share['1']) === 13) {
        const recvCnt = share.recvCnt ?? share['3'], uTime = officialDateMs(share.uTime ?? share['6']);
        if (Number.isSafeInteger(recvCnt) && recvCnt >= 0 && uTime !== null) {
          const shareValue = { 'free-water-share.share13.uid': officialUid, 'free-water-share.share13.tmpId': 13,
            'free-water-share.share13.recvCnt': recvCnt, 'free-water-share.share13.uTime': uTime };
          const sharePaths = Object.keys(shareValue).sort();
          entries.push({ domainId: 'free-water-share', complete: true, paths: sharePaths, semanticValue: shareValue,
            cellSources: Object.fromEntries(sharePaths.map(path => [path, source])), semanticFingerprint: fingerprint(shareValue), observedAtMs: observation.receivedDeviceMs });
        }
      }
      const usr = sync?.['7'] && typeof sync['7'] === 'object' ? (sync['7'].usr ?? sync['7']['0']) : null;
      const bag = usr && typeof usr === 'object' ? (usr.bag ?? usr['32']) : null, item7 = bag && typeof bag === 'object' ? bag['7'] : undefined;
      if (Number.isSafeInteger(item7) && item7 >= 0) {
        const itemValue = { 'free-water-item.item7.balance': item7 }, itemPaths = Object.keys(itemValue);
        entries.push({ domainId: 'free-water-item', complete: true, paths: itemPaths, semanticValue: itemValue,
          cellSources: Object.fromEntries(itemPaths.map(path => [path, source])), semanticFingerprint: fingerprint(itemValue), observedAtMs: observation.receivedDeviceMs });
      }
    }
  }
  if (accepted.flowerRack?.accepted === true && observation.dsName === 'G.ISyncData') {
    const sync = observation.value && typeof observation.value === 'object' ? observation.value : null;
    const raw = sync?.['104'] ?? sync?.flowerRack;
    const map = raw && typeof raw === 'object' ? (raw.flowerRackMap ?? raw['0']) : null;
    const officialUid = accepted.landView?.current === true && accepted.landView.identity?.verified === true &&
      accepted.landView.identity.uid?.presence === 'present' && accepted.landView.identity.uid.state === 'known'
      ? accepted.landView.identity.uid.value : null;
    if (Number.isSafeInteger(officialUid) && officialUid > 0 && map && typeof map === 'object' &&
        Object.values(map).every(member => member && typeof member === 'object' && (member.uid ?? member['0']) === officialUid)) {
      const value = { 'flower-rack.fields.uid': officialUid, 'flower-rack.fields.rackMap': map }, paths = Object.keys(value), source = {
        sourceRef, method: observation.method, connectionEpoch: epoch, requestSequence: observation.requestSequence,
        observedAtMs: observation.receivedDeviceMs, observedMonotonicMs: observation.receivedMonotonicMs };
      entries.push({ domainId: 'flower-rack', complete: true, paths, semanticValue: value,
        cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(value), observedAtMs: observation.receivedDeviceMs });
    }
  }
  if (accepted.freeWater === true && ['index.login', 'freeWater.recv', 'usr.share'].includes(observation.method) && observation.dsName === 'G.ISyncData') {
    const uid = accepted.landView?.identity?.verified === true && accepted.landView.identity.uid?.presence === 'present' &&
      accepted.landView.identity.uid.state === 'known' ? accepted.landView.identity.uid.value : null;
    const sync = observation.value && typeof observation.value === 'object' ? observation.value : null;
    const usrTotal = sync?.['7'] && typeof sync['7'] === 'object' ? sync['7'] : null;
    const usr = usrTotal ? (usrTotal.usr ?? usrTotal['0']) : null;
    const bag = usr && typeof usr === 'object' ? (usr.bag ?? usr['32']) : null;
    const item7 = bag && typeof bag === 'object' ? bag['7'] : undefined;
    if (Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(item7) && item7 >= 0) {
      const value = { 'free-water-item.item7.balance': item7 }, paths = Object.keys(value), source = { sourceRef, method: observation.method,
        connectionEpoch: epoch, requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
        observedMonotonicMs: observation.receivedMonotonicMs };
      entries.push({ domainId: 'free-water-item', complete: true, paths, semanticValue: value,
        cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(value), observedAtMs: observation.receivedDeviceMs });
    }
    const total = sync?.['31'] ?? sync?.shareTot, map = total && typeof total === 'object' ? (total.map ?? total['0']) : null;
    const share = map && typeof map === 'object' ? map['13'] : null;
    if (Number.isSafeInteger(uid) && uid > 0 && share && typeof share === 'object' && (share.uid ?? share['0']) === uid &&
        (share.tmpId ?? share['1']) === 13) {
      const recvCnt = share.recvCnt ?? share['3'], uTime = officialDateMs(share.uTime ?? share['6']);
      if (Number.isSafeInteger(recvCnt) && recvCnt >= 0 && uTime !== null) {
        const value = { 'free-water-share.share13.uid': uid, 'free-water-share.share13.tmpId': 13,
          'free-water-share.share13.recvCnt': recvCnt, 'free-water-share.share13.uTime': uTime }, paths = Object.keys(value), source = {
          sourceRef, method: observation.method, connectionEpoch: epoch, requestSequence: observation.requestSequence,
          observedAtMs: observation.receivedDeviceMs, observedMonotonicMs: observation.receivedMonotonicMs };
        entries.push({ domainId: 'free-water-share', complete: true, paths, semanticValue: value,
          cellSources: Object.fromEntries(paths.map(path => [path, source])), semanticFingerprint: fingerprint(value), observedAtMs: observation.receivedDeviceMs });
      }
    }
  }
  const landReplay = accepted.land?.coverageReplay === true && accepted.landView?.current === true;
  const replayProfile = accepted.landView?.profile;
  const replayProfileCells = Object.values(cellsFrom(replayProfile, 'profile'));
  const replayProfileSourceValid = landReplay && replayProfileCells.length > 0 && replayProfileCells.every(cell => {
    return cell.sourceRef === sourceRef && cell.connectionEpoch === epoch && cell.requestSequence === observation.requestSequence &&
      cell.method === observation.method && cell.observedAtMs === observation.receivedDeviceMs &&
      cell.observedMonotonicMs === observation.receivedMonotonicMs;
  });
  if ((accepted.land?.accepted === true || replayProfileSourceValid) && accepted.landView?.current) {
    if (accepted.land?.accepted !== true) {
      add('profile', accepted.landView, view => view.profile);
    } else {
    add('land', accepted.landView, view => ({ lands: view.lands }));
    add('land-top', accepted.landView, view => ({ top: view.top }));
    add('profile', accepted.landView, view => view.profile);
    const bag = accepted.landView.inventory?.bag;
    const itemExt = accepted.landView.inventory?.itemExt;
    if (bag?.state === 'known' && bag.complete === true && bag.source?.connectionEpoch === epoch && Number.isSafeInteger(bag.source?.receivedDeviceMs) &&
        itemExt?.state === 'known' && itemExt.complete === true && itemExt.source?.connectionEpoch === epoch) {
      const bagItems = cellsFrom(bag.items || {}, 'inventory.bag.items', {}, true), bagStamp = bag.source.receivedDeviceMs;
      const extItems = cellsFrom(itemExt.items || {}, 'inventory.itemExt.items', {}, true);
      if (Number.isSafeInteger(bagStamp) && Number.isFinite(bag.source.receivedMonotonicMs) && Number.isSafeInteger(itemExt.source?.receivedDeviceMs) && Number.isFinite(itemExt.source?.receivedMonotonicMs)) {
        const typed = { 'inventory.bag.complete': true, ...Object.fromEntries(Object.entries(bagItems).map(([key, one]) => [key, one.value])),
          'inventory.itemExt.complete': true, ...Object.fromEntries(Object.entries(extItems).map(([key, one]) => [key, one.value])) };
        const paths = Object.keys(typed).sort();
        const cellSources = Object.fromEntries([...Object.entries(bagItems), ...Object.entries(extItems)].map(([key, one]) => [key, { sourceRef: one.sourceRef,
          method: one.method, connectionEpoch: one.connectionEpoch, requestSequence: one.requestSequence, observedAtMs: one.observedAtMs,
          observedMonotonicMs: one.observedMonotonicMs }]));
        cellSources['inventory.bag.complete'] = { sourceRef: bag.source.responseRef, method: bag.source.method || null,
          connectionEpoch: bag.source.connectionEpoch, requestSequence: bag.source.requestSequence, observedAtMs: bagStamp,
          observedMonotonicMs: bag.source.receivedMonotonicMs };
        cellSources['inventory.itemExt.complete'] = { sourceRef: itemExt.source.responseRef, method: itemExt.source.method || null,
          connectionEpoch: itemExt.source.connectionEpoch, requestSequence: itemExt.source.requestSequence, observedAtMs: itemExt.source.receivedDeviceMs,
          observedMonotonicMs: itemExt.source.receivedMonotonicMs };
        const sources = Object.values(cellSources), responseContributes = sources.some(one => one.sourceRef === sourceRef);
        const noPlantInventoryUpdate = observation.method === 'usrLand.plant' && observation.source === 'response' &&
          observation.transport === 'answered' && observation.envelopeOk === true && observation.rejected !== true &&
          !Object.hasOwn(observation.value?.['7']?.['0'] ?? {}, '32') &&
          !Object.hasOwn(observation.value?.['7']?.['0'] ?? {}, '33') &&
          !Object.hasOwn(observation.value?.['7'] ?? {}, '2') && !Object.hasOwn(observation.value?.['100'] ?? {}, '2');
        if (responseContributes || noPlantInventoryUpdate) {
          const replaceCollections = [
            ...(bag.source.responseRef === sourceRef ? ['inventory.bag.items'] : []),
            ...(itemExt.source.responseRef === sourceRef ? ['inventory.itemExt.items'] : [])];
          entries.push({ domainId: 'inventory', complete: true, paths, semanticValue: typed, cellSources, replaceCollections,
            semanticFingerprint: fingerprint(typed), observedAtMs: Math.min(...sources.map(one => one.observedAtMs)) });
        }
      }
    }
    add('cultivation', accepted.landView, view => ({ cultivates: view.cultivates }));
    }
  }
  if (accepted.customer?.accepted === true && accepted.customerView) {
    add('profile', accepted.customerView, view => view.eligibilityInputs?.profile);
    const collectionCell = collection => collection && ({ presence: collection.presence, state: collection.state,
      complete: collection.complete === true, returnedComplete: collection.returnedComplete === true,
      value: { complete: collection.complete === true, total: collection.total, returnedComplete: collection.returnedComplete === true,
        reportedEmpty: collection.reportedEmpty === true, entries: semanticValue(collection.entries || []) },
      source: collection.source, current: collection.current });
    const collectionCompleteCell = collection => collection?.complete === true && collection?.returnedComplete === true
      ? { presence: 'present', state: 'known', value: true, source: collection.source, current: collection.current } : null;
    add('customer', accepted.customerView, view => ({ orderMap: collectionCell(view.orderMap),
      orderMapComplete: collectionCompleteCell(view.orderMap), orderStockList: collectionCell(view.orderStockList),
      orderStockListComplete: collectionCompleteCell(view.orderStockList), nextGenTime: view.nextGenTime, uTime: view.uTime,
      cTime: view.cTime, createCount: view.createCount, isOrderStockInit: view.isOrderStockInit }), ['orderMap', 'orderStockList']);
    const missingCustomerOverride = currentLoginMissingCustomerOpenOverride(context, observation, accepted.customerView);
    const customerEligibilityView = missingCustomerOverride ? { ...accepted.customerView, eligibilityInputs: {
      ...accepted.customerView.eligibilityInputs,
      serverOpenMap: { ...accepted.customerView.eligibilityInputs.serverOpenMap, sys_orderCustomer: missingCustomerOverride },
    } } : accepted.customerView;
    add('customer-eligibility', customerEligibilityView, view => view.eligibilityInputs);
    const artMapCell = cell => cell && ({ presence: cell.presence, state: cell.state,
      complete: cell.sourceProvidedMapComplete === true && cell.decodedComplete === true,
      returnedComplete: cell.sourceProvidedMapComplete === true && cell.decodedComplete === true,
      value: { total: cell.total ?? cell.entries?.length ?? null, reportedEmpty: cell.reportedEmpty === true,
        sourceProvidedMapComplete: cell.sourceProvidedMapComplete === true, decodedComplete: cell.decodedComplete === true,
        entries: semanticValue(cell.entries || []) }, source: cell.source, current: cell.current });
    const artInputs = accepted.customerView.artEligibilityInputs;
    add('art-inputs', accepted.customerView, () => artInputs && ({
      vases: { domain: artInputs.vases?.domain, map: artMapCell(artInputs.vases?.map),
        mapComplete: artInputs.vases?.map?.sourceProvidedMapComplete === true && artInputs.vases?.map?.decodedComplete === true
          ? { presence: 'present', state: 'known', value: true, source: artInputs.vases.map.source, current: artInputs.vases.map.current } : null },
      flowerArt: { domain: artInputs.flowerArt?.domain, uid: artInputs.flowerArt?.uid,
        makeList: artInputs.flowerArt?.makeList } }),
      ['vases.map', 'flowerArt.domain', 'flowerArt.uid', 'flowerArt.makeList']);
    const derivedEmptyCell = (source, rule, originalPresence) => source?.responseRef === sourceRef && source.connectionEpoch === epoch
      ? { presence: 'present', state: 'known', complete: true, returnedComplete: true, current: true, source,
        value: { complete: true, total: 0, returnedComplete: true, reportedEmpty: true, entries: [], derivedEmpty: true,
          derivationRule: rule, originalPresence } } : null;
    const albumClaimHistory = artInputs?.collectRwd?.artCreateRwdList?.current === true ? artInputs.collectRwd.artCreateRwdList
      : artInputs?.collectRwd?.artCreateRwdListDefault?.current === true ? derivedEmptyCell(
        artInputs.collectRwd.map?.source, artInputs.collectRwd.artCreateRwdListDefault.rule, artInputs.collectRwd.artCreateRwdList?.presence) :
        artInputs?.collectRwd?.artCreateRwdList;
    const albumExperience = artInputs?.collectRwd?.exp?.current === true ? artInputs.collectRwd.exp
      : artInputs?.collectRwd?.expDefault?.current === true && artInputs.collectRwd.expDefault.source?.responseRef === sourceRef &&
        artInputs.collectRwd.expDefault.source.connectionEpoch === epoch
        ? { presence: 'present', state: 'known', complete: true, current: true, source: artInputs.collectRwd.expDefault.source,
          value: 0, derivedDefault: true, derivationRule: artInputs.collectRwd.expDefault.rule,
          originalPresence: artInputs.collectRwd.exp?.presence } : artInputs?.collectRwd?.exp;
    const rawShareClaims = artInputs?.flowerArt?.sRecvList;
    const normalizedShareClaimHistory = rawShareClaims?.current === true && rawShareClaims.presence === 'present' &&
      rawShareClaims.state === 'known' && Array.isArray(rawShareClaims.value) && rawShareClaims.value.length <= 4096 &&
      rawShareClaims.value.every(id => Number.isSafeInteger(id) && id > 0)
      ? { ...rawShareClaims, complete: true, returnedComplete: true, value: { complete: true, total: rawShareClaims.value.length,
        returnedComplete: true, reportedEmpty: rawShareClaims.value.length === 0, entries: rawShareClaims.value,
        normalizedFromRawArray: true, normalizationRule: 'official-current-complete-106-member-sRecvList-array/v1' } }
      : rawShareClaims;
    const shareClaimHistory = normalizedShareClaimHistory?.current === true ? normalizedShareClaimHistory
      : artInputs?.flowerArt?.sRecvListDefault?.current === true ? derivedEmptyCell(
        artInputs.flowerArt.makeList?.source || artInputs.flowerArt.domain?.source,
        artInputs.flowerArt.sRecvListDefault.rule, artInputs.flowerArt.sRecvList?.presence) : artInputs?.flowerArt?.sRecvList;
    add('art-album', accepted.customerView, () => artInputs && ({
      flowerArt: { domain: artInputs.flowerArt?.domain, uid: artInputs.flowerArt?.uid,
        makeList: artInputs.flowerArt?.makeList },
      collectRwd: { domain: artInputs.collectRwd?.domain, map: artInputs.collectRwd?.map, exp: albumExperience,
        uid: artInputs.collectRwd?.uid, artCreateRwdList: albumClaimHistory } }),
      ['flowerArt.domain', 'flowerArt.uid', 'flowerArt.makeList', 'collectRwd.domain', 'collectRwd.map', 'collectRwd.exp',
        'collectRwd.artCreateRwdList']);
    add('art-share', accepted.customerView, () => artInputs && ({
      flowerArt: { domain: artInputs.flowerArt?.domain, uid: artInputs.flowerArt?.uid, sRecvList: shareClaimHistory,
        makeList: artInputs.flowerArt?.makeList }, shareTot: artInputs.shareTot }),
      ['flowerArt.domain', 'flowerArt.uid', 'flowerArt.makeList', 'flowerArt.sRecvList', 'shareTot.domain', 'shareTot.map']);
  }
  if (accepted.flowerOrders?.accepted === true && accepted.flowerView?.current) {
    add('order-flower', accepted.flowerView, view => ({ domain: view.domain, fields: view.fields }), ['domain', 'fields.uid']);
    add('order-flower-counter', accepted.flowerView, view => ({ counters: view.counters, financial: view.financial }));
    add('order-flower-eligibility', accepted.flowerView, view => view.eligibilityInputs);
    add('profile', accepted.flowerView, view => view.eligibilityInputs?.profile);
    // Ordinary delivery accounting reads the complete official stockMap. Keep
    // that raw typed cell alongside the separately gated hire projection; a
    // missing hire observation must not block the ordinary negative-stock path.
    add('order-flower-butler', accepted.flowerView, view => ({ ...view.butler, stockMap: view.fields.stockMap }), ['stockMap']);
    add('order-flower-card', accepted.flowerView, view => view.adCard);
  }
  const auxiliary = accepted.flowerAuxiliary;
  const auxiliarySource = auxiliary?.source;
  if (auxiliary?.current === true && auxiliarySource?.responseRef === sourceRef && auxiliarySource.connectionEpoch === epoch &&
      Number.isSafeInteger(auxiliarySource.requestSequence) && Number.isSafeInteger(auxiliarySource.receivedDeviceMs) &&
      Number.isFinite(auxiliarySource.receivedMonotonicMs)) {
    const addAuxiliary = (domainId, fields, complete) => {
      if (!complete) return;
      const semanticValue = {};
      const cellSources = {};
      const currentSources = value => {
        const sourcesOf = item => {
          if (!item || typeof item !== 'object') return [];
          if (Array.isArray(item)) return item.flatMap(sourcesOf);
          if (item.known === true && Object.hasOwn(item, 'value')) return sourcesOf(item.value);
          if (item.source?.responseRef) return [item.source];
          return Object.values(item).flatMap(sourcesOf);
        };
        const sources = sourcesOf(value);
        return sources.length > 0 && sources.every(source => source.responseRef === sourceRef &&
          source.connectionEpoch === epoch && source.requestSequence === auxiliarySource.requestSequence &&
          source.method === auxiliarySource.method);
      };
      for (const [name, value] of fields) {
        if (!value || value.known !== true) return;
        if (name === 'counters' && Array.isArray(value.value)) {
          for (const counter of value.value) {
            if (counter?.known !== true || !counter.value || !Number.isSafeInteger(counter.value.type)) continue;
            for (const key of ['uid', 'type', 'raw', 'total', 'rTime']) {
              const source = counter.value.fieldSources?.[key];
              if (!source || source.responseRef !== sourceRef || source.connectionEpoch !== epoch ||
                  source.requestSequence !== auxiliarySource.requestSequence || source.method !== auxiliarySource.method) continue;
              const path = domainId + '.counters.' + counter.value.type + '.' + key;
              semanticValue[path] = semanticValueOfAux(counter.value[key]);
              cellSources[path] = { sourceRef, method: source.method, connectionEpoch: epoch,
                requestSequence: source.requestSequence, observedAtMs: source.receivedDeviceMs,
                observedMonotonicMs: source.receivedMonotonicMs };
            }
          }
          continue;
        }
        const entries = name === 'counters' && Array.isArray(value.value)
          ? value.value.map(counter => ['counters.' + counter.value?.type, counter]) : [[name, value]];
        for (const [path, component] of entries) {
          if (!currentSources(component)) continue;
          semanticValue[domainId + '.' + path] = semanticValueOfAux(component);
          cellSources[domainId + '.' + path] = { sourceRef, method: auxiliarySource.method, connectionEpoch: epoch,
            requestSequence: auxiliarySource.requestSequence, observedAtMs: auxiliarySource.receivedDeviceMs,
            observedMonotonicMs: auxiliarySource.receivedMonotonicMs };
        }
      }
      const paths = Object.keys(semanticValue).sort();
      if (!paths.length) return;
      entries.push({ domainId, complete: true, paths, semanticValue, cellSources, semanticFingerprint: fingerprint(semanticValue),
        observedAtMs: auxiliarySource.receivedDeviceMs });
    };
    const addAuxiliaryField = (domainId, path, value, source, { complete = true, replaceCollections = [] } = {}) => {
      if (value === undefined || !source || source.responseRef !== sourceRef || source.connectionEpoch !== epoch ||
          source.requestSequence !== auxiliarySource.requestSequence || source.method !== auxiliarySource.method) return;
      const key = domainId + '.' + path, semanticValue = { [key]: semanticValueOfAux(value) };
      entries.push({ domainId, complete, paths: [key], semanticValue, replaceCollections,
        cellSources: { [key]: { sourceRef, method: source.method, connectionEpoch: epoch,
          requestSequence: source.requestSequence, observedAtMs: source.receivedDeviceMs,
          observedMonotonicMs: source.receivedMonotonicMs } }, semanticFingerprint: fingerprint(semanticValue),
        observedAtMs: source.receivedDeviceMs });
    };
    const addAuxiliaryRow = (domainId, path, cell, keys) => {
      if (!cell || typeof cell !== 'object') return;
      const row = cell.value && typeof cell.value === 'object' ? cell.value : cell;
      const fields = cell.fieldSources || row?.fieldSources || {};
      const presence = cell.presence || row?.presence, rowSource = cell.source || row?.source;
      if (presence === 'absent-by-explicit-delete') {
        addAuxiliaryField(domainId, path + '.present', false, rowSource,
          { complete: true, replaceCollections: [domainId + '.' + path] });
        return;
      }
      for (const key of keys) {
        if (!Object.hasOwn(fields, key) || !Object.hasOwn(row || {}, key)) continue;
        addAuxiliaryField(domainId, path + '.' + key, row[key], fields[key],
          { complete: cell.known === true || row?.known === true });
      }
    };
    const shares = auxiliary.payload?.videoShares;
    for (const [kind, id] of [['resident', 5], ['satin', 19], ['decorate', 34]])
      addAuxiliaryRow('order-flower-video-' + kind, 'share', shares?.[id],
        ['uid', 'shareId', 'shareCnt', 'recvCnt', 'recvTime', 'total', 'uTime']);
    const videoCard = auxiliary.payload?.videoCard, nobleCard = auxiliary.payload?.nobleCard;
    addAuxiliaryRow('order-flower-card-video', 'card', videoCard, ['uid', 'type', 'isMain', 'invalidTime']);
    addAuxiliaryRow('order-flower-card-noble', 'card', nobleCard, ['uid', 'type', 'isMain', 'invalidTime']);
    const reward = auxiliary.payload?.rewardState;
    const countersKnown = Array.isArray(reward?.counters) && reward.counters.length === 4 && reward.counters.every(cell => cell?.known === true);
    const counters = countersKnown ? { known: true, value: reward.counters } : null;
    if (reward?.stage?.known === true) {
      const stage = reward.stage.value;
      for (const key of ['uid', 'receivedIds', 'receivedTime', 'resetTime'])
        addAuxiliaryField('order-flower-reward-stage', 'stage.' + key, stage?.[key], stage?.fieldSources?.[key]);
    }
    addAuxiliary('order-flower-reward-stage', [['counters', counters]], countersKnown);
    if (reward?.achievement?.known === true) {
      const achievement = reward.achievement.value;
      for (const [key, value] of [['uid', achievement?.uid], ['progress', achievement?.progress],
        ['receivedIndex', achievement?.receivedIndex], ['achHist', achievement?.achHist],
        ['progressMapFingerprint', achievement?.progressMapFingerprint], ['otherRecvMapFingerprint', achievement?.otherRecvMapFingerprint]])
        addAuxiliaryField('order-flower-reward-achievement', 'achievement.' + key, value, achievement?.fieldSources?.[key]);
    }
    addAuxiliaryField('order-flower-reward-achievement', 'ownership', reward?.ownership?.value,
      reward?.ownership?.value?.source);
    addAuxiliary('order-flower-reward-achievement', [['counters', counters]], countersKnown);
    const enter = auxiliary.payload?.enterState;
    if (enter?.known === true && enter.value) {
      for (const key of ['uid', 'residents', 'satin', 'decorate', 'receivedIds', 'resetTime'])
        if (Object.hasOwn(enter.value.board || {}, key)) addAuxiliaryField('order-flower-enter-state', 'board.' + key,
          enter.value.board[key], enter.value.board.fieldSources?.[key] || enter.value.board.source);
      const enterCounters = (enter.value.counters ?? []).map(row => row?.known === true ? row :
        row && typeof row === 'object' ? { known: true, value: row } : row);
      const countersComplete = enterCounters.length === 4 && enterCounters.every(row => row?.known === true);
      addAuxiliary('order-flower-enter-state', [['counters', { known: countersComplete, value: enterCounters }]], countersComplete);
    }
  }
  const day = accepted.customerDay;
  if (observation.method === 'index.login' && day?.current && day.officialDay?.known === true && day.officialDay.source?.responseRef === sourceRef) {
    const semanticValue = { dayKey: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
      proofRef: day.officialDay.proofRef };
    if (day.count107?.current === true) Object.assign(semanticValue, { count107Uid: day.count107.uid, count107Type: day.count107.type,
      count107Today: day.count107.tdyCnt, count107Total: day.count107.totCnt, count107ResetTime: day.count107.rTimeMs });
    const typed = Object.fromEntries(Object.entries(semanticValue).map(([key, value]) => ['official-day.' + key, value]));
    entries.push({ domainId: 'customer-day', complete: true, paths: Object.keys(typed), semanticValue: typed,
      cellSources: Object.fromEntries(Object.keys(typed).map(path => [path, { sourceRef, method: observation.method,
        connectionEpoch: epoch, requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
        observedMonotonicMs: observation.receivedMonotonicMs }])),
      semanticFingerprint: fingerprint(typed), observedAtMs: observation.receivedDeviceMs });
  }
  const clock = accepted.officialClock;
  if (clock?.available === true && clock.connectionEpoch === epoch && clock.source === 'official-anchor-monotonic' &&
      clock.evidence?.responseRef === sourceRef && clock.evidence?.requestSequence === observation.requestSequence &&
      Number.isFinite(clock.anchorLowerBoundMs) && Number.isFinite(clock.anchorUpperBoundMs) &&
      Number.isSafeInteger(clock.evidence.receivedDeviceMs) && Number.isFinite(clock.evidence.receivedMonotonicMs) &&
      observation.source === 'response' && observation.transport === 'answered' && observation.envelopeOk === true &&
      observation.dsName === 'G.ISyncData' && isNormalSyncMethod(observation.method)) {
    const semanticValue = { source: clock.source, connectionEpoch: clock.connectionEpoch,
      lowerBoundMs: clock.anchorLowerBoundMs, upperBoundMs: clock.anchorUpperBoundMs };
    const typed = Object.fromEntries(Object.entries(semanticValue).map(([key, value]) => ['official-clock.' + key, value]));
    entries.push({ domainId: 'clock', complete: true, paths: Object.keys(typed), semanticValue: typed,
      cellSources: Object.fromEntries(Object.keys(typed).map(path => [path, { sourceRef, method: observation.method,
        connectionEpoch: epoch, requestSequence: observation.requestSequence, observedAtMs: observation.receivedDeviceMs,
        observedMonotonicMs: observation.receivedMonotonicMs }])),
      semanticFingerprint: fingerprint(typed), observedAtMs: observation.receivedDeviceMs });
  }
  const merged = new Map();
  for (const entry of entries) {
    const prior = merged.get(entry.domainId);
    if (!prior) { merged.set(entry.domainId, entry); continue; }
    const semanticValue = { ...prior.semanticValue }, cellSources = { ...prior.cellSources };
    const replaceCollections = [...new Set([...(prior.replaceCollections || []), ...(entry.replaceCollections || [])])];
    for (const path of entry.paths) {
      if (Object.hasOwn(semanticValue, path)) {
        const before = cellSources[path], after = entry.cellSources[path];
        if (fingerprint(semanticValue[path]) !== fingerprint(entry.semanticValue[path]) ||
            fingerprint(before) !== fingerprint(after)) {
          throw Object.assign(new Error('Repeated typed projection disagrees within one matched response'), { code: 'DYNAMIC_TYPED_FRAGMENT_CONFLICT' });
        }
      } else {
        semanticValue[path] = entry.semanticValue[path];
        cellSources[path] = entry.cellSources[path];
      }
    }
    const paths = Object.keys(semanticValue).sort();
    merged.set(entry.domainId, { domainId: entry.domainId, complete: prior.complete && entry.complete, paths, replaceCollections,
      semanticValue, cellSources, semanticFingerprint: fingerprint(semanticValue),
      observedAtMs: Math.min(prior.observedAtMs, entry.observedAtMs) });
  }
  return [...merged.values()];
}

function semanticValueOfAux(value) {
  return semanticValue(value);
}
