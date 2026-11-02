import { canonical, clone, fingerprint, freeze, plainObject } from '../../common.mjs';
import { officialAnswerProtocolChecks } from '../../official-server-version-contract.mjs';
import { ART_MAKE_CONTRACT, assertArtMakeProposal, artAfterCloseLoginProof } from './rpc-contract.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';

const VERSION = 'art-make-verification/after-close-cost-observation-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sourceKind = source => source?.kind ?? source?.sourceKind ?? source?.source;
const BASIS_METHODS = new Set(NORMAL_SYNC_METHODS);
const codeOf = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'ART_POST_READ_FAILED';
function safeSource(source) {
  return source ? { kind: ['response', 'late', 'push'].includes(sourceKind(source)) ? sourceKind(source) : null,
    method: BASIS_METHODS.has(source.method) ? source.method : null, responseRef: reference(source.responseRef) ? source.responseRef : null,
    wireKey: reference(source.wireKey) ? source.wireKey : null, connectionEpoch: positive(source.connectionEpoch) ? source.connectionEpoch : null,
    requestSequence: positive(source.requestSequence) ? source.requestSequence : null } : null;
}
function at(root, path) {
  let value = root;
  for (const key of path) {
    if (!plainObject(value) || !Object.hasOwn(value, key)) return { supplied: false, value: null };
    value = value[key];
  }
  return { supplied: true, value };
}
function itemMap(root, path) {
  const entry = at(root, path), values = entry.value;
  const known = entry.supplied && plainObject(values) && Object.keys(values).length <= 20000 &&
    Object.entries(values).every(([key, value]) => /^[1-9][0-9]*$/.test(key) && positive(Number(key)) && nonnegative(value));
  return { supplied: entry.supplied, known, values: known ? values : null };
}
const item = (map, id, missingZero = false) => map.known && Object.hasOwn(map.values, String(id)) ? map.values[id] : map.known && missingZero ? 0 : null;
function snapshot({ proposal, response, observation, bridge }) {
  assertArtMakeProposal(proposal);
  if (!bridge || observation !== bridge.newLoginObservation) return null;
  const proof = artAfterCloseLoginProof({ proposal, response, bridge }), raw = observation.value, art = proposal.art;
  const bag = itemMap(raw, ['7', '0', '32']), gold = at(raw, ['7', '0', '44']), yb = at(raw, ['7', '0', '41']);
  const vase = at(raw, ['102', '0', String(art.vaseId)]), ownArtUid = at(raw, ['106', '0', '0']);
  const makeList = at(raw, ['106', '0', '2']);
  if (!bag.known || !gold.supplied || !nonnegative(gold.value) || !yb.supplied || !nonnegative(yb.value) ||
    !vase.supplied || !plainObject(vase.value) || vase.value['0'] !== art.officialUid || vase.value['1'] !== art.vaseId ||
    !ownArtUid.supplied || ownArtUid.value !== art.officialUid || !makeList.supplied || !Array.isArray(makeList.value) ||
    makeList.value.length > 4096 || Object.keys(makeList.value).length !== makeList.value.length || !makeList.value.every(positive)) return null;
  return { proof, bag, gold: gold.value, yb: yb.value,
    vase: { uid: vase.value['0'], vaseId: vase.value['1'] },
    makeHistory: { containsArt: makeList.value.includes(art.artId), total: makeList.value.length,
      valuesFingerprint: fingerprint(makeList.value), meaning: 'first-make-history-not-produced-quantity' } };
}
export function validateArtSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { return snapshot({ proposal, response, observation, bridge: bridge || postReadBridge }) !== null; }
  catch { return false; }
}
function sourceBefore(source, proposal, response) {
  return sourceKind(source) === 'response' && BASIS_METHODS.has(source?.method) && source.connectionEpoch === proposal.connectionEpoch &&
    positive(source.requestSequence) && source.requestSequence < response.requestSequence && reference(source.responseRef) && reference(source.wireKey);
}
function before(proposal, response, expected) {
  const art = proposal.art, items = art.beforeItems, profile = art.beforeProfile, vase = art.beforeVase;
  const ids = [...expected.map(one => one.itemId), art.artId];
  if (!Array.isArray(items) || items.length !== ids.length || new Set(items.map(one => one.itemId)).size !== ids.length ||
    !items.every(one => ids.includes(one.itemId) && nonnegative(one.quantity) && reference(one.basisRef) && sourceBefore(one.source, proposal, response)) ||
    !expected.every(one => {
      const original = items.find(entry => entry.itemId === one.itemId);
      const resource = proposal.resources.find(entry => entry.resourceRef === 'item:' + one.itemId);
      return original?.quantity >= one.quantity && resource?.basisRef === original.basisRef;
    }) || !plainObject(profile) || !nonnegative(profile.gold) || !nonnegative(profile.yb) || !sourceBefore(profile.goldSource, proposal, response) ||
    !sourceBefore(profile.ybSource, proposal, response) ||
    !plainObject(vase) || vase.uid !== art.officialUid || vase.vaseId !== art.vaseId ||
    !positive(vase.uTime) || !positive(vase.cTime) || !sourceBefore(vase.source, proposal, response)) return null;
  return { items: [...items].sort((a, b) => a.itemId - b.itemId).map(one => ({ itemId: one.itemId, quantity: one.quantity,
    basisRef: one.basisRef, source: safeSource(one.source) })), profile: { gold: profile.gold, yb: profile.yb,
      goldSource: safeSource(profile.goldSource), ybSource: safeSource(profile.ybSource) },
    vase: { uid: vase.uid, vaseId: vase.vaseId, uTime: vase.uTime, cTime: vase.cTime, source: safeSource(vase.source) } };
}
function result(proposal, response, reasonCode, details = {}) {
  const { observation = null, proof = null, initial = null, flows = null,
    amounts = null, costReceipt = null, history = null, confirmed = false } = details;
  const verdict = confirmed ? 'confirmed' : 'unknown', target = proposal.targets[0], art = proposal.art;
  const postReadRef = reference(observation?.responseRef) ? observation.responseRef : null;
  return freeze({ verdict, verificationVersion: VERSION, reasonCode, postReadRef,
    member: { memberKey: target.memberKey, verdict, reasonCode },
    targetEffect: confirmed ? { kind: 'single-recipe-product-and-cost-observed', artId: art.artId, quantity: 1,
      parentLifecycleRef: art.parentLifecycleRef, demandRef: art.demandRef, unitRef: art.unitRef } : null,
    observedCostReceipt: costReceipt,
    evidence: { version: VERSION, operationId: proposal.operationId, reasonCode, targetRef: target.targetRef,
      lifecycleRef: target.lifecycleRef, parentLifecycleRef: art.parentLifecycleRef, demandRef: art.demandRef,
      recipeFingerprint: art.recipeFingerprint, before: initial, answer: safeSource(response), postRead: safeSource(observation),
      flows, amounts, expectedConsumptions: clone(details.expectedConsumptions || []),
      unexpectedDebits: clone(details.unexpectedDebits || []),
      unattributedCurrencyChange: clone(details.unattributedCurrencyChange || null),
      makeHistory: history, observedCostReceipt: costReceipt,
      bridge: proof ? { leaseRef: proof.leaseRef, bridgeFingerprint: proof.bridgeFingerprint,
        closureEvidenceRef: proof.oldPhysicalCloseReceipt.closureEvidenceRef, originalConnectionEpoch: proof.originalContext.connectionEpoch,
        newConnectionEpoch: proof.newContext.connectionEpoch, writeResponseRef: proof.after.responseRef,
        newLoginResponseRef: proof.newLogin.responseRef } : null },
    resourceResolutions: proposal.resources.map(resource => ({ resourceKey: resource.resourceKey, state: 'historical_footprint',
      basisRefs: postReadRef ? [postReadRef] : [], coverageRef: null })) });
}
function analyze({ proposal, response, observation, bridge }) {
  const contract = assertArtMakeProposal(proposal), art = proposal.art, expected = contract.expectedConsumptions;
  const context = { observation }, finish = reasonCode => result(proposal, response, reasonCode, context);
  const anchor = art.versionEvidence, version = response?.versionEvidence;
  const protocols = officialAnswerProtocolChecks(response, anchor, proposal, art.officialUid);
  if (response?.source !== 'response' || response.transport !== 'answered' || response.method !== ART_MAKE_CONTRACT.method ||
    response.connectionEpoch !== proposal.connectionEpoch || !positive(response.requestSequence) || !reference(response.wireKey) || !reference(response.responseRef) ||
    response.envelopeOk !== true || response.dsName !== 'G.ISyncData' || response.rejected === true ||
    response.messagePresent === true && response.noticeOnly !== true || version?.gameVersion !== anchor.gameVersion ||
    !protocols.versionProtocol || version?.loginResponseRef !== anchor.loginResponseRef ||
    !protocols.frameProtocol) return finish('ART_MAKE_MATCHED_ANSWER_UNPROVEN');
  const initial = before(proposal, response, expected);
  if (!initial) return finish('ART_MAKE_ORIGINAL_ITEM_PROFILE_OR_VASE_UNPROVEN');
  context.initial = initial;
  let current;
  try { current = snapshot({ proposal, response, observation, bridge }); } catch { /* No replacement proof may be guessed. */ }
  if (!current) return finish('ART_MAKE_NEW_LOGIN_COVERAGE_MISSING');
  context.proof = current.proof; context.history = current.makeHistory;
  for (const path of [['7', '0', '0'], ['106', '0', '0'], ['102', '0', String(art.vaseId), '0']]) {
    const uid = at(response.value, path);
    if (uid.supplied && uid.value !== art.officialUid) return finish('ART_MAKE_ANSWER_UID_CONFLICT');
  }
  const names = { bi: '0', bo: '1', bd: '2', actBi: '3', actBo: '4', proxyBi: '5', proxyBo: '6' };
  const maps = Object.fromEntries(Object.entries(names).map(([name, key]) => [name, itemMap(response.value, ['7', '2', key])]));
  const safeMap = map => ({ supplied: map.supplied, readable: map.known,
    entries: map.known ? Object.entries(map.values).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({ itemId: Number(id), quantity }))
      .sort((a, b) => a.itemId - b.itemId) : null });
  context.flows = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, safeMap(map)]));
  context.expectedConsumptions = expected;
  if (!maps.bo.known || !maps.bi.known || Object.values(maps).some(map => map.supplied && !map.known)) return finish('ART_MAKE_ITEM_FLOWS_UNREADABLE');
  const expectedByItem = new Map(expected.map(one => [one.itemId, one.quantity]));
  const unexpectedDebits = [];
  for (const [id, quantity] of Object.entries(maps.bo.values)) {
    const itemId = Number(id), expectedQuantity = expectedByItem.get(itemId) || 0;
    if (quantity > expectedQuantity) unexpectedDebits.push({ source: 'bo', itemId, quantity: quantity - expectedQuantity,
      expectedQuantity, observedQuantity: quantity, evidence: 'complete-known-official-operation-flow' });
  }
  for (const name of ['actBo', 'proxyBo']) if (maps[name].known) for (const [id, quantity] of Object.entries(maps[name].values)) {
    if (quantity > 0) unexpectedDebits.push({ source: name, itemId: Number(id), quantity, expectedQuantity: 0,
      observedQuantity: quantity, evidence: 'complete-known-official-operation-flow' });
  }
  context.unexpectedDebits = unexpectedDebits;
  if (unexpectedDebits.length) return finish('ART_MAKE_UNEXPECTED_COST');
  if (!expected.every(one => item(maps.bo, one.itemId) === one.quantity)) return finish('ART_MAKE_FLOW_QUANTITIES_UNPROVEN');
  const gains = [maps.bi, maps.actBi, maps.proxyBi];
  if (item(maps.bi, art.artId) !== 1 || gains.slice(1).some(map => map.known && item(map, art.artId, true) > 0) ||
    gains.some(map => map.known && expected.some(one => item(map, one.itemId, true) > 0))) return finish('ART_MAKE_PRODUCT_OR_INPUT_GAIN_AMBIGUOUS');
  const amounts = initial.items.map(one => {
    const fee = expected.find(entry => entry.itemId === one.itemId)?.quantity || 0;
    const wanted = one.itemId === art.artId ? one.quantity + 1 : one.quantity - fee;
    return { itemId: one.itemId, before: one.quantity, expectedAfter: wanted, after: item(current.bag, one.itemId, true),
      writeAbsolute: item(maps.bd, one.itemId), operationConsumption: item(maps.bo, one.itemId, true) };
  });
  context.amounts = { items: amounts, currencies: { beforeGold: initial.profile.gold, afterGold: current.gold,
    beforeYb: initial.profile.yb, afterYb: current.yb }, vaseStillPresent: current.vase.vaseId === art.vaseId };
  if (amounts.some(one => !nonnegative(one.expectedAfter) || one.after !== one.expectedAfter ||
    one.writeAbsolute !== null && one.writeAbsolute !== one.expectedAfter)) return finish('ART_MAKE_ABSOLUTE_ITEMS_CONFLICT');
  // Currency values are actual IUsr.gld/dmd fields. Bag[11]/bag[6] cannot
  // establish them, and absence of a currency flow is not a zero balance.
  if (current.gold !== initial.profile.gold || current.yb !== initial.profile.yb ||
    gains.some(map => map.known && (item(map, 11, true) > 0 || item(map, 6, true) > 0))) {
    // A later absolute profile read can include unrelated play during the
    // reconnect. It proves the new balance, but cannot attribute the delta to
    // this operation. Keep this operation unknown and refresh/reconcile; only
    // matched write flows above may establish a durable cost-contract guard.
    context.unattributedCurrencyChange = {
      before: { gold: initial.profile.gold, yb: initial.profile.yb },
      after: { gold: current.gold, yb: current.yb },
      positiveCurrencyFlowReported: gains.some(map => map.known && (item(map, 11, true) > 0 || item(map, 6, true) > 0)),
      evidence: 'independent-current-profile-not-operation-attributed',
    };
    return finish('ART_MAKE_CURRENCY_RECONCILIATION_UNPROVEN');
  }
  for (const [key, expectedValue] of [['44', initial.profile.gold], ['41', initial.profile.yb]]) {
    const value = at(response.value, ['7', '0', key]);
    if (value.supplied && value.value !== expectedValue) return finish('ART_MAKE_WRITE_PROFILE_CURRENCY_CONFLICT');
  }
  const receipt = { version: 'art-observed-cost/v1', kind: 'observed-versioned-recipe-cost', known: true, complete: true,
    operationId: proposal.operationId, unitRef: art.unitRef, quotaRef: art.costObservation?.quotaRef ?? null,
    gameVersion: art.versionEvidence.gameVersion, protocolVersion: art.versionEvidence.protocolVersion, artId: art.artId, vaseId: art.vaseId,
    flowersIds: [...art.flowersIds], num: 1, recipeFingerprint: art.recipeFingerprint,
    consumptions: expected, produced: { itemId: art.artId, quantity: 1 }, additionalCurrencyCostKnown: true,
    gold: 0, yb: 0, vaseConsumed: false, originalCurrencies: { gold: initial.profile.gold, yb: initial.profile.yb },
    costObservationOnly: contract.costMode === 'validation-single-cost-observation', globalFreeRuleProven: false,
    answer: safeSource(response), postRead: safeSource(observation), bridgeFingerprint: current.proof.bridgeFingerprint,
    positiveCostFlows: context.flows.bo.entries, actBoReported: maps.actBo.supplied, proxyBoReported: maps.proxyBo.supplied,
    noOtherPositiveReportedCost: true, exactVersionRecipeOnly: true };
  const receiptFingerprint = fingerprint(receipt);
  context.costReceipt = { ...receipt, receiptRef: 'art-observed-cost:' + receiptFingerprint, receiptFingerprint };
  return result(proposal, response, 'ART_MAKE_SINGLE_PRODUCT_AND_EXACT_COST_CONFIRMED', { ...context, confirmed: true });
}
// Expose the pure derivation for protocol-level regression tests. Production
// still reaches it only through createArtVerification's leased read port.
export { analyze as deriveArtVerification };
export function validateArtTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try {
    const packet = bridge || postReadBridge, observation = packet?.newLoginObservation;
    if (verification?.verdict !== 'confirmed' || !Array.isArray(postReads) || !postReads.includes(observation) ||
      observation.responseRef !== verification.postReadRef) return false;
    const derived = analyze({ proposal, response, observation, bridge: packet });
    return derived.verdict === 'confirmed' && canonical(derived) === canonical(verification);
  } catch { return false; }
}
export function createArtVerification({ isLeaseCurrent = null } = {}) {
  if (isLeaseCurrent !== null && (typeof isLeaseCurrent !== 'function' || isLeaseCurrent.constructor?.name === 'AsyncFunction')) throw new TypeError('Art lease guard must be synchronous or null');
  const current = input => {
    if (!isLeaseCurrent) return true;
    const value = isLeaseCurrent(input);
    if (value?.then) { value.catch?.(() => {}); throw new TypeError('Art lease guard must be synchronous'); }
    return value === true;
  };
  async function verify({ proposal, response, connection, signal }) {
    assertArtMakeProposal(proposal);
    const unknown = (reasonCode, observation = null) => result(proposal, response, reasonCode, { observation });
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') return unknown('ART_MAKE_READ_LEASE_NOT_AVAILABLE');
    let bridge;
    try { signal?.throwIfAborted(); bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(codeOf(error?.code)); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('ART_MAKE_READ_LEASE_REVOKED', bridge?.newLoginObservation);
    const verified = analyze({ proposal, response, observation: bridge.newLoginObservation, bridge });
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('ART_MAKE_READ_LEASE_REVOKED', bridge.newLoginObservation);
    return verified;
  }
  return Object.freeze({ verify });
}
