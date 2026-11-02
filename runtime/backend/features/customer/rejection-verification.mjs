import { canonical, freeze, plainObject } from '../../common.mjs';
import { knownCustomerCell, decodeOfficialCustomerObservation } from './wire-facts.mjs';
import { assertCustomerRejectProposal, customerRejectAfterCloseLoginProof } from './rejection-contract.mjs';
import { customerVersionFrameValid } from './rpc-contract.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { CUSTOMER_BATCH_REJECT_VERSION } from './impossibility.mjs';

const VERSION = 'customer-policy-reject-verification/after-close-v1';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const METHODS = new Set(NORMAL_SYNC_METHODS);
const codeOf = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : 'CUSTOMER_REJECT_POST_READ_FAILED';
const kind = source => source?.kind ?? source?.sourceKind ?? source?.source;
const safeSource = source => source ? { kind: ['response', 'late', 'push'].includes(kind(source)) ? kind(source) : null,
  method: METHODS.has(source.method) ? source.method : null, connectionEpoch: positive(source.connectionEpoch) ? source.connectionEpoch : null,
  requestSequence: positive(source.requestSequence) ? source.requestSequence : null, wireKey: reference(source.wireKey) ? source.wireKey : null,
  responseRef: reference(source.responseRef) ? source.responseRef : null } : null;
