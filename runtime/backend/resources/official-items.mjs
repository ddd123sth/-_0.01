import { canonical, clone, fingerprint, freeze, parseStored, plainObject, problem } from '../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { createVerifiedReadMemo } from '../persistence/verified-read-memo.mjs';
import { currentOfficialDataEvidence, currentOfficialSourceEvidence } from '../official-data-evidence.mjs';
import { verifyOfficialServerVersionFrame } from '../official-server-version-contract.mjs';
import { knownCell } from '../features/land/wire-facts.mjs';
import { resolveAcceptedLandObservationEvidence } from '../features/land/compatibility-evidence.mjs';
import { orderFlowerSourceProofValid } from '../features/order-flower/wire-facts.mjs';
import { assertLandAccelerationProposal } from '../features/land/acceleration-contract.mjs';
import { customerContextKey } from '../features/customer/wire-facts.mjs';
import { createOfficialCustomerCatalog } from '../features/customer/catalog.mjs';
import { createOfficialArtCatalog } from '../features/art/catalog.mjs';
import { artRecipeFingerprint, artTargetFingerprint } from '../features/art/rpc-contract.mjs';
import { DAILY_ART_CONTRACT, DAILY_ART_POST_READ, assertDailyArtProposal } from '../features/art/daily-rpc-contract.mjs';
import { CUSTOMER_ART_BATCH_CONTRACT, CUSTOMER_ART_BATCH_POST_READ, assertCustomerArtBatchProposal } from '../features/art/customer-batch-contract.mjs';
import { ORDER_FLOWER_CONTRACTS, orderFlowerHistoricalAdmittedContractMatches, assertOrderFlowerProposal,
  orderFlowerRequirements } from '../features/order-flower/rpc-contract.mjs';

const num = value => Number.isSafeInteger(value) && value >= 0;
const val = cell => knownCell(cell) ? cell.value : null;
const unknown = reasonCode => ({ known: false, value: null, lowerBound: null, upperBound: null, reasonCode, issues: [{ reasonCode }] });
const absent = cell => !cell || cell.presence === 'missing' || cell.presence === 'null';
// Official 7.2.0/.1/.2 = IOutIn bi/bo/bd. bi/bo are audit flows; bd is the
// per-item absolute patch. A write response therefore proves the post-write
// absolute bag only when every item it describes (bi, bo or bd) also carries a
// bd value; bi/bo are never converted into an absolute here.
export function officialAbsoluteBagPatch(observationValue) {
  const user = plainObject(observationValue) ? observationValue['7'] : null;
  const flow = plainObject(user) ? user['2'] : null;
  if (!plainObject(flow)) return Object.freeze({ available: false, bd: null, described: [],
    reasonCode: 'OFFICIAL_BAG_FLOW_BLOCK_MISSING' });
  const maps = {};
  for (const [key, name] of [['0', 'bi'], ['1', 'bo'], ['2', 'bd']]) {
    const block = flow[key];
    if (block === undefined) { maps[name] = {}; continue; }
    if (!plainObject(block) || Object.keys(block).length > 4096) return Object.freeze({ available: false, bd: null, described: [],
      reasonCode: 'OFFICIAL_BAG_FLOW_BLOCK_INVALID' });
    const entries = {};
    for (const [id, value] of Object.entries(block)) {
      const numericId = Number(id);
      if (!/^\d{1,16}$/.test(id) || !Number.isSafeInteger(numericId) || numericId < 1 || !Number.isSafeInteger(value) ||
          name === 'bd' && value < 0) return Object.freeze({ available: false, bd: null, described: [],
        reasonCode: 'OFFICIAL_BAG_FLOW_ENTRY_INVALID' });
      entries[id] = value;
    }
    maps[name] = entries;
  }
  const described = [...new Set([...Object.keys(maps.bi), ...Object.keys(maps.bo), ...Object.keys(maps.bd)])].sort();
  const missingAbsolute = described.filter(id => !Object.hasOwn(maps.bd, id));
  if (missingAbsolute.length) return Object.freeze({ available: false, bd: maps.bd, described,
    missingAbsolute: missingAbsolute.slice(0, 16), reasonCode: 'OFFICIAL_BAG_ABSOLUTE_PATCH_INCOMPLETE' });
  return Object.freeze({ available: true, bd: maps.bd, described, reasonCode: null });
}
function compatibleActionContract(left, right, action) {
  if (!left || !right || left.protocolVersion !== right.protocolVersion) return false;
  if (left.gameVersion === '480.0.27' && right.gameVersion === '480.0.27' && left.protocolVersion === '480.0.0') return true;
  if (left.gameVersion === '480.0.27' || right.gameVersion === '480.0.27') return false;
  const a = left.sourceProofs?.[action], b = right.sourceProofs?.[action];
  const blockSet = proof => {
    if (!Array.isArray(proof?.matchedBlocks) || proof.matchedBlocks.length === 0 || proof.matchedBlocks.length > 64) return null;
    const blocks = proof.matchedBlocks.map(block => ({ name: block?.name, byteLength: block?.byteLength, sha256: block?.sha256 }));
    if (blocks.some(block => typeof block.name !== 'string' || block.name.length === 0 || !Number.isSafeInteger(block.byteLength) || block.byteLength < 1 ||
        !/^[a-f0-9]{64}$/.test(block.sha256 || '')) || new Set(blocks.map(block => block.name)).size !== blocks.length) return null;
    return blocks.sort((one, two) => one.name < two.name ? -1 : one.name > two.name ? 1 : 0);
  };
  const leftBlocks = blockSet(a), rightBlocks = blockSet(b);
  return !!a && !!b && a.supported === true && b.supported === true &&
    a.sourceVersion === left.gameVersion && b.sourceVersion === right.gameVersion &&
    a.protocolVersion === left.protocolVersion && b.protocolVersion === right.protocolVersion &&
    a.actionContractId === b.actionContractId && !!leftBlocks && !!rightBlocks &&
    canonical(leftBlocks) === canonical(rightBlocks);
}
const sameActionLoginProof = (left, right, action) => left?.gameVersion === right?.gameVersion &&
  left?.protocolVersion === right?.protocolVersion && left?.loginResponseRef === right?.loginResponseRef &&
  compatibleActionContract(left, right, action);
function scalar(fields, key, fallback, zeroFallback = false) {
  const one = fields[key];
  if (absent(one)) return { known: true, value: fallback };
  if (!knownCell(one) || !num(one.value)) return { known: false, value: null };
  return { known: true, value: zeroFallback && one.value === 0 ? fallback : one.value };
}
function timestamp(fields, key) {
  const one = fields[key];
  if (absent(one) || one?.rawValue === 0) return { known: true, value: 0 };
  return knownCell(one) && num(one.value) ? { known: true, value: one.value } : { known: false, value: null };
}
function effectiveWater({ base, ext, extAbsent, creationTime, clock, connectionEpoch, gameVersion = '480.0.27' }) {
  if (!num(base)) return unknown('ITEM_BASE_UNKNOWN');
  if (!extAbsent && (!ext || !ext.valid)) return unknown('ITEM_EXT_UNKNOWN');
  const fields = ext?.fields || {};
  const r = scalar(fields, 'resetNum', 65), q = scalar(fields, 'restoreNum', 1, true), cd = scalar(fields, 'cd', 120000, true), limit = scalar(fields, 'limit', 0, true);
  const lems = timestamp(fields, 'lems'), lrms = timestamp(fields, 'lrms');
  if (![r, q, cd, limit, lems, lrms].every(one => one.known)) return unknown('WATER_INSTANCE_RULE_UNREADABLE');
  const cap = limit.value, target = cap > 0 ? Math.min(r.value, cap) : r.value;
  const initial = extAbsent || base === 0 && lems.value === 0 && lrms.value === 0;
  const finish = value => cap > 0 ? Math.min(value, cap) : value;
  if (initial) {
    const value = finish(base < target ? target : base);
    return { known: true, value, lowerBound: value, upperBound: value, reasonCode: null, issues: [],
      ruleVersion: `official-${gameVersion}/G480-item7/v1`, initial: true, nextIncreaseOfficialMs: null };
  }
  if (q.value === 0) { const value = finish(base); return { known: true, value, lowerBound: value, upperBound: value, issues: [], reasonCode: null, ruleVersion: `official-${gameVersion}/G480-item7/v1`, nextIncreaseOfficialMs: null }; }
  // If restoration cannot run without cTime, the official branch keeps the
  // raw base. An unreadable supplied cTime is not proof of this falsy branch.
  if (creationTime?.presence === 'missing' || creationTime?.presence === 'null') {
    return unknown('WATER_CREATION_TIME_NOT_OBSERVED');
  }
  if (!knownCell(creationTime) || !num(creationTime.value) || creationTime.value === 0) return unknown('WATER_CREATION_TIME_UNREADABLE');
  if (clock?.available !== true || clock.connectionEpoch !== connectionEpoch || !Number.isFinite(clock.nowMs)
    || !Number.isFinite(clock.uncertaintyMs) || clock.uncertaintyMs < 0) return unknown('WATER_OFFICIAL_CLOCK_UNAVAILABLE');
  const lowerTime = Number.isFinite(clock.lowerBoundMs) ? clock.lowerBoundMs : Math.max(0, clock.nowMs - clock.uncertaintyMs);
  const upperTime = Number.isFinite(clock.upperBoundMs) ? clock.upperBoundMs : clock.nowMs + clock.uncertaintyMs;
  if (lowerTime < 0 || upperTime < lowerTime || !Number.isFinite(upperTime)) return unknown('WATER_CLOCK_INTERVAL_INVALID');
  const anchor = Math.max(lems.value, lrms.value, creationTime.value);
  if (!(cd.value > 0) || !num(cd.value) || !num(q.value)) return unknown('WATER_RESTORE_RULE_UNSUPPORTED');
  const at = time => {
    let increase = time > anchor ? Math.floor((time - anchor) / cd.value) * q.value : 0;
    if (!num(increase)) return null;
    if (target > 0) increase = Math.max(0, Math.min(increase, target - base));
    const result = finish(base + increase);
    return num(result) ? result : null;
  };
  const lower = at(lowerTime), upper = at(upperTime);
  if (lower === null || upper === null || upper < lower) return unknown('WATER_EFFECTIVE_COUNT_OVERFLOW');
  const canIncrease = (target === 0 || lower < target) && (cap === 0 || lower < cap);
  const next = canIncrease ? anchor + (Math.max(0, Math.floor((lowerTime - anchor) / cd.value)) + 1) * cd.value : null;
  return { known: lower === upper, value: lower === upper ? lower : null, lowerBound: lower, upperBound: upper,
    ruleVersion: `official-${gameVersion}/G480-item7/v1`, reasonCode: lower === upper ? null : 'WATER_CLOCK_INTERVAL_CROSSES_TICK', issues: [],
    asOfOfficialMs: clock.nowMs, clockRevision: clock.revision, anchorMs: anchor, restoreCount: q.value, restorePeriodMs: cd.value,
    nextIncreaseOfficialMs: num(next) && next > clock.nowMs ? next : null, initial: false };
}

