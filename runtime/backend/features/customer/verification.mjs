import { canonical, fingerprint, freeze, plainObject } from '../../common.mjs';
import { assertCustomerFinishProposal, customerAfterCloseLoginProof, customerVersionFrameValid } from './rpc-contract.mjs';
import { customerDateMs, decodeOfficialCustomerObservation, knownCustomerCell } from './wire-facts.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';

const VERSION = 'customer-finish-verification/after-close-v1';
const ORDER_FIELDS = ['dialogId', 'artId', 'num', 'pathId', 'cTime'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const codeOf = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'CUSTOMER_POST_READ_FAILED';
export function hasProvenCustomerUnexpectedDebit(evidence) {
  return Array.isArray(evidence?.unexpectedDebits) && evidence.unexpectedDebits.length > 0 &&
    evidence.unexpectedDebits.every(one => Number.isSafeInteger(one.quantity) && one.quantity > 0 &&
      Number.isSafeInteger(one.expectedQuantity) && one.expectedQuantity >= 0 && typeof one.source === 'string' &&
      one.evidence === 'complete-known-official-operation-flow');
}
const sourceKind = source => source?.kind ?? source?.sourceKind ?? source?.source;
const BASIS_METHODS = new Set(NORMAL_SYNC_METHODS);
function safeSource(source) {
  if (!source) return null;
  return { method: BASIS_METHODS.has(source.method) ? source.method : null,
    kind: ['response', 'late', 'push'].includes(sourceKind(source)) ? sourceKind(source) : null,
    connectionEpoch: positive(source.connectionEpoch) ? source.connectionEpoch : null,
    requestSequence: positive(source.requestSequence) ? source.requestSequence : null,
    wireKey: reference(source.wireKey) ? source.wireKey : null, responseRef: reference(source.responseRef) ? source.responseRef : null };
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
  const known = entry.supplied && plainObject(values) && Object.keys(values).length <= 20000
    && Object.entries(values).every(([key, value]) => /^[1-9][0-9]*$/.test(key) && positive(Number(key)) && nonnegative(value));
  return { supplied: entry.supplied, known, values: known ? values : null };
}
const item = (map, id, missingZero = false) => map.known && Object.hasOwn(map.values, String(id)) ? map.values[id] : map.known && missingZero ? 0 : null;
function beforeOrder(proposal) {
  const input = proposal.customer?.beforeOrder;
  if (!plainObject(input) || input.npcId !== proposal.customer.npcId || !positive(input.npcId)) return null;
  const out = { npcId: input.npcId };
  for (const name of ORDER_FIELDS) {
    if (!(['artId', 'num', 'cTime'].includes(name) ? positive(input[name]) : nonnegative(input[name]))
      || name === 'cTime' && customerDateMs(input[name]) !== input[name]) return null;
    out[name] = input[name];
  }
  const content = { npcId: out.npcId, fields: Object.fromEntries(ORDER_FIELDS.map(name => [name,
    { presence: 'present', state: 'known', value: out[name] }])) };
  return out.artId === proposal.customer.artId && out.num === proposal.customer.need
    && fingerprint(content) === proposal.customer.contentFingerprint && fingerprint(content) === proposal.targets[0].targetFingerprint ? out : null;
}
function safeObservedOrder(order) {
  if (!order) return null;
  return { npcId: positive(order.npcId) ? order.npcId : null,
    fields: Object.fromEntries(ORDER_FIELDS.map(name => {
      const cell = order.fields?.[name];
      return [name, { presence: ['missing', 'null', 'present'].includes(cell?.presence) ? cell.presence : 'missing',
        state: knownCustomerCell(cell) ? 'known' : 'unreadable', value: knownCustomerCell(cell) && nonnegative(cell.value) ? cell.value : null }];
    })) };
}
function snapshot({ proposal, response, observation, bridge }) {
  assertCustomerFinishProposal(proposal);
  if (!bridge || observation !== bridge.newLoginObservation) return null;
  const proof = customerAfterCloseLoginProof({ proposal, response, bridge });
  const frame = decodeOfficialCustomerObservation({ context: bridge.newContext, observation });
  const payload = frame?.payload, map = payload?.orderMap;
  if (!frame?.admissible || frame.source.kind !== 'response' || frame.source.method !== 'index.login'
    || !knownCustomerCell(payload.profileUid) || payload.profileUid.value !== proposal.customer.officialUid
    || !knownCustomerCell(payload.uid) || payload.uid.value !== proposal.customer.officialUid
    || map?.presence !== 'present' || map.state !== 'known' || map.sourceProvidedMapComplete !== true
    || !Array.isArray(map.entries) || map.total !== map.entries.length) return null;
  const bag = itemMap(observation.value, ['7', '0', '32']);
  if (!bag.known) return null;
  return { proof, frame, bag, order: map.entries.find(order => order.npcId === proposal.customer.npcId) || null };
}

// Used by the gateway's fixed descriptor, never as an additional read method.
// It requires this new login's actually supplied board and absolute bag; cached
// read-model fields and a missing 109 domain cannot satisfy the contract.
export function validateCustomerSnapshotCoverage({ proposal, response, observation, bridge = null, postReadBridge = null } = {}) {
  try { return snapshot({ proposal, response, observation, bridge: bridge || postReadBridge }) !== null; }
  catch { return false; }
}

function result(proposal, response, reasonCode, { before = null, observed = null, proof = null,
  after = null, costs = null, effect = null, confirmed = false } = {}) {
  const verdict = confirmed ? 'confirmed' : 'unknown', target = proposal.targets[0];
  const postReadRef = reference(observed?.responseRef) ? observed.responseRef : null;
  return freeze({ verdict, verificationVersion: VERSION, reasonCode,
    member: { memberKey: target.memberKey, verdict, reasonCode }, postReadRef, targetEffect: effect,
    evidence: { version: VERSION, reasonCode, operationId: proposal.operationId, targetRef: target.targetRef,
      lifecycleRef: target.lifecycleRef, contentFingerprint: target.targetFingerprint, beforeOrder: before,
      answer: safeSource(response), responseRejected: response?.rejected === true, postRead: safeSource(observed),
      afterOrder: after, targetEffect: effect, items: costs,
      unexpectedDebits: Array.isArray(costs?.unexpectedDebits) ? costs.unexpectedDebits : [],
      bridge: proof ? { leaseRef: proof.leaseRef, bridgeFingerprint: proof.bridgeFingerprint,
        closureEvidenceRef: proof.oldPhysicalCloseReceipt.closureEvidenceRef,
        originalConnectionEpoch: proof.originalContext.connectionEpoch, newConnectionEpoch: proof.newContext.connectionEpoch,
        writeResponseRef: proof.after.responseRef, newLoginResponseRef: proof.newLogin.responseRef } : null },
    resourceResolutions: proposal.resources.map(resource => ({ resourceKey: resource.resourceKey, state: 'historical_footprint',
      basisRefs: postReadRef ? [postReadRef] : [], coverageRef: null })) });
}
export function deriveCustomerVerification({ proposal, response, observation, bridge }) {
  const before = beforeOrder(proposal), context = { before, observed: observation };
  const finish = (reasonCode, details = {}) => result(proposal, response, reasonCode, { ...context, ...details });
  if (!before) return finish('CUSTOMER_FINISH_ORIGINAL_ORDER_UNPROVEN');
  let state;
  try { state = snapshot({ proposal, response, observation, bridge }); } catch { /* A malformed bridge proves no result. */ }
  if (!state) return finish('CUSTOMER_FINISH_NEW_LOGIN_COVERAGE_MISSING');
  context.proof = state.proof;
  context.after = safeObservedOrder(state.order);
  const source = proposal.customer.beforeStock?.source, stock = proposal.customer.beforeStock;
  if (!plainObject(stock) || stock.itemId !== before.artId || !nonnegative(stock.quantity) || stock.quantity < before.num
    || stock.basisRef !== proposal.resources[0].basisRef || sourceKind(source) !== 'response' || !BASIS_METHODS.has(source?.method)
    || source.connectionEpoch !== proposal.connectionEpoch || !positive(source.requestSequence) || source.requestSequence >= response.requestSequence
    || !reference(source.wireKey) || !reference(source.responseRef) || !positive(proposal.customer.rewardQuantity)) {
    return finish('CUSTOMER_FINISH_ORIGINAL_STOCK_OR_REWARD_UNPROVEN');
  }
  const anchor = proposal.customer.versionEvidence, version = response?.versionEvidence;
  const originalContext = Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
    .map(key => [key, proposal[key]]));
  if (response?.source !== 'response' || response.transport !== 'answered' || response.method !== 'orderCustomer.finishOrder'
    || response.connectionEpoch !== proposal.connectionEpoch || !positive(response.requestSequence) || !reference(response.wireKey)
    || !reference(response.responseRef) || response.envelopeOk !== true || response.dsName !== 'G.ISyncData'
    || response.rejected === true || response.messagePresent === true && response.noticeOnly !== true
    || version?.gameVersion !== anchor.gameVersion
    || version?.loginResponseRef !== anchor.loginResponseRef
    || !customerVersionFrameValid(response, anchor, originalContext, proposal.customer.officialUid)) return finish('CUSTOMER_FINISH_MATCHED_ANSWER_UNPROVEN');
  for (const path of [['7', '0', '0'], ['109', '0', '0']]) {
    const uid = at(response.value, path);
    if (uid.supplied && uid.value !== proposal.customer.officialUid) return finish('CUSTOMER_FINISH_ANSWER_UID_CONFLICT');
  }
  const bo = itemMap(response.value, ['7', '2', '1']), bi = itemMap(response.value, ['7', '2', '0']);
  const bd = itemMap(response.value, ['7', '2', '2']);
  const extraCost = ['4', '6'].map(key => itemMap(response.value, ['7', '2', key]));
  const extraGain = ['3', '5'].map(key => itemMap(response.value, ['7', '2', key]));
  const spent = item(bo, before.artId), reward = item(bi, 1002), expectedAfter = stock.quantity - before.num;
  const loginArt = item(state.bag, before.artId, true), loginReward = item(state.bag, 1002, true);
  const writeArt = item(bd, before.artId), writeReward = item(bd, 1002);
  context.costs = { artId: before.artId, need: before.num, beforeAbsolute: stock.quantity, beforeBasisRef: stock.basisRef,
    beforeSource: safeSource(source), bo: spent, bd: writeArt, loginBag: loginArt, expectedAfter,
    rewardItemId: 1002, expectedReward: proposal.customer.rewardQuantity, bi1002: reward, bd1002: writeReward, loginBag1002: loginReward };
  if (!bo.known || !bi.known || bd.supplied && !bd.known || extraCost.some(map => map.supplied && !map.known)
    || extraGain.some(map => map.supplied && !map.known)) return finish('CUSTOMER_FINISH_ITEM_FLOWS_UNREADABLE');
  const unexpectedDebits = [];
  for (const [id, quantity] of Object.entries(bo.values)) if (quantity > 0 &&
    (Number(id) !== before.artId || quantity > before.num)) unexpectedDebits.push({ source: 'bo', itemId: Number(id), quantity,
      expectedQuantity: Number(id) === before.artId ? before.num : 0, evidence: 'complete-known-official-operation-flow' });
  for (const [index, map] of extraCost.entries()) if (map.known) for (const [id, quantity] of Object.entries(map.values)) if (quantity > 0)
    unexpectedDebits.push({ source: index === 0 ? 'actBo' : 'proxyBo', itemId: Number(id), quantity, expectedQuantity: 0,
      evidence: 'complete-known-official-operation-flow' });
  if (unexpectedDebits.length) { context.costs.unexpectedDebits = unexpectedDebits; return finish('CUSTOMER_FINISH_UNEXPECTED_COST'); }
  if (spent !== before.num) return finish('CUSTOMER_FINISH_ART_CONSUMPTION_UNPROVEN');
  if (reward !== proposal.customer.rewardQuantity || extraGain.some(map => item(map, 1002, true) > 0)
    || item(bi, before.artId, true) > 0 || extraGain.some(map => item(map, before.artId, true) > 0)) return finish('CUSTOMER_FINISH_REWARD_OR_ART_GAIN_AMBIGUOUS');
  if (loginArt !== expectedAfter || writeArt !== null && writeArt !== expectedAfter
    || !nonnegative(loginReward) || loginReward < proposal.customer.rewardQuantity || writeReward !== null && writeReward !== loginReward) {
    return finish('CUSTOMER_FINISH_ABSOLUTE_ITEMS_CONFLICT');
  }
  if (state.order && (!state.order.readable || !ORDER_FIELDS.every(name => knownCustomerCell(state.order.fields[name])))) {
    return finish('CUSTOMER_FINISH_REPLACEMENT_ROW_UNREADABLE');
  }
  const distinguished = state.order && ['cTime', 'artId', 'num'].some(name => state.order.fields[name].value !== before[name]);
  if (state.order && !distinguished) return finish('CUSTOMER_FINISH_SAME_ORDER_OR_LIFECYCLE_AMBIGUOUS');
  return finish('CUSTOMER_FINISH_EXACT_EFFECT_CONFIRMED', { confirmed: true,
    effect: { kind: state.order ? 'distinguished-replacement' : 'absent-in-complete-board', npcId: before.npcId,
      originalLifecycleRef: proposal.customer.lifecycleRef, originalContentFingerprint: proposal.customer.contentFingerprint } });
}

