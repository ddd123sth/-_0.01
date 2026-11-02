import { officialAnswerProtocolChecks } from '../../official-server-version-contract.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { orderFlowerContext, sameOrderFlowerContext, ORDER_FLOWER_AXES } from './wire-facts.mjs';
import { orderFlowerSafeSource } from './rpc-contract.mjs';
import { orderFlowerExperienceTransition } from './level-catalog.mjs';
import { orderFlowerBranchShape } from './branch-shape.mjs';
import { currentOfficialDataEvidence, currentOfficialSourceEvidence } from '../../official-data-evidence.mjs';

export const auxPositive = value => Number.isSafeInteger(value) && value > 0;
export const auxNonnegative = value => Number.isSafeInteger(value) && value >= 0;
export const auxRef = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
export const auxDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const auxExact = (value, keys) => plainObject(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
export const ORDER_FLOWER_AUX_POST_READ = freeze({ contractId: 'order-flower-auxiliary/fresh-login-after-close/v1', kind: 'after-close-login',
  method: 'index.login', args: {}, evidenceRef: 'g4/official-auxiliary/actual-close-fresh-login/v1' });
let loaded;
let loadedCurrent;
export function orderFlowerAuxiliaryCatalog(versionEvidence = null) {
  if (versionEvidence?.gameVersion === '490.0.5') {
    if (!loadedCurrent) {
      const bytes = fs.readFileSync(new URL('./static/auxiliary-490.0.5.json', import.meta.url));
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== '11dc65e4838726cae2fc5714f86506a4df695c9306329b20a9c986ae4b913a40')
        throw problem('ORDER_AUX_STATIC_INTEGRITY', '当前订单辅助合同静态来源不一致', 500);
      loadedCurrent = freeze(JSON.parse(bytes.toString('utf8')));
    }
    return loadedCurrent;
  }
  if (!loaded) {
    const bytes = fs.readFileSync(new URL('./static/auxiliary-480.0.27.json', import.meta.url));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== 'a174fe2befa823f0da00326ad2d51ca892703f179ecacd1757fe7b2844e5db46') throw problem('ORDER_AUX_STATIC_INTEGRITY', '订单辅助合同静态来源不一致', 500);
    loaded = freeze(JSON.parse(bytes.toString('utf8')));
  }
  return loaded;
}
function exactAuxiliarySourceEvidence(versionEvidence) {
  const catalog = orderFlowerAuxiliaryCatalog(versionEvidence), source = currentOfficialSourceEvidence(versionEvidence);
  if (!source || versionEvidence.protocolVersion !== catalog.protocolVersion ||
      versionEvidence.resourceSha256 !== catalog.sourceDataSha256 ||
      versionEvidence.tableHashes?.c_share !== catalog.tableSha256?.c_share) return false;
  return ['order.resident', 'order.satin', 'order.decorate'].some(action => {
    const proof = versionEvidence.sourceProofs?.[action];
    return currentOfficialDataEvidence(versionEvidence, action)?.sourceVersion === versionEvidence.gameVersion &&
      proof?.gameSha256 === catalog.gameDecodedSha256;
  });
}
export function orderFlowerAuxiliarySourceSupported(versionEvidence) {
  return exactAuxiliarySourceEvidence(versionEvidence);
}
export function auxAt(raw, path) {
  let value = raw;
  for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return { supplied: false, value: null }; value = value[key]; }
  return { supplied: true, value };
}
export function auxDate(value) {
  if (auxPositive(value) && value <= 8640000000000000) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return auxPositive(ms) && [value, value.replace('Z', '.000Z')].includes(new Date(ms).toISOString()) ? ms : null;
}
export function auxNumMap(value, maximum = 20000) {
  return plainObject(value) && Object.keys(value).length <= maximum && Object.entries(value).every(([id, count]) =>
    /^[1-9]\d*$/.test(id) && auxPositive(Number(id)) && auxNonnegative(count));
}
export const auxBagBody = values => Object.fromEntries(Object.entries(values).filter(([, count]) => count > 0));
export const auxBinding = (a, b) => !!a && !!b && ['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].every(key => a[key] === b[key]);
export function auxOrderFields(kind, value) {
  const keys = ['npcId', 'dialogId', 'isVideo', 'cTime', 'cdTime', kind === 'resident' ? 'placeIdx' : 'finishCnt', 'videoRwd',
    ...(Object.hasOwn(value || {}, 'flowers') ? ['flowers'] : [])];
  return auxExact(value, keys) && orderFlowerBranchShape(kind, value);
}
export function auxSourceBefore(source, proposal, response = null) {
  return source?.kind === 'response' && source.connectionEpoch === proposal.connectionEpoch && auxPositive(source.requestSequence) &&
    auxRef(source.responseRef) && auxRef(source.wireKey) && auxRef(source.method) && (!response || source.requestSequence < response.requestSequence);
}
export function auxSourceOnLoginAnchor(source, proposal) {
  const anchor = proposal?.versionEvidence ?? proposal?.orderFlowerReward?.versionEvidence ??
    proposal?.orderFlowerEnter?.versionEvidence ?? proposal?.orderFlowerVideo?.versionEvidence;
  if (!auxSourceBefore(source, proposal) || !anchor?.loginResponseRef) return false;
  if (source.method === 'index.login') return source.responseRef === anchor.loginResponseRef;
  return source.versionEvidence?.loginResponseRef === anchor.loginResponseRef &&
    source.versionEvidence?.gameVersion === anchor.gameVersion && source.versionEvidence?.protocolVersion === anchor.protocolVersion;
}
export function auxMatched(observation, { method, connectionEpoch, anchor, uid = null, context = null } = {}) {
  const version = observation?.versionEvidence, actual = orderFlowerContext(context),
    officialUid = uid ?? auxAt(observation?.value, ['7','0','0']).value,
    frameChecks = actual && officialAnswerProtocolChecks(observation, version, actual, officialUid);
  return actual?.connectionEpoch === connectionEpoch && frameChecks?.versionProtocol === true && frameChecks.frameProtocol === true && observation?.source === 'response' && observation.transport === 'answered' && observation.method === method &&
    observation.connectionEpoch === connectionEpoch && auxPositive(observation.requestSequence) && auxRef(observation.wireKey) && auxRef(observation.responseRef) &&
    observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true &&
    !(observation.messagePresent === true && observation.noticeOnly !== true) &&
    currentOfficialSourceEvidence(version) && ['order.resident', 'order.satin', 'order.decorate'].some(action => currentOfficialDataEvidence(version, action)) &&
    version.loginResponseRef === anchor &&
    (uid === null || !auxAt(observation.value, ['7', '0', '0']).supplied || observation.value['7']['0']['0'] === uid);
}
export function captureOrderFlowerInventory({ context, observation } = {}) {
  const actual = orderFlowerContext(context), uid = auxAt(observation?.value, ['7', '0', '0']).value,
    bag = auxAt(observation?.value, ['7', '0', '32']), profile = Object.fromEntries([['gold', '44'], ['yb', '41'], ['level', '34'], ['lvlExp', '35']]
      .map(([name, key]) => [name, auxAt(observation?.value, ['7', '0', key])]));
  const vipExp = auxAt(observation?.value, ['7', '0', '37']);
  if (!actual || !auxPositive(uid) || !auxMatched(observation, { method: 'index.login', context: actual, connectionEpoch: actual.connectionEpoch, anchor: observation?.responseRef }) ||
    !bag.supplied || !auxNumMap(bag.value) || Object.values(profile).some(one => !one.supplied || !auxNonnegative(one.value)) ||
    !auxPositive(profile.level.value) || vipExp.supplied && !auxNonnegative(vipExp.value)) return null;
  if (vipExp.supplied) profile.vipExp = vipExp;
  return freeze({ version: 'order-aux-current-inventory/v1', context: actual, officialUid: uid, source: orderFlowerSafeSource(observation),
    versionEvidence: clone(observation.versionEvidence), bagComplete: true, bagFingerprint: fingerprint(auxBagBody(bag.value)),
    bagEntries: Object.keys(auxBagBody(bag.value)).length, rewardSeedQuantity: bag.value['21068'] || 0,
    profile: Object.fromEntries(Object.entries(profile).map(([key, one]) => [key, one.value])) });
}
export function captureOrderFlowerCounter(observation, id) {
  const row = auxAt(observation?.value, ['7', '4', String(id)]), value = row.value;
  return row.supplied && plainObject(value) && auxPositive(value['0']) && value['1'] === id && auxNonnegative(value['2']) &&
    auxNonnegative(value['3']) && auxPositive(auxDate(value['4'])) ? freeze({ uid: value['0'], type: id, raw: value['2'], total: value['3'],
      rTime: auxDate(value['4']), source: orderFlowerSafeSource(observation) }) : null;
}
export function auxSameDay(day, observation, uid) {
  const ms = auxAt(observation?.value, ['2', '3']).value, tz = auxAt(observation?.value, ['2', '11']).value, proof = day?.timezoneProof;
  if (day?.known !== true || !auxRef(day.proofRef) || day.source?.officialUid !== uid || !auxPositive(ms) || observation.serverMs !== ms ||
    ms < day.startMs || ms >= day.endMs || day.endMs - day.startMs !== 86400000 || !Number.isSafeInteger(day.utcOffsetMinutes) ||
    Math.abs(day.utcOffsetMinutes) > 840 || proof?.kind !== 'matched-other-tzinfo-normal/v1' || !plainObject(tz?.normal) ||
    !['type', 'ms', 'secNum', 'tzo'].every(key => (tz.normal[key] ?? null) === (proof.normal?.[key] ?? null)) || tz.normal.type !== 0 ||
    !auxPositive(tz.normal.ms) || !/^\d{14}$/.test(String(tz.normal.secNum))) return false;
  const text = String(tz.normal.secNum), parts = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8), text.slice(8, 10), text.slice(10, 12), text.slice(12, 14)].map(Number);
  if (Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]) - tz.normal.ms !== day.utcOffsetMinutes * 60000 ||
    Object.hasOwn(tz.normal, 'tzo') && tz.normal.tzo !== -day.utcOffsetMinutes) return false;
  if (tz.splitMap != null) {
    if (!plainObject(tz.splitMap) || Object.keys(tz.splitMap).length > 16 || Object.entries(tz.splitMap).some(([year, values]) =>
      !/^\d{4}$/.test(year) || !Array.isArray(values) || values.length !== 0) || proof.splitMap?.presence !== 'present' ||
      proof.splitMap.complete !== true || proof.splitMap.totalAnchors !== 0 || proof.splitMap.fingerprint !== fingerprint(tz.splitMap)) return false;
  } else if (proof.splitMap?.totalAnchors !== 0 || proof.splitMap.totalYears !== 0 || proof.splitMap.presence === 'present') return false;
  return Math.floor((ms + day.utcOffsetMinutes * 60000) / 86400000) * 86400000 - day.utcOffsetMinutes * 60000 === day.startMs;
}
export function auxRawOrder(observation, kind, boxId, officialUid = null) {
  if (!['resident', 'satin', 'decorate'].includes(kind) || !auxPositive(boxId) ||
    (kind === 'resident' ? boxId > 6 : boxId !== (kind === 'satin' ? 7 : 8))) return { known: false, row: null };
  const domain = auxAt(observation?.value, ['105', '0']), field = kind === 'resident' ? ['1', String(boxId)] : [kind === 'satin' ? '6' : '7'];
  if (!domain.supplied || !plainObject(domain.value) ||
    (Object.hasOwn(domain.value, '0') ? !auxPositive(domain.value['0']) || auxPositive(officialUid) && domain.value['0'] !== officialUid
      : !auxPositive(officialUid))) return { known: false, row: null };
  if (kind === 'resident') {
    if (!plainObject(domain.value['1']) || Object.keys(domain.value['1']).length > 6 || !Object.keys(domain.value['1']).every(key => /^[1-6]$/.test(key))) return { known: false, row: null };
    if (!Object.hasOwn(domain.value['1'], String(boxId))) return { known: true, row: null };
  }
  const entry = auxAt(domain.value, field), raw = entry.value;
  if (!entry.supplied) return { known: false, row: null };
  if (raw === null) return { known: true, row: null };
  const keys = kind === 'resident' ? { npcId: '0', dialogId: '1', flowers: '2', isVideo: '3', cdTime: '4', cTime: '5', placeIdx: '6', videoRwd: '7' }
    : { flowers: '0', npcId: '1', dialogId: '2', finishCnt: '3', isVideo: '4', videoRwd: '5', cdTime: '6', cTime: '7' };
  if (!plainObject(raw)) return { known: false, row: null };
  const row = Object.fromEntries(Object.entries(keys).filter(([name, key]) => name !== 'flowers' || Object.hasOwn(raw, key))
    .map(([name, key]) => [name, name.endsWith('Time') ? raw[key] == null ? null : auxDate(raw[key]) : raw[key] ?? null]));
  if (!orderFlowerBranchShape(kind, row, { boxId }) || raw[keys.cdTime] != null && !auxPositive(row.cdTime)) return { known: false, row: null };
  return { known: true, row: clone(row) };
}
export function assertOrderFlowerAuxiliaryBase(proposal, definition, field) {
  const context = orderFlowerContext(proposal), preparation = proposal?.[field], target = proposal?.targets?.[0];
  if (!context || !definition || !plainObject(preparation) || proposal.featureId !== definition.featureId || proposal.scope !== definition.scope ||
    proposal.method !== definition.method || !auxPositive(preparation.officialUid) || !auxRef(preparation.lifecycleRef) || !auxDigest(preparation.targetFingerprint) ||
    !auxSourceBefore(preparation.source, proposal) || preparation.source.method !== 'index.login' ||
    !exactAuxiliarySourceEvidence(preparation.versionEvidence) ||
    preparation.versionEvidence.loginResponseRef !== preparation.source.responseRef ||
    !Array.isArray(proposal.targets) || proposal.targets.length !== 1 || !auxExact(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
    target.targetKind !== definition.targetKind || target.lifecycleRef !== preparation.lifecycleRef || target.targetFingerprint !== preparation.targetFingerprint ||
    !auxRef(target.targetRef) || !auxRef(target.memberKey) || !Array.isArray(proposal.resources) || proposal.resources.length !== 0 ||
    !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== 0 ||
    !['order-aux-current-inventory/v1', 'order-aux-current-inventory/v2'].includes(preparation.beforeInventory?.version) || preparation.beforeInventory.bagComplete !== true ||
    !auxDigest(preparation.beforeInventory.bagFingerprint) || preparation.beforeInventory.officialUid !== preparation.officialUid ||
    !sameOrderFlowerContext(preparation.beforeInventory.context, context) || !auxSourceBefore(preparation.beforeInventory.source, proposal) ||
    preparation.beforeInventory.source.method !== 'index.login' || preparation.beforeInventory.source.responseRef !== preparation.source.responseRef ||
    !exactAuxiliarySourceEvidence(preparation.beforeInventory.versionEvidence) ||
    preparation.beforeInventory.versionEvidence.loginResponseRef !== preparation.source.responseRef ||
    !['gold', 'yb', 'lvlExp'].every(key => auxNonnegative(preparation.beforeInventory.profile?.[key])) || !auxPositive(preparation.beforeInventory.profile?.level) ||
    preparation.beforeInventory.profile?.vipExp != null && !auxNonnegative(preparation.beforeInventory.profile.vipExp) ||
    preparation.beforeInventory.version === 'order-aux-current-inventory/v2' && !validCurrentInventoryEnvelope(preparation.beforeInventory, proposal) ||
    preparation.day?.known !== true || preparation.day.source?.officialUid !== preparation.officialUid ||
    preparation.day.source.responseRef !== preparation.source.responseRef || !auxRef(preparation.day.proofRef) || !auxPositive(preparation.day.startMs) ||
    preparation.day.endMs - preparation.day.startMs !== 86400000) {
    throw problem('ORDER_FLOWER_AUXILIARY_PROPOSAL_INVALID', '辅助订单动作须绑定原当前身份、唯一目标和真实绝对库存', 400);
  }
  return preparation;
}
export function auxiliarySemanticKeyBinding(proposal, field, baseKey) {
  const need = proposal?.[field]?.currentNeed, target = proposal?.targets?.[0];
  if (proposal?.semanticKey === baseKey && need == null) return Object.freeze({
    valid: true, phase: 'preflight', baseSemanticKey: baseKey, decisionGeneration: null, currentNeed: null });
  if (!plainObject(need) || need.necessary !== true || need.featureId !== proposal.featureId ||
      need.targetRef !== target?.targetRef || !auxRef(need.businessNeedRef) ||
      need.needRef !== 'current-need:' + fingerprint([need.featureId, need.targetRef, need.businessNeedRef]) ||
      !auxDigest(need.decisionGeneration) || !auxDigest(need.semanticFingerprint) ||
      proposal.semanticKey !== baseKey + ':current-need:' + need.decisionGeneration) {
    return Object.freeze({ valid: false, phase: 'invalid', baseSemanticKey: baseKey, decisionGeneration: null, currentNeed: null });
  }
  return Object.freeze({ valid: true, phase: 'claimed', baseSemanticKey: baseKey,
    decisionGeneration: need.decisionGeneration, currentNeed: need });
}
export function auxiliarySemanticKeyMatches(proposal, field, baseKey) {
  return auxiliarySemanticKeyBinding(proposal, field, baseKey).valid;
}
function validCurrentInventoryEnvelope(inventory, proposal) {
  const values = inventory.itemValues, sources = inventory.itemSources, profileSources = inventory.fieldSources;
  if (!auxDigest(inventory.projectionFingerprint) || !inventory.baseline || !auxDigest(inventory.baseline.fingerprint) ||
      !auxSourceBefore(inventory.bagSource, proposal) || !plainObject(profileSources) ||
      !['gold', 'yb', 'level', 'lvlExp'].every(key => auxRef(profileSources[key]?.responseRef)) ||
      Object.keys(profileSources).some(key => !['gold', 'yb', 'level', 'lvlExp', 'vipExp'].includes(key)) ||
      inventory.profile?.vipExp != null && !auxRef(profileSources.vipExp?.responseRef) ||
      !Object.values(profileSources).every(one => auxSourceBefore(one, proposal)) || !auxNumMap(values, 20000) || !plainObject(sources) ||
      canonical(Object.keys(values).sort()) !== canonical(Object.keys(sources).sort()) ||
      !Object.values(sources).every(one => auxSourceBefore(one, proposal)) ||
      fingerprint(auxBagBody(values)) !== inventory.bagFingerprint) return false;
  const sourceBasis = { bagSource: inventory.bagSource, itemSources: sources, profileSources };
  return fingerprint({ items: auxBagBody(values), profile: inventory.profile, sources: sourceBasis }) === inventory.projectionFingerprint;
}
export function orderFlowerAuxiliaryAfterCloseProof({ proposal, response, bridge, field, proofVersion }) {
  const preparation = proposal[field], old = orderFlowerContext(proposal), next = orderFlowerContext(bridge?.newContext), observed = bridge?.newLoginObservation;
  const closed = bridge?.oldPhysicalCloseReceipt, anchor = preparation?.versionEvidence, version = observed?.versionEvidence;
  if (!auxRef(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !auxDigest(bridge.bridgeFingerprint) ||
    !sameOrderFlowerContext(bridge.originalContext, old) || !next || ORDER_FLOWER_AXES.slice(0, 5).some(key => next[key] !== old[key]) || next.connectionEpoch <= old.connectionEpoch ||
    !auxMatched(response, { method: proposal.method, context: old, connectionEpoch: old.connectionEpoch, anchor: anchor?.loginResponseRef, uid: preparation?.officialUid }) ||
    !auxBinding(bridge.after, response) || closed?.closed !== true || closed.connectionEpoch !== old.connectionEpoch || !auxRef(closed.closureEvidenceRef) ||
    bridge.officialUid !== preparation.officialUid || bridge.oldLoginSource?.officialUid !== preparation.officialUid || bridge.oldLoginSource.method !== 'index.login' ||
    bridge.oldLoginSource.connectionEpoch !== old.connectionEpoch || bridge.oldLoginSource.responseRef !== anchor.loginResponseRef ||
    bridge.oldLoginSource.versionEvidence?.source !== anchor.source || bridge.oldLoginSource.versionEvidence?.gameVersion !== anchor.gameVersion || bridge.oldLoginSource.versionEvidence?.protocolVersion !== anchor.protocolVersion ||
    !auxMatched(observed, { method: 'index.login', context: next, connectionEpoch: next.connectionEpoch, anchor: observed?.responseRef, uid: preparation.officialUid }) ||
    observed.value?.['7']?.['0']?.['0'] !== preparation.officialUid || version.gameVersion !== anchor.gameVersion || version.protocolVersion !== anchor.protocolVersion ||
    !exactAuxiliarySourceEvidence(version)) {
    throw problem('ORDER_AUXILIARY_AFTER_CLOSE_BRIDGE_INVALID', '订单辅助动作缺少原写实际关闭后的同身份正常登录桥');
  }
  return freeze({ version: proofVersion, leaseRef: bridge.leaseRef, operationId: proposal.operationId, originalContext: old, newContext: next,
    after: Object.fromEntries(['connectionEpoch', 'requestSequence', 'wireKey', 'responseRef'].map(key => [key, response[key]])), bridgeFingerprint: bridge.bridgeFingerprint,
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: old.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { ...orderFlowerSafeSource(observed), gameVersion: version.gameVersion, protocolVersion: version.protocolVersion,
      loginResponseRef: version.loginResponseRef, sourceProofFingerprint: currentOfficialSourceEvidence(version)?.proofFingerprint ?? null,
      dataSnapshotId: version.dataSnapshotId }, officialUid: preparation.officialUid });
}
export function auxiliaryInventoryEffect({ before, response, observation, allowProxy = null, gainRule } = {}) {
  const denied = reasonCode => ({ known: false, reasonCode });
  const after = captureOrderFlowerInventory({ context: before.context && { ...before.context, connectionEpoch: observation?.connectionEpoch }, observation });
  if (!after || after.officialUid !== before.officialUid) return denied('ORDER_AUXILIARY_ABSOLUTE_INVENTORY_MISSING');
  const maps = Object.fromEntries([['bi', '0'], ['bo', '1'], ['bd', '2'], ['actBi', '3'], ['actBo', '4'], ['proxyBi', '5'], ['proxyBo', '6']].map(([name, key]) => {
    const one = auxAt(response?.value, ['7', '2', key]); return [name, { supplied: one.supplied, known: one.supplied && auxNumMap(one.value), values: one.value }];
  }));
  if (!maps.bi.known || Object.values(maps).some(one => one.supplied && !one.known)) return denied('ORDER_AUXILIARY_ITEM_FLOWS_UNREADABLE');
  if (['bo', 'actBo', 'proxyBo'].some(key => maps[key].known && Object.values(maps[key].values).some(value => value > 0)) ||
    maps.actBi.known && Object.values(maps.actBi.values).some(value => value > 0)) return denied('ORDER_AUXILIARY_UNEXPECTED_ITEM_EFFECT');
  const gains = auxBagBody(maps.bi.values), proxy = maps.proxyBi.known ? auxBagBody(maps.proxyBi.values) : {};
  // Item 3 is profile vipExp in the official item mapping. This inventory
  // snapshot intentionally contains only gold/yb/level/remaining-exp, so its
  // effect cannot be silently treated as an ordinary bag item or as zero.
  if ((gains[3] || 0) > 0 && (!auxNonnegative(before.profile.vipExp) || !auxNonnegative(after.profile.vipExp) ||
      after.profile.vipExp !== before.profile.vipExp + gains[3])) return denied('ORDER_AUXILIARY_VIP_EXPERIENCE_EFFECT_UNPROVEN');
  if (Object.keys(proxy).length && (!allowProxy || allowProxy(proxy) !== true)) return denied('ORDER_AUXILIARY_PROXY_GAIN_UNPROVEN');
  const transition = orderFlowerExperienceTransition({ before: before.profile, after: after.profile, experience: gains[2] || 0 });
  if (!transition.known || typeof gainRule !== 'function' || gainRule({ gains, proxy, transition }) !== true) return denied('ORDER_AUXILIARY_REWARD_CONTRACT_UNPROVEN');
  const expectedGold = before.profile.gold + (gains[11] || 0), expectedYb = before.profile.yb + (gains[1] || 0);
  if (!auxNonnegative(expectedGold) || !auxNonnegative(expectedYb) || after.profile.gold !== expectedGold || after.profile.yb !== expectedYb) return denied('ORDER_AUXILIARY_CURRENCY_EFFECT_UNPROVEN');
  for (const [name, key] of [['gold', '44'], ['yb', '41'], ['level', '34'], ['lvlExp', '35'], ['vipExp', '37']]) {
    const supplied = auxAt(response?.value, ['7', '0', key]);
    if (supplied.supplied && supplied.value !== after.profile[name]) return denied('ORDER_AUXILIARY_WRITE_PROFILE_CONFLICT');
  }
  const reversed = { ...observation.value['7']['0']['32'] };
  for (const [id, quantity] of Object.entries(gains)) {
    if ([1, 2, 3, 11].includes(Number(id))) continue;
    const ownedElsewhere = allowProxy?.({ [id]: quantity }, { rawGain: true }) === true;
    if (ownedElsewhere) continue;
    const value = (reversed[id] || 0) - quantity;
    if (!auxNonnegative(value)) return denied('ORDER_AUXILIARY_ABSOLUTE_REWARD_DIFFERENCE_UNPROVEN');
    reversed[id] = value;
  }
  if (fingerprint(auxBagBody(reversed)) !== before.bagFingerprint) return denied('ORDER_AUXILIARY_WHOLE_BAG_EFFECT_CONFLICT');
  if (maps.bd.known) for (const [id, value] of Object.entries(maps.bd.values)) {
    const actual = ({ 1: after.profile.yb, 2: after.profile.lvlExp, 3: after.profile.vipExp, 11: after.profile.gold })[id] ?? (observation.value['7']['0']['32'][id] || 0);
    if (value !== actual) return denied('ORDER_AUXILIARY_WRITE_ABSOLUTE_EFFECT_CONFLICT');
  }
  return freeze({ known: true, reasonCode: null, beforeBagFingerprint: before.bagFingerprint, afterBagFingerprint: after.bagFingerprint,
    gains: clone(gains), proxyGains: clone(proxy), zeroItemCost: true, profileBefore: clone(before.profile), profileAfter: clone(after.profile), experienceTransition: transition,
    // A reward-only answer can omit bo. Preserve that omission and prove the
    // zero debit using the supplied complete gain map and full absolute bag /
    // profile conservation above; omission alone is never a zero-cost proof.
    zeroItemCostProof: { kind: 'provided-gains-and-complete-absolute-inventory-conservation/v1',
      gainMapFingerprint: fingerprint(maps.bi.values), costMapSupplied: maps.bo.supplied, costMapReadable: maps.bo.known,
      completeBagDifferenceChecked: true, currencyAndExperienceDifferenceChecked: true },
    answer: orderFlowerSafeSource(response), postRead: orderFlowerSafeSource(observation) });
}
export function auxiliaryResult(proposal, response, version, reasonCode, { field, observation = null, proof = null, confirmed = false, effect = null } = {}) {
  const before = proposal[field], verdict = confirmed ? 'confirmed' : 'unknown';
  return freeze({ verdict, verificationVersion: version, reasonCode, postReadRef: observation?.responseRef ?? null,
    member: { memberKey: proposal.targets[0].memberKey, verdict, reasonCode }, resourceResolutions: [],
    evidence: { version, operationId: proposal.operationId, targetRef: proposal.targets[0].targetRef, lifecycleRef: before.lifecycleRef,
      targetFingerprint: before.targetFingerprint, reasonCode, answer: orderFlowerSafeSource(response), postRead: orderFlowerSafeSource(observation),
      bridge: proof, effect, businessCounterOrClaimFlagAloneConfirmsNothing: true } });
}
export function createAuxiliaryVerifier({ assert, analyze, unknown, isLeaseCurrent }) {
  if (typeof isLeaseCurrent !== 'function' || isLeaseCurrent.constructor?.name === 'AsyncFunction') throw new TypeError('Auxiliary verification requires a synchronous exact lease-current guard');
  const current = input => { const value = isLeaseCurrent(input); if (value?.then) { value.catch?.(() => {}); throw new TypeError('Auxiliary lease-current guard must be synchronous'); } return value === true; };
  return Object.freeze({ async verify({ proposal, response, connection, signal }) {
    assert(proposal);
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') return unknown(proposal, response, 'ORDER_AUXILIARY_READ_LEASE_UNAVAILABLE');
    let bridge;
    try { signal?.throwIfAborted(); bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(proposal, response, typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code) ? error.code : 'ORDER_AUXILIARY_POST_READ_FAILED'); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown(proposal, response, 'ORDER_AUXILIARY_READ_LEASE_REVOKED', bridge.newLoginObservation);
    const result = analyze({ proposal, response, bridge });
    return signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge }) ? unknown(proposal, response, 'ORDER_AUXILIARY_READ_LEASE_REVOKED', bridge.newLoginObservation) : result;
  } });
}