function at(root, path) {
  let value = root;
  for (const key of path) { if (!plainObject(value) || !Object.hasOwn(value, key)) return { supplied: false, value: null }; value = value[key]; }
  return { supplied: true, value };
}
function itemMap(raw, path) {
  const entry = at(raw, path), map = entry.value;
  const known = entry.supplied && plainObject(map) && Object.keys(map).length <= 20000 &&
    Object.entries(map).every(([key, quantity]) => /^[1-9][0-9]*$/.test(key) && positive(Number(key)) && nonnegative(quantity));
  return { supplied: entry.supplied, known, values: known ? map : null };
}
const item = (map, id, absentZero = false) => map.known && Object.hasOwn(map.values, String(id)) ? map.values[id] : map.known && absentZero ? 0 : null;
function snapshot({ proposal, response, observation, bridge }) {
  assertCustomerRejectProposal(proposal);
  if (!bridge || observation !== bridge.newLoginObservation) return null;
  const proof = customerRejectAfterCloseLoginProof({ proposal, response, bridge });
  const frame = decodeOfficialCustomerObservation({ context: bridge.newContext, observation }), payload = frame?.payload, map = payload?.orderMap;
  const bag = itemMap(observation.value, ['7', '0', '32']), gold = at(observation.value, ['7', '0', '44']), yb = at(observation.value, ['7', '0', '41']);
  if (!frame?.admissible || frame.source.kind !== 'response' || frame.source.method !== 'index.login' ||
    !knownCustomerCell(payload.profileUid) || payload.profileUid.value !== proposal.customer.officialUid ||
    !knownCustomerCell(payload.uid) || payload.uid.value !== proposal.customer.officialUid || map?.presence !== 'present' || map.state !== 'known' ||
    map.sourceProvidedMapComplete !== true || !Array.isArray(map.entries) || map.total !== map.entries.length || !bag.known ||
    !gold.supplied || !nonnegative(gold.value) || !yb.supplied || !nonnegative(yb.value)) return null;
  return { proof, bag, gold: gold.value, yb: yb.value, order: map.entries.find(order => order.npcId === proposal.customer.npcId) || null };
}
export function validateCustomerRejectSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { return snapshot({ proposal, response, observation, bridge: bridge || postReadBridge }) !== null; } catch { return false; }
}
function result(proposal, response, reasonCode, { observation = null, proof = null, afterOrder = null, balances = null, flows = null,
  targetEffect = null, confirmed = false } = {}) {
  const verdict = confirmed ? 'confirmed' : 'unknown', target = proposal.targets[0];
  const version = proposal.customer.rejectCause ? 'customer-physical-reject-verification/after-close-v1' : VERSION;
  return freeze({ verdict, verificationVersion: version, reasonCode, postReadRef: reference(observation?.responseRef) ? observation.responseRef : null,
    member: { memberKey: target.memberKey, verdict, reasonCode }, targetEffect, resourceResolutions: [],
    evidence: { version, operationId: proposal.operationId, reasonCode, targetRef: target.targetRef,
      lifecycleRef: target.lifecycleRef, contentFingerprint: target.targetFingerprint, beforeOrder: cloneOrder(proposal.customer.beforeOrder),
      ...(proposal.customer.rejectCause ? { acceptedDecisionRef: proposal.customer.acceptedDecisionRef, rejectCause: proposal.customer.rejectCause }
        : { filteredDecisionRef: proposal.customer.filteredDecisionRef }), policyFingerprint: proposal.customer.policyFingerprint,
      answer: safeSource(response), postRead: safeSource(observation), afterOrder, balances, flows, targetEffect,
      noDeliveryInferenceFromMissingFlow: true,
      bridge: proof ? { leaseRef: proof.leaseRef, bridgeFingerprint: proof.bridgeFingerprint,
        closureEvidenceRef: proof.oldPhysicalCloseReceipt.closureEvidenceRef, originalConnectionEpoch: proof.originalContext.connectionEpoch,
        newConnectionEpoch: proof.newContext.connectionEpoch, writeResponseRef: proof.after.responseRef,
        newLoginResponseRef: proof.newLogin.responseRef } : null } });
}
function cloneOrder(order) {
  return Object.fromEntries(['npcId', 'dialogId', 'artId', 'num', 'pathId', 'cTime'].map(key => [key, order[key]]));
}
function analyze({ proposal, response, observation, bridge }) {
  assertCustomerRejectProposal(proposal);
  const customer = proposal.customer, anchor = customer.versionEvidence, version = response?.versionEvidence;
  const originalContext = Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .map(key => [key, proposal[key]]));
  const context = { observation }, finish = reasonCode => result(proposal, response, reasonCode, context);
  if (response?.source !== 'response' || response.transport !== 'answered' || response.method !== 'orderCustomer.rejectOrder' ||
    response.connectionEpoch !== proposal.connectionEpoch || !positive(response.requestSequence) || !reference(response.wireKey) || !reference(response.responseRef) ||
    response.envelopeOk !== true || response.dsName !== 'G.ISyncData' || response.rejected === true ||
    response.messagePresent === true && response.noticeOnly !== true || version?.gameVersion !== anchor.gameVersion ||
    version?.loginResponseRef !== anchor.loginResponseRef ||
    !customerVersionFrameValid(response, anchor, originalContext, customer.officialUid)) return finish('CUSTOMER_REJECT_MATCHED_ANSWER_UNPROVEN');
  const sourceBefore = source => kind(source) === 'response' && METHODS.has(source?.method) && source.connectionEpoch === proposal.connectionEpoch &&
    positive(source.requestSequence) && source.requestSequence < response.requestSequence && reference(source.wireKey) && reference(source.responseRef);
  if (!customer.beforeItems.every(one => sourceBefore(one.source)) ||
      !sourceBefore(customer.beforeProfile.goldSource) || !sourceBefore(customer.beforeProfile.ybSource)) return finish('CUSTOMER_REJECT_ORIGINAL_BALANCE_SOURCE_UNPROVEN');
  if (customer.rejectCause) {
    const sources = customer.rejectCause.evidence.sources;
    const proofs = customer.rejectCause.version === CUSTOMER_BATCH_REJECT_VERSION
      ? [sources.product?.source, ...sources.materials.map(one => one.source)]
      : [sources.product?.source, sources.vase?.source, sources.vase?.domainSource, ...sources.materials.map(one => one.source)];
    if (!proofs.every(sourceBefore)) return finish('CUSTOMER_PHYSICAL_REJECT_CAUSE_NOT_BEFORE_WRITE');
  }
  let state;
  try { state = snapshot({ proposal, response, observation, bridge }); } catch { /* Missing or invalid independent evidence proves no result. */ }
  if (!state) return finish('CUSTOMER_REJECT_NEW_LOGIN_COVERAGE_MISSING');
  context.proof = state.proof;
  for (const path of [['7', '0', '0'], ['109', '0', '0']]) {
    const uid = at(response.value, path);
    if (uid.supplied && uid.value !== customer.officialUid) return finish('CUSTOMER_REJECT_ANSWER_UID_CONFLICT');
  }
  const maps = Object.fromEntries(Object.entries({ bi: '0', bo: '1', bd: '2', actBi: '3', actBo: '4', proxyBi: '5', proxyBo: '6' })
    .map(([name, key]) => [name, itemMap(response.value, ['7', '2', key])]));
  context.flows = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, { supplied: map.supplied, readable: map.known,
    positiveEntries: map.known ? Object.entries(map.values).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({ itemId: Number(id), quantity }))
      .sort((a, b) => a.itemId - b.itemId) : null }]));
  if (Object.values(maps).some(map => map.supplied && !map.known)) return finish('CUSTOMER_REJECT_REPORTED_ITEM_FLOWS_UNREADABLE');
  if ([maps.bo, maps.actBo, maps.proxyBo].some(map => map.known && Object.values(map.values).some(quantity => quantity > 0))) return finish('CUSTOMER_REJECT_UNEXPECTED_CONSUMPTION');
  if ([maps.bi, maps.actBi, maps.proxyBi].some(map => map.known && [customer.artId, 1002, 11, 6].some(id => item(map, id, true) > 0))) return finish('CUSTOMER_REJECT_DELIVERY_OR_CURRENCY_GAIN_OBSERVED');
  const balances = customer.beforeItems.map(one => ({ itemId: one.itemId, before: one.quantity, after: item(state.bag, one.itemId, true),
    writeAbsolute: item(maps.bd, one.itemId), beforeBasisRef: one.basisRef, beforeSource: safeSource(one.source) }));
  context.balances = { items: balances, currencies: { beforeGold: customer.beforeProfile.gold, afterGold: state.gold,
    beforeYb: customer.beforeProfile.yb, afterYb: state.yb,
    beforeGoldSource: safeSource(customer.beforeProfile.goldSource),
    beforeYbSource: safeSource(customer.beforeProfile.ybSource) } };
  if (balances.some(one => one.before !== one.after || one.writeAbsolute !== null && one.writeAbsolute !== one.before) ||
    state.gold !== customer.beforeProfile.gold || state.yb !== customer.beforeProfile.yb) return finish('CUSTOMER_REJECT_NO_DELIVERY_ABSOLUTE_EFFECT_UNPROVEN');
  for (const [key, expected] of [['44', customer.beforeProfile.gold], ['41', customer.beforeProfile.yb]]) {
    const value = at(response.value, ['7', '0', key]);
    if (value.supplied && value.value !== expected) return finish('CUSTOMER_REJECT_WRITE_PROFILE_CONFLICT');
  }
  if (state.order) {
    context.afterOrder = { npcId: state.order.npcId, fields: Object.fromEntries(Object.entries(state.order.fields).map(([key, cell]) =>
      [key, { presence: cell.presence, state: cell.state, value: knownCustomerCell(cell) ? cell.value : null }])) };
    if (!state.order.readable || !Object.values(state.order.fields).every(knownCustomerCell)) return finish('CUSTOMER_REJECT_REPLACEMENT_ROW_UNREADABLE');
    if (!['cTime', 'artId', 'num'].some(key => state.order.fields[key].value !== customer.beforeOrder[key])) return finish('CUSTOMER_REJECT_ORIGINAL_ORDER_OR_LIFECYCLE_AMBIGUOUS');
  }
  return result(proposal, response, customer.rejectCause ? 'CUSTOMER_PHYSICAL_REJECT_EXACT_EFFECT_CONFIRMED' : 'CUSTOMER_POLICY_REJECT_EXACT_EFFECT_CONFIRMED', { ...context, confirmed: true,
    targetEffect: { kind: state.order ? 'distinguished-replacement-without-delivery-effect' : 'absent-in-complete-board-without-delivery-effect',
      npcId: customer.npcId, originalLifecycleRef: customer.lifecycleRef, originalContentFingerprint: customer.contentFingerprint } });
}
export function validateCustomerRejectTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try {
    const packet = bridge || postReadBridge, observation = packet?.newLoginObservation;
    if (verification?.verdict !== 'confirmed' || !Array.isArray(postReads) || !postReads.includes(observation) || observation.responseRef !== verification.postReadRef) return false;
    const derived = analyze({ proposal, response, observation, bridge: packet });
    return derived.verdict === 'confirmed' && canonical(derived) === canonical(verification);
  } catch { return false; }
}
export function createCustomerRejectVerification({ isLeaseCurrent = null } = {}) {
  if (isLeaseCurrent !== null && (typeof isLeaseCurrent !== 'function' || isLeaseCurrent.constructor?.name === 'AsyncFunction')) throw new TypeError('Reject lease guard must be synchronous or null');
  const current = input => {
    if (!isLeaseCurrent) return true;
    const value = isLeaseCurrent(input);
    if (value?.then) { value.catch?.(() => {}); throw new TypeError('Reject lease guard must be synchronous'); }
    return value === true;
  };
  async function verify({ proposal, response, connection, signal }) {
    assertCustomerRejectProposal(proposal);
    const unknown = (reasonCode, observation = null) => result(proposal, response, reasonCode, { observation });
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') return unknown('CUSTOMER_REJECT_READ_LEASE_NOT_AVAILABLE');
    let bridge;
    try { signal?.throwIfAborted(); bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(codeOf(error?.code)); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('CUSTOMER_REJECT_READ_LEASE_REVOKED', bridge?.newLoginObservation);
    const verified = analyze({ proposal, response, observation: bridge.newLoginObservation, bridge });
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) return unknown('CUSTOMER_REJECT_READ_LEASE_REVOKED', bridge.newLoginObservation);
    return verified;
  }
  return Object.freeze({ verify });
}