export function validateCustomerTargetVerification({ proposal, response, verification, postReads, bridge = null, postReadBridge = null } = {}) {
  try {
    if (verification?.verdict !== 'confirmed' || !Array.isArray(postReads)) return false;
    const packet = bridge || postReadBridge, observation = packet?.newLoginObservation;
    if (!postReads.includes(observation) || observation.responseRef !== verification.postReadRef) return false;
    const derived = deriveCustomerVerification({ proposal, response, observation, bridge: packet });
    return derived.verdict === 'confirmed' && canonical(derived) === canonical(verification);
  } catch { return false; }
}

export function createCustomerVerification({ isLeaseCurrent = null } = {}) {
  if (isLeaseCurrent !== null && (typeof isLeaseCurrent !== 'function' || isLeaseCurrent.constructor?.name === 'AsyncFunction')) {
    throw new TypeError('Customer lease-current guard must be synchronous or null');
  }
  const current = input => {
    if (!isLeaseCurrent) return true;
    const value = isLeaseCurrent(input);
    if (value?.then) { value.catch?.(() => {}); throw new TypeError('Customer lease-current guard must be synchronous'); }
    return value === true;
  };
  async function verify({ proposal, response, connection, signal }) {
    assertCustomerFinishProposal(proposal);
    const unknown = (reasonCode, details = {}) => result(proposal, response, reasonCode, { before: beforeOrder(proposal), ...details });
    if (signal?.aborted || connection?.isOpen?.() !== true || typeof connection.readSnapshotAfterClose !== 'function') {
      return unknown('CUSTOMER_FINISH_READ_LEASE_NOT_AVAILABLE');
    }
    let bridge;
    try { signal?.throwIfAborted(); bridge = await connection.readSnapshotAfterClose(); }
    catch (error) { return unknown(codeOf(error?.code)); }
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) {
      return unknown('CUSTOMER_FINISH_READ_LEASE_REVOKED', { observed: bridge?.newLoginObservation });
    }
    const verified = deriveCustomerVerification({ proposal, response, observation: bridge.newLoginObservation, bridge });
    if (signal?.aborted || connection.isOpen() !== true || !current({ proposal, response, bridge })) {
      return unknown('CUSTOMER_FINISH_READ_LEASE_REVOKED', { observed: bridge.newLoginObservation });
    }
    return verified;
  }
  return Object.freeze({ verify });
}