export function createOfficialItemResources({ store, catalog, catalogForContext = () => catalog, catalogForVersionEvidence = () => null, projection, clock, readAdmission = () => ({ resourceFootprints: [] }), appendOutbox = () => {}, additionalItemRule = null, validatePostReadBridge = null } = {}) {
  if (!store || !catalog || !projection || typeof clock !== 'function') throw new TypeError('Official item resources require store/catalog/projection/clock');
  if (additionalItemRule !== null && typeof additionalItemRule !== 'function') throw new TypeError('Additional item rule reader must be a synchronous function or null');
  if (validatePostReadBridge !== null && (typeof validatePostReadBridge !== 'function' || validatePostReadBridge.constructor?.name === 'AsyncFunction')) throw new TypeError('Post-read bridge validator must be synchronous or null');
  const historyMemo = createVerifiedReadMemo(store);
  const { run, get, all, transaction, nowIso } = historyMemo.store;
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_frames(observation_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,
    response_ref TEXT NOT NULL,wire_key TEXT,source_json TEXT NOT NULL,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE INDEX IF NOT EXISTS backend_official_item_wire ON backend_official_item_frames(subject_ref,connection_epoch,wire_key)');
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_flows(flow_ref TEXT PRIMARY KEY,observation_ref TEXT NOT NULL,
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,item_id INTEGER NOT NULL,kind TEXT NOT NULL,quantity INTEGER NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_balance_bases(basis_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,item_id INTEGER NOT NULL,basis_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_coverage(coverage_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,quantity INTEGER NOT NULL,basis_ref TEXT NOT NULL,
    post_read_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,request_sequence INTEGER NOT NULL,result_fingerprint TEXT NOT NULL,
    evidence_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE INDEX IF NOT EXISTS backend_official_item_coverage_resource ON backend_official_item_coverage(operation_id,resource_key)');
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_coverage_reconcile_cursors(owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    last_prepared_at TEXT,last_operation_id TEXT,scan_active INTEGER NOT NULL CHECK(scan_active IN (0,1)),updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref))`);
  run(`CREATE TABLE IF NOT EXISTS backend_official_item_current_separations(separation_ref TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    context_json TEXT NOT NULL,source_json TEXT NOT NULL,receipt_json TEXT NOT NULL,receipt_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE INDEX IF NOT EXISTS backend_official_item_current_separation_resource ON backend_official_item_current_separations(operation_id,resource_key)');
  for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_official_item_current_separations_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_official_item_current_separations BEGIN SELECT RAISE(ABORT,'current item separation evidence is append only'); END`);
  for (const table of ['frames', 'flows', 'balance_bases', 'coverage']) for (const action of ['UPDATE', 'DELETE']) run(`CREATE TRIGGER IF NOT EXISTS backend_official_item_${table}_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_official_item_${table} BEGIN SELECT RAISE(ABORT,'official item evidence is append only'); END`);
  function ingest(frame) {
    return transaction(() => {
      const accepted = resolveAcceptedLandObservationEvidence({ store, context: frame.context, observationRef: frame.observationRef, source: frame.source });
      if (!accepted?.accepted || !frame.admissible || canonical(frame) !== canonical(accepted.frame)) return { accepted: false, reasonCode: 'ITEM_FRAME_NOT_ADMITTED' };
      if (get('SELECT observation_ref FROM backend_official_item_frames WHERE observation_ref=?', frame.observationRef)) return { accepted: false, replayed: true };
      const payload = Object.fromEntries(['bag', 'itemExt', 'bi', 'bo', 'bd'].map(key => [key, frame[key]]));
      run('INSERT INTO backend_official_item_frames VALUES(?,?,?,?,?,?,?,?,?,?,?)', frame.observationRef, frame.context.ownerRef, frame.context.accountRef,
        frame.context.subjectRef, frame.source.connectionEpoch, frame.source.requestSequence, frame.source.responseRef, frame.source.wireKey, canonical(frame.source), canonical(payload), nowIso());
      let flows = 0;
      // Login has already set the full supplied data; oi there must not be
      // reused as a second gain/loss event.
      if (frame.source.method !== 'index.login') for (const kind of ['bi', 'bo']) for (const [id, one] of Object.entries(frame[kind].items || {})) {
        if (!knownCell(one)) continue;
        run('INSERT INTO backend_official_item_flows VALUES(?,?,?,?,?,?,?,?)', 'official-flow:' + fingerprint([frame.context.subjectRef, frame.source.connectionEpoch, frame.source.wireKey || frame.observationRef, kind, id]),
          frame.observationRef, frame.context.ownerRef, frame.context.subjectRef, Number(id), kind, one.value, nowIso());
        flows += 1;
      }
      return { accepted: true, flows };
    });
  }
  function balance({ context, itemId } = {}) {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw problem('ITEM_ID_INVALID', '物品编号无效', 400);
    return balanceFromModel(context, itemId, projection.view(context));
  }
  function balanceBatch({ context, itemIds } = {}) {
    if (!Array.isArray(itemIds) || itemIds.length > 8192 || new Set(itemIds).size !== itemIds.length ||
        itemIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw problem('ITEM_BATCH_INVALID', '批量物品名单超出有界范围', 400);
    const model = projection.view(context), bag = model.inventory.bag;
    const bagKnown = model.current && bag.complete === true && bag.state === 'known' && bag.source?.connectionEpoch === context.connectionEpoch &&
      Object.values(bag.items || {}).every(cell => knownCell(cell) && Number.isSafeInteger(cell.value) && cell.value >= 0);
    const positiveBag = bagKnown ? Object.fromEntries(Object.entries(bag.items || {}).filter(([, cell]) => cell.value > 0).map(([id, cell]) => [id, cell.value])) : null;
    return freeze({ current: model.current, context: clone(context), identity: clone(model.identity), source: clone(model.identity.source),
      profile: { gold: clone(model.profile.gold || null), yuanbao: clone(model.profile.yuanbao || null) },
      completeBagFingerprint: { known: !!bagKnown, fingerprint: bagKnown ? fingerprint(positiveBag) : null,
        positiveItemCount: bagKnown ? Object.keys(positiveBag).length : null, source: clone(bag.source),
        rule: 'complete-absolute-bag-positive-integer-counts/zero-and-missing-equivalent/v1' },
      items: Object.fromEntries(itemIds.map(itemId => [itemId, balanceFromModel(context, itemId, model)])) });
  }
  function balanceFromModel(context, itemId, model) {
    const bag = model.inventory.bag, extMap = model.inventory.itemExt;
    const one = bag.items?.[itemId];
    const zeroProven = !one && bag.complete && bag.source?.connectionEpoch === context.connectionEpoch && bag.state === 'known';
    const raw = knownCell(one) ? one.value : zeroProven ? 0 : null;
    const baseSource = one?.source || bag.source || null;
    const base = { known: model.current && num(raw), value: model.current && num(raw) ? raw : null, basisRef: one?.sourceRef || bag.sourceRef || null,
      source: baseSource, coverage: bag.coverage || null, missingKeyProvenZero: zeroProven };
    const candidateExt = extMap.items?.[itemId];
    // An old empty extension has only missing fields, so marking known fields
    // stale is insufficient. Defaults require a current-map/entry source too.
    const extCurrent = model.current && extMap.state === 'known' && extMap.source?.connectionEpoch === context.connectionEpoch
      && candidateExt?.source?.connectionEpoch === context.connectionEpoch;
    const ext = extCurrent ? candidateExt : null;
    const extAbsent = !candidateExt && extMap.complete && extMap.state === 'known' && extMap.source?.connectionEpoch === context.connectionEpoch;
    const profileCatalog = catalogForContext(context);
    const profileIdentity = profileCatalog?.identity?.() ?? null;
    const staticItem = profileCatalog?.item(itemId) ?? null, ordinaryFlower = itemId !== 7 && profileCatalog?.flower(itemId);
    let additionalRule = null;
    if (base.known && staticItem && itemId !== 7 && !ordinaryFlower && additionalItemRule) {
      const rule = additionalItemRule(context, itemId, profileIdentity);
      if (rule?.then) throw new TypeError('Additional item rule reader must be synchronous');
      // This is a bounded static-rule port, not a generic item-type allowlist.
      // Runtime source/current gates and every reservation axis stay shared.
      if (rule?.kind === 'ordinary-flower-art' && rule.itemId === itemId && rule.staticItemType === 12
        && rule.staticResetRestoreLimitAbsent === true && staticItem.id === itemId && staticItem.type === 12
        && !['reset', 'restore', 'limit'].some(key => Object.hasOwn(staticItem, key))
        && rule.catalogId === `official-public/customer-${profileIdentity.indexVersion}`
        && (rule.ruleVersion === 'G480/ordinary-flower-art/semantic-v1' || profileIdentity.indexVersion === '480.0.27' &&
          rule.ruleVersion === 'official-480.0.27/G480-ordinary-flower-art/v1')
        && typeof rule.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(rule.manifestSha256)
        && typeof rule.artTableSha256 === 'string' && /^[a-f0-9]{64}$/.test(rule.artTableSha256)
        && typeof rule.itemTableSha256 === 'string' && /^[a-f0-9]{64}$/.test(rule.itemTableSha256)
        && rule.itemTableSha256 === profileIdentity.tableSha256?.c_item &&
        rule.artTableSha256 === profileIdentity.tableSha256?.c_flowerArt) additionalRule = rule;
      else if (rule?.kind === 'land-speed-card' && itemId === 1001 && rule.itemId === itemId && rule.staticItemType === 1 &&
          staticItem.id === itemId && staticItem.type === 1 && rule.extensionId === 'land-acceleration-public-data/v1' &&
          rule.staticResetRestoreLimitAbsent === true && !['reset', 'restore', 'limit'].some(key => Object.hasOwn(staticItem, key)) &&
          rule.baseDataSnapshotId === profileIdentity.dataSnapshotId && rule.loginResponseRef === profileIdentity.loginResponseRef &&
          rule.bundleRef === profileIdentity.bundleRef && typeof rule.extensionRef === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(rule.extensionRef) && typeof rule.itemTableSha256 === 'string' &&
          rule.itemTableSha256 === profileIdentity.tableSha256?.c_item) additionalRule = rule;
    }
    let effective;
    if (!base.known) effective = unknown('ITEM_BASE_UNKNOWN');
    else if (!profileCatalog || !profileIdentity) effective = unknown('ITEM_PROFILE_UNSUPPORTED');
    else if (!staticItem) effective = unknown('ITEM_STATIC_RULE_UNSUPPORTED');
    else if (itemId === 7 && profileCatalog.supports({ purpose: 'water', fields: ['id', 'reset', 'restore', 'limit'] })?.supported !== true)
      effective = unknown('ITEM_PROFILE_RULE_UNVERIFIED');
    else if (itemId === 7) effective = effectiveWater({ base: raw, ext, extAbsent, creationTime: model.profile.cTime,
      clock: clock(context.subjectRef), connectionEpoch: context.connectionEpoch, gameVersion: profileIdentity.indexVersion });
    else if (!ordinaryFlower && !additionalRule) effective = unknown('ITEM_EFFECTIVE_RULE_UNIMPLEMENTED');
    else if (!extAbsent && !ext?.valid) effective = unknown('ITEM_EXT_UNKNOWN');
    else {
      const hard = scalar(ext?.fields || {}, 'limit', 0, true);
      if (!hard.known) effective = unknown('ITEM_LIMIT_UNREADABLE');
      else {
        const value = hard.value > 0 ? Math.min(raw, hard.value) : raw;
        effective = { known: true, value, lowerBound: value, upperBound: value, reasonCode: null, issues: [],
          ruleVersion: additionalRule?.ruleVersion || 'official-480.0.27/G480-ordinary-flower/v1' };
      }
    }
    const extFields = Object.fromEntries(Object.entries(ext?.fields || {}).map(([key, cell]) => [key, { presence: cell.presence, state: cell.state, value: cell.value }]));
    const identity = { subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch, itemId, profileCatalogId: profileIdentity?.catalogId ?? null,
      profileManifestSha256: profileIdentity?.manifestSha256 ?? null, base: base.value,
      baseKnown: base.known, extFields, extAbsent, creationTime: val(model.profile.cTime),
      effectiveLowerBound: effective.lowerBound, effectiveUpperBound: effective.upperBound, ruleVersion: effective.ruleVersion || null,
      clockAvailable: effective.clockRevision !== undefined,
      ...(additionalRule ? { additionalRule: additionalRule.kind === 'land-speed-card'
        ? { extensionId: additionalRule.extensionId, extensionRef: additionalRule.extensionRef,
          baseDataSnapshotId: additionalRule.baseDataSnapshotId, bundleRef: additionalRule.bundleRef, itemTableSha256: additionalRule.itemTableSha256,
          staticResetRestoreLimitAbsent: additionalRule.staticResetRestoreLimitAbsent }
        : { catalogId: additionalRule.catalogId, manifestSha256: additionalRule.manifestSha256,
          artTableSha256: additionalRule.artTableSha256, itemTableSha256: additionalRule.itemTableSha256 } } : {}) };
    // Clock.now changes continuously; a stable effective interval and source
    // produce a stable basis. Reservation insertion does not change this id.
    const accountingVersion = fingerprint(identity), basisRef = 'official-item-basis:' + accountingVersion;
    return freeze({ itemId, base, effective, basisRef, accountingVersion, identity, context: clone(context),
      ext: { known: !!ext?.valid || extAbsent, absent: extAbsent, current: !!extCurrent || extAbsent, sourceRef: ext?.sourceRef || extMap.sourceRef || null } });
  }
  function coverageFor({ context, resource, balance: current }) {
    const operationId = resource.operation_id ?? resource.operationId, resourceKey = resource.resource_key ?? resource.resourceKey;
    return all('SELECT * FROM backend_official_item_coverage WHERE owner_ref=? AND subject_ref=? AND operation_id=? AND resource_key=?', context.ownerRef, context.subjectRef, operationId, resourceKey)
      .filter(link => current.base.source && (current.base.source.connectionEpoch > link.connection_epoch
        || current.base.source.connectionEpoch === link.connection_epoch && current.base.source.requestSequence >= link.request_sequence));
  }
  function budgetFromCurrent({ context, itemId, keep, quantity, claimingOperationId, requireOwnReservation, current, admission } = {}) {
    if (!num(keep) || !num(quantity)) throw problem('ITEM_BUDGET_INVALID', '物品预算需要非负安全整数', 400);
    if (admission?.then) throw new TypeError('Resource admission reader must be synchronous');
    const footprints = admission?.resourceFootprints;
    if (!Array.isArray(footprints)) throw problem('ITEM_RESERVATION_VIEW_UNAVAILABLE', '资源预约视图不可用', 500);
    const applicable = footprints.filter(one => (one.resource_ref ?? one.resourceRef) === 'item:' + itemId && (one.resource_kind ?? one.resourceKind) === 'item');
    const other = [], own = [], refs = [current.basisRef];
    let invalid = false;
    for (const one of applicable) {
      const operationId = one.operation_id ?? one.operationId, resourceKey = one.resource_key ?? one.resourceKey;
      if (!num(one.quantity)) { invalid = true; continue; }
      const covered = coverageFor({ context, resource: one, balance: current });
      const reflected = Math.min(one.quantity, covered.reduce((sum, link) => sum + link.quantity, 0));
      refs.push(...covered.map(link => link.coverage_key));
      // Historical outcome and current resource qualification are separate.
      // This narrow ordinary-instant proof is re-derived for THIS candidate
      // and current absolute base, never trusted merely because a receipt exists.
      const separation = reflected < one.quantity && operationId !== claimingOperationId
        ? orderFlowerCurrentSeparation({ context, resource: one, current, itemId, keep, quantity, claimingOperationId }) ||
          artCurrentSeparation({context,resource:one,current,itemId}) : null;
      if (separation) refs.push(separation.separationRef);
      const entry = { operationId, resourceKey, quantity: one.quantity, unreflectedQuantity: separation ? 0 : one.quantity - reflected,
        state: one.state, ...(separation ? { currentSeparationRef: separation.separationRef, currentSeparationQuantity: one.quantity - reflected } : {}) };
      if (claimingOperationId && operationId === claimingOperationId) own.push(entry); else other.push(entry);
    }
    const ownQuantity = own.reduce((sum, one) => sum + one.quantity, 0), otherQuantity = other.reduce((sum, one) => sum + one.unreflectedQuantity, 0);
    const ownValid = !requireOwnReservation || !!claimingOperationId && ownQuantity === quantity && own.length > 0;
    const known = !invalid && ownValid && num(current.effective.lowerBound) && num(otherQuantity);
    const available = known ? Math.max(0, current.effective.lowerBound - keep - otherQuantity) : null;
    return freeze({ known, allowed: known && available >= quantity, available, effectiveLowerBound: current.effective.lowerBound, keep, quantity,
      ownReservation: claimingOperationId ? { operationId: claimingOperationId, quantity: ownQuantity, resources: own, valid: ownValid } : null,
      otherUnreflectedReservations: other, accountingVersion: fingerprint({ balanceVersion: current.accountingVersion,
        other: other.map(one => [one.operationId, one.resourceKey, one.unreflectedQuantity]).sort(), coverage: refs.slice(1).sort() }),
      basisRefs: [...new Set(refs)].sort(), reasonCode: invalid ? 'ITEM_RESERVATION_QUANTITY_INVALID' : !ownValid ? 'ITEM_OWN_RESERVATION_MISMATCH' :
        !known ? current.effective.reasonCode || 'ITEM_BUDGET_UNKNOWN' : available < quantity ? 'ITEM_KEEP_OR_RESERVATIONS_INSUFFICIENT' : null,
      nextIncreaseOfficialMs: current.effective.nextIncreaseOfficialMs ?? null });
  }
  function budget({ context, itemId, keep = 0, quantity = 1, claimingOperationId = null, requireOwnReservation = false } = {}) {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw problem('ITEM_ID_INVALID', '物品编号无效', 400);
    return budgetFromCurrent({ context, itemId, keep, quantity, claimingOperationId, requireOwnReservation,
      current: balance({ context, itemId }), admission: readAdmission({ context, itemIds: [itemId] }) });
  }
  function budgetBatch({ context, itemIds, keep = 0, quantity = 1 } = {}) {
    if (!Array.isArray(itemIds) || itemIds.length > 8192 || new Set(itemIds).size !== itemIds.length ||
        itemIds.some(id => !Number.isSafeInteger(id) || id <= 0) || !num(keep) || !num(quantity))
      throw problem('ITEM_BUDGET_BATCH_INVALID', '批量物品预算超出有界范围', 400);
    const model = projection.view(context), admission = readAdmission({ context, itemIds: itemIds.length <= 128 ? itemIds : null });
    if (admission?.then) throw new TypeError('Resource admission reader must be synchronous');
    return freeze(Object.fromEntries(itemIds.map(itemId => [itemId, budgetFromCurrent({ context, itemId, keep, quantity,
      claimingOperationId: null, requireOwnReservation: false, current: balanceFromModel(context, itemId, model), admission })])));
  }
  // Read-only planning may need several quantities/keep values for one
  // synchronous preview. Capture its current model and reservation view once,
  // then keep the original per-item budget semantics. The returned reader is
  // intentionally request-local; execution and send-time callers keep using
  // budget()/balance() for a fresh read.
  function planningReader({ context } = {}) {
    if (!plainObject(context) || typeof context.ownerRef !== 'string' || typeof context.accountRef !== 'string' ||
        typeof context.subjectRef !== 'string' || !Number.isSafeInteger(context.ownerEpoch) ||
        !Number.isSafeInteger(context.runEpoch) || !Number.isSafeInteger(context.connectionEpoch)) {
      throw problem('ITEM_PLANNING_CONTEXT_INVALID', '只读花艺规划需要完整的当前账号上下文', 500);
    }
    const capturedContext = Object.freeze({ ...context });
    const model = projection.view(capturedContext), admission = readAdmission({ context: capturedContext });
    if (admission?.then) throw new TypeError('Resource admission reader must be synchronous');
    return Object.freeze({
      balance({ itemId } = {}) {
        if (!Number.isSafeInteger(itemId) || itemId <= 0) throw problem('ITEM_ID_INVALID', '物品编号无效', 400);
        return balanceFromModel(capturedContext, itemId, model);
      },
      budget({ itemId, keep = 0, quantity = 1, claimingOperationId = null, requireOwnReservation = false } = {}) {
        if (!Number.isSafeInteger(itemId) || itemId <= 0) throw problem('ITEM_ID_INVALID', '物品编号无效', 400);
        return budgetFromCurrent({ context: capturedContext, itemId, keep, quantity, claimingOperationId, requireOwnReservation,
          current: balanceFromModel(capturedContext, itemId, model), admission });
      },
    });
  }
  function reservationSpec({ context, itemId, quantity, memberKey, lifecycleRef } = {}) {
    if (!num(quantity) || !memberKey || !lifecycleRef) throw problem('ITEM_RESERVATION_INVALID', '资源预约缺少明确目标与数量', 500);
    const current = balance({ context, itemId });
    if (!num(current.effective.lowerBound)) throw problem('ITEM_BUDGET_UNKNOWN', '当前物品可用下界未核实');
    transaction(() => {
      const prior = get('SELECT basis_json FROM backend_official_item_balance_bases WHERE basis_ref=?', current.basisRef);
      const json = canonical({ identity: current.identity, base: current.base, effective: current.effective });
      if (prior && canonical(parseStored(prior.basis_json, 'item basis').identity) !== canonical(current.identity)) throw problem('ITEM_BASIS_CONFLICT', '物品基准身份冲突', 500);
      if (!prior) run('INSERT INTO backend_official_item_balance_bases VALUES(?,?,?,?,?,?,?)', current.basisRef, context.ownerRef, context.accountRef, context.subjectRef, itemId, json, nowIso());
    });
    return freeze({ resourceKey: 'item-reservation:' + fingerprint([context.subjectRef, memberKey, lifecycleRef, itemId]), resourceKind: 'item', resourceRef: 'item:' + itemId,
      basisRef: current.basisRef, accountingRef: 'item-accounting:' + fingerprint([context.subjectRef, lifecycleRef, itemId]), quantity });
  }
  function currencyBalance({ context, currency = 'gold' } = {}) {
    if (!['gold', 'yuanbao'].includes(currency) || !context) return freeze({ known: false, value: null, source: null, reasonCode: 'CURRENCY_NOT_SUPPORTED' });
    const model = projection.view(context), cell = model?.profile?.[currency], source = cell?.source || null;
    const valid = model?.current === true && knownCell(cell) && num(cell.value) && source?.kind === 'response' &&
      source.method === 'index.login' && source.connectionEpoch === context.connectionEpoch && source.responseRef;
    return freeze({ known: valid, value: valid ? cell.value : null, source: valid ? source : null,
      basisRef: valid ? `profile-${currency}-basis:` + fingerprint([context.ownerRef, context.subjectRef, source.responseRef, cell.value]) : null,
      reasonCode: valid ? null : `CURRENCY_${currency.toUpperCase()}_SOURCE_NOT_CURRENT` });
  }
  function currencyBudget({ context, currency = 'gold', quantity = 1, keep = 0, claimingOperationId = null, requireOwnReservation = false } = {}) {
    if (!num(quantity)) throw problem('CURRENCY_BUDGET_INVALID', '货币预算需要非负整数', 400);
    if (!num(keep)) throw problem('CURRENCY_BUDGET_INVALID', '货币保留额需要非负整数', 400);
    const current = currencyBalance({ context, currency }), admission = readAdmission({ context, itemIds: [currency === 'gold' ? 11 : 1] });
    if (admission?.then) throw new TypeError('Resource admission reader must be synchronous');
    const footprints = admission?.resourceFootprints;
    if (!Array.isArray(footprints)) throw problem('CURRENCY_RESERVATION_VIEW_UNAVAILABLE', '金币预约视图不可用', 500);
    const walletItem = currency === 'gold' ? 11 : currency === 'yuanbao' ? 1 : null;
    const applicable = footprints.filter(one => {
      const kind = one.resource_kind ?? one.resourceKind, ref = one.resource_ref ?? one.resourceRef;
      return kind === 'currency' && ref === 'currency:' + currency || walletItem !== null && kind === 'item' && ref === 'item:' + walletItem;
    });
    const own = [], other = [];
    for (const row of applicable) {
      const entry = { operationId: row.operation_id ?? row.operationId, resourceKey: row.resource_key ?? row.resourceKey,
        quantity: row.quantity, state: row.state };
      if (!num(entry.quantity)) return freeze({ known: false, allowed: false, available: null, reasonCode: 'CURRENCY_RESERVATION_INVALID' });
      (entry.operationId === claimingOperationId ? own : other).push(entry);
    }
    const ownQuantity = own.reduce((sum, row) => sum + row.quantity, 0), otherQuantity = other.reduce((sum, row) => sum + row.quantity, 0);
    const ownValid = !requireOwnReservation || !!claimingOperationId && own.length > 0 && ownQuantity === quantity;
    const available = current.known && ownValid ? Math.max(0, current.value - otherQuantity - keep) : null;
    return freeze({ known: current.known && ownValid, allowed: current.known && ownValid && available >= quantity, available,
      value: current.value, quantity, ownReservation: { valid: ownValid, operationId: claimingOperationId, quantity: ownQuantity, resources: own },
      otherUnreflectedReservations: other, basisRefs: current.basisRef ? [current.basisRef] : [], reasonCode: !current.known ? current.reasonCode :
        !ownValid ? 'CURRENCY_OWN_RESERVATION_MISMATCH' : available < quantity ? `CURRENCY_${currency.toUpperCase()}_INSUFFICIENT` : null });
  }
  function currencyReservationSpec({ context, amount, memberKey, lifecycleRef, currency = 'gold' } = {}) {
    if (!['gold', 'yuanbao'].includes(currency) || !num(amount) || amount < 1 || !memberKey || !lifecycleRef) throw problem('CURRENCY_RESERVATION_INVALID', '货币预约缺少当前来源或明确目标', 500);
    const current = currencyBalance({ context, currency });
    if (!current.known) throw problem(`CURRENCY_${currency.toUpperCase()}_SOURCE_NOT_CURRENT`, '当前货币绝对值未核实');
    return freeze({ resourceKey: 'currency-reservation:' + fingerprint([context.subjectRef, memberKey, lifecycleRef, currency]),
      resourceKind: 'currency', resourceRef: 'currency:' + currency, basisRef: current.basisRef,
      accountingRef: 'currency-accounting:' + fingerprint([context.subjectRef, lifecycleRef, currency]), quantity: amount });
  }
  function matchedAnswer(operationId, binding) {
    if (!binding) return null;
    const original = get('SELECT * FROM backend_operations WHERE operation_id=?', operationId);
    if (!original || original.connection_epoch !== binding.connectionEpoch) return null;
    const answers = all(`SELECT payload_json FROM backend_operation_evidence WHERE operation_id=?
      AND kind='official-answer' AND source='backend/write-gateway/v2'`, operationId);
    return answers.some(row => {
      const answer = parseStored(row.payload_json, 'official answer binding');
      return answer.method === original.method && answer.connectionEpoch === binding.connectionEpoch && answer.requestSequence === binding.requestSequence
        && answer.wireKey === binding.wireKey && answer.responseRef === binding.responseRef;
    }) ? original : null;
  }
  function landAccelerationPreparation(operationId, original) {
    const row = get(`SELECT evidence_key,kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1' AND kind='finite-domain-preparation'
        AND source='backend/write-gateway/v2'`, operationId);
    if (!row) return null;
    const payload = parseStored(row.payload_json, '加速有限域准备证据');
    if (ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint ||
        payload.domain !== 'land-acceleration' || !plainObject(payload.preparation)) return null;
    const acceleration = payload.preparation, landId = acceleration.targetLandId;
    const modeOk = acceleration.mode === 'card' && original?.method === 'usrLand.speedUp' && original.scope === 'land-speedup' &&
        original.paramsFingerprint === fingerprint({ landId }) || acceleration.mode === 'free' && original?.method === 'usrLand.speedUpFree' &&
        original.scope === 'land-speedfree' && original.paramsFingerprint === fingerprint({});
    const target = original?.targets?.[0];
    if (!modeOk || original.featureId !== 'land.acceleration' || original.targets?.length !== 1 || target?.targetKind !== 'land' ||
        target.targetRef !== `land:${original.subjectRef}:${landId}` || target.lifecycleRef !== original.resources?.find(one => one.resourceKind === 'land')?.accountingRef ||
        acceleration.connectionEpoch !== original.connectionEpoch || acceleration.extensionRef !== acceleration.extension?.extensionRef ||
        !/^sha256:[a-f0-9]{64}$/.test(acceleration.extensionRef || '') || acceleration.baseDataSnapshotId !== acceleration.extension?.baseDataSnapshotId ||
        acceleration.bundleRef !== acceleration.extension?.bundleRef || acceleration.loginResponseRef !== acceleration.extension?.loginResponseRef) return null;
    try { assertLandAccelerationProposal({ ...original, params: acceleration.mode === 'card' ? { landId } : {}, acceleration }); }
    catch { return null; }
    return acceleration;
  }
  function landAccelerationOriginal(operationId, original) {
    const acceleration = landAccelerationPreparation(operationId, original);
    if (!acceleration) return null;
    return { ...original, acceleration };
  }
  function landAccelerationDebitEvidence({ context, proposal, response, postRead } = {}) {
    const unknown = reasonCode => freeze({ known: false, reasonCode, itemId: 1001, before: proposal?.acceleration?.cardBalanceBefore ?? null, after: null });
    if (proposal?.featureId !== 'land.acceleration' || proposal.acceleration?.mode !== 'card' || response?.method !== 'usrLand.speedUp' ||
        postRead?.method !== 'usrLand.refresh' || response.connectionEpoch !== context?.connectionEpoch || postRead.connectionEpoch !== context?.connectionEpoch ||
        !Number.isSafeInteger(response.requestSequence) || !Number.isSafeInteger(postRead.requestSequence) || postRead.requestSequence <= response.requestSequence ||
        typeof response.responseRef !== 'string' || typeof postRead.responseRef !== 'string' || !Number.isSafeInteger(proposal.acceleration.cardBalanceBefore))
      return unknown('ITEM_ACCELERATION_DEBIT_BINDING_INVALID');
    const write = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      response.responseRef, context.ownerRef, context.subjectRef, context.connectionEpoch, response.requestSequence);
    const post = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      postRead.responseRef, context.ownerRef, context.subjectRef, context.connectionEpoch, postRead.requestSequence);
    if (!write || !post || parseStored(write.source_json, 'acceleration debit source').method !== 'usrLand.speedUp' ||
        parseStored(post.source_json, 'acceleration debit post source').method !== 'usrLand.refresh') return unknown('ITEM_ACCELERATION_DEBIT_FRAMES_MISSING');
    const payload = parseStored(write.payload_json, 'acceleration debit write'), postPayload = parseStored(post.payload_json, 'acceleration debit post');
    const spent = payload.bo?.items?.['1001'];
    const absolutes = [payload.bd?.items?.['1001'], postPayload.bd?.items?.['1001'], postPayload.bag?.items?.['1001']].filter(knownCell);
    if (new Set(absolutes.map(one => one.value)).size > 1) return unknown('ITEM_ACCELERATION_ABSOLUTE_BALANCE_CONFLICT');
    const after = absolutes[0] ?? null;
    if (!after || after.value !== proposal.acceleration.cardBalanceBefore - 1 || knownCell(spent) && spent.value !== 1)
      return unknown('ITEM_ACCELERATION_DEBIT_NOT_PROVEN');
    return freeze({ known: true, reasonCode: null, itemId: 1001, before: proposal.acceleration.cardBalanceBefore,
      after: after.value, spent: knownCell(spent) ? spent.value : null,
      writeResponseRef: write.response_ref, postReadRef: post.response_ref,
      absoluteSourceRef: knownCell(payload.bd?.items?.['1001']) ? write.observation_ref : post.observation_ref });
  }
  function landAccelerationCoverage({ context, original, operationId, settlementRef, sendBinding, postReadRef } = {}) {
    const denied = reasonCode => ({ links: [], reasonCode });
    if (!context || original?.featureId !== 'land.acceleration' || !['card'].includes(original.acceleration?.mode) ||
        original.scope !== 'land-speedup' || original.method !== 'usrLand.speedUp' || original.acceleration?.extension?.extensionId !== 'land-acceleration-public-data/v1' ||
        original.acceleration.extensionRef !== original.acceleration.extension.extensionRef || original.acceleration.cardBalanceBefore < 1 ||
        !/^[a-f0-9-]{20,64}$/.test(operationId || '') || !sendBinding || !Number.isSafeInteger(sendBinding.connectionEpoch) ||
        !Number.isSafeInteger(sendBinding.requestSequence) || !sendBinding.wireKey || !sendBinding.responseRef) return denied('ITEM_ACCELERATION_COVERAGE_CONTRACT_INVALID');
    const persisted = matchedAnswer(operationId, sendBinding);
    if (!persisted || persisted.feature_id !== 'land.acceleration' || persisted.scope !== 'land-speedup' || persisted.method !== 'usrLand.speedUp')
      return denied('ITEM_ACCELERATION_WRITE_BINDING_INVALID');
    if (!get('SELECT settlement_key FROM backend_operation_target_settlements WHERE operation_id=? AND settlement_key=?', operationId, settlementRef || ''))
      return denied('ITEM_ACCELERATION_SETTLEMENT_MISSING');
    const post = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=? AND connection_epoch=?',
      postReadRef || '', context.ownerRef, context.subjectRef, sendBinding.connectionEpoch);
    const write = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      sendBinding.responseRef, sendBinding.wireKey, context.ownerRef, context.subjectRef, sendBinding.connectionEpoch, sendBinding.requestSequence);
    if (!write || !post || post.request_sequence <= write.request_sequence || parseStored(post.source_json, 'acceleration post-read source').method !== 'usrLand.refresh')
      return denied('ITEM_ACCELERATION_FRESH_POST_READ_MISSING');
    const writePayload = parseStored(write.payload_json, 'acceleration write sources'), postPayload = parseStored(post.payload_json, 'acceleration post sources');
    const spent = writePayload.bo?.items?.['1001'], absoluteWrite = writePayload.bd?.items?.['1001'];
    const absolutePostBd = postPayload.bd?.items?.['1001'], absolutePostBag = postPayload.bag?.items?.['1001'];
    const absolutes = [absoluteWrite, absolutePostBd, absolutePostBag].filter(knownCell);
    if (new Set(absolutes.map(one => one.value)).size > 1) return denied('ITEM_ACCELERATION_ABSOLUTE_BALANCE_CONFLICT');
    const absolute = absolutes[0] ?? null;
    const actualRef = knownCell(absoluteWrite) ? write : knownCell(absolutePostBd) || knownCell(absolutePostBag) ? post : null;
    if (!absolute || absolute.value !== original.acceleration.cardBalanceBefore - 1 ||
        knownCell(spent) && spent.value !== 1) return denied('ITEM_ACCELERATION_CARD_DEDUCTION_UNPROVEN');
    const resource = (original.resources || []).find(one => (one.resourceRef ?? one.resource_ref) === 'item:1001' &&
      (one.resourceKind ?? one.resource_kind) === 'item' && (one.quantity === 1 || one.quantity === undefined));
    const resourceKey = resource?.resourceKey ?? resource?.resource_key;
    if (!resource || !resourceKey || resource.quantity !== 1) return denied('ITEM_ACCELERATION_CARD_RESERVATION_MISSING');
    const link = { coverageKey: 'item-coverage:' + fingerprint([operationId, resourceKey, actualRef.observation_ref]),
      ownerRef: context.ownerRef, subjectRef: context.subjectRef, operationId, resourceKey, quantity: 1,
      basisRef: 'official-absolute:' + actualRef.observation_ref + ':1001', postReadRef: post.response_ref,
      connectionEpoch: actualRef.connection_epoch, requestSequence: actualRef.request_sequence,
      evidence: { version: 'official-item-coverage/land-acceleration/v1', itemId: 1001, extensionId: original.acceleration.extension.extensionId,
        extensionRef: original.acceleration.extensionRef, baseDataSnapshotId: original.acceleration.baseDataSnapshotId,
        bundleRef: original.acceleration.bundleRef, loginResponseRef: original.acceleration.loginResponseRef,
        writeResponseRef: write.response_ref, postReadRef: post.response_ref, sendBinding: clone(sendBinding),
        beforeAbsolute: original.acceleration.cardBalanceBefore, afterAbsolute: absolute.value,
        absoluteSourceRef: actualRef.observation_ref, settlementRef } };
    return { links: [link], reasonCode: null };
  }
  const contextKeys = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
  const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const landMethods = { plant: 'usrLand.plant', water: 'usrLand.water', harvest: 'usrLand.harvest' };
  const sameContext = (a, b) => !!a && !!b && contextKeys.every(key => a[key] === b[key]);
  const sameBinding = (a, b) => !!a && !!b && ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].every(key => a[key] === b[key]);
  function acceptedActionLoginVersion(source, context, officialUid, action) {
    const thin = source?.versionEvidence;
    if (!source || source.method !== 'index.login' || !positive(source.connectionEpoch) || !positive(source.requestSequence) ||
        !reference(source.responseRef) || !reference(source.wireKey) || !sameContext(source.context || context, context) ||
        source.connectionEpoch !== context.connectionEpoch || !thin || thin.loginResponseRef !== source.responseRef ||
        !reference(thin.gameVersion) || !reference(thin.protocolVersion)) return null;
    // Keep the already-supported original static contract readable. Dynamic
    // sources need an immutable accepted login receipt carrying the complete
    // proof; the four-field bridge summary cannot supply that proof itself.
    if (thin.gameVersion === '480.0.27' && thin.protocolVersion === '480.0.0') return thin;
    const contextKey = customerContextKey(context);
    const rows = all(`SELECT * FROM backend_customer_generation_days WHERE owner_ref=? AND account_ref=? AND subject_ref=?
      AND context_key=? AND connection_epoch=? AND request_sequence=? AND response_ref=? LIMIT 17`,
      context.ownerRef, context.accountRef, context.subjectRef, contextKey, context.connectionEpoch, source.requestSequence, source.responseRef);
    if (rows.length === 0 || rows.length > 16) return null;
    const versions = [];
    for (const row of rows) {
      if (row.owner_ref !== context.ownerRef || row.account_ref !== context.accountRef || row.subject_ref !== context.subjectRef ||
          row.context_key !== contextKey || row.connection_epoch !== context.connectionEpoch || row.request_sequence !== source.requestSequence ||
          row.response_ref !== source.responseRef) continue;
      let payload;
      try { payload = parseStored(row.payload_json, 'accepted official login source'); } catch { continue; }
      if (!plainObject(payload) || fingerprint(payload) !== row.payload_fingerprint || payload.kind !== 'complete-login-day' ||
          payload.officialUid !== officialUid || !sameContext(payload.context, context)) continue;
      const accepted = payload.source, version = accepted?.version, binding = version?.profileBinding;
      if (accepted?.method !== 'index.login' || accepted.contextKey !== contextKey || accepted.connectionEpoch !== source.connectionEpoch ||
          accepted.requestSequence !== source.requestSequence || accepted.responseRef !== source.responseRef || accepted.wireKey !== source.wireKey ||
          accepted.dataSourceProofFingerprint == null || version?.loginResponseRef !== source.responseRef ||
          version?.gameVersion !== thin.gameVersion || version?.source !== thin.source ||
          !plainObject(binding) || binding.ownerRef !== context.ownerRef || binding.accountRef !== context.accountRef ||
          binding.subjectRef !== context.subjectRef || binding.ownerEpoch !== context.ownerEpoch || binding.runEpoch !== context.runEpoch ||
          binding.connectionEpoch !== context.connectionEpoch || binding.officialUid !== officialUid ||
          binding.loginResponseRef !== source.responseRef || binding.contractId !== version.contractId ||
          binding.dataSnapshotId !== version.dataSnapshotId) continue;
      const sourceEvidence = currentOfficialSourceEvidence(version), dataEvidence = currentOfficialDataEvidence(version, action);
      if (!sourceEvidence || !dataEvidence || accepted.dataSourceProofFingerprint !== sourceEvidence.proofFingerprint) continue;
      const rawProtocol = source.frameProtocolVersion ?? thin.protocolVersion;
      const reported = source.frameReportedServerVersion ?? thin.reportedServerVersion ?? version.reportedServerVersion;
      if (thin.reportedServerVersion != null && thin.reportedServerVersion !== version.reportedServerVersion ||
          source.frameReportedServerVersion != null && source.frameReportedServerVersion !== version.reportedServerVersion ||
          !verifyOfficialServerVersionFrame({ versionEvidence: version, frameProtocolVersion: rawProtocol,
            frameReportedServerVersion: reported, context, officialUid })) continue;
      versions.push(version);
    }
    if (!versions.length || versions.some(version => canonical(version) !== canonical(versions[0]))) return null;
    return versions[0];
  }
  function acceptedActionLoginCatalog(source, context, officialUid, action) {
    const version = acceptedActionLoginVersion(source, context, officialUid, action);
    if (!version) return null;
    const historical = catalogForVersionEvidence(version);
    if (historical) return { version, catalog: historical };
    // The pinned historical APK contract has no public snapshot proof bundle.
    // Its existing checked-in catalog remains available for audit reads.
    const legacyCatalog = version.gameVersion === '480.0.27'
      ? catalogForContext(context) || (catalog?.identity?.().indexVersion === '480.0.27' ? catalog : null) : null;
    return legacyCatalog ? { version, catalog: legacyCatalog } : null;
  }
  function bridgeReference(input) {
    if (!plainObject(input) || !reference(input.leaseRef) || !reference(input.operationId) || !isSha256(input.bridgeFingerprint)) return null;
    const context = value => plainObject(value) && contextKeys.slice(0, 3).every(key => reference(value[key]))
      && contextKeys.slice(3).every(key => positive(value[key])) ? Object.fromEntries(contextKeys.map(key => [key, value[key]])) : null;
    const originalContext = context(input.originalContext), newContext = context(input.newContext), after = input.after;
    if (!originalContext || !newContext || !plainObject(after) || !positive(after.connectionEpoch) || !positive(after.requestSequence)
      || !reference(after.wireKey) || !reference(after.responseRef)) return null;
    // Do not copy the packet's in-memory newLoginObservation/IUsr/IOther.
    return freeze({ leaseRef: input.leaseRef, operationId: input.operationId, originalContext, newContext,
      after: Object.fromEntries(['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].map(key => [key, after[key]])), bridgeFingerprint: input.bridgeFingerprint });
  }
  function evidencePayload(row) {
    const payload = parseStored(row.payload_json, 'item coverage operation evidence');
    return ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) === row.payload_fingerprint ? payload : null;
  }
  function boundSendPermit(operationId, original) {
    const row = get(`SELECT p.*,o.account_ref AS operation_account_ref,o.owner_ref AS operation_owner_ref,
      o.subject_ref AS operation_subject_ref,o.run_epoch AS operation_run_epoch,
      o.connection_epoch AS operation_connection_epoch,o.original_json AS operation_original_json,
      o.original_fingerprint AS operation_original_fingerprint
      FROM backend_send_permits p JOIN backend_operations o ON o.operation_id=p.operation_id WHERE p.operation_id=?`, operationId);
    if (!row) return null;
    const operationOriginal = parseStored(row.operation_original_json, 'send permit bound operation original');
    if (ledgerJsonFingerprint(operationOriginal) !== row.operation_original_fingerprint || canonical(operationOriginal) !== canonical(original) ||
        row.operation_owner_ref !== original.ownerRef || row.operation_account_ref !== original.accountRef ||
        row.operation_subject_ref !== original.subjectRef ||
        row.operation_run_epoch !== original.runEpoch || row.operation_connection_epoch !== original.connectionEpoch) return null;
    // account_ref belongs to the immutable operation row; the historical send
    // permit schema never stored that field, so do not synthesize/backfill it.
    return { ...row, account_ref: row.operation_account_ref };
  }
  function admittedItemFrame(row, context, method) {
    if (!row || row.owner_ref !== context.ownerRef || row.account_ref !== context.accountRef || row.subject_ref !== context.subjectRef
      || row.connection_epoch !== context.connectionEpoch) return null;
    const source = parseStored(row.source_json, 'item coverage source');
    const admitted = resolveAcceptedLandObservationEvidence({ store: historyMemo.store, context, observationRef: row.observation_ref, source });
    if (!admitted?.accepted) return null;
    const frame = admitted.frame;
    if (!frame.admissible || !sameContext(frame.context, context) || source.kind !== 'response' || source.method !== method
      || source.responseRef !== row.response_ref || source.wireKey !== row.wire_key || source.connectionEpoch !== row.connection_epoch
      || source.requestSequence !== row.request_sequence || canonical(source) !== canonical(frame.source)) return null;
    const payload = parseStored(row.payload_json, 'item coverage values');
    if (canonical(payload) !== canonical(Object.fromEntries(['bag', 'itemExt', 'bi', 'bo', 'bd'].map(key => [key, frame[key]])))) return null;
    return { frame, payload };
  }
  function customerBridgeCoverage({ operationId, settlementRef, sendBinding, postReadBridge }) {
    const denied = reasonCode => ({ link: null, reasonCode });
    const bridge = bridgeReference(postReadBridge);
    if (!bridge || bridge.operationId !== operationId || !validatePostReadBridge) return denied('ITEM_COVERAGE_BRIDGE_UNAVAILABLE');
    const validated = validatePostReadBridge(bridge);
    if (validated?.then) { validated.catch?.(() => {}); throw new TypeError('Post-read bridge validator must be synchronous'); }
    const receipt = validated?.receipt, next = receipt?.newLoginSource;
    // A validator may expose the already-derived hash on its returned receipt;
    // the immutable DB document being hashed cannot contain its own hash.
    const receiptBody = plainObject(receipt) ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'bridgeFingerprint')) : null;
    if (validated?.valid !== true || validated.bridgeFingerprint !== bridge.bridgeFingerprint || !receiptBody || fingerprint(receiptBody) !== bridge.bridgeFingerprint
      || receipt.bridgeFingerprint != null && receipt.bridgeFingerprint !== bridge.bridgeFingerprint
      || receipt.version !== 'after-physical-close-login/v1' || receipt.leaseRef !== bridge.leaseRef || receipt.operationId !== operationId
      || !sameContext(receipt.originalContext, bridge.originalContext) || !sameContext(receipt.newContext, bridge.newContext)
      || !sameBinding(receipt.after, bridge.after) || !sameBinding(sendBinding, bridge.after)) return denied('ITEM_COVERAGE_BRIDGE_UNPROVEN');
    const originalRow = matchedAnswer(operationId, sendBinding);
    if (!originalRow || originalRow.feature_id !== 'order.customer' || originalRow.scope !== 'order-customer'
      || originalRow.method !== 'orderCustomer.finishOrder') return denied('ITEM_COVERAGE_BRIDGE_SCOPE_INVALID');
    const original = parseStored(originalRow.original_json, 'customer item original');
    if (ledgerJsonFingerprint(original) !== originalRow.original_fingerprint || !sameContext(original, bridge.originalContext)
      || contextKeys.slice(0, 5).some(key => bridge.originalContext[key] !== bridge.newContext[key])
      || bridge.newContext.connectionEpoch <= bridge.originalContext.connectionEpoch
      || original.targets?.length !== 1 || original.targets[0].targetKind !== 'customer-order'
      || original.resources?.length !== 1 || original.resourceBindings?.length !== 1) return denied('ITEM_COVERAGE_BRIDGE_ORIGINAL_INVALID');
    const target = original.targets[0], resource = original.resources[0], binding = original.resourceBindings[0];
    const itemId = Number(String(resource.resourceRef || '').replace(/^item:/, ''));
    const nextCatalog = acceptedActionLoginCatalog(next, bridge.newContext, receipt.officialUid, 'customer.finish');
    if (resource.resourceKind !== 'item' || !positive(itemId) || resource.resourceRef !== 'item:' + itemId || !positive(resource.quantity)
      || nextCatalog?.catalog?.item(itemId)?.type !== 12 || binding.memberKey !== target.memberKey || binding.resourceKey !== resource.resourceKey
      || binding.quantity !== resource.quantity) return denied('ITEM_COVERAGE_BRIDGE_RESOURCE_INVALID');
    const targetRow = get('SELECT original_json FROM backend_operation_targets WHERE operation_id=? AND member_key=?', operationId, target.memberKey);
    const resourceRow = get('SELECT original_json FROM backend_operation_resources WHERE operation_id=? AND resource_key=?', operationId, resource.resourceKey);
    const member = get('SELECT quantity FROM backend_operation_resource_targets WHERE operation_id=? AND resource_key=? AND member_key=?', operationId, resource.resourceKey, target.memberKey);
    const settlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=? AND settlement_key=?', operationId, target.memberKey, settlementRef || '');
    if (!targetRow || !resourceRow || canonical(parseStored(targetRow.original_json, 'customer target original')) !== canonical(target)
      || canonical(parseStored(resourceRow.original_json, 'customer resource original')) !== canonical(resource) || member?.quantity !== resource.quantity
      || !settlement || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint) return denied('ITEM_COVERAGE_BRIDGE_SETTLEMENT_INVALID');
    const closure = receipt.oldPhysicalCloseReceipt;
    if (closure?.closed !== true || closure.connectionEpoch !== original.connectionEpoch || !reference(closure.closureEvidenceRef)
      || !positive(receipt.officialUid) || next?.officialUid !== receipt.officialUid || next.kind !== 'response' || next.transport !== 'answered'
      || next.method !== 'index.login' || next.connectionEpoch !== bridge.newContext.connectionEpoch || !positive(next.requestSequence)
      || !reference(next.wireKey) || !reference(next.responseRef) || next.versionEvidence?.loginResponseRef !== next.responseRef) return denied('ITEM_COVERAGE_BRIDGE_LOGIN_INVALID');
    const oldVersion = acceptedActionLoginVersion(receipt.oldLoginSource, bridge.originalContext, receipt.officialUid, 'customer.finish');
    const nextVersion = acceptedActionLoginVersion(next, bridge.newContext, receipt.officialUid, 'customer.finish');
    if (!oldVersion || !nextVersion || !compatibleActionContract(oldVersion, nextVersion, 'customer.finish')) return denied('ITEM_COVERAGE_BRIDGE_LOGIN_INVALID');
    const permit = get('SELECT consumed,connection_epoch,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', operationId);
    if (permit?.consumed !== 1 || permit.connection_epoch !== sendBinding.connectionEpoch || permit.wire_key !== sendBinding.wireKey
      || permit.request_sequence !== sendBinding.requestSequence) return denied('ITEM_COVERAGE_BRIDGE_PERMIT_INVALID');
    const answers = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    const bridges = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (answers.length > 16 || bridges.length > 16) return denied('ITEM_COVERAGE_BRIDGE_EVIDENCE_LIMIT');
    const answer = answers.some(row => { const value = evidencePayload(row); return value && value.method === original.method && value.rejected === false && sameBinding(value, sendBinding); });
    const bridgeEvidence = bridges
      .find(row => {
        const value = evidencePayload(row), login = value?.newLogin, closed = value?.oldPhysicalCloseReceipt;
        return value?.version === 'customer-after-close-login/v1' && value.leaseRef === bridge.leaseRef && value.operationId === operationId
          && value.bridgeFingerprint === bridge.bridgeFingerprint && sameContext(value.originalContext, bridge.originalContext)
          && sameContext(value.newContext, bridge.newContext) && sameBinding(value.after, sendBinding) && value.officialUid === receipt.officialUid
          && closed?.closed === true && closed.connectionEpoch === closure.connectionEpoch && closed.closureEvidenceRef === closure.closureEvidenceRef
          && sameBinding(login, next) && login.method === 'index.login' && login.gameVersion === next.versionEvidence.gameVersion
          && login.protocolVersion === next.versionEvidence.protocolVersion && login.loginResponseRef === next.responseRef;
      });
    if (!answer || !bridgeEvidence) return denied('ITEM_COVERAGE_BRIDGE_OPERATION_EVIDENCE_MISSING');
    const write = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      sendBinding.responseRef, sendBinding.wireKey, original.ownerRef, original.accountRef, original.subjectRef, original.connectionEpoch, sendBinding.requestSequence);
    const post = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      next.responseRef, next.wireKey, original.ownerRef, original.accountRef, original.subjectRef, next.connectionEpoch, next.requestSequence);
    const writeProof = admittedItemFrame(write, bridge.originalContext, original.method), postProof = admittedItemFrame(post, bridge.newContext, 'index.login');
    if (!writeProof || !postProof || !knownCell(postProof.frame.profile.uid) || postProof.frame.profile.uid.value !== receipt.officialUid) return denied('ITEM_COVERAGE_BRIDGE_ADMITTED_SOURCE_MISSING');
    const spent = writeProof.payload.bo?.items?.[itemId], bag = postProof.payload.bag, absolute = bag?.items?.[itemId];
    const absentZero = bag?.presence === 'present' && bag.state === 'known' && plainObject(bag.items)
      && !Object.hasOwn(bag.items, String(itemId)) && postProof.frame.coverage?.bagComplete === true;
    const value = knownCell(absolute) ? absolute.value : absentZero ? 0 : null;
    if (!knownCell(spent) || spent.value !== resource.quantity || !num(value)) return denied('ITEM_COVERAGE_BRIDGE_EXACT_CONSUMPTION_UNPROVEN');
    // No cross-connection sequence comparison. The validated immutable lease
    // establishes write -> physical closure -> independently sent new login.
    return { reasonCode: null, link: {
      coverageKey: 'item-coverage:' + fingerprint([operationId, resource.resourceKey, post.observation_ref]), ownerRef: original.ownerRef,
      subjectRef: original.subjectRef, operationId, resourceKey: resource.resourceKey, quantity: resource.quantity,
      basisRef: 'official-absolute:' + post.observation_ref + ':' + itemId, postReadRef: post.response_ref,
      connectionEpoch: post.connection_epoch, requestSequence: post.request_sequence,
      evidence: { version: 'official-item-coverage/customer-after-close/v1', itemId, writeResponseRef: write.response_ref,
        postReadRef: post.response_ref, sendBinding: clone(bridge.after), spent: spent.value, absoluteValue: value,
        absoluteSourceRef: post.observation_ref, absoluteKind: absentZero ? 'complete-login-bag-missing-key-zero' : 'explicit-login-bag-item',
        settlementRef: settlement.settlement_key, postReadBridge: bridge, bridgeEvidenceId: bridgeEvidence.evidence_id,
        bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint } } };
  }
  function hashedItemFrame(context, source, method) {
    if (!source || source.connectionEpoch !== context.connectionEpoch || !positive(source.requestSequence) ||
      !reference(source.responseRef) || !reference(source.wireKey)) return null;
    const row = get(`SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND account_ref=?
      AND subject_ref=? AND connection_epoch=? AND request_sequence=?`, source.responseRef, source.wireKey, context.ownerRef,
    context.accountRef, context.subjectRef, context.connectionEpoch, source.requestSequence);
    const admitted = admittedItemFrame(row, context, method);
    if (!admitted) return null;
    const audit = get(`SELECT payload_fingerprint FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=?
      AND account_ref=? AND subject_ref=?`, row.observation_ref, context.ownerRef, context.accountRef, context.subjectRef);
    const semantic = value => {
      if (Array.isArray(value)) return value.map(semantic);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key)).map(([key, one]) => [key, semantic(one)]));
      return value;
    };
    const body = Object.fromEntries(['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap']
      .map(key => [key, semantic(admitted.frame[key])]));
    return audit?.payload_fingerprint === fingerprint(body) ? { ...admitted, row } : null;
  }
  function matchedItemFlow({ context, source, method, itemId, featureId = null, contractRef = null, action = null } = {}) {
    const allowed = ['waterwheel.recv', 'freeWater.recv', 'usr.share'].includes(method) && itemId === 7 ||
      ['flowerRack.recvSellMoney','flowerRack.unlockStand'].includes(method) && itemId === 11 ||
      method === 'flowerArt.makeFlowerArt' && positive(itemId) ||
      featureId === 'art.first-album' && contractRef === 'art-first-album/by-vase/v1' && method === 'collectRwd.recvArtCreateRwdByVase' && itemId === 6 ||
      featureId === 'art.first-share' && contractRef === 'art-first-share/share6/v1' && method === 'usr.share' && positive(itemId) ||
      featureId === 'flower-rack' && contractRef === 'flower-rack/official-actions/v1' &&
        (method === 'flowerRack.sell' && action?.kind === 'sell' || method === 'flowerRack.cancelSell' && action?.kind === 'cancel') && positive(itemId) ||
      contractRef === 'special-orders/official-actions/v1' && positive(itemId) &&
        (featureId === 'order.palace' && action?.kind === 'palace' && action.action === 'finish' && method === 'orderPalace.finishOrder' ||
          featureId === 'order.team' && action?.kind === 'team' &&
          ({ take: 'orderTeam.takeOrder', submit: 'orderTeam.submitOrder', receive: 'orderTeam.recvRwd', stored: 'orderTeam.takeStoredOrder' })[action.action] === method);
    if (!context || !allowed) return null;
    const frame = hashedItemFrame(context, source, method);
    if (!frame) return null;
    const cell = collection => collection?.items?.[String(itemId)] ?? null;
    const profileGold = frame.frame.profile?.gold;
    const coverage = collection => ({ presence: collection?.presence ?? 'missing', state: collection?.state ?? 'unobserved',
      itemPresent: collection?.presence === 'present' && collection.state === 'known' && plainObject(collection.items) &&
        Object.hasOwn(collection.items, String(itemId)) });
    return freeze({ observationRef: frame.row.observation_ref, responseRef: frame.row.response_ref,
      method: frame.frame.source.method, connectionEpoch: frame.row.connection_epoch, requestSequence: frame.row.request_sequence,
      wireKey: frame.row.wire_key, bi: cell(frame.payload.bi), bo: cell(frame.payload.bo), bd: cell(frame.payload.bd),
      biCoverage: coverage(frame.payload.bi),
      boCoverage: { ...coverage(frame.payload.bo), presence: frame.payload.bo?.presence ?? 'missing', state: frame.payload.bo?.state ?? 'unobserved',
        item7Present: frame.payload.bo?.presence === 'present' && frame.payload.bo.state === 'known' &&
          plainObject(frame.payload.bo.items) && Object.hasOwn(frame.payload.bo.items, '7') },
      bdCoverage: { ...coverage(frame.payload.bd), presence: frame.payload.bd?.presence ?? 'missing', state: frame.payload.bd?.state ?? 'unobserved',
        item7Present: frame.payload.bd?.presence === 'present' && frame.payload.bd.state === 'known' &&
          plainObject(frame.payload.bd.items) && Object.hasOwn(frame.payload.bd.items, '7') },
      profileGold: profileGold || null,
      profileGoldCoverage: { presence: profileGold?.presence ?? 'missing', state: profileGold?.state ?? 'unobserved' },
      frameFingerprint: fingerprint({ source: frame.frame.source, bi: frame.payload.bi, bo: frame.payload.bo, bd: frame.payload.bd }) });
  }
  function matchedProfileFlow({ context, source, method, field, featureId = null, contractRef = null } = {}) {
    if (!context || !(['flowerRack.recvSellMoney','flowerRack.unlockStand'].includes(method) && field === 'gold' ||
      method === 'flowerArt.makeFlowerArt' && ['gold', 'yuanbao'].includes(field) ||
      featureId === 'art.first-share' && contractRef === 'art-first-share/share6/v1' && method === 'usr.share' && ['gold', 'yuanbao'].includes(field))) return null;
    const frame = hashedItemFrame(context, source, method);
    const value = frame?.frame?.profile?.[field];
    if (!frame || !knownCell(value)) return null;
    return freeze({ observationRef: frame.row.observation_ref, responseRef: frame.row.response_ref,
      method: frame.frame.source.method, connectionEpoch: frame.row.connection_epoch, requestSequence: frame.row.request_sequence,
      wireKey: frame.row.wire_key, value: value.value, field, frameFingerprint: fingerprint({ source: frame.frame.source, profile: frame.frame.profile }) });
  }
  function frameAbsolute(frame, itemId, allowDelta = false) {
    const bag = frame.payload.bag, delta = frame.payload.bd?.items?.[itemId];
    const explicit = allowDelta && knownCell(delta) ? delta : bag?.items?.[itemId];
    const absentZero = !explicit && bag?.presence === 'present' && bag.state === 'known' && plainObject(bag.items) &&
      !Object.hasOwn(bag.items, String(itemId)) && frame.frame.coverage?.bagComplete === true;
    return { value: knownCell(explicit) ? explicit.value : absentZero ? 0 : null, absentZero };
  }
  // Shared immutable proof for ONLY the three audited synchronous ordinary
  // finish tuples. Cost attribution and current separation below are distinct
  // conclusions; neither changes the original business verdict/footprint.
  function orderFlowerBridgeState({ operationId, settlementRef = null, sendBinding, postReadBridge, requireDomainVerification = true, checkedBridge = null }) {
    const denied = reasonCode => ({ valid: false, reasonCode });
    const bridge = bridgeReference(postReadBridge);
    if (!bridge || bridge.operationId !== operationId || !validatePostReadBridge) return denied('ITEM_ORDER_FLOWER_BRIDGE_UNAVAILABLE');
    const validated = checkedBridge ?? validatePostReadBridge({ ...bridge, phase: 'settling' });
    if (validated?.then) { validated.catch?.(() => {}); throw new TypeError('Post-read bridge validator must be synchronous'); }
    const receipt = validated?.receipt, next = receipt?.newLoginSource, old = receipt?.oldLoginSource;
    const body = plainObject(receipt) ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'bridgeFingerprint')) : null;
    if (validated?.valid !== true || validated.bridgeFingerprint !== bridge.bridgeFingerprint || !body || fingerprint(body) !== bridge.bridgeFingerprint ||
      receipt.bridgeFingerprint != null && receipt.bridgeFingerprint !== bridge.bridgeFingerprint || receipt.version !== 'after-physical-close-login/v1' ||
      receipt.leaseRef !== bridge.leaseRef || receipt.operationId !== operationId || !sameContext(receipt.originalContext, bridge.originalContext) ||
      !sameContext(receipt.newContext, bridge.newContext) || !sameBinding(receipt.after, bridge.after) || !sameBinding(sendBinding, bridge.after)) return denied('ITEM_ORDER_FLOWER_BRIDGE_UNPROVEN');
    const row = matchedAnswer(operationId, sendBinding);
    const definition = row && Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === row.feature_id && one.scope === row.scope && one.method === row.method);
    if (!definition || !['confirmed', 'unknown'].includes(row.business_verdict) || row.write_slot !== 0 || row.transport_state !== 'answered') return denied('ITEM_ORDER_FLOWER_TERMINATED_SCOPE_REQUIRED');
    const original = parseStored(row.original_json, 'order flower item original');
    if (ledgerJsonFingerprint(original) !== row.original_fingerprint || !sameContext(original, bridge.originalContext) ||
      contextKeys.slice(0, 5).some(key => bridge.originalContext[key] !== bridge.newContext[key]) ||
      bridge.newContext.connectionEpoch <= bridge.originalContext.connectionEpoch) return denied('ITEM_ORDER_FLOWER_ORIGINAL_INVALID');
    const preparationRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1'
      AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2'`, operationId);
    const contractRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_key='admitted-operation-contract:v1'
      AND kind='admitted-operation-contract' AND source='backend/write-gateway/v2'`, operationId);
    const prepared = preparationRow && evidencePayload(preparationRow), admitted = contractRow && evidencePayload(contractRow);
    if (prepared?.domain !== 'order-flower-' + definition.kind || prepared.preparation?.kind !== definition.kind ||
      !admitted || !orderFlowerHistoricalAdmittedContractMatches(admitted, definition)) return denied('ITEM_ORDER_FLOWER_ADMITTED_CONTRACT_INVALID');
    const proposal = { ...original, orderFlower: prepared.preparation, params: definition.kind === 'resident' ? { boxId: prepared.preparation.boxId } : {} };
    try { assertOrderFlowerProposal(proposal); } catch { return denied('ITEM_ORDER_FLOWER_PREPARATION_INVALID'); }
    const order = proposal.orderFlower, target = original.targets[0], expected = orderFlowerRequirements(order.beforeOrder.flowers);
    const currentOrderCatalog = acceptedActionLoginCatalog(next, bridge.newContext, order.officialUid, `order.${definition.kind}`)?.catalog;
    if (!expected || !currentOrderCatalog || expected.some(one => currentOrderCatalog.flower(one.itemId)?.id !== one.itemId)) return denied('ITEM_ORDER_FLOWER_FLOWER_RULE_UNPROVEN');
    const settlement = settlementRef ? get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=? AND settlement_key=?', operationId, target.memberKey, settlementRef)
      : get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=?', operationId, target.memberKey);
    const result = settlement ? parseStored(settlement.result_json, 'order flower item target result') : null, proof = result?.evidence?.payload;
    if (!settlement || settlement.verdict !== row.business_verdict || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint ||
      row.verification_version !== settlement.verification_version ||
      result.verificationVersion !== settlement.verification_version || result.member?.memberKey !== target.memberKey || result.member.verdict !== row.business_verdict ||
      result.evidence?.kind !== 'domain-verification' || result.evidence.source !== 'backend/write-gateway/v2' || !plainObject(proof)) return denied('ITEM_ORDER_FLOWER_SETTLEMENT_INVALID');
    if (requireDomainVerification && (settlement.verification_version !== 'order-flower-ordinary-verification/after-close-v1' || proof.version !== settlement.verification_version ||
      proof.operationId !== operationId || proof.targetRef !== target.targetRef || proof.lifecycleRef !== target.lifecycleRef ||
      proof.contentFingerprint !== order.contentFingerprint || canonical(proof.beforeOrder) !== canonical(order.beforeOrder) ||
      !sameBinding(proof.answer, sendBinding) || !sameBinding(proof.postRead, next))) return denied('ITEM_ORDER_FLOWER_DOMAIN_RESULT_UNPROVEN');
    if (!requireDomainVerification && (row.business_verdict !== 'unknown' ||
      !['order-flower-ordinary-verification/after-close-v1', 'backend/incomplete-single-target/v2'].includes(settlement.verification_version))) return denied('ITEM_ORDER_FLOWER_UNKNOWN_RESULT_UNPROVEN');
    const targetEvent = get('SELECT * FROM backend_operation_evidence WHERE evidence_id=? AND operation_id=?', settlement.evidence_id, operationId);
    const targetPayload = targetEvent && evidencePayload(targetEvent);
    if (!targetPayload || targetEvent.kind !== 'domain-verification' || targetEvent.source !== 'backend/write-gateway/v2' ||
      canonical(targetPayload) !== canonical({ ...proof, member: result.member, resourceResolutions: result.resourceResolutions,
        verificationVersion: result.verificationVersion, transportTermination: result.transportTermination })) return denied('ITEM_ORDER_FLOWER_TARGET_EVIDENCE_INVALID');
    const resources = all('SELECT * FROM backend_operation_resources WHERE operation_id=? ORDER BY resource_key', operationId);
    const bindings = all('SELECT resource_key,member_key,quantity FROM backend_operation_resource_targets WHERE operation_id=? ORDER BY resource_key', operationId);
    const targetRow = get('SELECT original_json FROM backend_operation_targets WHERE operation_id=? AND member_key=?', operationId, target.memberKey);
    if (!targetRow || canonical(parseStored(targetRow.original_json, 'order flower item target')) !== canonical(target) || resources.length !== expected.length ||
      bindings.length !== expected.length || !Array.isArray(result.resourceResolutions) || result.resourceResolutions.length !== expected.length ||
      new Set(result.resourceResolutions.map(one => one.resourceKey)).size !== expected.length ||
      !result.resourceResolutions.every(one => one.state === 'historical_footprint' && resources.some(resource => resource.resource_key === one.resourceKey))) return denied('ITEM_ORDER_FLOWER_RESOURCE_ROWS_INVALID');
    for (const one of expected) {
      const resource = original.resources.find(item => item.resourceRef === 'item:' + one.itemId), stored = resource && resources.find(item => item.resource_key === resource.resourceKey);
      const binding = resource && bindings.find(item => item.resource_key === resource.resourceKey), originalBinding = resource && original.resourceBindings.find(item => item.resourceKey === resource.resourceKey);
      if (!resource || resource.resourceKind !== 'item' || resource.quantity !== one.quantity || !stored || stored.quantity !== one.quantity ||
        canonical(parseStored(stored.original_json, 'order flower item resource')) !== canonical(resource) || binding?.member_key !== target.memberKey ||
        binding.quantity !== one.quantity || originalBinding?.memberKey !== target.memberKey || originalBinding.quantity !== one.quantity) return denied('ITEM_ORDER_FLOWER_RESOURCE_BINDING_INVALID');
    }
    const oldLoginVersion = acceptedActionLoginVersion(old, bridge.originalContext, order.officialUid, `order.${definition.kind}`);
    const newLoginVersion = acceptedActionLoginVersion(next, bridge.newContext, order.officialUid, `order.${definition.kind}`);
    const closed = receipt.oldPhysicalCloseReceipt;
    if (closed?.closed !== true || closed.connectionEpoch !== original.connectionEpoch || !reference(closed.closureEvidenceRef) ||
      receipt.officialUid !== order.officialUid || old?.officialUid !== order.officialUid || old.method !== 'index.login' ||
      old.connectionEpoch !== original.connectionEpoch || old.responseRef !== order.versionEvidence.loginResponseRef ||
      !orderFlowerSourceProofValid(order.versionEvidence, definition.kind) ||
      !oldLoginVersion || !orderFlowerSourceProofValid(oldLoginVersion, definition.kind) ||
      !sameActionLoginProof(order.versionEvidence, oldLoginVersion, `order.${definition.kind}`) ||
      next?.officialUid !== order.officialUid ||
      next.kind !== 'response' || next.transport !== 'answered' || next.method !== 'index.login' || next.connectionEpoch !== bridge.newContext.connectionEpoch ||
      !positive(next.requestSequence) || !reference(next.wireKey) || !reference(next.responseRef) ||
      !newLoginVersion || !orderFlowerSourceProofValid(newLoginVersion, definition.kind) || newLoginVersion.loginResponseRef !== next.responseRef) return denied('ITEM_ORDER_FLOWER_LOGIN_INVALID');
    const permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', operationId);
    if (permit?.consumed !== 1 || permit.owner_ref !== original.ownerRef || permit.subject_ref !== original.subjectRef || permit.owner_epoch !== original.ownerEpoch ||
      permit.run_epoch !== original.runEpoch || permit.connection_epoch !== original.connectionEpoch || permit.method !== original.method ||
      permit.params_fingerprint !== original.paramsFingerprint || permit.wire_key !== sendBinding.wireKey || permit.request_sequence !== sendBinding.requestSequence) return denied('ITEM_ORDER_FLOWER_PERMIT_INVALID');
    const answers = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    const bridges = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (answers.length > 16 || bridges.length > 16) return denied('ITEM_ORDER_FLOWER_EVIDENCE_LIMIT');
    const answer = answers.find(event => { const value = evidencePayload(event); return value && value.method === original.method && value.rejected === false && sameBinding(value, sendBinding); });
    const bridgeEvidence = bridges.find(event => {
      const value = evidencePayload(event), login = value?.newLogin, close = value?.oldPhysicalCloseReceipt;
      return value?.version === 'order-flower-after-close-login/v1' && value.leaseRef === bridge.leaseRef && value.operationId === operationId &&
        value.bridgeFingerprint === bridge.bridgeFingerprint && sameContext(value.originalContext, bridge.originalContext) && sameContext(value.newContext, bridge.newContext) &&
        sameBinding(value.after, sendBinding) && value.officialUid === order.officialUid && close?.closed === true && close.connectionEpoch === closed.connectionEpoch &&
        close.closureEvidenceRef === closed.closureEvidenceRef && sameBinding(login, next) && login.method === 'index.login' &&
        login.gameVersion === next.versionEvidence.gameVersion && login.protocolVersion === next.versionEvidence.protocolVersion && login.loginResponseRef === next.responseRef;
    });
    if (!answer || requireDomainVerification && !bridgeEvidence) return denied('ITEM_ORDER_FLOWER_OPERATION_EVIDENCE_MISSING');
    const write = hashedItemFrame(bridge.originalContext, sendBinding, original.method), post = hashedItemFrame(bridge.newContext, next, 'index.login');
    if (!write || !post || !knownCell(post.frame.profile.uid) || post.frame.profile.uid.value !== order.officialUid ||
      write.frame.profile.uid.presence !== 'missing' && (!knownCell(write.frame.profile.uid) || write.frame.profile.uid.value !== order.officialUid) ||
      post.payload.bag?.presence !== 'present' || post.payload.bag.state !== 'known' || post.frame.coverage?.bagComplete !== true) return denied('ITEM_ORDER_FLOWER_ADMITTED_SOURCE_MISSING');
    return { valid: true, bridge, receipt, row, original, proposal, order, target, expected, resources, bindings, settlement, result, proof,
      write, post, answer, bridgeEvidence, preparationRow, contractRow };
  }
  function orderFlowerBridgeCoverage(input) {
    const state = orderFlowerBridgeState(input), denied = reasonCode => ({ links: [], reasonCode });
    if (!state.valid) return denied(state.reasonCode);
    const { original, order, expected, target, settlement, write, post, bridge, answer, bridgeEvidence, row } = state;
    const bo = write.payload.bo, bi = write.payload.bi;
    if (bo?.presence !== 'present' || bo.state !== 'known' || !plainObject(bo.items) || bi?.presence !== 'present' || bi.state !== 'known' || !plainObject(bi.items) ||
      Object.entries(bo.items).some(([id, one]) => !knownCell(one) || !num(one.value) || one.value > 0 && !expected.some(item => item.itemId === Number(id))) ||
      Object.values(bi.items).some(one => !knownCell(one) || !num(one.value))) return denied('ITEM_ORDER_FLOWER_COST_MAP_UNPROVEN');
    const links = [];
    for (const one of expected) {
      const initial = order.beforeItems.find(item => item.itemId === one.itemId), source = initial?.source;
      const initialFrame = source?.kind === 'response' && source.connectionEpoch === original.connectionEpoch && source.requestSequence < bridge.after.requestSequence
        ? hashedItemFrame(bridge.originalContext, source, source.method) : null;
      const before = initialFrame && frameAbsolute(initialFrame, one.itemId, true), after = frameAbsolute(post, one.itemId);
      const spent = bo.items[one.itemId], gained = bi.items[one.itemId], gain = knownCell(gained) ? gained.value : 0;
      const resource = original.resources.find(item => item.resourceRef === 'item:' + one.itemId);
      if (!before || before.value !== initial.quantity || !num(after.value) || !knownCell(spent) || spent.value !== one.quantity ||
        after.value !== initial.quantity - one.quantity + gain || !positive(initial.quantity) || initial.quantity < one.quantity ||
        resource.basisRef !== initial.basisRef || knownCell(write.payload.bd?.items?.[one.itemId]) && write.payload.bd.items[one.itemId].value !== after.value) return denied('ITEM_ORDER_FLOWER_EXACT_CONSUMPTION_UNPROVEN');
      links.push({ coverageKey: 'item-coverage:' + fingerprint([original.operationId, resource.resourceKey, post.row.observation_ref]), ownerRef: original.ownerRef,
        subjectRef: original.subjectRef, operationId: original.operationId, resourceKey: resource.resourceKey, quantity: resource.quantity,
        basisRef: 'official-absolute:' + post.row.observation_ref + ':' + one.itemId, postReadRef: post.row.response_ref,
        connectionEpoch: post.row.connection_epoch, requestSequence: post.row.request_sequence,
        evidence: { version: 'official-item-coverage/order-flower-after-close/v1', itemId: one.itemId, kind: order.kind,
          writeResponseRef: write.row.response_ref, postReadRef: post.row.response_ref, sendBinding: clone(bridge.after), spent: spent.value, gained: gain,
          absoluteValue: after.value, absoluteSourceRef: post.row.observation_ref, absoluteKind: after.absentZero ? 'complete-login-bag-missing-key-zero' : 'explicit-login-bag-item',
          settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint, businessVerdict: row.business_verdict,
          businessOutcomeProvenByCoverage: false, originalFingerprint: row.original_fingerprint, postReadBridge: bridge,
          answerEvidenceId: answer.evidence_id, answerEvidenceFingerprint: answer.payload_fingerprint,
          bridgeEvidenceId: bridgeEvidence.evidence_id, bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint } });
    }
    return { links, reasonCode: null };
  }
  function orderFlowerCurrentSeparation({ context, resource, current, itemId, keep, quantity, claimingOperationId }) {
    if (!validatePostReadBridge || !current.base.known || !num(current.base.value)) return null;
    const operationId = resource.operation_id ?? resource.operationId, resourceKey = resource.resource_key ?? resource.resourceKey;
    const operation = get('SELECT business_verdict,feature_id,scope,method FROM backend_operations WHERE operation_id=?', operationId);
    if (operation?.business_verdict !== 'unknown' || !Object.values(ORDER_FLOWER_CONTRACTS).some(one => one.featureId === operation.feature_id && one.scope === operation.scope && one.method === operation.method)) return null;
    const lease = get('SELECT bridge_json,bridge_fingerprint FROM backend_session_verification_leases WHERE operation_id=?', operationId);
    if (!lease?.bridge_json || !isSha256(lease.bridge_fingerprint)) return null;
    const saved = parseStored(lease.bridge_json, 'order flower current separation bridge');
    const bridge = bridgeReference({ ...saved, bridgeFingerprint: lease.bridge_fingerprint });
    if (!bridge) return null;
    // The session validator is deliberately called on EVERY lookup. Only the
    // immutable historical conclusion is reused; current identity, balance,
    // source, candidate and admission guards below are evaluated afresh.
    const checkedBridge = validatePostReadBridge({ ...bridge, phase: 'settling' });
    if (checkedBridge?.then) { checkedBridge.catch?.(() => {}); throw new TypeError('Post-read bridge validator must be synchronous'); }
    if (checkedBridge?.valid!==true || !plainObject(checkedBridge.receipt) || checkedBridge.bridgeFingerprint!==bridge.bridgeFingerprint) return null;
    const state = historyMemo.memo(fingerprint({ operationId, bridge, checkedBridge }), () => {
      const full = orderFlowerBridgeState({ operationId, sendBinding: bridge.after, postReadBridge: bridge,
        requireDomainVerification: false, checkedBridge });
      if (!full.valid) return { valid: false, reasonCode: full.reasonCode };
      return { valid: true, original: { ownerRef: full.original.ownerRef, subjectRef: full.original.subjectRef,
        resources: full.original.resources.map(({ resourceKey, resourceRef, quantity }) => ({ resourceKey, resourceRef, quantity })) },
      row: { original_fingerprint: full.row.original_fingerprint }, order: { officialUid: full.order.officialUid },
      post: { row: Object.fromEntries(['connection_epoch', 'request_sequence', 'observation_ref', 'response_ref']
        .map(key => [key, full.post.row[key]])) }, bridge: full.bridge,
      receipt: { oldPhysicalCloseReceipt: full.receipt.oldPhysicalCloseReceipt },
      settlement: { settlement_key: full.settlement.settlement_key, result_fingerprint: full.settlement.result_fingerprint } };
    });
    // A normal remove/re-add may create a new account id for this same stable
    // subject. The original lease still proves the OLD account exactly; the
    // current projection below must separately prove the NEW current binding
    // and the same official UID. Changing an id grants no historical verdict,
    // ownership transfer, or permission to replay the original semantic key.
    if (!state.valid || state.original.ownerRef !== context.ownerRef || state.original.subjectRef !== context.subjectRef) return null;
    const originalResource = state.original.resources.find(one => one.resourceKey === resourceKey);
    if (!originalResource || originalResource.resourceRef !== 'item:' + itemId || originalResource.quantity !== resource.quantity) return null;
    const model = projection.view(context), source = current.base.source;
    if (!model.current || !sameContext(model.context, context) || model.identity?.verified !== true || !knownCell(model.identity.uid) ||
      model.identity.uid.value !== state.order.officialUid || source?.kind !== 'response' || source.connectionEpoch !== context.connectionEpoch ||
      source.connectionEpoch < state.post.row.connection_epoch || source.connectionEpoch === state.post.row.connection_epoch && source.requestSequence < state.post.row.request_sequence) return null;
    const currentFrame = hashedItemFrame(context, source, source.method), absolute = currentFrame && frameAbsolute(currentFrame, itemId, true);
    if (!absolute || absolute.value !== current.base.value || currentFrame.frame.profile.uid.presence !== 'missing' &&
      (!knownCell(currentFrame.frame.profile.uid) || currentFrame.frame.profile.uid.value !== state.order.officialUid)) return null;
    // The actual complete login bag after a physically closed synchronous
    // finish is a lower boundary for CURRENT accounting, even if the business
    // result is unknown. No claimed amount of historical consumption follows.
    const receipt = { version: 'ordinary-order-current-item-separation/v1', operationId, resourceKey, itemId,
      quantity: resource.quantity, originalFingerprint: state.row.original_fingerprint, originalBusinessVerdict: 'unknown',
      originalFootprintPreserved: true, costCoverageProven: false, semanticReplayAuthorized: false,
      leaseRef: bridge.leaseRef, bridgeFingerprint: bridge.bridgeFingerprint, closureEvidenceRef: state.receipt.oldPhysicalCloseReceipt.closureEvidenceRef,
      freshAbsoluteSourceRef: state.post.row.observation_ref, freshLoginResponseRef: state.post.row.response_ref,
      officialUid: state.order.officialUid, originalContext: clone(state.bridge.originalContext), freshLoginContext: clone(state.bridge.newContext),
      context: clone(context), accountIdChangeIsNotLedgerReset: true, currentSource: clone(source), currentSourceRef: currentFrame.row.observation_ref,
      currentBaseValue: current.base.value, currentBalanceVersion: current.accountingVersion,
      candidate: { itemId, keep, quantity, claimingOperationId }, settlementRef: state.settlement.settlement_key,
      settlementFingerprint: state.settlement.result_fingerprint };
    const receiptFingerprint = fingerprint(receipt), separationRef = 'ordinary-item-current-separation:' + receiptFingerprint;
    transaction(() => {
      const prior = get('SELECT receipt_json,receipt_fingerprint FROM backend_official_item_current_separations WHERE separation_ref=?', separationRef);
      if (prior) {
        if (prior.receipt_fingerprint !== receiptFingerprint || canonical(parseStored(prior.receipt_json, 'current separation original')) !== canonical(receipt)) throw problem('ITEM_CURRENT_SEPARATION_CONFLICT', '当前资源隔离原证据不可覆盖', 500);
        return;
      }
      run('INSERT INTO backend_official_item_current_separations VALUES(?,?,?,?,?,?,?,?,?,?,?)', separationRef, operationId, resourceKey,
        context.ownerRef, context.accountRef, context.subjectRef, canonical(context), canonical(source), canonical(receipt), receiptFingerprint, nowIso());
    });
    return { separationRef };
  }

  // A historical unknown is not a permanent ban on independently observed net
  // stock demand. This boundary needs the ACTUAL completed recipe transformation
  // (including zero currency debit), not merely a closed client or newer login.
  function observedArtCompletion({ context, operationId, artId = null } = {}) {
    if (!validatePostReadBridge || !context || !reference(operationId)) return null;
    const row=get('SELECT * FROM backend_operations WHERE operation_id=?',operationId);
    const definition=row?.feature_id==='art.daily'?DAILY_ART_CONTRACT:row?.feature_id==='art.customer-batch'?CUSTOMER_ART_BATCH_CONTRACT:null;
    if (!definition || row.scope!==definition.scope || row.method!==definition.method || row.transport_state!=='answered' || row.write_slot!==0 ||
        !['unknown','confirmed'].includes(row.business_verdict) || row.owner_ref!==context.ownerRef || row.subject_ref!==context.subjectRef) return null;
    const lease=get('SELECT bridge_json,bridge_fingerprint FROM backend_session_verification_leases WHERE operation_id=?',operationId);
    if (!lease?.bridge_json || !isSha256(lease.bridge_fingerprint)) return null;
    const saved=parseStored(lease.bridge_json,'art observed completion bridge');
    if (fingerprint(saved)!==lease.bridge_fingerprint) return null;
    const bridge=bridgeReference({...saved,bridgeFingerprint:lease.bridge_fingerprint});if(!bridge)return null;
    const checked=validatePostReadBridge({...bridge,phase:'settling'});
    if(checked?.then){checked.catch?.(()=>{});throw new TypeError('Post-read bridge validator must be synchronous');}
    if(checked?.valid!==true || !plainObject(checked.receipt) || checked.bridgeFingerprint!==bridge.bridgeFingerprint)return null;
    const boundary=historyMemo.memo('art-completion:'+fingerprint({operationId,checked,originalFingerprint:row.original_fingerprint,
      originalBytesHash:hashLedgerBytes(row.original_json)}),()=>{
      const fail=()=>null,receipt=checked.receipt,body=Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='bridgeFingerprint'));
      const original=parseStored(row.original_json,'art observed completion original');
      if(ledgerJsonFingerprint(original)!==row.original_fingerprint || !sameContext(original,bridge.originalContext) ||
          original.operationId!==operationId || original.featureId!==definition.featureId || original.scope!==row.scope || original.method!==row.method ||
          original.paramsFingerprint!==row.params_fingerprint || receipt.version!=='after-physical-close-login/v1' ||
          receipt.operationId!==operationId || receipt.leaseRef!==bridge.leaseRef || fingerprint(body)!==bridge.bridgeFingerprint ||
          !sameContext(receipt.originalContext,bridge.originalContext) || !sameContext(receipt.newContext,bridge.newContext) ||
          !sameBinding(receipt.after,bridge.after) || contextKeys.slice(0,5).some(key=>bridge.originalContext[key]!==bridge.newContext[key]) ||
          bridge.newContext.connectionEpoch<=bridge.originalContext.connectionEpoch || receipt.oldPhysicalCloseReceipt?.closed!==true ||
          receipt.oldPhysicalCloseReceipt.connectionEpoch!==original.connectionEpoch || !reference(receipt.oldPhysicalCloseReceipt.closureEvidenceRef))return fail();
      const readEvidence=(key,kind)=>{const e=get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`,operationId,key,kind);
        return e?{row:e,payload:evidencePayload(e)}:null;};
      const prepared=readEvidence('finite-domain-preparation:v1','finite-domain-preparation'),admitted=readEvidence('admitted-operation-contract:v1','admitted-operation-contract');
      const daily=definition.featureId==='art.daily',postRead=daily?DAILY_ART_POST_READ:CUSTOMER_ART_BATCH_POST_READ;
      const metadata={...definition,postRead:Object.fromEntries(['contractId','method','kind','args','evidenceRef'].map(key=>[key,postRead[key]]))};
      if(!prepared?.payload || prepared.payload.domain!==(daily?'art-daily':'art-customer-batch') || !admitted?.payload || canonical(admitted.payload)!==canonical(metadata))return fail();
      const prep=prepared.payload.preparation,params={vaseId:prep?.vaseId,flowersIds:prep?.flowersIds,num:prep?.batchQuantity};
      const proposal={...original,contractRef:definition.contractRef,params,[daily?'dailyArt':'customerArtBatch']:prep};
      try{(daily?assertDailyArtProposal:assertCustomerArtBatchProposal)(proposal);}catch{return fail();}
      const old=bridge.originalContext,next=receipt.newLoginSource,uid=prep.officialUid;
      if(receipt.officialUid!==uid || receipt.oldLoginSource?.officialUid!==uid || next?.officialUid!==uid ||
          receipt.oldLoginSource?.responseRef!==prep.loginResponseRef || receipt.oldLoginSource.connectionEpoch!==old.connectionEpoch ||
          !positive(receipt.oldLoginSource.requestSequence) || receipt.oldLoginSource.requestSequence>=bridge.after.requestSequence ||
          next.method!=='index.login' || next.kind!=='response' || next.transport!=='answered' || next.connectionEpoch!==bridge.newContext.connectionEpoch ||
          !positive(next.requestSequence) || !reference(next.responseRef) || !reference(next.wireKey))return fail();
      const oldCatalog=acceptedActionLoginCatalog(receipt.oldLoginSource,old,uid,'art.make')?.catalog;
      const nextVersion=acceptedActionLoginVersion(next,bridge.newContext,uid,'art.make');
      const oldVersion=acceptedActionLoginVersion(receipt.oldLoginSource,old,uid,'art.make');
      if(!oldCatalog || !oldVersion || !nextVersion || !compatibleActionContract(oldVersion,nextVersion,'art.make') ||
          !sameActionLoginProof(prep.versionEvidence,oldVersion,'art.make'))return fail();
      const recipe=createOfficialArtCatalog({landCatalog:oldCatalog,customerCatalog:createOfficialCustomerCatalog({landCatalog:oldCatalog})}).recipe(prep.artId);
      if(!recipe.known || recipe.vaseId!==params.vaseId || canonical(recipe.flowersIds)!==canonical(params.flowersIds) || artRecipeFingerprint(recipe)!==prep.recipeFingerprint)return fail();
      const permit=boundSendPermit(operationId,original);
      if(permit?.consumed!==1 || permit.account_ref!==original.accountRef || permit.owner_ref!==original.ownerRef || permit.subject_ref!==original.subjectRef ||
          permit.owner_epoch!==original.ownerEpoch || permit.run_epoch!==original.runEpoch || permit.connection_epoch!==original.connectionEpoch ||
          permit.method!==original.method || permit.params_fingerprint!==original.paramsFingerprint ||
          permit.request_sequence!==bridge.after.requestSequence || permit.wire_key!==bridge.after.wireKey)return fail();
      const answers=all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' LIMIT 2",operationId);
      const answer=answers.length===1?evidencePayload(answers[0]):null;
      if(!answer || answer.method!==row.method || answer.rejected!==false || !sameBinding(answer,bridge.after))return fail();
      const write=hashedItemFrame(old,bridge.after,row.method),post=hashedItemFrame(bridge.newContext,next,'index.login');
      if(!write || !post || !knownCell(post.frame.profile.uid) || post.frame.profile.uid.value!==uid ||
          write.frame.profile.uid.presence!=='missing'&&(!knownCell(write.frame.profile.uid)||write.frame.profile.uid.value!==uid) ||
          post.payload.bag?.presence!=='present' || post.payload.bag.state!=='known' || post.frame.coverage?.bagComplete!==true ||
          write.payload.bi?.presence!=='present' || write.payload.bi.state!=='known' || write.payload.bo?.presence!=='present' || write.payload.bo.state!=='known')return fail();
      const expected=recipe.unitInputMultiset.map(one=>({itemId:one.itemId,quantity:one.occurrences*params.num}));
      const beforeById=daily?prep.beforeBalances:Object.fromEntries([...prep.inputBalances.map(one=>[one.itemId,one]),[prep.artId,prep.beforeProduct]]);
      const ids=[prep.artId,...expected.map(one=>one.itemId)],deltas=[];
      if(new Set(ids).size!==ids.length || Object.entries(write.payload.bo.items||{}).some(([id,cell])=>!knownCell(cell)||cell.value<0||cell.value>0&&!expected.some(one=>one.itemId===Number(id))) ||
          Object.entries(write.payload.bi.items||{}).some(([id,cell])=>!knownCell(cell)||cell.value<0||cell.value>0&&Number(id)!==prep.artId))return fail();
      for(const id of ids){
        const before=beforeById[id],src=before?.source;
        if(!src || src.kind!=='response' || src.connectionEpoch!==old.connectionEpoch || !positive(src.requestSequence) || src.requestSequence>=bridge.after.requestSequence)return fail();
        const initial=hashedItemFrame(old,src,src.method),initialValue=initial&&frameAbsolute(initial,id,true),afterValue=frameAbsolute(post,id,true);
        const gain=write.payload.bi.items?.[id],spent=write.payload.bo.items?.[id],bd=write.payload.bd?.items?.[id];
        const bi=knownCell(gain)?gain.value:!gain?0:null,bo=knownCell(spent)?spent.value:!spent?0:null;
        const wantedGain=id===prep.artId?params.num:0,wantedCost=expected.find(one=>one.itemId===id)?.quantity||0;
        if(!initialValue || initialValue.value!==before.value || !afterValue || !num(afterValue.value) || bi!==wantedGain || bo!==wantedCost ||
            afterValue.value!==before.value+bi-bo || !knownCell(bd) || bd.value!==afterValue.value)return fail();
        if(wantedCost){const resource=original.resources.find(one=>one.resourceRef==='item:'+id);
          const stored=resource&&get('SELECT * FROM backend_operation_resources WHERE operation_id=? AND resource_key=?',operationId,resource.resourceKey);
          const member=resource&&get('SELECT * FROM backend_operation_resource_targets WHERE operation_id=? AND resource_key=? AND member_key=?',operationId,resource.resourceKey,original.targets[0].memberKey);
          if(!resource || resource.quantity!==wantedCost || (daily?before.basisRef!==initial.row.observation_ref:resource.basisRef!==before.basisRef) || !stored || stored.quantity!==wantedCost ||
              canonical(parseStored(stored.original_json,'art observed resource original'))!==canonical(resource) || member?.quantity!==wantedCost)return fail();}
        deltas.push({itemId:id,before:before.value,after:afterValue.value,bi,bo});
      }
      const beforeProfile=prep.beforeProfile;
      for(const [id,name]of [[11,'gold'],[1,'yuanbao']]){
        const b=beforeProfile?.[name],fieldSource=beforeProfile?.[name+'Source'];
        const sourceFrame=fieldSource?hashedItemFrame(old,fieldSource,fieldSource.method):null;
        const beforeCell=sourceFrame?.frame.profile?.[name],afterCell=post.frame.profile?.[name];
        const gain=write.payload.bi.items?.[id],spent=write.payload.bo.items?.[id];
        if(!num(b)||!knownCell(beforeCell)||beforeCell.value!==b||!knownCell(afterCell)||afterCell.value!==b||
            (gain?(!knownCell(gain)||gain.value!==0):false)||(spent?(!knownCell(spent)||spent.value!==0):false))return fail();
      }
      const target=get('SELECT original_json FROM backend_operation_targets WHERE operation_id=? AND member_key=?',operationId,original.targets[0].memberKey);
      if(!target||canonical(parseStored(target.original_json,'art observed target original'))!==canonical(original.targets[0]))return fail();
      return {version:'art-observed-completion/v1',operationId,featureId:definition.featureId,artId:prep.artId,officialUid:uid,targetRef:original.targets[0].targetRef,
        originalFingerprint:row.original_fingerprint,originalVerdictPreserved:true,originalFootprintsPreserved:true,semanticReplayAuthorized:false,
        recipeFingerprint:prep.recipeFingerprint,parentLifecycleRef:daily?null:prep.parentLifecycleRef,dayKey:daily?prep.dayKey:null,
        unitOrdinal:daily?prep.unitOrdinal:null,quantity:params.num,resources:original.resources.map(one=>({resourceKey:one.resourceKey,resourceRef:one.resourceRef,quantity:one.quantity})),
        leaseRef:bridge.leaseRef,bridgeFingerprint:bridge.bridgeFingerprint,oldContext:old,postContext:bridge.newContext,
        postSourceRef:post.row.observation_ref,postResponseRef:post.row.response_ref,postRequestSequence:post.row.request_sequence,
        answerEvidenceFingerprint:answers[0].payload_fingerprint,preparationFingerprint:prepared.row.payload_fingerprint,deltas};
    });
    if(!boundary || artId!==null&&boundary.artId!==artId)return null;
    const current=balance({context,itemId:boundary.artId}),model=projection.view(context),src=current.base.source;
    if(!model.current || model.identity?.verified!==true || !knownCell(model.identity.uid) || model.identity.uid.value!==boundary.officialUid ||
        !current.base.known || src?.kind!=='response' || src.method!=='index.login' || src.connectionEpoch!==context.connectionEpoch ||
        src.connectionEpoch<boundary.postContext.connectionEpoch || src.connectionEpoch===boundary.postContext.connectionEpoch&&src.requestSequence<boundary.postRequestSequence)return null;
    const currentFrame=hashedItemFrame(context,src,'index.login'),absolute=currentFrame&&frameAbsolute(currentFrame,boundary.artId,true);
    if(!absolute || absolute.value!==current.base.value)return null;
    const body={...boundary,currentContext:clone(context),currentSourceRef:currentFrame.row.observation_ref,
      currentResponseRef:src.responseRef,currentProduct:current.base.value,currentAccountingVersion:current.accountingVersion};
    return freeze({...body,boundaryRef:'art-current-net-boundary:'+fingerprint(body)});
  }

  function artCurrentSeparation({context,resource,current,itemId}) {
    const operationId=resource.operation_id??resource.operationId,resourceKey=resource.resource_key??resource.resourceKey;
    const boundary=observedArtCompletion({context,operationId});
    if(!boundary || !boundary.resources.some(one=>one.resourceKey===resourceKey&&one.resourceRef==='item:'+itemId&&one.quantity===resource.quantity))return null;
    const src=current.base.source;
    if(!current.base.known || src?.kind!=='response' || src.connectionEpoch!==context.connectionEpoch ||
        src.connectionEpoch<boundary.postContext.connectionEpoch || src.connectionEpoch===boundary.postContext.connectionEpoch&&src.requestSequence<boundary.postRequestSequence)return null;
    const currentFrame=hashedItemFrame(context,src,src.method),absolute=currentFrame&&frameAbsolute(currentFrame,itemId,true);
    if(!absolute || absolute.value!==current.base.value)return null;
    const body={version:'art-current-item-separation/v1',operationId,resourceKey,itemId,quantity:resource.quantity,
      originalFingerprint:boundary.originalFingerprint,originalFootprintPreserved:true,semanticReplayAuthorized:false,
      observedCompletion:boundary,currentContext:clone(context),currentSourceRef:currentFrame.row.observation_ref,
      currentAbsolute:current.base.value,currentAccountingVersion:current.accountingVersion};
    const receiptFingerprint=fingerprint(body),separationRef='art-item-current-separation:'+receiptFingerprint;
    transaction(()=>{
      const prior=get('SELECT receipt_json,receipt_fingerprint FROM backend_official_item_current_separations WHERE separation_ref=?',separationRef);
      if(prior){if(prior.receipt_fingerprint!==receiptFingerprint||canonical(parseStored(prior.receipt_json,'art current item separation'))!==canonical(body))throw problem('ITEM_CURRENT_SEPARATION_CONFLICT','当前资源隔离原证据不可覆盖',500);return;}
      run('INSERT INTO backend_official_item_current_separations VALUES(?,?,?,?,?,?,?,?,?,?,?)',separationRef,operationId,resourceKey,
        context.ownerRef,context.accountRef,context.subjectRef,canonical(context),canonical(src),canonical(body),receiptFingerprint,nowIso());
    });
    return {separationRef};
  }
  function artBridgeCoverage({ operationId, settlementRef, sendBinding, postReadBridge }) {
    const denied = reasonCode => ({ links: [], reasonCode });
    const bridge = bridgeReference(postReadBridge);
    if (!bridge || bridge.operationId !== operationId || !validatePostReadBridge) return denied('ITEM_ART_COVERAGE_BRIDGE_UNAVAILABLE');
    const validated = validatePostReadBridge({ ...bridge, phase: 'settling' });
    if (validated?.then) { validated.catch?.(() => {}); throw new TypeError('Post-read bridge validator must be synchronous'); }
    const receipt = validated?.receipt, next = receipt?.newLoginSource, oldLogin = receipt?.oldLoginSource;
    const receiptBody = plainObject(receipt) ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'bridgeFingerprint')) : null;
    if (validated?.valid !== true || validated.bridgeFingerprint !== bridge.bridgeFingerprint || !receiptBody || fingerprint(receiptBody) !== bridge.bridgeFingerprint ||
      receipt.bridgeFingerprint != null && receipt.bridgeFingerprint !== bridge.bridgeFingerprint || receipt.version !== 'after-physical-close-login/v1' ||
      receipt.leaseRef !== bridge.leaseRef || receipt.operationId !== operationId || !sameContext(receipt.originalContext, bridge.originalContext) ||
      !sameContext(receipt.newContext, bridge.newContext) || !sameBinding(receipt.after, bridge.after) || !sameBinding(sendBinding, bridge.after)) {
      return denied('ITEM_ART_COVERAGE_BRIDGE_UNPROVEN');
    }
    const oldLoginVersion = acceptedActionLoginVersion(oldLogin, bridge.originalContext, receipt.officialUid, 'art.make');
    const nextLoginVersion = acceptedActionLoginVersion(next, bridge.newContext, receipt.officialUid, 'art.make');
    if (!oldLoginVersion || !nextLoginVersion || !compatibleActionContract(oldLoginVersion, nextLoginVersion, 'art.make')) {
      return denied('ITEM_ART_COVERAGE_LOGIN_INVALID');
    }
    const row = matchedAnswer(operationId, sendBinding);
    if (!row || row.feature_id !== 'art.make' || row.scope !== 'flower-art-make' || row.method !== 'flowerArt.makeFlowerArt' ||
      row.business_verdict !== 'confirmed' || row.write_slot !== 0 || row.transport_state !== 'answered') return denied('ITEM_ART_COVERAGE_CONFIRMED_SCOPE_REQUIRED');
    const original = parseStored(row.original_json, 'art coverage original');
    if (ledgerJsonFingerprint(original) !== row.original_fingerprint || !sameContext(original, bridge.originalContext) ||
      contextKeys.slice(0, 5).some(key => bridge.originalContext[key] !== bridge.newContext[key]) ||
      bridge.newContext.connectionEpoch <= bridge.originalContext.connectionEpoch || original.targets?.length !== 1 ||
      original.targets[0].targetKind !== 'flower-art-unit') return denied('ITEM_ART_COVERAGE_ORIGINAL_INVALID');
    const target = original.targets[0], prefix = 'flower-art:' + original.subjectRef + ':';
    const suffix = typeof target.targetRef === 'string' && target.targetRef.startsWith(prefix) ? target.targetRef.slice(prefix.length) : '';
    const artId = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : null;
    if (!positive(artId) || target.memberKey !== 'art:' + target.lifecycleRef || original.semanticKey !== 'art-make:' + target.lifecycleRef) return denied('ITEM_ART_COVERAGE_TARGET_INVALID');
    const oldLandCatalog = acceptedActionLoginCatalog(oldLogin, bridge.originalContext, receipt.officialUid, 'art.make')?.catalog;
    const artCatalog = createOfficialArtCatalog({ landCatalog: oldLandCatalog,
      customerCatalog: createOfficialCustomerCatalog({ landCatalog: oldLandCatalog }) });
    const recipe = artCatalog.recipe(artId);
    if (!recipe.known) return denied('ITEM_ART_COVERAGE_RECIPE_UNSUPPORTED');
    const expected = recipe.unitInputMultiset.map(one => ({ itemId: one.itemId, quantity: one.occurrences }));
    if (!Array.isArray(original.resources) || original.resources.length !== expected.length || expected.length < 1 || expected.length > 3 ||
      !Array.isArray(original.resourceBindings) || original.resourceBindings.length !== expected.length ||
      new Set(original.resources.map(one => one.resourceKey)).size !== expected.length ||
      original.paramsFingerprint !== fingerprint(recipe.unitRequest)) return denied('ITEM_ART_COVERAGE_RECIPE_RESOURCES_INVALID');
    const settlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=? AND settlement_key=?',
      operationId, target.memberKey, settlementRef || '');
    const result = settlement ? parseStored(settlement.result_json, 'art coverage target result') : null;
    const proof = result?.evidence?.payload, cost = proof?.observedCostReceipt;
    if (!settlement || settlement.verdict !== 'confirmed' || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint || row.verification_version !== settlement.verification_version ||
      settlement.verification_version !== 'art-make-verification/after-close-cost-observation-v1' ||
      result.verificationVersion !== settlement.verification_version || result.member?.memberKey !== target.memberKey || result.member.verdict !== 'confirmed' ||
      result.evidence?.kind !== 'domain-verification' || result.evidence.source !== 'backend/write-gateway/v2' ||
      proof?.version !== settlement.verification_version || proof.operationId !== operationId || proof.targetRef !== target.targetRef ||
      proof.lifecycleRef !== target.lifecycleRef || !cost || cost.known !== true || cost.complete !== true ||
      cost.version !== 'art-observed-cost/v1' || cost.kind !== 'observed-versioned-recipe-cost' || cost.operationId !== operationId ||
      cost.unitRef !== target.lifecycleRef || cost.gameVersion !== oldLoginVersion.gameVersion || cost.protocolVersion !== oldLoginVersion.protocolVersion || cost.artId !== artId ||
      cost.vaseId !== recipe.vaseId || cost.num !== 1 || canonical(cost.flowersIds) !== canonical(recipe.flowersIds) ||
      canonical(cost.consumptions) !== canonical(expected) || cost.additionalCurrencyCostKnown !== true || cost.gold !== 0 || cost.yb !== 0 ||
      cost.vaseConsumed !== false || cost.produced?.itemId !== artId || cost.produced.quantity !== 1 ||
      cost.bridgeFingerprint !== bridge.bridgeFingerprint || cost.recipeFingerprint !== artRecipeFingerprint({ artId, ...recipe.unitRequest }) ||
      proof.recipeFingerprint !== cost.recipeFingerprint || target.targetFingerprint !== artTargetFingerprint({ parentLifecycleRef: proof.parentLifecycleRef,
        demandRef: proof.demandRef, unitRef: target.lifecycleRef, recipeFingerprint: cost.recipeFingerprint })) return denied('ITEM_ART_COVERAGE_SETTLEMENT_INVALID');
    const costBody = Object.fromEntries(Object.entries(cost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key)));
    if (fingerprint(costBody) !== cost.receiptFingerprint || cost.receiptRef !== 'art-observed-cost:' + cost.receiptFingerprint) return denied('ITEM_ART_COVERAGE_COST_RECEIPT_INVALID');
    const targetEvent = get('SELECT * FROM backend_operation_evidence WHERE evidence_id=? AND operation_id=?', settlement.evidence_id, operationId);
    const targetPayload = targetEvent ? evidencePayload(targetEvent) : null;
    if (!targetPayload || targetEvent.kind !== 'domain-verification' || targetEvent.source !== 'backend/write-gateway/v2' ||
      canonical(targetPayload) !== canonical({ ...proof, member: result.member, resourceResolutions: result.resourceResolutions,
        verificationVersion: result.verificationVersion, transportTermination: result.transportTermination })) return denied('ITEM_ART_COVERAGE_TARGET_EVIDENCE_INVALID');
    const closure = receipt.oldPhysicalCloseReceipt;
    if (closure?.closed !== true || closure.connectionEpoch !== original.connectionEpoch || !reference(closure.closureEvidenceRef) ||
      !positive(receipt.officialUid) || oldLogin?.officialUid !== receipt.officialUid || oldLogin.method !== 'index.login' ||
      oldLogin.connectionEpoch !== original.connectionEpoch || oldLogin.versionEvidence?.gameVersion !== oldLoginVersion.gameVersion ||
      oldLogin.versionEvidence?.protocolVersion !== oldLoginVersion.protocolVersion || next?.officialUid !== receipt.officialUid || next.kind !== 'response' ||
      next.transport !== 'answered' || next.method !== 'index.login' || next.connectionEpoch !== bridge.newContext.connectionEpoch ||
      !positive(next.requestSequence) || !reference(next.wireKey) || !reference(next.responseRef) || next.versionEvidence?.gameVersion !== nextLoginVersion.gameVersion ||
      next.versionEvidence?.protocolVersion !== nextLoginVersion.protocolVersion || next.versionEvidence?.loginResponseRef !== next.responseRef ||
      proof.before?.vase?.uid !== receipt.officialUid || proof.before.vase.vaseId !== recipe.vaseId) return denied('ITEM_ART_COVERAGE_LOGIN_INVALID');
    const permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', operationId);
    if (permit?.consumed !== 1 || permit.owner_ref !== original.ownerRef || permit.subject_ref !== original.subjectRef ||
      permit.owner_epoch !== original.ownerEpoch || permit.run_epoch !== original.runEpoch || permit.connection_epoch !== original.connectionEpoch ||
      permit.method !== original.method || permit.params_fingerprint !== original.paramsFingerprint || permit.wire_key !== sendBinding.wireKey ||
      permit.request_sequence !== sendBinding.requestSequence) return denied('ITEM_ART_COVERAGE_PERMIT_INVALID');
    const answers = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    const bridges = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (answers.length > 16 || bridges.length > 16) return denied('ITEM_ART_COVERAGE_EVIDENCE_LIMIT');
    const answer = answers.find(event => { const value = evidencePayload(event); return value && value.method === original.method && value.rejected === false && sameBinding(value, sendBinding); });
    const bridgeEvidence = bridges.find(event => {
      const value = evidencePayload(event), login = value?.newLogin, closed = value?.oldPhysicalCloseReceipt;
      return value?.version === 'art-after-close-login/v1' && value.leaseRef === bridge.leaseRef && value.operationId === operationId &&
        value.bridgeFingerprint === bridge.bridgeFingerprint && sameContext(value.originalContext, bridge.originalContext) &&
        sameContext(value.newContext, bridge.newContext) && sameBinding(value.after, sendBinding) && value.officialUid === receipt.officialUid &&
        closed?.closed === true && closed.connectionEpoch === closure.connectionEpoch && closed.closureEvidenceRef === closure.closureEvidenceRef &&
        sameBinding(login, next) && login.method === 'index.login' && login.gameVersion === next.versionEvidence.gameVersion &&
        login.protocolVersion === next.versionEvidence.protocolVersion && login.loginResponseRef === next.responseRef;
    });
    if (!answer || !bridgeEvidence || !sameBinding(cost.answer, sendBinding) || !sameBinding(cost.postRead, next)) return denied('ITEM_ART_COVERAGE_OPERATION_EVIDENCE_MISSING');
    const semantic = value => {
      if (Array.isArray(value)) return value.map(semantic);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['source', 'sourceRef', 'semanticVersion', 'observationRef', 'responseRef'].includes(key)).map(([key, one]) => [key, semantic(one)]));
      return value;
    };
    const findFrame = (context, source, method) => {
      if (!source || source.connectionEpoch !== context.connectionEpoch || !positive(source.requestSequence) || !reference(source.responseRef) || !reference(source.wireKey)) return null;
      const frameRow = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND account_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
        source.responseRef, source.wireKey, context.ownerRef, context.accountRef, context.subjectRef, context.connectionEpoch, source.requestSequence);
      const admitted = admittedItemFrame(frameRow, context, method);
      if (!admitted) return null;
      const audit = get('SELECT payload_fingerprint FROM backend_land_domain_observations WHERE observation_ref=? AND owner_ref=? AND account_ref=? AND subject_ref=?',
        frameRow.observation_ref, context.ownerRef, context.accountRef, context.subjectRef);
      const body = Object.fromEntries(['profile', 'landUid', 'landBase', 'landChanges', 'cultivates', 'bag', 'itemExt', 'bi', 'bo', 'bd', 'top', 'harvestMap']
        .map(key => [key, semantic(admitted.frame[key])]));
      return audit?.payload_fingerprint === fingerprint(body) ? { ...admitted, row: frameRow } : null;
    };
    const write = findFrame(bridge.originalContext, sendBinding, original.method), post = findFrame(bridge.newContext, next, 'index.login');
    if (!write || !post || !knownCell(post.frame.profile.uid) || post.frame.profile.uid.value !== receipt.officialUid ||
      write.frame.profile.uid.presence !== 'missing' && (!knownCell(write.frame.profile.uid) || write.frame.profile.uid.value !== receipt.officialUid) ||
      post.payload.bag?.presence !== 'present' || post.payload.bag.state !== 'known' || post.frame.coverage?.bagComplete !== true) return denied('ITEM_ART_COVERAGE_ADMITTED_SOURCE_MISSING');
    const absolute = (frame, itemId, allowDelta = false) => {
      const bag = frame.payload.bag, explicit = allowDelta && knownCell(frame.payload.bd?.items?.[itemId]) ? frame.payload.bd.items[itemId] : bag?.items?.[itemId];
      const absentZero = !explicit && bag?.presence === 'present' && bag.state === 'known' && plainObject(bag.items) &&
        !Object.hasOwn(bag.items, String(itemId)) && frame.frame.coverage?.bagComplete === true;
      return { value: knownCell(explicit) ? explicit.value : absentZero ? 0 : null, absentZero };
    };
    const costItems = write.payload.bo;
    if (costItems?.presence !== 'present' || costItems.state !== 'known' || !plainObject(costItems.items) ||
      Object.entries(costItems.items).some(([id, one]) => !knownCell(one) || one.value > 0 && !expected.some(item => item.itemId === Number(id)))) return denied('ITEM_ART_COVERAGE_COST_MAP_UNPROVEN');
    const allResources = all('SELECT * FROM backend_operation_resources WHERE operation_id=? ORDER BY resource_key', operationId);
    const allBindings = all('SELECT resource_key,member_key,quantity FROM backend_operation_resource_targets WHERE operation_id=? ORDER BY resource_key', operationId);
    const targetRow = get('SELECT original_json FROM backend_operation_targets WHERE operation_id=? AND member_key=?', operationId, target.memberKey);
    if (!targetRow || canonical(parseStored(targetRow.original_json, 'art coverage target original')) !== canonical(target) ||
      allResources.length !== expected.length || allBindings.length !== expected.length ||
      !Array.isArray(result.resourceResolutions) || result.resourceResolutions.length !== expected.length ||
      !result.resourceResolutions.every(one => one.state === 'historical_footprint' && original.resources.some(resource => resource.resourceKey === one.resourceKey))) {
      return denied('ITEM_ART_COVERAGE_RESOURCE_ROWS_INVALID');
    }
    const initialItems = proof.before?.items;
    if (!Array.isArray(initialItems) || initialItems.length !== expected.length + 1 || new Set(initialItems.map(one => one.itemId)).size !== initialItems.length) return denied('ITEM_ART_COVERAGE_BEFORE_ITEMS_MISSING');
    const links = [];
    for (const one of [...expected, { itemId: artId, quantity: -1 }]) {
      const initial = initialItems.find(item => item.itemId === one.itemId), source = initial?.source;
      if (!initial || !num(initial.quantity) || source?.kind !== 'response' || source.connectionEpoch !== original.connectionEpoch ||
        !positive(source.requestSequence) || source.requestSequence >= sendBinding.requestSequence ||
        !['index.login', 'usrLand.refresh', 'usrLand.plant', 'usrLand.water', 'usrLand.harvest', 'orderCustomer.finishOrder', 'flowerArt.makeFlowerArt'].includes(source.method)) return denied('ITEM_ART_COVERAGE_BEFORE_SOURCE_INVALID');
      const initialFrame = findFrame(bridge.originalContext, source, source.method), previous = initialFrame && absolute(initialFrame, one.itemId, true);
      const nextValue = absolute(post, one.itemId), spent = write.payload.bo.items[one.itemId];
      if (!previous || previous.value !== initial.quantity || !num(nextValue.value) || nextValue.value !== initial.quantity - one.quantity ||
        knownCell(write.payload.bd?.items?.[one.itemId]) && write.payload.bd.items[one.itemId].value !== nextValue.value) return denied('ITEM_ART_COVERAGE_ABSOLUTE_DIFFERENCE_UNPROVEN');
      if (one.itemId === artId) {
        if (!knownCell(write.payload.bi?.items?.[artId]) || write.payload.bi.items[artId].value !== 1) return denied('ITEM_ART_COVERAGE_PRODUCT_GAIN_UNPROVEN');
        continue;
      }
      const resource = original.resources.find(item => item.resourceKind === 'item' && item.resourceRef === 'item:' + one.itemId);
      const stored = resource && allResources.find(item => item.resource_key === resource.resourceKey), binding = resource && allBindings.find(item => item.resource_key === resource.resourceKey);
      const originalBinding = resource && original.resourceBindings.find(item => item.resourceKey === resource.resourceKey);
      if (!resource || resource.quantity !== one.quantity || resource.basisRef !== initial.basisRef || !stored || stored.quantity !== one.quantity ||
        canonical(parseStored(stored.original_json, 'art coverage resource original')) !== canonical(resource) ||
        binding?.member_key !== target.memberKey || binding.quantity !== one.quantity || originalBinding?.memberKey !== target.memberKey ||
        originalBinding.quantity !== one.quantity || !knownCell(spent) || spent.value !== one.quantity) return denied('ITEM_ART_COVERAGE_EXACT_CONSUMPTION_UNPROVEN');
      links.push({ coverageKey: 'item-coverage:' + fingerprint([operationId, resource.resourceKey, post.row.observation_ref]), ownerRef: original.ownerRef,
        subjectRef: original.subjectRef, operationId, resourceKey: resource.resourceKey, quantity: resource.quantity,
        basisRef: 'official-absolute:' + post.row.observation_ref + ':' + one.itemId, postReadRef: post.row.response_ref,
        connectionEpoch: post.row.connection_epoch, requestSequence: post.row.request_sequence,
        evidence: { version: 'official-item-coverage/art-after-close/v1', itemId: one.itemId, artId, recipeFingerprint: cost.recipeFingerprint,
          writeResponseRef: write.row.response_ref, postReadRef: post.row.response_ref, sendBinding: clone(bridge.after), spent: spent.value,
          absoluteValue: nextValue.value, absoluteSourceRef: post.row.observation_ref,
          absoluteKind: nextValue.absentZero ? 'complete-login-bag-missing-key-zero' : 'explicit-login-bag-item',
          settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint,
          costReceiptRef: cost.receiptRef, costReceiptFingerprint: cost.receiptFingerprint,
          postReadBridge: bridge, answerEvidenceId: answer.evidence_id, answerEvidenceFingerprint: answer.payload_fingerprint,
          bridgeEvidenceId: bridgeEvidence.evidence_id, bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint } });
    }
    const initialProfile = proof.before?.profile, profileSource = initialProfile?.source;
    const initialProfileFrame = profileSource?.kind === 'response' && profileSource.connectionEpoch === original.connectionEpoch &&
      profileSource.requestSequence < sendBinding.requestSequence ? findFrame(bridge.originalContext, profileSource, profileSource.method) : null;
    if (!initialProfileFrame || !num(initialProfile.gold) || !num(initialProfile.yb) ||
      !knownCell(initialProfileFrame.frame.profile.gold) || initialProfileFrame.frame.profile.gold.value !== initialProfile.gold ||
      !knownCell(initialProfileFrame.frame.profile.yuanbao) || initialProfileFrame.frame.profile.yuanbao.value !== initialProfile.yb ||
      !knownCell(post.frame.profile.gold) || post.frame.profile.gold.value !== initialProfile.gold ||
      !knownCell(post.frame.profile.yuanbao) || post.frame.profile.yuanbao.value !== initialProfile.yb) return denied('ITEM_ART_COVERAGE_PROFILE_CURRENCY_UNPROVEN');
    return { links, reasonCode: null };
  }
  function dailyArtBridgeCoverage({ operationId, settlementRef, sendBinding, postReadBridge, applyMemo = null }) {
    const denied = reasonCode => ({ links: [], reasonCode });
    const bridge = bridgeReference(postReadBridge);
    if (!bridge || bridge.operationId !== operationId || !validatePostReadBridge) return denied('ITEM_DAILY_ART_BRIDGE_UNAVAILABLE');
    const validated = validatePostReadBridge({ ...bridge, phase: 'settling' });
    if (validated?.then) { validated.catch?.(() => {}); throw new TypeError('Post-read bridge validator must be synchronous'); }
    const receipt = validated?.receipt, next = receipt?.newLoginSource;
    const body = plainObject(receipt) ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'bridgeFingerprint')) : null;
    if (validated?.valid !== true || validated.bridgeFingerprint !== bridge.bridgeFingerprint || !body || fingerprint(body) !== bridge.bridgeFingerprint ||
        receipt.version !== 'after-physical-close-login/v1' || receipt.leaseRef !== bridge.leaseRef || receipt.operationId !== operationId ||
        !sameContext(receipt.originalContext, bridge.originalContext) || !sameContext(receipt.newContext, bridge.newContext) ||
        !sameBinding(receipt.after, bridge.after) || !sameBinding(sendBinding, bridge.after) || receipt.oldPhysicalCloseReceipt?.closed !== true)
      return denied('ITEM_DAILY_ART_BRIDGE_UNPROVEN');
    let applyMemoKey = null;
    if (applyMemo instanceof Map) {
      try { applyMemoKey = canonical({ operationId, settlementRef: settlementRef || '', sendBinding, bridge, receipt }); }
      catch { applyMemoKey = null; }
      if (applyMemoKey !== null && applyMemo.has(applyMemoKey)) return applyMemo.get(applyMemoKey);
    }
    const row = matchedAnswer(operationId, sendBinding);
    if (!row || row.feature_id !== 'art.daily' || row.scope !== 'flower-art-daily' || row.method !== 'flowerArt.makeFlowerArt' ||
        row.business_verdict !== 'confirmed' || row.write_slot !== 0 || row.transport_state !== 'answered') return denied('ITEM_DAILY_ART_CONFIRMED_SCOPE_REQUIRED');
    const original = parseStored(row.original_json, 'daily art coverage original');
    if (ledgerJsonFingerprint(original) !== row.original_fingerprint || !sameContext(original, bridge.originalContext) ||
        contextKeys.slice(0, 5).some(key => bridge.originalContext[key] !== bridge.newContext[key]) ||
        bridge.newContext.connectionEpoch <= bridge.originalContext.connectionEpoch || original.targets?.length !== 1 ||
        original.targets[0].targetKind !== 'flower-art-daily-unit' || !Array.isArray(original.resources) ||
        !Array.isArray(original.resourceBindings) || original.resources.length < 1 || original.resources.length > 3 ||
        original.resourceBindings.length !== original.resources.length) return denied('ITEM_DAILY_ART_ORIGINAL_INVALID');
    const target = original.targets[0], settlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=? AND settlement_key=?',
      operationId, target.memberKey, settlementRef || '');
    const result = settlement ? parseStored(settlement.result_json, 'daily art coverage target result') : null;
    const proof = result?.evidence?.payload;
    if (!settlement || settlement.verdict !== 'confirmed' || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint ||
        result.verificationVersion !== 'art-daily/target-postread/v2' || result.member?.memberKey !== target.memberKey || result.member.verdict !== 'confirmed' ||
        proof?.targetRef !== target.targetRef || proof.operationId !== operationId || proof.writeResponseRef !== sendBinding.responseRef ||
        proof.postReadRef !== next?.responseRef || proof.bridgeFingerprint !== bridge.bridgeFingerprint || proof.unitRef !== target.lifecycleRef ||
        !plainObject(proof.flows) || !plainObject(proof.deltas)) return denied('ITEM_DAILY_ART_SETTLEMENT_INVALID');
    const prepRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='finite-domain-preparation'
      AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 1`, operationId);
    const prepEvent = prepRow ? evidencePayload(prepRow) : null;
    const daily = prepEvent?.domain === 'art-daily' ? prepEvent.preparation : null;
    if (!daily || daily.unitRef !== target.lifecycleRef || daily.recipeFingerprint !== proof.recipeFingerprint ||
        daily.dataSnapshotId !== proof.dailyDataSnapshotId || !plainObject(daily.beforeBalances)) return denied('ITEM_DAILY_ART_PREPARATION_INVALID');
    const answerEvents = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    const bridgeEvents = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (answerEvents.length > 16 || bridgeEvents.length > 16) return denied('ITEM_DAILY_ART_EVIDENCE_LIMIT');
    const answer = answerEvents.find(event => { const value = evidencePayload(event); return value && value.method === original.method && value.rejected === false && sameBinding(value, sendBinding); });
    const bridgeEvidence = bridgeEvents.find(event => { const value = evidencePayload(event); return value?.version === 'art-daily/after-close-login/v1' &&
      value.operationId === operationId && value.leaseRef === bridge.leaseRef && value.bridgeFingerprint === bridge.bridgeFingerprint &&
      sameContext(value.newContext, bridge.newContext) && sameBinding(value.after, sendBinding) && value.newLoginResponseRef === next.responseRef; });
    const write = hashedItemFrame(bridge.originalContext, sendBinding, original.method), post = hashedItemFrame(bridge.newContext, next, 'index.login');
    const permit = boundSendPermit(operationId, original);
    if (!answer || !bridgeEvidence || !write || !post || permit?.consumed !== 1 || permit.owner_ref !== original.ownerRef ||
        permit.account_ref !== original.accountRef || permit.subject_ref !== original.subjectRef || permit.owner_epoch !== original.ownerEpoch || permit.run_epoch !== original.runEpoch ||
        permit.connection_epoch !== original.connectionEpoch || permit.method !== original.method || permit.params_fingerprint !== original.paramsFingerprint || permit.wire_key !== sendBinding.wireKey ||
        permit.request_sequence !== sendBinding.requestSequence) return denied('ITEM_DAILY_ART_WRITE_BINDING_INVALID');
    const expected = new Map();
    for (const resource of original.resources) {
      const match = /^item:([1-9][0-9]*)$/.exec(resource.resourceRef || ''), id = match ? Number(match[1]) : null;
      if (!positive(id) || resource.resourceKind !== 'item' || !positive(resource.quantity) || expected.has(id)) return denied('ITEM_DAILY_ART_RESOURCE_INVALID');
      expected.set(id, resource.quantity);
    }
    const links = [];
    for (const [itemId, quantity] of expected) {
      const binding = original.resourceBindings.find(one => one.resourceKey === original.resources.find(resource => resource.resourceRef === 'item:' + itemId)?.resourceKey);
      const before = daily.beforeBalances[String(itemId)], initialSource = before?.source;
      const initial = initialSource && hashedItemFrame(bridge.originalContext, initialSource, initialSource.method);
      const previous = initial && frameAbsolute(initial, itemId, true), absolute = frameAbsolute(post, itemId, true);
      const flow = proof.flows[String(itemId)], delta = proof.deltas[String(itemId)];
      const bi = write.payload.bi?.items?.[String(itemId)], bo = write.payload.bo?.items?.[String(itemId)];
      const zeroIfKnownMapOmits = (cell, collection, id) => !cell && collection?.presence === 'present' && collection.state === 'known' &&
        plainObject(collection.items) && !Object.hasOwn(collection.items, String(id));
      const biZero = !bi && zeroIfKnownMapOmits(null, write.payload.bi, itemId);
      const boZero = !bo && zeroIfKnownMapOmits(null, write.payload.bo, itemId);
      if (!binding || binding.memberKey !== target.memberKey || binding.quantity !== quantity || !previous || previous.value !== before.value ||
          !absolute || absolute.value !== before.value - quantity || !(knownCell(bi) && bi.value === 0 || biZero) ||
          !(knownCell(bo) && bo.value === quantity || boZero && quantity === 0) ||
          flow?.responseRef !== sendBinding.responseRef || flow?.observationRef !== write.row.observation_ref ||
          flow?.frameFingerprint !== fingerprint({ source: write.frame.source, bi: write.payload.bi, bo: write.payload.bo, bd: write.payload.bd }) ||
          delta?.before !== before.value || delta?.after !== absolute.value || delta?.delta !== -quantity) return denied('ITEM_DAILY_ART_RESOURCE_FLOW_INVALID');
      const resource = original.resources.find(one => one.resourceRef === 'item:' + itemId), stored = get('SELECT * FROM backend_operation_resources WHERE operation_id=? AND resource_key=?', operationId, resource.resourceKey);
      if (!stored || stored.quantity !== quantity || canonical(parseStored(stored.original_json, 'daily art resource original')) !== canonical(resource))
        return denied('ITEM_DAILY_ART_RESOURCE_ROWS_INVALID');
      links.push({ coverageKey: 'item-coverage:' + fingerprint([operationId, resource.resourceKey, post.row.observation_ref]), ownerRef: original.ownerRef,
        subjectRef: original.subjectRef, operationId, resourceKey: resource.resourceKey, quantity, basisRef: 'official-absolute:' + post.row.observation_ref + ':' + itemId,
        postReadRef: post.row.response_ref, connectionEpoch: post.row.connection_epoch, requestSequence: post.row.request_sequence,
        evidence: { version: 'official-item-coverage/art-daily-after-close/v1', itemId, artId: daily.artId, recipeFingerprint: daily.recipeFingerprint,
          writeResponseRef: write.row.response_ref, postReadRef: post.row.response_ref, sendBinding: clone(bridge.after), spent: quantity,
          absoluteValue: absolute.value, absoluteSourceRef: post.row.observation_ref,
          settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint,
          postReadBridge: bridge, answerEvidenceId: answer.evidence_id, answerEvidenceFingerprint: answer.payload_fingerprint,
          bridgeEvidenceId: bridgeEvidence.evidence_id, bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint } });
    }
    if (links.length !== expected.size) return denied('ITEM_DAILY_ART_COVERAGE_INCOMPLETE');
    const coverageResult = { links, reasonCode: null };
    if (applyMemoKey !== null) applyMemo.set(applyMemoKey, coverageResult);
    return coverageResult;
  }
  function customerArtBatchBridgeCoverage({ operationId, settlementRef, sendBinding, postReadBridge }) {
    const denied = reasonCode => ({ links: [], reasonCode }), bridge = bridgeReference(postReadBridge);
    if (!bridge || bridge.operationId !== operationId || !validatePostReadBridge) return denied('ITEM_CUSTOMER_ART_BATCH_BRIDGE_UNAVAILABLE');
    const validated = validatePostReadBridge({ ...bridge, phase: 'settling' }), receipt = validated?.receipt;
    const body = plainObject(receipt) ? Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'bridgeFingerprint')) : null;
    if (validated?.valid !== true || validated.bridgeFingerprint !== bridge.bridgeFingerprint || !body || fingerprint(body) !== bridge.bridgeFingerprint ||
        receipt.version !== 'after-physical-close-login/v1' || receipt.leaseRef !== bridge.leaseRef || receipt.operationId !== operationId ||
        !sameContext(receipt.originalContext, bridge.originalContext) || !sameContext(receipt.newContext, bridge.newContext) ||
        !sameBinding(receipt.after, bridge.after) || !sameBinding(sendBinding, bridge.after) || receipt.oldPhysicalCloseReceipt?.closed !== true)
      return denied('ITEM_CUSTOMER_ART_BATCH_BRIDGE_UNPROVEN');
    const row = matchedAnswer(operationId, sendBinding);
    if (!row || row.feature_id !== 'art.customer-batch' || row.scope !== 'flower-art-customer-batch' || row.method !== 'flowerArt.makeFlowerArt' ||
        row.business_verdict !== 'confirmed' || row.write_slot !== 0 || row.transport_state !== 'answered') return denied('ITEM_CUSTOMER_ART_BATCH_CONFIRMED_SCOPE_REQUIRED');
    const original = parseStored(row.original_json, 'customer art batch coverage original');
    if (ledgerJsonFingerprint(original) !== row.original_fingerprint || !sameContext(original, bridge.originalContext) ||
        contextKeys.slice(0, 5).some(key => bridge.originalContext[key] !== bridge.newContext[key]) ||
        bridge.newContext.connectionEpoch <= bridge.originalContext.connectionEpoch || original.targets?.length !== 1 ||
        original.targets[0].targetKind !== 'flower-art-customer-batch' || !Array.isArray(original.resources) ||
        !Array.isArray(original.resourceBindings) || original.resources.length < 1 || original.resources.length > 3 ||
        original.resourceBindings.length !== original.resources.length) return denied('ITEM_CUSTOMER_ART_BATCH_ORIGINAL_INVALID');
    const target = original.targets[0], settlement = get('SELECT * FROM backend_operation_target_settlements WHERE operation_id=? AND member_key=? AND settlement_key=?',
      operationId, target.memberKey, settlementRef || ''), result = settlement ? parseStored(settlement.result_json, 'customer art batch target result') : null,
      proof = result?.evidence?.payload;
    if (!settlement || settlement.verdict !== 'confirmed' || hashLedgerBytes(settlement.result_json) !== settlement.result_fingerprint ||
        result.verificationVersion !== 'art-customer-batch/target-postread/v2' || result.member?.memberKey !== target.memberKey || result.member.verdict !== 'confirmed' ||
        proof?.targetRef !== target.targetRef || proof.operationId !== operationId || proof.writeResponseRef !== sendBinding.responseRef ||
        proof.postReadRef !== receipt.newLoginSource?.responseRef || proof.bridgeFingerprint !== bridge.bridgeFingerprint ||
        proof.parentLifecycleRef !== target.lifecycleRef || !plainObject(proof.flows) || !plainObject(proof.deltas))
      return denied('ITEM_CUSTOMER_ART_BATCH_SETTLEMENT_INVALID');
    const prepRow = get(`SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='finite-domain-preparation'
      AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 1`, operationId), prepEvent = prepRow && evidencePayload(prepRow);
    if (!prepEvent || prepEvent.domain !== 'art-customer-batch' || !plainObject(prepEvent.preparation))
      return denied('ITEM_CUSTOMER_ART_BATCH_PREPARATION_INVALID');
    const prepared = prepEvent.preparation, answerEvents = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId),
      bridgeEvents = all("SELECT * FROM backend_operation_evidence WHERE operation_id=? AND kind='after-close-login-post-read' AND source='backend/write-gateway/v2' ORDER BY evidence_id LIMIT 17", operationId);
    if (prepared.parentLifecycleRef !== target.lifecycleRef || prepared.recipeFingerprint !== proof.recipeFingerprint ||
        prepared.dataSnapshotId !== proof.sourceSnapshotRef || prepared.officialUid !== receipt.officialUid)
      return denied('ITEM_CUSTOMER_ART_BATCH_PREPARATION_BINDING_INVALID');
    if (answerEvents.length > 16 || bridgeEvents.length > 16) return denied('ITEM_CUSTOMER_ART_BATCH_EVIDENCE_LIMIT');
    const answer = answerEvents.find(event => { const value = evidencePayload(event); return value && value.method === original.method && value.rejected === false && sameBinding(value, sendBinding); });
    const bridgeEvidence = bridgeEvents.find(event => { const value = evidencePayload(event); return value?.version === 'art-customer-batch/after-close-login/v2' &&
      value.operationId === operationId && value.leaseRef === bridge.leaseRef && value.bridgeFingerprint === bridge.bridgeFingerprint &&
      sameContext(value.newContext, bridge.newContext) && sameBinding(value.after, sendBinding) && value.newLoginResponseRef === receipt.newLoginSource?.responseRef; });
    const write = hashedItemFrame(bridge.originalContext, sendBinding, original.method), post = hashedItemFrame(bridge.newContext, receipt.newLoginSource, 'index.login'),
      permit = boundSendPermit(operationId, original);
    if (!answer || !bridgeEvidence || !write || !post || permit?.consumed !== 1 || permit.owner_ref !== original.ownerRef || permit.account_ref !== original.accountRef ||
        permit.subject_ref !== original.subjectRef || permit.owner_epoch !== original.ownerEpoch || permit.run_epoch !== original.runEpoch ||
        permit.connection_epoch !== original.connectionEpoch || permit.method !== original.method || permit.params_fingerprint !== original.paramsFingerprint ||
        permit.wire_key !== sendBinding.wireKey || permit.request_sequence !== sendBinding.requestSequence)
      return denied('ITEM_CUSTOMER_ART_BATCH_WRITE_BINDING_INVALID');
    const links = [];
    for (const resource of original.resources) {
      const match = /^item:([1-9][0-9]*)$/.exec(resource.resourceRef || ''), itemId = match ? Number(match[1]) : null,
        binding = original.resourceBindings.find(one => one.resourceKey === resource.resourceKey), before = prepared.inputBalances?.find(one => one.itemId === itemId),
        previousSource = before?.source, initial = previousSource && hashedItemFrame(bridge.originalContext, previousSource, previousSource.method),
        previous = initial && frameAbsolute(initial, itemId, true), absolute = frameAbsolute(post, itemId, true), flow = proof.flows?.[itemId], delta = proof.deltas?.[itemId],
        bo = write.payload.bo?.items?.[String(itemId)], bi = write.payload.bi?.items?.[String(itemId)];
      const zeroIfKnownMapOmits = (cell, collection) => !cell && collection?.presence === 'present' && collection.state === 'known' &&
        plainObject(collection.items) && !Object.hasOwn(collection.items, String(itemId));
      if (!positive(itemId) || resource.resourceKind !== 'item' || !positive(resource.quantity) || !binding || binding.memberKey !== target.memberKey ||
          binding.quantity !== resource.quantity || !before || !previous || previous.value !== before.value || !absolute ||
          absolute.value !== before.value - resource.quantity || !(knownCell(bo) && bo.value === resource.quantity) ||
          !(knownCell(bi) && bi.value === 0 || zeroIfKnownMapOmits(bi, write.payload.bi)) ||
          flow?.responseRef !== sendBinding.responseRef || flow?.observationRef !== write.row.observation_ref ||
          flow?.frameFingerprint !== fingerprint({ source: write.frame.source, bi: write.payload.bi, bo: write.payload.bo, bd: write.payload.bd }) ||
          delta?.before !== before.value || delta?.after !== absolute.value || delta?.delta !== -resource.quantity)
        return denied('ITEM_CUSTOMER_ART_BATCH_RESOURCE_FLOW_INVALID');
      const stored = get('SELECT * FROM backend_operation_resources WHERE operation_id=? AND resource_key=?', operationId, resource.resourceKey);
      if (!stored || stored.quantity !== resource.quantity || canonical(parseStored(stored.original_json, 'customer art batch resource')) !== canonical(resource))
        return denied('ITEM_CUSTOMER_ART_BATCH_RESOURCE_ROW_INVALID');
      links.push({ coverageKey: 'item-coverage:' + fingerprint([operationId, resource.resourceKey, post.row.observation_ref]), ownerRef: original.ownerRef,
        subjectRef: original.subjectRef, operationId, resourceKey: resource.resourceKey, quantity: resource.quantity,
        basisRef: 'official-absolute:' + post.row.observation_ref + ':' + itemId, postReadRef: post.row.response_ref,
        connectionEpoch: post.row.connection_epoch, requestSequence: post.row.request_sequence,
        evidence: { version: 'official-item-coverage/art-customer-batch-after-close/v2', itemId, artId: prepared.artId,
          recipeFingerprint: prepared.recipeFingerprint, parentLifecycleRef: target.lifecycleRef, writeResponseRef: write.row.response_ref,
          postReadRef: post.row.response_ref, sendBinding: clone(bridge.after), spent: resource.quantity, absoluteValue: absolute.value,
          absoluteSourceRef: post.row.observation_ref, settlementRef: settlement.settlement_key, settlementFingerprint: settlement.result_fingerprint,
          postReadBridge: bridge, answerEvidenceId: answer.evidence_id, answerEvidenceFingerprint: answer.payload_fingerprint,
          bridgeEvidenceId: bridgeEvidence.evidence_id, bridgeEvidenceFingerprint: bridgeEvidence.payload_fingerprint } });
    }
    return links.length === original.resources.length ? { links, reasonCode: null } : denied('ITEM_CUSTOMER_ART_BATCH_COVERAGE_INCOMPLETE');
  }
  function planCoverage({ context, operation, targetSettlement, postRead, sendBinding = null, postReadBridge = null } = {}) {
    const denied = reasonCode => freeze({ applicable: false, links: [], issues: [{ reasonCode }] });
    const original = operation?.original;
    if (!original || original.ownerRef !== context.ownerRef || original.subjectRef !== context.subjectRef) return denied('ITEM_COVERAGE_OPERATION_SCOPE_MISMATCH');
    if (!sendBinding || sendBinding.connectionEpoch !== original.connectionEpoch || !Number.isSafeInteger(sendBinding.requestSequence)
      || !sendBinding.wireKey || !sendBinding.responseRef) return denied('ITEM_COVERAGE_SEND_BINDING_MISSING');
    const persisted = matchedAnswer(original.operationId, sendBinding);
    if (!persisted || persisted.owner_ref !== context.ownerRef || persisted.subject_ref !== context.subjectRef
      || canonical(parseStored(persisted.original_json, 'resource operation original')) !== canonical(original)) return denied('ITEM_COVERAGE_OPERATION_BINDING_UNPROVEN');
    const postRef = postRead?.responseRef || postRead?.source?.responseRef;
    if (postReadBridge !== null) {
      if (Object.values(ORDER_FLOWER_CONTRACTS).some(one => one.featureId === original.featureId && one.scope === original.scope && one.method === original.method)) {
        const derived = orderFlowerBridgeCoverage({ operationId: original.operationId, settlementRef: targetSettlement?.settlement_key, sendBinding, postReadBridge });
        return derived.links.length > 0 && derived.links.every(link => link.postReadRef === postRef)
          ? freeze({ applicable: true, links: derived.links, issues: [] }) : denied(derived.reasonCode || 'ITEM_ORDER_FLOWER_POST_READ_MISMATCH');
      }
      if (original.featureId === 'art.make' && original.scope === 'flower-art-make' && original.method === 'flowerArt.makeFlowerArt') {
        const derived = artBridgeCoverage({ operationId: original.operationId, settlementRef: targetSettlement?.settlement_key, sendBinding, postReadBridge });
        return derived.links.length > 0 && derived.links.every(link => link.postReadRef === postRef)
          ? freeze({ applicable: true, links: derived.links, issues: [] }) : denied(derived.reasonCode || 'ITEM_ART_COVERAGE_POST_READ_MISMATCH');
      }
      if (original.featureId === 'art.daily' && original.scope === 'flower-art-daily' && original.method === 'flowerArt.makeFlowerArt') {
        const derived = dailyArtBridgeCoverage({ operationId: original.operationId, settlementRef: targetSettlement?.settlement_key, sendBinding, postReadBridge });
        return derived.links.length > 0 && derived.links.every(link => link.postReadRef === postRef)
          ? freeze({ applicable: true, links: derived.links, issues: [] }) : denied(derived.reasonCode || 'ITEM_DAILY_ART_COVERAGE_POST_READ_MISMATCH');
      }
      if (original.featureId === 'art.customer-batch' && original.scope === 'flower-art-customer-batch' && original.method === 'flowerArt.makeFlowerArt') {
        const derived = customerArtBatchBridgeCoverage({ operationId: original.operationId, settlementRef: targetSettlement?.settlement_key, sendBinding, postReadBridge });
        return derived.links.length > 0 && derived.links.every(link => link.postReadRef === postRef)
          ? freeze({ applicable: true, links: derived.links, issues: [] }) : denied(derived.reasonCode || 'ITEM_CUSTOMER_ART_BATCH_COVERAGE_POST_READ_MISMATCH');
      }
      const derived = customerBridgeCoverage({ operationId: original.operationId, settlementRef: targetSettlement?.settlement_key,
        sendBinding, postReadBridge });
      return derived.link && derived.link.postReadRef === postRef ? freeze({ applicable: true, links: [derived.link], issues: [] })
        : denied(derived.reasonCode || 'ITEM_COVERAGE_BRIDGE_POST_READ_MISMATCH');
    }
    if (original.featureId === 'land.acceleration') {
      const preparedOriginal = landAccelerationOriginal(original.operationId, original);
      if (!preparedOriginal) return denied('ITEM_ACCELERATION_PREPARATION_EVIDENCE_INVALID');
      const derived = landAccelerationCoverage({ context, original: preparedOriginal, operationId: original.operationId,
        settlementRef: targetSettlement?.settlement_key ?? targetSettlement?.settlementKey ?? null, sendBinding, postReadRef: postRef });
      return derived.links.length === 1 && derived.links[0].postReadRef === postRef
        ? freeze({ applicable: true, links: derived.links, issues: [] }) : denied(derived.reasonCode || 'ITEM_ACCELERATION_COVERAGE_UNPROVEN');
    }
    if (!Object.hasOwn(landMethods, original.featureId) || original.scope !== original.featureId || original.method !== landMethods[original.featureId]) {
      return denied('ITEM_COVERAGE_POST_READ_CONTRACT_REQUIRED');
    }
    const post = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=? AND connection_epoch=?', postRef || '', context.ownerRef, context.subjectRef, sendBinding.connectionEpoch);
    const write = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND wire_key=? AND owner_ref=? AND subject_ref=? AND connection_epoch=? AND request_sequence=?',
      sendBinding.responseRef, sendBinding.wireKey, context.ownerRef, context.subjectRef, sendBinding.connectionEpoch, sendBinding.requestSequence);
    if (!post || !write || post.request_sequence <= write.request_sequence || parseStored(post.source_json, 'item post-read source').method !== 'usrLand.refresh') return denied('ITEM_COVERAGE_FRESH_POST_READ_MISSING');
    if (!targetSettlement || targetSettlement.operation_id !== original.operationId
      || !get('SELECT settlement_key FROM backend_operation_target_settlements WHERE operation_id=? AND settlement_key=?', original.operationId, targetSettlement.settlement_key || '')) return denied('ITEM_COVERAGE_TARGET_SETTLEMENT_MISSING');
    const writePayload = parseStored(write.payload_json, 'item write sources'), postPayload = parseStored(post.payload_json, 'item post sources');
    const links = [];
    for (const resource of operation.resources || []) {
      const raw = resource.original || resource, itemId = Number(String(raw.resourceRef || resource.resource_ref || '').replace(/^item:/, ''));
      const resourceKey = raw.resourceKey || resource.resource_key, resourceKind = raw.resourceKind || resource.resource_kind;
      if (resourceKind !== 'item' || !Number.isSafeInteger(itemId) || itemId <= 0 || !num(resource.quantity)) continue;
      const spent = writePayload.bo?.items?.[itemId], absoluteWrite = writePayload.bd?.items?.[itemId];
      const absolutePost = knownCell(postPayload.bd?.items?.[itemId]) ? postPayload.bd.items[itemId] : postPayload.bag?.items?.[itemId];
      if (!knownCell(spent) || spent.value !== resource.quantity || !knownCell(absoluteWrite) && !knownCell(absolutePost)) continue;
      const useWrite = knownCell(absoluteWrite), actualRef = useWrite ? write : post;
      links.push({ coverageKey: 'item-coverage:' + fingerprint([original.operationId, resourceKey, actualRef.observation_ref]),
        ownerRef: context.ownerRef, subjectRef: context.subjectRef, operationId: original.operationId, resourceKey, quantity: resource.quantity,
        basisRef: 'official-absolute:' + actualRef.observation_ref + ':' + itemId, postReadRef: post.response_ref,
        connectionEpoch: actualRef.connection_epoch, requestSequence: actualRef.request_sequence,
        evidence: { version: 'official-item-coverage/v1', itemId, writeResponseRef: write.response_ref, postReadRef: post.response_ref,
          sendBinding: clone(sendBinding),
          spent: spent.value, absoluteValue: useWrite ? absoluteWrite.value : absolutePost.value,
          absoluteSourceRef: actualRef.observation_ref, settlementRef: targetSettlement.settlement_key || targetSettlement.settlementKey || null } });
    }
    return freeze({ applicable: links.length > 0, links, issues: links.length ? [] : [{ reasonCode: 'ITEM_EXACT_CONSUMPTION_COVERAGE_NOT_PROVEN' }] });
  }
  function applyCoverage(plan) {
    return transaction(() => {
      const refs = [], dailyArtApplyMemo = new Map();
      for (const link of plan?.links || []) {
        const original = get(`SELECT r.quantity,r.resource_ref,r.resource_kind,o.owner_ref,o.subject_ref,o.feature_id,o.scope,o.method FROM backend_operation_resources r
          JOIN backend_operations o ON o.operation_id=r.operation_id WHERE r.operation_id=? AND r.resource_key=?`, link.operationId, link.resourceKey);
        if (!original || original.owner_ref !== link.ownerRef || original.subject_ref !== link.subjectRef || !num(link.quantity) || link.quantity > original.quantity
          || original.resource_kind !== 'item' || original.resource_ref !== 'item:' + link.evidence?.itemId
          || !get('SELECT settlement_key FROM backend_operation_target_settlements WHERE operation_id=? AND settlement_key=?', link.operationId, link.evidence?.settlementRef || '')
          || !matchedAnswer(link.operationId, link.evidence?.sendBinding)) throw problem('ITEM_COVERAGE_SCOPE_INVALID', '消费覆盖证据与原资源不匹配', 500);
        if (link.evidence?.version === 'official-item-coverage/order-flower-after-close/v1') {
          const derived = orderFlowerBridgeCoverage({ operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadBridge: link.evidence.postReadBridge });
          const exact = derived.links.find(item => item.resourceKey === link.resourceKey);
          if (!exact || canonical(exact) !== canonical(link)) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '普通鲜花订单消费覆盖原证据无法重导', 500);
        } else if (link.evidence?.version === 'official-item-coverage/art-after-close/v1') {
          const derived = artBridgeCoverage({ operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadBridge: link.evidence.postReadBridge });
          const exact = derived.links.find(item => item.resourceKey === link.resourceKey);
          if (!exact || canonical(exact) !== canonical(link)) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '花艺消费覆盖桥接原证据无法重导', 500);
        } else if (link.evidence?.version === 'official-item-coverage/art-daily-after-close/v1') {
          const derived = dailyArtBridgeCoverage({ operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadBridge: link.evidence.postReadBridge, applyMemo: dailyArtApplyMemo });
          const exact = derived.links.find(item => item.resourceKey === link.resourceKey);
          if (!exact || canonical(exact) !== canonical(link)) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '日常花艺消费覆盖原证据无法重导', 500);
        } else if (link.evidence?.version === 'official-item-coverage/art-customer-batch-after-close/v2') {
          const derived = customerArtBatchBridgeCoverage({ operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadBridge: link.evidence.postReadBridge });
          const exact = derived.links.find(item => item.resourceKey === link.resourceKey);
          if (!exact || canonical(exact) !== canonical(link)) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '顾客花艺批量消费覆盖原证据无法重导', 500);
        } else if (link.evidence?.version === 'official-item-coverage/customer-after-close/v1') {
          const derived = customerBridgeCoverage({ operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadBridge: link.evidence.postReadBridge });
          if (!derived.link || canonical(derived.link) !== canonical(link)) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '消费覆盖桥接原证据无法重导', 500);
        } else if (link.evidence?.version === 'official-item-coverage/land-acceleration/v1') {
          const row = get('SELECT original_json FROM backend_operations WHERE operation_id=? AND owner_ref=? AND subject_ref=?',
            link.operationId, link.ownerRef, link.subjectRef);
          const storedOriginal = row ? parseStored(row.original_json, 'acceleration operation original') : null;
          const sourceOriginal = landAccelerationOriginal(link.operationId, storedOriginal);
          const derived = landAccelerationCoverage({ context: { ownerRef: link.ownerRef, subjectRef: link.subjectRef }, original: sourceOriginal,
            operationId: link.operationId, settlementRef: link.evidence.settlementRef,
            sendBinding: link.evidence.sendBinding, postReadRef: link.postReadRef });
          if (!derived.links.some(item => canonical(item) === canonical(link))) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '加速卡扣量覆盖原证据无法重导', 500);
        } else {
          if (link.evidence?.version !== 'official-item-coverage/v1' || !Object.hasOwn(landMethods, original.feature_id)
            || original.scope !== original.feature_id || original.method !== landMethods[original.feature_id]) {
            throw problem('ITEM_COVERAGE_SCOPE_INVALID', '消费覆盖缺少对应领域的有限后读合同', 500);
          }
          // Re-derive proof from immutable admitted sources; caller-provided
          // quantities/absolute values alone are never an authority.
          const source = get('SELECT * FROM backend_official_item_frames WHERE observation_ref=? AND owner_ref=? AND subject_ref=?', link.evidence?.absoluteSourceRef, link.ownerRef, link.subjectRef);
          const write = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=?', link.evidence?.writeResponseRef, link.ownerRef, link.subjectRef);
          const post = get('SELECT * FROM backend_official_item_frames WHERE response_ref=? AND owner_ref=? AND subject_ref=?', link.postReadRef, link.ownerRef, link.subjectRef);
          const payload = write ? parseStored(write.payload_json, 'coverage write') : null;
          const abs = source ? parseStored(source.payload_json, 'coverage absolute') : null, itemId = link.evidence?.itemId;
          const absolute = knownCell(abs?.bd?.items?.[itemId]) ? abs.bd.items[itemId] : abs?.bag?.items?.[itemId];
          const binding = link.evidence.sendBinding;
          if (!source || !write || !post || write.connection_epoch !== post.connection_epoch || post.request_sequence <= write.request_sequence
            || !knownCell(payload?.bo?.items?.[itemId]) || payload.bo.items[itemId].value !== link.quantity || !knownCell(absolute)
            || write.connection_epoch !== binding.connectionEpoch || write.request_sequence !== binding.requestSequence || write.wire_key !== binding.wireKey
            || write.response_ref !== binding.responseRef || ![write.observation_ref, post.observation_ref].includes(source.observation_ref)
            || parseStored(post.source_json, 'coverage post read').method !== 'usrLand.refresh'
            || source.connection_epoch !== link.connectionEpoch || source.request_sequence !== link.requestSequence) throw problem('ITEM_COVERAGE_EVIDENCE_INVALID', '消费覆盖来源无法核验', 500);
        }
        const digest = fingerprint(link), prior = get('SELECT result_fingerprint FROM backend_official_item_coverage WHERE coverage_key=?', link.coverageKey);
        if (prior) { if (prior.result_fingerprint !== digest) throw problem('ITEM_COVERAGE_CONFLICT', '消费覆盖原证据不可覆盖', 500); refs.push(link.coverageKey); continue; }
        const previous = get('SELECT COALESCE(SUM(quantity),0) AS quantity FROM backend_official_item_coverage WHERE operation_id=? AND resource_key=?', link.operationId, link.resourceKey).quantity;
        if (previous + link.quantity > original.quantity) throw problem('ITEM_COVERAGE_DUPLICATE', '同一消费不能重复覆盖', 500);
        run('INSERT INTO backend_official_item_coverage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', link.coverageKey, link.ownerRef, link.subjectRef, link.operationId,
          link.resourceKey, link.quantity, link.basisRef, link.postReadRef, link.connectionEpoch, link.requestSequence, digest, canonical(link.evidence), nowIso());
        // This hook also runs for an old epoch. It records attribution only;
        // the gateway's onCurrentVerified owns all current announcements.
        refs.push(link.coverageKey);
      }
      return freeze({ applied: refs.length, coverageRefs: refs });
    });
  }
  function inspectOrderFlowerCoverage({ ownerRef, subjectRef, operationId } = {}) {
    const row = get('SELECT * FROM backend_operations WHERE operation_id=? AND owner_ref=? AND subject_ref=?', operationId, ownerRef, subjectRef);
    const definition = row && Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === row.feature_id && one.scope === row.scope && one.method === row.method);
    if (!definition) return freeze({ available: false, applicable: false, reasonCode: 'ITEM_ORDER_FLOWER_OPERATION_NOT_FOUND', links: [] });
    const lease = get('SELECT * FROM backend_session_verification_leases WHERE operation_id=? AND owner_ref=? AND subject_ref=?', operationId, ownerRef, subjectRef);
    if (!lease?.bridge_json || !lease.bridge_fingerprint) return freeze({ available: true, applicable: false, reasonCode: 'ITEM_ORDER_FLOWER_BRIDGE_UNAVAILABLE', links: [] });
    const receipt = parseStored(lease.bridge_json, 'order flower coverage audit bridge'), bridge = {
      leaseRef: lease.lease_ref, operationId, originalContext: receipt.originalContext,
      newContext: receipt.newContext, after: receipt.after, bridgeFingerprint: lease.bridge_fingerprint };
    const derived = orderFlowerBridgeCoverage({ operationId, sendBinding: receipt.after, postReadBridge: bridge });
    return freeze({ available: true, applicable: derived.links.length > 0, reasonCode: derived.reasonCode,
      operationId, originalOutcomeUnchanged: true, originalFootprintsUnchanged: true, links: derived.links });
  }
  function reconcileOrderFlowerCoverage({ ownerRef, subjectRef, limit = 10, beginScanIfIdle = false } = {}) {
    if (!reference(ownerRef) || !reference(subjectRef) || !positive(limit) || limit > 32 || typeof beginScanIfIdle !== 'boolean') throw problem('ITEM_COVERAGE_RECONCILIATION_SCOPE_INVALID', '费用索引重导范围无效', 400);
    // This repairs a derived materialization from complete immutable evidence.
    // It performs no game RPC and changes neither an outcome nor a footprint.
    const current = get(`SELECT last_prepared_at,last_operation_id,scan_active FROM backend_official_item_coverage_reconcile_cursors
      WHERE owner_ref=? AND subject_ref=?`, ownerRef, subjectRef);
    const cursor = current?.scan_active === 1 ? current : null;
    if ((beginScanIfIdle && current?.scan_active !== 1) || !current) run(`INSERT INTO backend_official_item_coverage_reconcile_cursors
      (owner_ref,subject_ref,last_prepared_at,last_operation_id,scan_active,updated_at) VALUES(?,?,NULL,NULL,1,?)
      ON CONFLICT(owner_ref,subject_ref) DO UPDATE SET last_prepared_at=NULL,last_operation_id=NULL,scan_active=1,updated_at=excluded.updated_at`,
    ownerRef, subjectRef, nowIso());
    const rows = all(`SELECT o.operation_id,o.prepared_at,o.feature_id,o.business_verdict FROM backend_operations o WHERE o.owner_ref=? AND o.subject_ref=?
      AND o.transport_state='answered' AND o.business_verdict IN ('confirmed','unknown') AND o.write_slot=0
      AND ((o.feature_id='order.resident' AND o.scope='order-resident' AND o.method='orderFlower.finishOrder')
        OR (o.feature_id='order.satin' AND o.scope='order-satin' AND o.method='orderFlower.finishSatinOrder')
        OR (o.feature_id='order.decorate' AND o.scope='order-decorate' AND o.method='orderFlower.finishDecorateOrder')
        OR (o.feature_id='art.daily' AND o.scope='flower-art-daily' AND o.method='flowerArt.makeFlowerArt')
        OR (o.feature_id='art.customer-batch' AND o.scope='flower-art-customer-batch' AND o.method='flowerArt.makeFlowerArt')
        OR (o.feature_id='order.customer' AND o.scope='order-customer' AND o.method='orderCustomer.finishOrder' AND o.business_verdict='confirmed'))
      AND EXISTS(SELECT 1 FROM backend_operation_resources r WHERE r.operation_id=o.operation_id AND r.resource_kind='item'
        AND NOT EXISTS(SELECT 1 FROM backend_official_item_coverage c WHERE c.operation_id=r.operation_id AND c.resource_key=r.resource_key))
      AND (? IS NULL OR o.prepared_at>? OR (o.prepared_at=? AND o.operation_id>?))
      ORDER BY o.prepared_at,o.operation_id LIMIT ?`, ownerRef, subjectRef, cursor?.last_prepared_at || null,
    cursor?.last_prepared_at || null, cursor?.last_prepared_at || null, cursor?.last_operation_id || '', limit);
    let appended = 0;
    const blocked = [];
    for (const row of rows) {
      try {
        let derived;
        if (row.feature_id === 'order.customer') {
          if (row.business_verdict !== 'confirmed') { blocked.push({ operationId: row.operation_id, reasonCode: 'ITEM_CUSTOMER_FINISH_OUTCOME_NOT_CONFIRMED' }); continue; }
          const opRow = get('SELECT original_json FROM backend_operations WHERE operation_id=? AND owner_ref=? AND subject_ref=?', row.operation_id, ownerRef, subjectRef);
          const original = opRow ? parseStored(opRow.original_json, 'customer finish coverage original') : null;
          const target = original?.targets?.[0], settlement = target && get(`SELECT * FROM backend_operation_target_settlements
            WHERE operation_id=? AND member_key=? ORDER BY settlement_key LIMIT 1`, row.operation_id, target.memberKey);
          const lease = get(`SELECT lease_ref,bridge_json,bridge_fingerprint FROM backend_session_verification_leases
            WHERE operation_id=? AND owner_ref=? AND subject_ref=? ORDER BY lease_ref LIMIT 1`, row.operation_id, ownerRef, subjectRef);
          const receipt = lease?.bridge_json ? parseStored(lease.bridge_json, 'customer finish coverage bridge') : null;
          if (!original || !settlement || !lease || !receipt) { blocked.push({ operationId: row.operation_id, reasonCode: 'ITEM_CUSTOMER_FINISH_COVERAGE_SOURCES_MISSING' }); continue; }
          const bridge = { leaseRef: lease.lease_ref, operationId: row.operation_id, originalContext: receipt.originalContext,
            newContext: receipt.newContext, after: receipt.after, bridgeFingerprint: lease.bridge_fingerprint };
          const derivedPlan = planCoverage({ context: { ownerRef, subjectRef }, operation: { original, resources: original.resources || [] },
            targetSettlement: settlement, postRead: { responseRef: receipt.newLoginSource?.responseRef }, sendBinding: receipt.after, postReadBridge: bridge });
          derived = { applicable: derivedPlan.applicable === true, links: derivedPlan.links, reasonCode: derivedPlan.issues?.[0]?.reasonCode };
        } else if (row.feature_id === 'art.daily' || row.feature_id === 'art.customer-batch') {
          if (row.business_verdict !== 'confirmed') { blocked.push({ operationId: row.operation_id, reasonCode: 'ITEM_FINITE_ART_OUTCOME_NOT_CONFIRMED' }); continue; }
          const opRow = get('SELECT original_json FROM backend_operations WHERE operation_id=? AND owner_ref=? AND subject_ref=?', row.operation_id, ownerRef, subjectRef);
          const original = opRow ? parseStored(opRow.original_json, 'finite art coverage original') : null;
          const target = original?.targets?.[0], settlement = target && get(`SELECT * FROM backend_operation_target_settlements
            WHERE operation_id=? AND member_key=? ORDER BY settlement_key LIMIT 1`, row.operation_id, target.memberKey);
          const lease = get(`SELECT lease_ref,bridge_json,bridge_fingerprint FROM backend_session_verification_leases
            WHERE operation_id=? AND owner_ref=? AND subject_ref=? ORDER BY lease_ref LIMIT 1`, row.operation_id, ownerRef, subjectRef);
          const receipt = lease?.bridge_json ? parseStored(lease.bridge_json, 'finite art coverage bridge') : null;
          if (!original || !settlement || !lease || !receipt) { blocked.push({ operationId: row.operation_id, reasonCode: 'ITEM_FINITE_ART_COVERAGE_SOURCES_MISSING' }); continue; }
          const bridge = { leaseRef: lease.lease_ref, operationId: row.operation_id, originalContext: receipt.originalContext,
            newContext: receipt.newContext, after: receipt.after, bridgeFingerprint: lease.bridge_fingerprint };
          const derivedPlan = planCoverage({ context: { ownerRef, subjectRef }, operation: { original, resources: original.resources || [] },
            targetSettlement: settlement, postRead: { responseRef: receipt.newLoginSource?.responseRef }, sendBinding: receipt.after, postReadBridge: bridge });
          derived = { applicable: derivedPlan.applicable === true, links: derivedPlan.links, reasonCode: derivedPlan.issues?.[0]?.reasonCode };
        } else derived = inspectOrderFlowerCoverage({ ownerRef, subjectRef, operationId: row.operation_id });
        if (!derived.applicable) { blocked.push({ operationId: row.operation_id, reasonCode: derived.reasonCode }); continue; }
        const missing = derived.links.filter(link => !get('SELECT coverage_key FROM backend_official_item_coverage WHERE coverage_key=?', link.coverageKey));
        if (missing.length) { applyCoverage({ links: missing }); appended += missing.length; }
      } catch (error) {
        blocked.push({ operationId: row.operation_id, reasonCode: /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code || '')
          ? error.code : 'ITEM_COVERAGE_MATERIALIZATION_UNAVAILABLE' });
      }
    }
    const last = rows.at(-1) || null;
    if (last) run(`UPDATE backend_official_item_coverage_reconcile_cursors SET last_prepared_at=?,last_operation_id=?,scan_active=1,updated_at=?
      WHERE owner_ref=? AND subject_ref=?`, last.prepared_at, last.operation_id, nowIso(), ownerRef, subjectRef);
    const hasMore = !!last && !!get(`SELECT 1 AS found FROM backend_operations o WHERE o.owner_ref=? AND o.subject_ref=?
      AND o.transport_state='answered' AND o.business_verdict IN ('confirmed','unknown') AND o.write_slot=0
      AND ((o.feature_id='order.resident' AND o.scope='order-resident' AND o.method='orderFlower.finishOrder')
        OR (o.feature_id='order.satin' AND o.scope='order-satin' AND o.method='orderFlower.finishSatinOrder')
        OR (o.feature_id='order.decorate' AND o.scope='order-decorate' AND o.method='orderFlower.finishDecorateOrder')
        OR (o.feature_id='art.daily' AND o.scope='flower-art-daily' AND o.method='flowerArt.makeFlowerArt')
        OR (o.feature_id='art.customer-batch' AND o.scope='flower-art-customer-batch' AND o.method='flowerArt.makeFlowerArt')
        OR (o.feature_id='order.customer' AND o.scope='order-customer' AND o.method='orderCustomer.finishOrder' AND o.business_verdict='confirmed'))
      AND EXISTS(SELECT 1 FROM backend_operation_resources r WHERE r.operation_id=o.operation_id AND r.resource_kind='item'
        AND NOT EXISTS(SELECT 1 FROM backend_official_item_coverage c WHERE c.operation_id=r.operation_id AND c.resource_key=r.resource_key))
      AND (o.prepared_at>? OR (o.prepared_at=? AND o.operation_id>?)) LIMIT 1`, ownerRef, subjectRef,
    last.prepared_at, last.prepared_at, last.operation_id);
    if (!hasMore) run(`UPDATE backend_official_item_coverage_reconcile_cursors SET last_prepared_at=NULL,last_operation_id=NULL,
      scan_active=0,updated_at=? WHERE owner_ref=? AND subject_ref=?`, nowIso(), ownerRef, subjectRef);
    return freeze({ scanned: rows.length, appended, blocked, hasMore: !!hasMore, originalOutcomesUnchanged: true,
      originalFootprintsUnchanged: true, noGameRequestSent: true });
  }
  return Object.freeze({ ingest, balance, balanceBatch, budget, budgetBatch, planningReader, reservationSpec, currencyBalance, currencyBudget, currencyReservationSpec, landAccelerationDebitEvidence, matchedItemFlow, matchedProfileFlow, observedArtCompletion, planCoverage, applyCoverage, inspectOrderFlowerCoverage, reconcileOrderFlowerCoverage,
    view: ({ context, itemIds = [] }) => freeze(Object.fromEntries(itemIds.map(itemId => [itemId, balance({ context, itemId })]))) });
}
