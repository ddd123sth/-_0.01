import { randomInt } from 'node:crypto';
import { measureSyncCost } from './sync-costs.mjs';
import { clone, fingerprint, freeze, gatewayVerificationEvidencePayload, newId, parseStored, plainObject, problem } from '../common.mjs';
import { ledgerJsonFingerprint } from '../persistence/json-contract.mjs';
import { CONFIG_FIELDS, atPath } from '../config/fields.mjs';
import { CUSTOMER_FINISH_CONTRACT, captureCustomerFinishArgs, assertCustomerFinishProposal, customerAfterCloseLoginProof } from '../features/customer/rpc-contract.mjs';
import { ART_MAKE_CONTRACT, captureArtMakeArgs, assertArtMakeProposal, artAfterCloseLoginProof } from '../features/art/rpc-contract.mjs';
import { CUSTOMER_REJECT_CONTRACT, captureCustomerRejectArgs, assertCustomerRejectProposal, customerRejectAfterCloseLoginProof } from '../features/customer/rejection-contract.mjs';
import { CUSTOMER_GENERATION_CONTRACT, captureCustomerGenerationArgs, assertCustomerGenerationProposal, customerGenerationAfterCloseLoginProof } from '../features/customer/generation-contract.mjs';
import { ORDER_FLOWER_CONTRACTS, captureOrderFlowerArgs, assertOrderFlowerProposal, assertOrderFlowerImmutableEvidence,
  orderFlowerAfterCloseLoginProof } from '../features/order-flower/rpc-contract.mjs';
import { ORDER_FLOWER_VIDEO_CONTRACTS, captureOrderFlowerVideoArgs, assertOrderFlowerVideoProposal, assertOrderFlowerVideoPreparedOperation,
  orderFlowerVideoAfterCloseLoginProof } from '../features/order-flower/video-contract.mjs';
import { ORDER_FLOWER_REWARD_CONTRACTS, captureOrderFlowerStageRewardArgs, captureOrderFlowerAchievementArgs,
  assertOrderFlowerRewardProposal, assertOrderFlowerRewardPreparedOperation, orderFlowerRewardAfterCloseLoginProof } from '../features/order-flower/reward-contract.mjs';
import { ORDER_FLOWER_ENTER_CONTRACTS, captureOrderFlowerEnterArgs, assertOrderFlowerEnterProposal,
  assertOrderFlowerEnterPreparedOperation, orderFlowerEnterAfterCloseLoginProof } from '../features/order-flower/enter-contract.mjs';
import { LAND_ACCELERATION_METHODS, LAND_ACCELERATION_SCOPES, captureLandAccelerationArgs,
  assertLandAccelerationProposal } from '../features/land/acceleration-contract.mjs';
import { WATERWHEEL_DEFINITIONS, captureWaterwheelArgs, assertWaterwheelProposal,
  waterwheelResponseCoverage, waterwheelTargetVerification, waterwheelAfterCloseLoginProof, WATERWHEEL_POST_READ } from '../features/waterwheel/rpc-contract.mjs';
import { FREE_WATER_DEFINITIONS, captureFreeWaterArgs, assertFreeWaterProposal, freeWaterTargetVerification,
  freeWaterAfterCloseLoginProof, FREE_WATER_POST_READ } from '../features/free-water/rpc-contract.mjs';
import { FLOWER_RACK_DEFINITIONS, captureFlowerRackArgs, assertFlowerRackProposal, flowerRackTargetVerification,
  flowerRackResponseCoverage, flowerRackAfterCloseLoginProof } from '../features/flower-rack/rpc-contract.mjs';
import { DAILY_ART_CONTRACT, DAILY_ART_POST_READ, assertDailyArtProposal, dailyArtResponseCoverage,
  captureDailyArtMakeArgs, dailyArtAfterCloseLoginProof, dailyArtTargetVerification } from '../features/art/daily-rpc-contract.mjs';
import { CUSTOMER_ART_BATCH_CONTRACT, CUSTOMER_ART_BATCH_POST_READ, assertCustomerArtBatchProposal,
  captureCustomerArtBatchArgs, customerArtBatchAfterCloseLoginProof, customerArtBatchTargetVerification } from '../features/art/customer-batch-contract.mjs';
import { ART_FIRST_ALBUM_CONTRACT, ART_FIRST_ALBUM_POST_READ, assertArtFirstAlbumProposal, captureArtFirstAlbumArgs,
  artFirstAlbumAfterCloseLoginProof, artFirstAlbumTargetVerification, ART_FIRST_SHARE_CONTRACT, ART_FIRST_SHARE_POST_READ,
  assertArtFirstShareProposal, captureArtFirstShareArgs, artFirstShareAfterCloseLoginProof, artFirstShareTargetVerification }
  from '../features/art/first-reward-contract.mjs';
import { affectedDomainsForWrite, dynamicTokenMatches } from '../facts/dynamic-state.mjs';
import { REWARD_CARDS } from '../features/rewards/catalog.mjs';
import { captureClaimArgs, assertClaimProposal, claimContract, rewardAfterCloseLoginProof,
  rewardTargetVerification } from '../features/rewards/rpc-contract.mjs';
import { timedSyncPhase } from '../../performance-diagnostics.mjs';
import { SPECIAL_ORDER_DEFINITIONS, SPECIAL_ORDER_POST_READ, captureSpecialOrderArgs, assertSpecialOrderProposal,
  specialOrderAfterCloseLoginProof, specialOrderTargetVerification } from '../features/special-orders/rpc-contract.mjs';
const ordinaryFlowerDomain = kind => Object.freeze({ definition: ORDER_FLOWER_CONTRACTS[kind],
  capture: params => captureOrderFlowerArgs(kind, params), assert: assertOrderFlowerProposal, proof: orderFlowerAfterCloseLoginProof,
  preparation: 'orderFlower', contractKeys: Object.freeze([...Object.keys(ORDER_FLOWER_CONTRACTS[kind]), 'postRead', 'validateTargetVerification']) });
const auxiliaryDomains = [
  ...Object.entries(ORDER_FLOWER_VIDEO_CONTRACTS).map(([kind, definition]) => ['order-flower-video-' + kind, {
    definition, capture: captureOrderFlowerVideoArgs, assert: assertOrderFlowerVideoProposal, assertPrepared: assertOrderFlowerVideoPreparedOperation,
    proof: orderFlowerVideoAfterCloseLoginProof, preparation: 'orderFlowerVideo', family: 'video' }]),
  ...Object.entries(ORDER_FLOWER_REWARD_CONTRACTS).map(([kind, definition]) => ['order-flower-reward-' + kind, {
    definition, capture: kind === 'stage' ? captureOrderFlowerStageRewardArgs : captureOrderFlowerAchievementArgs,
    assert: assertOrderFlowerRewardProposal, assertPrepared: assertOrderFlowerRewardPreparedOperation,
    proof: orderFlowerRewardAfterCloseLoginProof, preparation: 'orderFlowerReward', family: 'reward' }]),
  ...Object.entries(ORDER_FLOWER_ENTER_CONTRACTS).map(([kind, definition]) => ['order-flower-enter-' + kind, {
    definition, capture: captureOrderFlowerEnterArgs, assert: assertOrderFlowerEnterProposal, assertPrepared: assertOrderFlowerEnterPreparedOperation,
    proof: orderFlowerEnterAfterCloseLoginProof, preparation: 'orderFlowerEnter', family: 'enter' }]),
].map(([key, domain]) => [key, Object.freeze(domain)]);
const REWARD_FINITE = Object.freeze(Object.fromEntries(REWARD_CARDS.flatMap(card => card.methods.map(method => {
  const scope = card.methodScopes[method];
  const action = card.units.find(unit => unit.scheduleKey === scope)?.action || card.units[0].action;
  return ['reward:' + card.featureId + ':' + scope, Object.freeze({ definition: claimContract(card.featureId, scope, method, action),
    capture: params => ({ params: captureClaimArgs({ method, params }) }), assert: assertClaimProposal, proof: rewardAfterCloseLoginProof,
    preparation: 'reward', validateTargetVerification: rewardTargetVerification })];
}))));
const FINITE_DOMAINS = Object.freeze({
  ...Object.fromEntries(Object.values(SPECIAL_ORDER_DEFINITIONS).map(definition => [definition.scope, Object.freeze({ definition,
    capture: params => captureSpecialOrderArgs({ method: definition.method, params }), assert: assertSpecialOrderProposal,
    proof: specialOrderAfterCloseLoginProof, preparation: 'specialOrder', postRead: SPECIAL_ORDER_POST_READ,
    validateTargetVerification: specialOrderTargetVerification })])),
  customer: Object.freeze({ definition: CUSTOMER_FINISH_CONTRACT, capture: captureCustomerFinishArgs, assert: assertCustomerFinishProposal, proof: customerAfterCloseLoginProof, preparation: 'customer' }),
  'customer-reject': Object.freeze({ definition: CUSTOMER_REJECT_CONTRACT, capture: captureCustomerRejectArgs, assert: assertCustomerRejectProposal, proof: customerRejectAfterCloseLoginProof, preparation: 'customer' }),
  'customer-generation': Object.freeze({ definition: CUSTOMER_GENERATION_CONTRACT, capture: captureCustomerGenerationArgs, assert: assertCustomerGenerationProposal, proof: customerGenerationAfterCloseLoginProof, preparation: 'generation' }),
  art: Object.freeze({ definition: ART_MAKE_CONTRACT, capture: captureArtMakeArgs, assert: assertArtMakeProposal, proof: artAfterCloseLoginProof, preparation: 'art' }),
  'art-daily': Object.freeze({ definition: DAILY_ART_CONTRACT, capture: captureDailyArtMakeArgs, assert: assertDailyArtProposal,
    proof: dailyArtAfterCloseLoginProof, preparation: 'dailyArt', validateTargetVerification: dailyArtTargetVerification }),
  'art-customer-batch': Object.freeze({ definition: CUSTOMER_ART_BATCH_CONTRACT, capture: captureCustomerArtBatchArgs,
    assert: assertCustomerArtBatchProposal, proof: customerArtBatchAfterCloseLoginProof, preparation: 'customerArtBatch',
    validateTargetVerification: customerArtBatchTargetVerification }),
  'art-first-album': Object.freeze({ definition: ART_FIRST_ALBUM_CONTRACT, capture: captureArtFirstAlbumArgs,
    assert: assertArtFirstAlbumProposal, proof: artFirstAlbumAfterCloseLoginProof, preparation: 'artFirstReward',
    postRead: ART_FIRST_ALBUM_POST_READ, validateTargetVerification: artFirstAlbumTargetVerification }),
  'art-first-share': Object.freeze({ definition: ART_FIRST_SHARE_CONTRACT, capture: captureArtFirstShareArgs,
    assert: assertArtFirstShareProposal, proof: artFirstShareAfterCloseLoginProof, preparation: 'artFirstReward',
    postRead: ART_FIRST_SHARE_POST_READ, validateTargetVerification: artFirstShareTargetVerification }),
  'order-flower-resident': ordinaryFlowerDomain('resident'),
  'order-flower-satin': ordinaryFlowerDomain('satin'),
  'order-flower-decorate': ordinaryFlowerDomain('decorate'),
  'waterwheel-recv': Object.freeze({ definition: WATERWHEEL_DEFINITIONS.recv,
    capture: params => captureWaterwheelArgs({ method: WATERWHEEL_DEFINITIONS.recv.method, params }), assert: assertWaterwheelProposal,
    proof: waterwheelAfterCloseLoginProof, preparation: 'waterwheel', validateTargetVerification: waterwheelTargetVerification }),
  'waterwheel-skip': Object.freeze({ definition: WATERWHEEL_DEFINITIONS.skip,
    capture: params => captureWaterwheelArgs({ method: WATERWHEEL_DEFINITIONS.skip.method, params }), assert: assertWaterwheelProposal,
    proof: waterwheelAfterCloseLoginProof, preparation: 'waterwheel', validateTargetVerification: waterwheelTargetVerification }),
  'waterwheel-ad-bucket': Object.freeze({ definition: WATERWHEEL_DEFINITIONS.share,
    capture: params => captureWaterwheelArgs({ method: WATERWHEEL_DEFINITIONS.share.method, params }), assert: assertWaterwheelProposal,
    proof: waterwheelAfterCloseLoginProof, preparation: 'waterwheel', family: 'waterwheel',
    validateTargetVerification: waterwheelTargetVerification }),
  'free-water-recv': Object.freeze({ definition: FREE_WATER_DEFINITIONS.receive,
    capture: params => captureFreeWaterArgs({ method: FREE_WATER_DEFINITIONS.receive.method, params }), assert: assertFreeWaterProposal,
    proof: freeWaterAfterCloseLoginProof, preparation: 'freeWater', validateTargetVerification: freeWaterTargetVerification }),
  'free-water-fallback': Object.freeze({ definition: FREE_WATER_DEFINITIONS.share,
    capture: params => captureFreeWaterArgs({ method: FREE_WATER_DEFINITIONS.share.method, params }), assert: assertFreeWaterProposal,
    proof: freeWaterAfterCloseLoginProof, preparation: 'freeWater', validateTargetVerification: freeWaterTargetVerification }),
  'rack-unlock': Object.freeze({ definition: FLOWER_RACK_DEFINITIONS.unlock, capture: params => captureFlowerRackArgs({ method: FLOWER_RACK_DEFINITIONS.unlock.method, params }),
    assert: assertFlowerRackProposal, proof: flowerRackAfterCloseLoginProof, preparation: 'flowerRack', validateTargetVerification: flowerRackTargetVerification }),
  'rack-sell': Object.freeze({ definition: FLOWER_RACK_DEFINITIONS.sell, capture: params => captureFlowerRackArgs({ method: FLOWER_RACK_DEFINITIONS.sell.method, params }),
    assert: assertFlowerRackProposal, proof: flowerRackAfterCloseLoginProof, preparation: 'flowerRack', validateTargetVerification: flowerRackTargetVerification }),
  'rack-recv': Object.freeze({ definition: FLOWER_RACK_DEFINITIONS.receive, capture: params => captureFlowerRackArgs({ method: FLOWER_RACK_DEFINITIONS.receive.method, params }),
    assert: assertFlowerRackProposal, proof: flowerRackAfterCloseLoginProof, preparation: 'flowerRack', validateTargetVerification: flowerRackTargetVerification }),
  'rack-cancel': Object.freeze({ definition: FLOWER_RACK_DEFINITIONS.cancel, capture: params => captureFlowerRackArgs({ method: FLOWER_RACK_DEFINITIONS.cancel.method, params }),
    assert: assertFlowerRackProposal, proof: flowerRackAfterCloseLoginProof, preparation: 'flowerRack', validateTargetVerification: flowerRackTargetVerification }),
  ...Object.fromEntries(auxiliaryDomains),
  ...REWARD_FINITE,
});

const SINGLE_METHODS = Object.freeze({ plant: 'usrLand.plant', water: 'usrLand.water', harvest: 'usrLand.harvest' });
const ACCELERATION_RESPONSE_COVERAGE = ({ observation }) => observation?.method === 'usrLand.refresh' && observation.transport === 'answered' &&
  observation.source === 'response' && observation.envelopeOk === true && observation.dsName === 'G.ISyncData' && observation.rejected !== true;
const ACCELERATION_TARGET_VERIFICATION = ({ proposal, verification }) =>
  verification?.verificationVersion === 'land-acceleration/independent-postread/v1' && verification.evidence?.targetRef === proposal.targets?.[0]?.targetRef;
const PREPARATION_FIELD = Object.freeze({ 'land-acceleration': 'acceleration', 'free-water-recv': 'freeWater', 'free-water-fallback': 'freeWater',
  'art-daily': 'dailyArt', 'art-customer-batch': 'customerArtBatch', 'art-first-album': 'artFirstReward', 'art-first-share': 'artFirstReward',
  'rack-unlock': 'flowerRack', 'rack-sell': 'flowerRack', 'rack-recv': 'flowerRack', 'rack-cancel': 'flowerRack' });
const CONTEXT_KEYS = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const sameContext = (left, right) => Boolean(left && right && CONTEXT_KEYS.every(key => left[key] === right[key]));
const contextOf = value => Object.freeze(Object.fromEntries(CONTEXT_KEYS.map(key => [key, value[key]])));
const contextKey = value => JSON.stringify(CONTEXT_KEYS.map(key => value[key]));
const SUPERSEDED_BEFORE_SEND = new Set(['WRITE_FACTS_SUPERSEDED', 'WRITE_CONFIG_SUPERSEDED']);
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'WRITE_EXECUTION_FAILED';
const contractText = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const exactKeys = (value, keys) => plainObject(value) && fingerprint(Object.keys(value).sort()) === fingerprint([...keys].sort());
const valueAt = (root, dottedPath) => dottedPath.split('.').reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : null, root);
function currentNeedEntries(root, prefix = '', depth = 0, output = []) {
  if (!plainObject(root) || depth > 8) return output;
  for (const [key, value] of Object.entries(root)) {
    const path = prefix ? prefix + '.' + key : key;
    // operationDescriptor carries the immutable declaration that authorizes
    // the proposal.currentNeed field; it is contract metadata, not a second
    // business-need credential supplied by the proposal.
    if (depth === 0 && key === 'operationDescriptor') continue;
    if (key === 'currentNeed' && value !== null) output.push({ path, value });
    else if (plainObject(value)) currentNeedEntries(value, path, depth + 1, output);
  }
  return output;
}
export function validateDeclaredCurrentNeed({ proposal, declaration }) {
  const declared = declaration ? valueAt(proposal, declaration.path) : null;
  const present = currentNeedEntries(proposal);
  if (present.length > 1 || present.some(one => one.path !== declaration?.path) || present.length && !declaration) {
    throw problem('WRITE_CURRENT_NEED_CONTRACT_CONFLICT', '提案中的当前需求来源与已登记的操作合同不一致', 409,
      { expectedPath: declaration?.path ?? null, actualPaths: present.map(one => one.path) });
  }
  if (declaration?.required && declared === null) throw problem('WRITE_CURRENT_NEED_REQUIRED', '操作合同要求当前业务需求，但提案没有提供可核验的需求凭据');
  if (present.length && (declared === null || typeof declared !== 'object')) {
    throw problem('WRITE_CURRENT_NEED_CONTRACT_INVALID', '当前需求字段与合同声明不一致');
  }
  return present.length ? declared : null;
}
const syncFunction = value => typeof value === 'function' && value.constructor?.name !== 'AsyncFunction';
const SEND_PACING_MIN_MS = 1400, SEND_PACING_MAX_MS = 2600;
function synchronously(fn, value) {
  const result = fn(value);
  if (result && typeof result.then === 'function') {
    result.catch?.(() => {});
    throw problem('ASYNC_SEND_FENCE_FORBIDDEN', '最终发送与持久结算钩必须同步完成', 500);
  }
  return result;
}

// Features receive only proposal/read ports. The root owns this gateway and
// injects synchronous domain persistence hooks and an exact recovery notifier.
export function createWriteGateway({ store, ledger, registry, supervisor, readConfiguration, authorize,
  readFactBasis, evaluateAdmission = null, resolveAdmission = null, resolveAdmissionBoundary = null, beforeSend = async () => {}, onSettled = () => {}, onNotSent = () => {},
  onCurrentVerified = () => {}, onTransportUncertain = () => {}, postReadLease = null,
  canBeginWrite = null, readExternalHold = null, assertSourceReady = () => {}, dynamicState = null, authorizeFaultRecovery = null }) {
  for (const callback of [authorize, readFactBasis, onSettled, onNotSent, onCurrentVerified, onTransportUncertain, assertSourceReady]) {
    if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') throw new TypeError('Gateway fences and settlement hooks must be synchronous');
  }
  for (const callback of [evaluateAdmission, resolveAdmission, resolveAdmissionBoundary]) if (callback !== null &&
      (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction')) throw new TypeError('Gateway admission resolvers must be synchronous');
  if (!evaluateAdmission && !resolveAdmission) throw new TypeError('Gateway requires an authoritative admission port');
  for (const port of [canBeginWrite, readExternalHold]) if (port !== null &&
      (typeof port !== 'function' || port.constructor?.name === 'AsyncFunction')) throw new TypeError('Gateway admission ports must be synchronous');
  if (!dynamicState || typeof dynamicState.snapshot !== 'function' || typeof dynamicState.beforeDispatch !== 'function') {
    throw new TypeError('Gateway requires the shared dynamic-state send fence');
  }
  // Scoped exactly like the scheduler hold: only the subjects whose own drain
  // is unresolved are fenced, so another account's ordinary fault cannot stop
  // a healthy account's legitimate write.
  const recoveryHolds = { process: false, subjects: new Set() };
  const recoveryHeldFor = subjectRef => recoveryHolds.process || recoveryHolds.subjects.has(subjectRef);
  const assertProcessWriteAdmission = flight => {
    if (!flight?.consumed && recoveryHeldFor(flight?.proposal?.subjectRef))
      throw problem('ENGINE_PROCESS_RECOVERY_HOLD', '该账号上一次发送正在安全收口，暂缓本账号新的官服写入');
  };
  function assertWriteAdmission(context) {
    try {
      if (readExternalHold && readExternalHold(context) === true) throw problem('EXTERNAL_UI_YIELD_PENDING', '外部游戏界面正占用主体，暂缓新的官服写入');
      if (canBeginWrite && canBeginWrite(context) !== true) throw problem('EXTERNAL_UI_YIELD_PENDING', '外部游戏界面正占用主体，暂缓新的官服写入');
    } catch (error) {
      if (error?.code === 'EXTERNAL_UI_YIELD_PENDING') throw error;
      throw problem('EXTERNAL_UI_YIELD_PENDING', '外部游戏界面状态尚未允许新的官服写入');
    }
  }
  if (postReadLease !== null && (typeof postReadLease.readSnapshotAfterClose !== 'function' ||
    !syncFunction(postReadLease.validateReadSnapshotLease) || typeof postReadLease.releaseReadSnapshotLease !== 'function')) {
    throw new TypeError('Post-close reads require finite supervisor read/validation/release ports');
  }
  const { get, run, all, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_send_permits(
    permit_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE REFERENCES backend_operations(operation_id),
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,
    connection_epoch INTEGER NOT NULL,method TEXT NOT NULL,params_fingerprint TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,consumed_at TEXT,wire_key TEXT,created_at TEXT NOT NULL,request_sequence INTEGER);`);
  // The dynamic-fact proof chain reads account_ref from this table. A store created before the column
  // existed used to throw on every post-write read, which poisons proof for the whole process; the row
  // stays nullable so those historical permits are refused by a named axis gap instead of a crash.
  if (!all('PRAGMA table_info(backend_send_permits)').some(column => column.name === 'account_ref')) {
    run('ALTER TABLE backend_send_permits ADD COLUMN account_ref TEXT');
  }
  if (!all('PRAGMA table_info(backend_send_permits)').some(column => column.name === 'request_sequence')) {
    run('ALTER TABLE backend_send_permits ADD COLUMN request_sequence INTEGER');
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_gateway_subject_faults(
    fault_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    operation_id TEXT,reason_code TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS backend_gateway_subject_faults_subject ON backend_gateway_subject_faults(subject_ref);
    CREATE TABLE IF NOT EXISTS backend_gateway_subject_fault_recoveries(
    fault_ref TEXT PRIMARY KEY REFERENCES backend_gateway_subject_faults(fault_ref),
    evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_gateway_subject_faults_no_update BEFORE UPDATE ON backend_gateway_subject_faults
      BEGIN SELECT RAISE(ABORT,'gateway fault history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_gateway_subject_faults_no_delete BEFORE DELETE ON backend_gateway_subject_faults
      BEGIN SELECT RAISE(ABORT,'gateway fault history is retained'); END;
    CREATE TRIGGER IF NOT EXISTS backend_gateway_subject_fault_recoveries_no_update BEFORE UPDATE ON backend_gateway_subject_fault_recoveries
      BEGIN SELECT RAISE(ABORT,'gateway fault recovery is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_gateway_subject_fault_recoveries_no_delete BEFORE DELETE ON backend_gateway_subject_fault_recoveries
      BEGIN SELECT RAISE(ABORT,'gateway fault recovery is retained'); END;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_subject_send_pacing(
    subject_ref TEXT PRIMARY KEY,last_permit_claim_ms INTEGER NOT NULL,next_permit_claim_ms INTEGER NOT NULL,gap_ms INTEGER NOT NULL,
    process_ref TEXT NOT NULL,operation_id TEXT NOT NULL,updated_at TEXT NOT NULL,
    last_socket_dispatch_ms INTEGER NOT NULL DEFAULT 0,next_socket_dispatch_ms INTEGER NOT NULL DEFAULT 0);`);
  const pacingSchema = () => new Set(all('PRAGMA table_info(backend_subject_send_pacing)').map(column => column.name));
  let pacingColumns = pacingSchema();
  for (const [currentName, legacyName, declaration] of [
    ['last_permit_claim_ms', 'last_dispatch_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['next_permit_claim_ms', 'next_dispatch_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ['gap_ms', null, 'INTEGER NOT NULL DEFAULT 1400'],
    ['process_ref', null, "TEXT NOT NULL DEFAULT ''"],
    ['operation_id', null, "TEXT NOT NULL DEFAULT 'legacy-pacing-row'"],
    ['updated_at', null, "TEXT NOT NULL DEFAULT ''"],
    ['last_socket_dispatch_ms', null, 'INTEGER NOT NULL DEFAULT 0'],
    ['next_socket_dispatch_ms', null, 'INTEGER NOT NULL DEFAULT 0']
  ]) {
    if (pacingColumns.has(currentName)) continue;
    if (legacyName && pacingColumns.has(legacyName)) run(`ALTER TABLE backend_subject_send_pacing RENAME COLUMN ${legacyName} TO ${currentName}`);
    else run(`ALTER TABLE backend_subject_send_pacing ADD COLUMN ${currentName} ${declaration}`);
    pacingColumns = pacingSchema();
  }
  const pacingInfo = all('PRAGMA table_info(backend_subject_send_pacing)');
  const expectedPacingColumns = new Set(['subject_ref','last_permit_claim_ms','next_permit_claim_ms','gap_ms','process_ref',
    'operation_id','updated_at','last_socket_dispatch_ms','next_socket_dispatch_ms']);
  const incompatiblePacingColumns = pacingInfo.filter(column => !expectedPacingColumns.has(column.name) &&
    column.notnull === 1 && column.dflt_value === null && column.pk === 0).map(column => column.name);
  if (incompatiblePacingColumns.length) throw problem('SEND_PACING_SCHEMA_INCOMPATIBLE',
    '发送节奏表含有当前写入合同无法安全满足的旧必填列', 503);
  const pacingProcessRef = newId(), pacingMonotonic = new Map(), lastSocketDispatch = new Map();
  const monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000;
  const beginFlightStage = (flight, stage, limitMs) => {
    const stageState = { token: Symbol(stage), stage, startedMono: monotonicNow(), startedAtMs: Date.now(), limitMs };
    flight.activeStage = stageState;
    return stageState;
  };
  const touchFlightStage = flight => {
    if (!flight?.activeStage) return;
    flight.activeStage.startedMono = monotonicNow();
    flight.activeStage.startedAtMs = Date.now();
  };
  async function inFlightStage(flight, stage, limitMs, action) {
    const previous = flight.activeStage, state = beginFlightStage(flight, stage, limitMs);
    try { return await action(); }
    finally { if (flight.activeStage === state) flight.activeStage = previous || null; }
  }
  async function waitForPacing(proposal, signal) {
    const row = get('SELECT * FROM backend_subject_send_pacing WHERE subject_ref=?', proposal.subjectRef);
    if (!row) return;
    const local = pacingMonotonic.get(proposal.subjectRef);
    const remaining = local ? local.nextMono - monotonicNow()
      : row.process_ref === pacingProcessRef ? row.next_socket_dispatch_ms - Date.now() : SEND_PACING_MAX_MS;
    const waitMs = Math.max(0, Math.min(SEND_PACING_MAX_MS, Math.ceil(remaining)));
    if (!waitMs) return;
    if (signal?.aborted) throw signal.reason || problem('RUN_INTENT_REVOKED', '原运行意愿已停止');
    await new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || problem('RUN_INTENT_REVOKED', '原运行意愿已停止')); };
      const timer = setTimeout(finish, waitMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function healthSnapshot() {
    const nowMono = monotonicNow();
    const activeStages = [...flights.values()].filter(flight => flight.activeStage).map(flight => {
      const { proposal, activeStage } = flight;
      return { ownerRef: proposal.ownerRef, accountRef: String(proposal.accountRef), subjectRef: proposal.subjectRef,
        ownerEpoch: proposal.ownerEpoch, runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch,
        featureKey: proposal.featureId, operationId: proposal.operationId, stage: activeStage.stage,
        startedAtMs: activeStage.startedAtMs, ageMs: Math.max(0, Math.floor(nowMono - activeStage.startedMono)),
        stageLimitMs: activeStage.limitMs, deadlineAtMs: activeStage.startedAtMs + activeStage.limitMs,
        overdue: nowMono - activeStage.startedMono >= activeStage.limitMs };
    });
    const activeFlights = [...flights.values()].map(flight => ({ ownerRef: flight.proposal.ownerRef,
      accountRef: String(flight.proposal.accountRef), subjectRef: flight.proposal.subjectRef,
      ownerEpoch: flight.proposal.ownerEpoch, runEpoch: flight.proposal.runEpoch,
      connectionEpoch: flight.proposal.connectionEpoch, operationId: flight.operationId,
      consumed: flight.consumed === true, stage: flight.activeStage?.stage || null }));
    return { activeStages, activeFlights, activeFlightCount: activeFlights.length, processRecoveryHold: recoveryHolds.process,
      recoveryHeldSubjects: [...recoveryHolds.subjects].sort(),
      stalled: activeStages.some(stage => stage.overdue), sampledAtMs: Date.now() };
  }
  const unresolvedFaults = subjectRef => all(`SELECT f.* FROM backend_gateway_subject_faults f
    LEFT JOIN backend_gateway_subject_fault_recoveries r ON r.fault_ref=f.fault_ref
    WHERE f.subject_ref=? AND r.fault_ref IS NULL ORDER BY f.recorded_at,f.fault_ref`, subjectRef);
  const flights = new Map(), finished = new Map(), failedSubjects = new Set(all(`SELECT DISTINCT f.subject_ref FROM backend_gateway_subject_faults f
    LEFT JOIN backend_gateway_subject_fault_recoveries r ON r.fault_ref=f.fault_ref WHERE r.fault_ref IS NULL`).map(row => row.subject_ref)),
    unpersistedFailures = new Set(), revokedContexts = new Set();
  function recordSubjectFault(flight, reasonCode) {
    const p = flight.proposal;
    failedSubjects.add(p.subjectRef);
    try {
      run(`INSERT OR IGNORE INTO backend_gateway_subject_faults
        (fault_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,operation_id,reason_code,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, 'gateway-fault:' + fingerprint([contextOf(p), p.operationId, reasonCode]),
      p.ownerRef, String(p.accountRef), p.subjectRef, p.ownerEpoch, p.runEpoch, p.connectionEpoch,
      flight.prepared ? p.operationId : null, reasonCode, nowIso());
    } catch { unpersistedFailures.add(p.subjectRef); }
  }
  function recoverSubjectFaults({ context, checkpoint } = {}) {
    if (!context?.subjectRef || flights.has(context.subjectRef) || unpersistedFailures.has(context.subjectRef) ||
        typeof authorizeFaultRecovery !== 'function') return { recovered: 0, remaining: failedSubjects.has(context?.subjectRef) ? 1 : 0 };
    return transaction(() => {
      let recovered = 0;
      for (const fault of unresolvedFaults(context.subjectRef)) {
        if (fault.owner_ref !== context.ownerRef || fault.account_ref !== String(context.accountRef) || !fault.operation_id) continue;
        const proof = synchronously(authorizeFaultRecovery, { context, checkpoint, operationId: fault.operation_id,
          requireNative: fault.reason_code !== 'WRITE_POST_READ_LEASE_RELEASE_UNCONFIRMED' });
        if (!proof || proof.technicalFaultOnly !== true || proof.operationId !== fault.operation_id) continue;
        const encoded = JSON.stringify(proof);
        run('INSERT INTO backend_gateway_subject_fault_recoveries VALUES(?,?,?,?)', fault.fault_ref, encoded, ledgerJsonFingerprint(proof), nowIso());
        recovered += 1;
      }
      const remaining = unresolvedFaults(context.subjectRef).length;
      if (!remaining) failedSubjects.delete(context.subjectRef);
      return { recovered, remaining };
    });
  }

  function holdForProcessRecovery(subjects = null) {
    if (Array.isArray(subjects) && subjects.length) {
      for (const subjectRef of subjects) if (typeof subjectRef === 'string' && subjectRef) recoveryHolds.subjects.add(subjectRef);
    } else recoveryHolds.process = true;
    return healthSnapshot();
  }
  function releaseProcessRecoveryHold(subjects = null) {
    if (Array.isArray(subjects) && subjects.length) {
      for (const subjectRef of subjects) recoveryHolds.subjects.delete(subjectRef);
    } else { recoveryHolds.process = false; recoveryHolds.subjects.clear(); }
    return healthSnapshot();
  }
  const proposalContracts = new WeakMap();
  const blockedTransports = new WeakSet();
  const featureBasis = (config, featureId) => Object.fromEntries(CONFIG_FIELDS.filter(field => field.featureId === featureId)
    .map(field => [field.dtoPath, atPath(config, field.dtoPath).value]));

  function registryAdmitsRead(proposal, descriptor) {
    if (descriptor.domain === 'land') return;
    const read = descriptor.metadata.postRead;
    if (typeof registry.permitsRead !== 'function' || synchronously(input => registry.permitsRead(input), {
      featureId: proposal.featureId, scope: proposal.scope, writeMethod: proposal.method,
      readContractId: read.contractId, readMethod: read.method, readKind: read.kind ?? 'same-connection', evidenceRef: read.evidenceRef }) !== true) {
      throw problem('WRITE_POST_READ_NOT_ADMITTED', '顾客独立后读合同尚未由根名册明确准入');
    }
  }
  function domainDescriptor(input, module) {
    if (input.featureId === 'land.acceleration' && Object.values(LAND_ACCELERATION_METHODS).includes(input.method) &&
        LAND_ACCELERATION_SCOPES[input.acceleration?.mode] === input.scope && LAND_ACCELERATION_METHODS[input.acceleration?.mode] === input.method) {
      if (input.acceleration?.extension && input.targets) assertLandAccelerationProposal(input);
      const currentNeedContract = module.currentNeedContracts?.[input.method] ?? null;
      const metadata = freeze({ contractId: 'land-acceleration/' + input.acceleration.mode + '/v1', featureId: input.featureId,
        scope: input.scope, method: input.method, targetKind: 'land', params: input.params,
        ...(currentNeedContract ? { currentNeed: currentNeedContract } : {}),
        postRead: { contractId: 'land-refresh/post-write-v1', method: 'usrLand.refresh', kind: 'same-connection', args: {},
          evidenceRef: 'land-acceleration/partial-target-refresh/v1' } });
      const descriptor = Object.freeze({ domain: 'land-acceleration', currentNeedContract, metadata,
        validateResponseCoverage: ACCELERATION_RESPONSE_COVERAGE,
        validateTargetVerification: ACCELERATION_TARGET_VERIFICATION });
      registryAdmitsRead(input, descriptor);
      return descriptor;
    }
    if (Object.hasOwn(SINGLE_METHODS, input.featureId) && input.method === SINGLE_METHODS[input.featureId] && input.scope === input.featureId) {
      const declaredNeed = module.currentNeedContracts?.[input.method] ?? null;
      return Object.freeze({ domain: 'land', currentNeedContract: declaredNeed, metadata: freeze({ contractId: 'land-single/' + input.featureId + '/v1',
        featureId: input.featureId, scope: input.scope, method: input.method, targetKind: 'land',
        ...(declaredNeed ? { currentNeed: declaredNeed } : {}),
        postRead: { contractId: 'land-refresh/post-write-v1', method: 'usrLand.refresh', args: {}, evidenceRef: 'land-single/v1' } }),
        validateResponseCoverage: null, validateTargetVerification: null });
    }
    const domain = Object.keys(FINITE_DOMAINS).find(key => { const one = FINITE_DOMAINS[key].definition; return input.featureId === one.featureId && input.scope === one.scope && input.method === one.method; });
    const definition = FINITE_DOMAINS[domain]?.definition;
    if (!definition) {
      throw problem('WRITE_SINGLE_TARGET_ONLY', '当前仅准入已登记的单地与有限单顾客交付合同');
    }
    const contract = module.operationContracts?.[input.method] ?? module.operationContract, read = contract?.postRead;
    const currentNeedContract = module.currentNeedContracts?.[input.method] ?? null;
    const readKind = read?.kind ?? 'same-connection';
    const contractKeys = FINITE_DOMAINS[domain].contractKeys ?? [...Object.keys(definition), 'postRead', 'validateTargetVerification'];
    if (!exactKeys(contract, contractKeys) ||
      Object.entries(definition).some(([key, expected]) => contract[key] !== expected) ||
      !exactKeys(read, ['contractId', 'method', 'args', 'evidenceRef', 'validateResponseCoverage', ...(Object.hasOwn(read || {}, 'kind') ? ['kind'] : [])]) || !contractText(read.contractId) ||
      !contractText(read.evidenceRef) || typeof read.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(read.method) ||
      !['same-connection', 'after-close-login'].includes(readKind) || readKind === 'after-close-login' &&
        (read.method !== 'index.login' || !postReadLease || !syncFunction(supervisor.verificationLease)) ||
      readKind === 'same-connection' && read.method === 'index.login' || !exactKeys(read.args, []) ||
      !syncFunction(read.validateResponseCoverage) || !syncFunction(contract.validateTargetVerification)) {
      throw problem('WRITE_DOMAIN_DESCRIPTOR_INCOMPLETE', '顾客单笔合同缺少有限方法、覆盖或原目标核验声明');
    }
    const descriptor = Object.freeze({ domain, currentNeedContract, metadata: freeze({ ...definition,
      ...(definition.featureId === 'art.first-album' || definition.featureId === 'art.first-share'
        ? { domain, contractId: definition.contractRef } : {}),
      ...(currentNeedContract ? { currentNeed: currentNeedContract } : {}),
      postRead: { contractId: read.contractId, method: read.method, kind: readKind, args: {}, evidenceRef: read.evidenceRef } }),
      validateResponseCoverage: read.validateResponseCoverage, validateTargetVerification: contract.validateTargetVerification });
    if (/^order-flower-(?:video|reward|enter)-/.test(domain) && currentNeedContract &&
        supervisor.supportsVerificationContract?.({ featureId: definition.featureId, scope: definition.scope,
          method: definition.method, contractId: definition.contractId, currentNeed: currentNeedContract }) !== true) {
      throw problem('ORDER_FLOWER_AUXILIARY_VERIFICATION_CONTRACT_UNAVAILABLE',
        '订单辅助动作等待会话后验支持完整当前需求合同，原未知记录保留；普通交单继续');
    }
    registryAdmitsRead(input, descriptor);
    return descriptor;
  }
  function boundDescriptor(proposal, module) {
    const captured = proposalContracts.get(proposal), current = domainDescriptor(proposal, module);
    if (!captured || registry.get(proposal.featureId) !== module || fingerprint(captured.metadata) !== fingerprint(current.metadata) ||
      captured.validateResponseCoverage !== current.validateResponseCoverage || captured.validateTargetVerification !== current.validateTargetVerification ||
      captured.domain !== 'land' && fingerprint(proposal.operationDescriptor) !== fingerprint(captured.metadata)) {
      throw problem('WRITE_DOMAIN_DESCRIPTOR_CHANGED', '原提案的有限方法或后读合同已改变');
    }
    return captured;
  }

  function contextCheck(proposal, { checkConfig = true } = {}) {
    if (revokedContexts.has(contextKey(proposal))) throw problem('WRITE_CONTEXT_REVOKED', '原写入代际已经撤销');
    const actor = supervisor.context(proposal.subjectRef);
    if (!actor || !actor.isCurrent() || !sameContext(actor, proposal)) throw problem('WRITE_CONTEXT_REVOKED', '运行意愿、执行权或连接已改变');
    if (!actor.connection?.isOpen()) throw problem('WRITE_CONNECTION_CLOSED', '当前官服连接已结束');
    if (failedSubjects.has(proposal.subjectRef) || blockedTransports.has(actor.connection)) throw problem('WRITE_TRANSPORT_QUARANTINED', '当前主体仍有未安全收口的持久发送');
    if (!registry.permits(proposal.featureId, proposal.scope, proposal.method)) throw problem('WRITE_CAPABILITY_UNAVAILABLE', '该方法尚未登记本阶段验收能力');
    if (synchronously(authorize, { ownerRef: actor.ownerRef, purpose: 'business-write', featureId: proposal.featureId }) !== true) throw problem('WRITE_AUTHORIZATION_MISSING', '当前软件授权未核实');
    const config = readConfiguration(actor);
    if (checkConfig) {
      const original = get('SELECT dto_json FROM backend_config_history WHERE owner_ref=? AND account_ref=? AND revision=?', actor.ownerRef, actor.accountRef, proposal.configRevision);
      if (!original || config.featureCancelEpochs[proposal.featureId] !== proposal.featureCancelEpoch ||
          fingerprint(featureBasis(JSON.parse(original.dto_json), proposal.featureId)) !== fingerprint(featureBasis(config.config, proposal.featureId))) {
        throw problem('WRITE_CONFIG_SUPERSEDED', '配置依据已经改变，旧提案不再发送或发布当前计划');
      }
    }
    return { actor, config };
  }
  function check(proposal, module, boundary) {
    return timedSyncPhase('gateway.check', () => measureSyncCost(store, 'gateway.check', () => checkInPhase(proposal, module, boundary)));
  }
  function checkInPhase(proposal, module, boundary) {
    const { actor, config } = measureSyncCost(store, 'gateway.context', () => contextCheck(proposal));
    if (boundary === 'before-prepare' || boundary === 'before-send') {
      measureSyncCost(store, 'gateway.source', () => synchronously(assertSourceReady, { proposal, module, boundary }));
    }
    if (boundary === 'before-prepare' || boundary === 'before-send') {
      const current = timedSyncPhase('gateway.semanticToken', () => dynamicState.semanticToken({ context: contextOf(proposal),
        feature: module, config: config.config, method: proposal.method, proposal }));
      if (!current.current) throw problem('DYNAMIC_FACTS_NOT_CURRENT', '当前动态事实不完整或正在刷新，等待系统自动核对', 409,
        { reasonCode: current.reasonCode, domains: current.domains.filter(one => !one.current).map(one => one.domainId) });
      if (!dynamicTokenMatches(current, proposal.dynamicFactToken)) throw problem('WRITE_DYNAMIC_FACTS_SUPERSEDED',
        '评估后动态事实语义或覆盖已变化，当前候选已取消并重新评估', 409);
    }
    if (typeof supervisor.verificationLease === 'function' && synchronously(input => supervisor.verificationLease(input), {
      subjectRef: proposal.subjectRef, ownerRef: proposal.ownerRef })?.active === true) {
      throw problem('WRITE_VERIFICATION_LEASE_ACTIVE', '主体仍在原操作的关闭后登录后验中，禁止新业务写');
    }
    measureSyncCost(store, 'gateway.descriptor', () => boundDescriptor(proposal, module));
    if (fingerprint(proposal.params) !== proposal.paramsFingerprint) throw problem('WRITE_PAYLOAD_CHANGED', '提案参数与已核准指纹不一致');
    const ownReservation = { operationId: proposal.operationId, required: boundary === 'before-send' };
    if (ownReservation.required) measureSyncCost(store, 'gateway.reservation', () => {
      const operation = ledger.operation(proposal.operationId), permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', proposal.operationId);
      if (!operation || operation.write_slot !== 1 || !['not_started', 'may_have_sent'].includes(operation.transport_state) ||
          operation.owner_ref !== proposal.ownerRef || operation.account_ref !== proposal.accountRef || operation.subject_ref !== proposal.subjectRef ||
          operation.run_epoch !== proposal.runEpoch || operation.connection_epoch !== proposal.connectionEpoch ||
          operation.original.ownerEpoch !== proposal.ownerEpoch || operation.params_fingerprint !== proposal.paramsFingerprint ||
          fingerprint(operation.original.targets) !== fingerprint(proposal.targets) || fingerprint(operation.original.resources) !== fingerprint(proposal.resources) ||
          fingerprint(operation.original.resourceBindings) !== fingerprint(proposal.resourceBindings) ||
          !permit || permit.owner_ref !== proposal.ownerRef || permit.subject_ref !== proposal.subjectRef || permit.owner_epoch !== proposal.ownerEpoch ||
          permit.run_epoch !== proposal.runEpoch || permit.connection_epoch !== proposal.connectionEpoch || permit.consumed !== 0 ||
          permit.method !== proposal.method || permit.params_fingerprint !== proposal.paramsFingerprint) {
        throw problem('WRITE_OWN_RESERVATION_CHANGED', '本操作原预约或发送凭证已变化');
      }
    });
    const admissionFunction = resolveAdmission
      ? synchronously(resolveAdmission, proposal.featureId)
      : evaluateAdmission;
    if (typeof admissionFunction !== 'function' || admissionFunction.constructor?.name === 'AsyncFunction')
      throw problem('WRITE_RESOURCE_ADMISSION_MISSING', '当前功能没有同步的权威准入核验');
    const boundaryReader = resolveAdmissionBoundary ? synchronously(resolveAdmissionBoundary, proposal) : null;
    let factBasis, admission;
    const verifyBasis = () => measureSyncCost(store, 'gateway.factHash', () => {
      if (fingerprint(factBasis) !== fingerprint(proposal.factBasis)) throw problem('WRITE_FACTS_SUPERSEDED', '官服事实依据已经改变，需要重新评估');
    });
    if (boundaryReader !== null) {
      const combined = measureSyncCost(store, 'gateway.admission', () => synchronously(boundaryReader,
        { proposal, actor, module, boundary, ownReservation }));
      if (combined?.contract !== 'authoritative-facts-and-admission/v1' || combined.admissionFunction !== admissionFunction)
        throw problem('WRITE_BOUNDARY_ADMISSION_PORT_INVALID', '同步事实与准入必须来自同一权威核验', 409);
      factBasis = combined.factBasis; admission = combined.admission;
    } else {
      factBasis = timedSyncPhase('gateway.factBasis', () => measureSyncCost(store, 'gateway.factBasis', () => synchronously(readFactBasis,
        { proposal, actor, module, boundary, ownReservation })));
      verifyBasis();
      admission = measureSyncCost(store, 'gateway.admission', () => synchronously(admissionFunction,
        { proposal, actor, factBasis, boundary, ownReservation }));
    }
    if (admission?.allowed !== true || admission.historicalConstraintsChecked !== true || admission.currentInFlightChecked !== true) {
      throw problem(admission?.reasonCode || 'WRITE_RESOURCE_ADMISSION_MISSING', '目标、资源或历史足迹尚未完成当前准入核对');
    }
    if (boundaryReader !== null) verifyBasis();
    const qualification = module.qualify === admissionFunction ? admission : measureSyncCost(store, 'gateway.qualification', () =>
      synchronously(module.qualify, { proposal, actor: contextOf(actor), config, factBasis, boundary, ownReservation }));
    if (qualification?.allowed !== true || qualification.targetsCurrent !== true || qualification.resourcesCurrent !== true) throw problem(qualification?.reasonCode || 'WRITE_QUALIFICATION_MISSING', '当前目标、资源或资格未核实');
    return actor;
  }
  function supersessionReceipt(proposal, module, flight, reasonCode) {
    if (!SUPERSEDED_BEFORE_SEND.has(reasonCode) || !flight.durableOutcome || flight.controller.signal.aborted ||
        flight.consumed || flight.byteSendStarted || flight.bypass || flight.sendReturned) return null;
    const { actor, config } = contextCheck(proposal, { checkConfig: false });
    const operation = ledger.operation(proposal.operationId);
    if (operation && (operation.transport_state !== 'not_sent' || operation.business_verdict !== 'not_applicable' || operation.write_slot !== 0 ||
        operation.owner_ref !== proposal.ownerRef || operation.account_ref !== proposal.accountRef || operation.subject_ref !== proposal.subjectRef ||
        operation.run_epoch !== proposal.runEpoch || operation.connection_epoch !== proposal.connectionEpoch ||
        operation.original.ownerEpoch !== proposal.ownerEpoch || operation.params_fingerprint !== proposal.paramsFingerprint ||
        fingerprint(operation.original.targets) !== fingerprint(proposal.targets))) return null;
    const permit = operation ? get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', proposal.operationId) : null;
    if (operation && (!permit || permit.consumed !== 0 || permit.wire_key !== null || permit.request_sequence !== null)) return null;
    const currentBasis = synchronously(readFactBasis, { proposal, actor, module, boundary: 'before-prepare',
      ownReservation: { operationId: proposal.operationId, required: false } });
    if (!currentBasis || typeof currentBasis !== 'object' || Array.isArray(currentBasis) || !Object.keys(currentBasis).length) return null;
    const originalBasisFingerprint = fingerprint(proposal.factBasis), currentBasisFingerprint = fingerprint(currentBasis);
    const history = get('SELECT dto_json FROM backend_config_history WHERE owner_ref=? AND account_ref=? AND revision=?',
      proposal.ownerRef, proposal.accountRef, proposal.configRevision);
    const originalFeatureConfigFingerprint = history ? fingerprint(featureBasis(JSON.parse(history.dto_json), proposal.featureId)) : null;
    const currentFeatureConfigFingerprint = fingerprint(featureBasis(config.config, proposal.featureId));
    const factsChanged = originalBasisFingerprint !== currentBasisFingerprint;
    const configChanged = originalFeatureConfigFingerprint !== null && (originalFeatureConfigFingerprint !== currentFeatureConfigFingerprint ||
      proposal.featureCancelEpoch !== config.featureCancelEpochs[proposal.featureId]);
    if (reasonCode === 'WRITE_FACTS_SUPERSEDED' ? !factsChanged : !configChanged) return null;
    const receipt = { version: 'gateway-presend-supersession/v1', kind: 'superseded-before-send', reasonCode,
      context: contextOf(proposal), featureId: proposal.featureId, proposalId: proposal.proposalId, operationId: proposal.operationId,
      operationPrepared: operation !== null, notSentVerified: true, durableOutcome: true,
      consumed: false, byteSendStarted: false, originalBasisFingerprint, currentBasisFingerprint, factsChanged,
      originalFeatureConfigFingerprint, currentFeatureConfigFingerprint, configChanged,
      originalConfigRevision: proposal.configRevision, currentConfigRevision: config.savedRevision,
      originalFeatureCancelEpoch: proposal.featureCancelEpoch, currentFeatureCancelEpoch: config.featureCancelEpochs[proposal.featureId] };
    return freeze({ ...receipt, receiptRef: 'presend-supersession:' + fingerprint(receipt) });
  }
  function propose(input) {
    const module = registry.get(input.featureId);
    if (!module || typeof module.qualify !== 'function' || typeof module.verify !== 'function') throw problem('WRITE_CONTRACT_UNAVAILABLE', '该功能尚无完整写前与写后合同');
    const descriptor = domainDescriptor(input, module);
    if (!Array.isArray(input.targets) || input.targets.length !== 1) throw problem('WRITE_SINGLE_TARGET_ONLY', '本合同仅允许一个原始目标成员');
    const acceleration = descriptor.domain === 'land-acceleration' ? captureLandAccelerationArgs({ mode: input.acceleration?.mode,
      params: input.params, targetLandId: input.acceleration?.targetLandId }) : null;
    const params = FINITE_DOMAINS[descriptor.domain] ? FINITE_DOMAINS[descriptor.domain].capture(input.params).params : clone(input.params);
    if (descriptor.domain === 'land') {
      const keys = Object.keys(params).sort(), expectedKeys = input.featureId === 'plant' ? ['flowerId', 'landId'] : ['landId'];
      if (fingerprint(keys) !== fingerprint(expectedKeys) || expectedKeys.some(key => !Number.isSafeInteger(params[key]) || params[key] <= 0)) throw problem('WRITE_ARGUMENT_CONTRACT_INVALID', '单地参数不符合已核合同', 400);
    }
    const affectedDomains = affectedDomainsForWrite(input.featureId, input.method);
    const proposal = { ...clone(input), ...(acceleration ? { scope: acceleration.scope, method: acceleration.method, params: acceleration.params } : {}), affectedDomains: [...affectedDomains],
      proposalId: input.proposalId || newId(), operationId: input.operationId || newId(),
      implementationVersion: module.implementationVersion, params, paramsFingerprint: fingerprint(params) };
    const declaredNeed = validateDeclaredCurrentNeed({ proposal, declaration: descriptor.currentNeedContract });
    const traceSeed = proposal.traceId || declaredNeed?.businessNeedRef || declaredNeed?.needRef || proposal.operationId;
    proposal.traceId = typeof traceSeed === 'string' && traceSeed.length <= 64 && /^[A-Za-z0-9_.:-]{1,64}$/.test(traceSeed)
      ? traceSeed : fingerprint({ scope: 'backend-trace/v1', traceSeed });
    if (typeof proposal.traceId !== 'string' || proposal.traceId.length > 64 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(proposal.traceId)) {
      throw problem('WRITE_TRACE_ID_INVALID', '写入追踪标识不符合云端64字符合同', 400);
    }
    const { config: currentConfiguration } = contextCheck(proposal);
    const dynamicFactToken = timedSyncPhase('gateway.semanticToken', () => dynamicState.semanticToken({ context: contextOf(input),
      feature: module, config: currentConfiguration.config, method: input.method, proposal }));
    if (!dynamicFactToken.current) throw problem('DYNAMIC_FACTS_NOT_CURRENT', '当前动态事实仍在自动核对，暂不生成写候选', 409,
      { domains: dynamicFactToken.domains.filter(one => !one.current).map(one => one.domainId) });
    proposal.dynamicFactToken = dynamicFactToken;
    if (!proposal.factBasis || !Object.keys(proposal.factBasis).length || !Array.isArray(proposal.resources) || !Array.isArray(proposal.resourceBindings)) {
      throw problem('WRITE_PROPOSAL_INCOMPLETE', '提案缺少事实或显式资源绑定', 400);
    }
    if (descriptor.domain === 'land') {
      if (proposal.targets[0].targetKind !== 'land' || proposal.targets[0].targetRef !== 'land:' + proposal.subjectRef + ':' + params.landId) throw problem('WRITE_PROPOSAL_INCOMPLETE', '提案缺少准确土地身份', 400);
    } else if (descriptor.domain === 'land-acceleration') {
      assertLandAccelerationProposal(proposal);
      if (input.operationDescriptor !== undefined && fingerprint(input.operationDescriptor) !== fingerprint(descriptor.metadata))
        throw problem('WRITE_DOMAIN_DESCRIPTOR_CHANGED', '加速方法合同已改变');
      proposal.operationDescriptor = descriptor.metadata;
    } else {
      if (input.operationDescriptor !== undefined && fingerprint(input.operationDescriptor) !== fingerprint(descriptor.metadata)) throw problem('WRITE_DOMAIN_DESCRIPTOR_CHANGED', '提交的顾客方法合同已改变');
      proposal.operationDescriptor = descriptor.metadata;
      FINITE_DOMAINS[descriptor.domain].assert(proposal);
    }
    const frozen = freeze(proposal); proposalContracts.set(frozen, descriptor); return frozen;
  }
  function revoke(context, { reasonCode = 'RUN_INTENT_REVOKED' } = {}) {
    revokedContexts.add(contextKey(context));
    const flight = flights.get(context.subjectRef);
    if (flight && sameContext(flight.context, context)) {
      flight.revoked = true; flight.controller.abort(problem(reasonCode, '原运行代际已经撤销'));
      return Object.freeze({ captured: true, completion: flight.completion });
    }
    const previous = finished.get(contextKey(context));
    if (previous && sameContext(previous.context, context)) return Object.freeze({ captured: false, completion: previous.completion });
    const receipt = {
      operationId: null, durableOutcome: true, consumed: false, byteSendStarted: false, reasonCode: 'NO_MATCHING_GATEWAY_FLIGHT' };
    const completion = Promise.resolve(Object.freeze(receipt));
    finished.set(contextKey(context), { context: contextOf(context), receipt, completion });
    return Object.freeze({ captured: false, completion });
  }
  async function submit(input, signal) {
    const proposal = propose(input), module = registry.get(proposal.featureId);
    assertProcessWriteAdmission();
    assertWriteAdmission(contextOf(proposal));
    synchronously(assertSourceReady, { proposal, module });
    const descriptor = boundDescriptor(proposal, module);
    // A later rejected empty flight must not replace this context's earlier
    // unconfirmed drain with durable=true. Only a new real executor may recover
    // a poisoned subject from its preserved ledger and isolation evidence.
    if (failedSubjects.has(proposal.subjectRef)) throw problem('WRITE_TRANSPORT_QUARANTINED', '当前主体仍有未确认的持久收尾');
    if (revokedContexts.has(contextKey(proposal))) throw problem('WRITE_CONTEXT_REVOKED', '原写入代际已经撤销');
    if (flights.has(proposal.subjectRef)) throw problem('WRITE_SUBJECT_BUSY', '当前主体有一笔写入正在核对');
    let resolveDone;
    const flight = { proposal, context: contextOf(proposal), operationId: proposal.operationId, controller: new AbortController(), revoked: false, prepared: false,
      consumed: false, byteSendStarted: false, bypass: false, sendReturned: false, answerMatched: false,
      durableOutcome: false, reasonCode: 'WRITE_PENDING', completion: new Promise(resolve => { resolveDone = resolve; }) };
    flights.set(proposal.subjectRef, flight);
    beginFlightStage(flight, 'before-prepare', 3 * 60_000);
    let actor, permitId, binding = null, matchedReply = null, preparing = false;
    let leaseAttempted = false, leasePacket = null, postReadBridge = null, postReadBridgeProof = null, bridgePromise = null, bridgeInFlight = false;
    const postReads = [], approvedPostReads = new Set(), unlink = [];
    const followSignal = source => {
      if (!source) return;
      const abort = () => flight.controller.abort(source.reason || problem('RUN_INTENT_REVOKED', '原运行意愿已撤销'));
      source.addEventListener('abort', abort, { once: true }); unlink.push(() => source.removeEventListener('abort', abort));
      if (source.aborted) abort();
    };
    const ensureActive = () => { flight.controller.signal.throwIfAborted(); if (flight.revoked) throw problem('RUN_INTENT_REVOKED', '原代际已撤销'); };
    const evidence = (kind, payload) => ({ kind, source: 'backend/write-gateway/v2', payload: kind === 'domain-verification'
      ? gatewayVerificationEvidencePayload(proposal.traceId, payload) : { traceId: proposal.traceId, ...payload } });
    const termination = () => ({ ended: true, source: 'matched-rpc-response', operationId: proposal.operationId,
      connectionEpoch: proposal.connectionEpoch, wireKey: binding.wireKey, requestSequence: binding.requestSequence, responseRef: matchedReply.responseRef });
    const settle = (verification, notify) => transaction(() => {
      const result = ledger.settleSingleTarget({ operationId: proposal.operationId, settlementKey: proposal.operationId + ':single-target',
        member: { memberKey: proposal.targets[0].memberKey, verdict: verification.verdict, reasonCode: verification.reasonCode || 'DOMAIN_' + verification.verdict.toUpperCase() },
        verificationVersion: verification.verificationVersion, evidence: evidence('domain-verification', verification.evidence),
        resourceResolutions: verification.resourceResolutions, transportTermination: flight.answerMatched ? termination() : null });
      let current = false;
      if (!flight.revoked && !flight.controller.signal.aborted) { try { contextCheck(proposal); current = true; } catch { /* Original audit remains valid. */ } }
      // SDK tokens are wire-only capabilities. They may exist on the live
      // proposal while the RPC is pending, but never cross into settlement
      // hooks, outbox payloads, evidence JSON, or caller-visible receipts.
      const eventProposal = FINITE_DOMAINS[descriptor.domain]?.family === 'video'
        ? Object.freeze({ ...proposal, params: clone(proposal.orderFlowerVideo.publicArgs) }) : proposal;
      const event = { proposal: eventProposal, verification, operation: result.operation, targetSettlement: result.targetSettlement,
        visibility: current ? 'current' : 'audit-only', postReads: Object.freeze([...postReads]),
        postReadBridge, postReadBridges: Object.freeze(postReadBridge ? [postReadBridge] : []),
        postReadBridgeProof,
        sendBinding: flight.answerMatched ? Object.freeze({ connectionEpoch: proposal.connectionEpoch,
          requestSequence: binding.requestSequence, wireKey: binding.wireKey, responseRef: matchedReply.responseRef }) : null };
      if (notify) synchronously(onSettled, event);
      if (current) { try { contextCheck(proposal); } catch { current = false; } }
      if (notify && current) {
        synchronously(onCurrentVerified, event);
        ledger.appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'OperationVerified', eventKey: proposal.operationId,
          configRevision: proposal.configRevision, payload: { operationId: proposal.operationId, traceId: proposal.traceId, featureId: proposal.featureId,
            verdict: verification.verdict, evidenceRef: verification.evidenceRef ?? null, runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch } });
      } else ledger.appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'OperationAuditSettled', eventKey: proposal.operationId,
        configRevision: proposal.configRevision, payload: { operationId: proposal.operationId, traceId: proposal.traceId, featureId: proposal.featureId, verdict: verification.verdict,
          runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, currentEffectsPublished: false } });
      return result.operation;
    });
    const afterBinding = () => ({ connectionEpoch: proposal.connectionEpoch, requestSequence: binding.requestSequence,
      wireKey: binding.wireKey, responseRef: matchedReply.responseRef });
    const checkOriginalReadSlot = () => {
      const original = ledger.operation(proposal.operationId);
      if (!original || original.transport_state !== 'answered' || original.business_verdict !== 'unverified' || original.write_slot !== 1 ||
        original.owner_ref !== proposal.ownerRef || original.account_ref !== proposal.accountRef || original.subject_ref !== proposal.subjectRef ||
        original.run_epoch !== proposal.runEpoch || original.connection_epoch !== proposal.connectionEpoch || original.original.ownerEpoch !== proposal.ownerEpoch ||
        original.params_fingerprint !== proposal.paramsFingerprint || fingerprint(original.original.targets) !== fingerprint(proposal.targets) ||
        !flight.answerMatched || !flight.consumed) throw problem('WRITE_POST_READ_ORIGINAL_SLOT_CHANGED', '后读原操作不再持有已回答的唯一写位');
    };
    const validateBridge = ({ requireCurrent = true, phase = 'reading' } = {}) => {
      if (!postReadLease || !leasePacket) throw problem('WRITE_POST_READ_LEASE_MISSING', '本次跨连接后验租约尚未建立');
      const valid = synchronously(input => postReadLease.validateReadSnapshotLease(input), {
        leaseRef: leasePacket.leaseRef, operationId: proposal.operationId, originalContext: contextOf(proposal),
        newContext: leasePacket.newContext, after: afterBinding(), bridgeFingerprint: leasePacket.bridgeFingerprint, phase });
      if (valid?.valid !== true || valid.bridgeFingerprint !== leasePacket.bridgeFingerprint || requireCurrent && valid.current !== true) {
        throw problem(valid?.reasonCode || 'WRITE_POST_READ_LEASE_INVALID', '本次关闭与新登录桥未获原租约证据确认');
      }
      const receipt = valid.receipt, login = receipt?.newLoginSource, observed = leasePacket.newLoginObservation;
      if (!receipt || receipt.version !== 'after-physical-close-login/v1' || receipt.leaseRef !== leasePacket.leaseRef ||
        receipt.operationId !== proposal.operationId || !sameContext(receipt.originalContext, contextOf(proposal)) ||
        !sameContext(receipt.newContext, leasePacket.newContext) || fingerprint(receipt.after) !== fingerprint(afterBinding()) ||
        fingerprint(receipt.oldPhysicalCloseReceipt) !== fingerprint(leasePacket.oldPhysicalCloseReceipt) ||
        receipt.officialUid !== leasePacket.officialUid || login?.officialUid !== leasePacket.officialUid ||
        login.method !== 'index.login' || login.connectionEpoch !== observed?.connectionEpoch || login.requestSequence !== observed?.requestSequence ||
        login.wireKey !== observed?.wireKey || login.responseRef !== observed?.responseRef ||
        login.versionEvidence?.gameVersion !== observed?.versionEvidence?.gameVersion ||
        login.versionEvidence?.protocolVersion !== observed?.versionEvidence?.protocolVersion ||
        login.versionEvidence?.loginResponseRef !== observed?.responseRef ||
        receipt.oldLoginSource?.responseRef !== (descriptor.domain.startsWith('rack-') ? proposal.flowerRack?.loginResponseRef
          : descriptor.domain.startsWith('waterwheel-') ? proposal.waterwheel?.loginResponseRef
          : descriptor.domain.startsWith('free-water-') ? proposal.freeWater?.loginResponseRef
          : descriptor.domain === 'art-daily' ? proposal.dailyArt?.versionEvidence?.loginResponseRef
          : FINITE_DOMAINS[descriptor.domain]?.preparation
            ? proposal[FINITE_DOMAINS[descriptor.domain].preparation]?.versionEvidence?.loginResponseRef
            : proposal.waterwheel?.loginResponseRef)) {
        throw problem('WRITE_POST_READ_LEASE_PACKET_MISMATCH', '后验原始收件与持久关闭登录桥不一致');
      }
      return valid;
    };
    const readSnapshotAfterClose = () => {
      ensureActive();
      const currentDescriptor = boundDescriptor(proposal, module);
      if (currentDescriptor.domain === 'land' || currentDescriptor.metadata.postRead.kind !== 'after-close-login') {
        throw problem('WRITE_POST_READ_BRIDGE_NOT_CONTRACTED', '本操作没有关闭后登录的有限后读合同');
      }
      if (bridgePromise) { if (postReadBridge) validateBridge(); return bridgePromise; }
      contextCheck(proposal, { checkConfig: false }); checkOriginalReadSlot();
      leaseAttempted = true; bridgeInFlight = true;
      bridgePromise = (async () => {
        leasePacket = freeze(await inFlightStage(flight, 'after-close-login', 15 * 60_000,
          () => postReadLease.readSnapshotAfterClose({ context: contextOf(proposal), operationId: proposal.operationId,
            after: afterBinding(), signal: flight.controller.signal, onProgress: () => touchFlightStage(flight) })));
        touchFlightStage(flight);
        ensureActive(); boundDescriptor(proposal, module);
        const proof = FINITE_DOMAINS[descriptor.domain].proof({ proposal, response: matchedReply, bridge: leasePacket });
        validateBridge(); checkOriginalReadSlot();
        const currentActor = supervisor.context(proposal.subjectRef);
        if (!currentActor || !currentActor.isCurrent() || !sameContext(currentActor, leasePacket.newContext) || !currentActor.connection?.isOpen() ||
          synchronously(authorize, { ownerRef: proposal.ownerRef, purpose: 'business-write', featureId: proposal.featureId }) !== true) {
          throw problem('WRITE_POST_READ_NEW_CONTEXT_REVOKED', '同主体新连接不再属于原运行意愿与授权');
        }
        postReadBridge = leasePacket; postReadBridgeProof = proof;
        const observed = leasePacket.newLoginObservation;
        ledger.appendEvidence({ operationId: proposal.operationId, evidenceKey: 'after-close-login-post-read:' + proof.leaseRef,
          kind: 'after-close-login-post-read', source: 'backend/write-gateway/v2', payload: proof });
        // The supervisor's physical-close bridge replaces the same-connection
        // seq comparison. The original matched write remains immutable.
        postReads.push(observed);
        if (synchronously(descriptor.validateResponseCoverage, { proposal, response: matchedReply, observation: observed,
          bridge: postReadBridge, postReadBridge, postReadBridgeProof: proof }) !== true) throw problem('WRITE_POST_READ_COVERAGE_UNPROVEN', '新正常登录未覆盖原订单与成品后验域');
        approvedPostReads.add(observed.responseRef); return postReadBridge;
      })().finally(() => { bridgeInFlight = false; });
      bridgePromise.catch(() => {});
      return bridgePromise;
    };
    try {
      followSignal(signal); ensureActive(); assertWriteAdmission(contextOf(proposal));
      actor = check(proposal, module, 'before-prepare'); followSignal(actor.controller?.signal);
      ensureActive();
      await inFlightStage(flight, 'subject-send-pacing', 5000,
        () => waitForPacing(proposal, flight.controller.signal));
      ensureActive(); assertWriteAdmission(contextOf(proposal));
      actor = check(proposal, module, 'before-prepare'); followSignal(actor.controller?.signal);
      ensureActive(); preparing = true;
      transaction(() => {
        const currentNeed = validateDeclaredCurrentNeed({ proposal, declaration: descriptor.currentNeedContract });
        if (currentNeed) {
          if (typeof module.consumeCurrentNeed !== 'function') throw problem('WRITE_CURRENT_NEED_CLAIM_PORT_MISSING', '当前业务需求未接入共享单次准入');
          const consumed = synchronously(module.consumeCurrentNeed, { proposal });
          if (consumed?.accepted !== true) throw problem(consumed?.reasonCode || 'WRITE_CURRENT_NEED_CLAIM_REJECTED', '当前需求声明已由其他提案占用');
        }
        const receipt = ledger.prepareOperation({ operationId: proposal.operationId, proposalId: proposal.proposalId,
          ownerRef: proposal.ownerRef, accountRef: proposal.accountRef, subjectRef: proposal.subjectRef, ownerEpoch: proposal.ownerEpoch,
          executorRef: supervisor.executorRef,
          featureId: proposal.featureId, scope: proposal.scope, method: proposal.method, semanticKey: proposal.semanticKey, paramsFingerprint: proposal.paramsFingerprint,
          traceId: proposal.traceId,
            ...(descriptor.domain === 'land' ? { landRequest: { version: 'land-request/v1', params: proposal.params,
              ...(proposal.land?.proofWorkset ? { workset: proposal.land.proofWorkset } : {}) } } : {}),
          runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, configRevision: proposal.configRevision,
          cancelEpoch: proposal.featureCancelEpoch, factBasis: proposal.factBasis, targets: proposal.targets, resources: proposal.resources, resourceBindings: proposal.resourceBindings });
        if (receipt.replayed) throw problem('WRITE_OPERATION_ALREADY_PREPARED', '原操作已存在，不能重新发送');
        if (typeof module.claimTechnicalReview === 'function') {
          const review = synchronously(module.claimTechnicalReview, { proposal });
          if (review?.accepted !== true) throw problem(review?.reasonCode || 'TECHNICAL_HOLD_REVIEW_NOT_CLAIMED', '本操作未取得技术复核资格');
        }
        permitId = newId();
        run(`INSERT INTO backend_send_permits(permit_id,operation_id,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,method,params_fingerprint,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, permitId, proposal.operationId, proposal.ownerRef, String(proposal.accountRef), proposal.subjectRef,
        proposal.ownerEpoch, proposal.runEpoch, proposal.connectionEpoch, proposal.method, proposal.paramsFingerprint, nowIso());
        if (descriptor.domain !== 'land') ledger.appendEvidence({ operationId: proposal.operationId,
          evidenceKey: 'admitted-operation-contract:v1', kind: 'admitted-operation-contract', source: 'backend/write-gateway/v2', payload: descriptor.metadata });
        if (descriptor.domain !== 'land') ledger.appendEvidence({ operationId: proposal.operationId,
          evidenceKey: 'finite-domain-preparation:v1', kind: 'finite-domain-preparation', source: 'backend/write-gateway/v2',
          payload: { domain: descriptor.domain, preparation: clone(proposal[FINITE_DOMAINS[descriptor.domain]?.preparation || PREPARATION_FIELD[descriptor.domain]]) } });
      });
      flight.prepared = true;
      // Preparation is durable before yielding: STOP/cancellation can close it
      // through the existing never-consumed permit proof instead of leaving a
      // feature claim without an operation. Give pending I/O a real turn.
      await new Promise(resolve => setImmediate(resolve));
      ensureActive();
      const preparedFrame = actor.connection.prepareWrite(proposal.method, proposal.params);
      await inFlightStage(flight, 'before-send-fence', 3 * 60_000,
        () => beforeSend({ proposal, signal: flight.controller.signal }));
      const ordinaryFlower = Object.values(ORDER_FLOWER_CONTRACTS).find(one => one.featureId === proposal.featureId &&
        one.scope === proposal.scope && one.method === proposal.method);
      if (ordinaryFlower) {
        const readEvidence = (evidenceKey, kind) => {
          const row = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
            WHERE operation_id=? AND evidence_key=? AND kind=? AND source='backend/write-gateway/v2'`, proposal.operationId, evidenceKey, kind);
          const payload = row ? parseStored(row.payload_json, '普通订单发送前不可变合同证据') : null;
          if (!row || ledgerJsonFingerprint({ kind: row.kind, source: row.source, payload, observedAt: row.observed_at }) !== row.payload_fingerprint) {
            throw problem('ORDER_FLOWER_PRESEND_CONTRACT_INVALID', '普通订单发送前不可变合同证据未通过校验');
          }
          return payload;
        };
        const operation = ledger.operation(proposal.operationId);
        assertOrderFlowerImmutableEvidence({ admitted: readEvidence('admitted-operation-contract:v1', 'admitted-operation-contract'),
          prepared: readEvidence('finite-domain-preparation:v1', 'finite-domain-preparation'), definition: ordinaryFlower,
          original: operation?.original });
      }
      assertWriteAdmission(contextOf(proposal));
      ensureActive(); check(proposal, module, 'before-send');
      ledger.markMayHaveSent({ operationId: proposal.operationId, evidence: evidence('durable-send-intent', { permitId, paramsFingerprint: proposal.paramsFingerprint, connectionEpoch: proposal.connectionEpoch }) });
      const permit = Object.freeze({ operationId: proposal.operationId, method: proposal.method, paramsFingerprint: proposal.paramsFingerprint,
        claim(value) {
          ensureActive();
            assertProcessWriteAdmission(flight);
          assertWriteAdmission(contextOf(proposal));
          if (flight.consumed || flight.byteSendStarted) throw problem('WRITE_PERMIT_ALREADY_USED', '发送凭证已经使用');
          if (value.method !== proposal.method || value.paramsFingerprint !== proposal.paramsFingerprint || value.connectionEpoch !== proposal.connectionEpoch ||
              typeof value.wireKey !== 'string' || !value.wireKey || value.wireKey.length > 128 || !Number.isSafeInteger(value.requestSequence) || value.requestSequence <= 0) throw problem('WRITE_PERMIT_BINDING_MISMATCH', '发送字节与原提案绑定不一致');
          transaction(() => {
            check(proposal, module, 'before-send');
            dynamicState.beforeDispatch({ context: contextOf(proposal), proposal,
              binding: { requestSequence: value.requestSequence, connectionEpoch: value.connectionEpoch, wireKey: value.wireKey } });
            const changed = run(`UPDATE backend_send_permits SET consumed=1,consumed_at=?,wire_key=?,request_sequence=?
              WHERE permit_id=? AND consumed=0 AND operation_id=? AND connection_epoch=?`, nowIso(), value.wireKey, value.requestSequence, permitId, proposal.operationId, proposal.connectionEpoch).changes;
            if (changed !== 1) throw problem('WRITE_PERMIT_ALREADY_USED', '发送凭证已经使用');
            const claimAtMs = Date.now(), gapMs = randomInt(SEND_PACING_MIN_MS, SEND_PACING_MAX_MS + 1);
            run(`INSERT INTO backend_subject_send_pacing(subject_ref,last_permit_claim_ms,next_permit_claim_ms,gap_ms,process_ref,operation_id,updated_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject_ref) DO UPDATE SET
              last_permit_claim_ms=excluded.last_permit_claim_ms,next_permit_claim_ms=excluded.next_permit_claim_ms,gap_ms=excluded.gap_ms,
              process_ref=excluded.process_ref,operation_id=excluded.operation_id,updated_at=excluded.updated_at`,
            proposal.subjectRef, claimAtMs, claimAtMs + gapMs, gapMs, pacingProcessRef, proposal.operationId, nowIso());
            flight.pacingGapMs = gapMs;
            flight.consumed = true;
          });
          // Re-read the durable native STOP latch after the permit transaction
          // (which may fsync) and immediately before returning control to
          // world-transport's synchronous socket.send boundary. No await or
          // other JS work is allowed between this check and the send.
          contextCheck(proposal, { checkConfig: false });
          binding = Object.freeze({ wireKey: value.wireKey, requestSequence: value.requestSequence }); flight.byteSendStarted = true; return true;
        },
        dispatched(value) {
          if (!flight.consumed || !flight.byteSendStarted || !binding || value.method !== proposal.method ||
              value.connectionEpoch !== proposal.connectionEpoch || value.wireKey !== binding.wireKey ||
              value.requestSequence !== binding.requestSequence) return false;
          const dispatchedAtMs = Date.now(), dispatchedMono = monotonicNow(), gapMs = flight.pacingGapMs;
          if (!Number.isFinite(gapMs) || gapMs < SEND_PACING_MIN_MS || gapMs > SEND_PACING_MAX_MS) return false;
          const previous = lastSocketDispatch.get(proposal.subjectRef);
          pacingMonotonic.set(proposal.subjectRef, { nextMono: dispatchedMono + gapMs, gapMs, operationId: proposal.operationId });
          lastSocketDispatch.set(proposal.subjectRef, { atMs: dispatchedAtMs, mono: dispatchedMono, operationId: proposal.operationId });
          // This callback runs after ws.send() returned. Never turn a real send
          // into a retryable error because its pacing receipt could not persist.
          try { run(`UPDATE backend_subject_send_pacing SET last_socket_dispatch_ms=?,next_socket_dispatch_ms=?,updated_at=?
            WHERE subject_ref=? AND process_ref=? AND operation_id=?`, dispatchedAtMs, dispatchedAtMs + gapMs, nowIso(),
          proposal.subjectRef, pacingProcessRef, proposal.operationId); } catch { /* monotonic in-process anchor remains active */ }
          try { ledger.appendEvidence({ operationId: proposal.operationId, evidenceKey: 'socket-api-dispatch:v1',
            kind: 'socket-api-dispatch', source: 'backend/write-gateway/v2', payload: { traceId: proposal.traceId,
              operationId: proposal.operationId, processRef: pacingProcessRef, ownerRef: proposal.ownerRef,
              accountRef: String(proposal.accountRef), subjectRef: proposal.subjectRef, ownerEpoch: proposal.ownerEpoch,
              runEpoch: proposal.runEpoch, method: proposal.method,
              connectionEpoch: proposal.connectionEpoch, wireKey: binding.wireKey, requestSequence: binding.requestSequence,
              socketSendReturnedAtMs: dispatchedAtMs, socketSendReturnedMonotonicMs: dispatchedMono,
              previousDispatchOperationId: previous?.operationId || null,
              gapFromPreviousDispatchMs: previous ? Math.max(0, dispatchedMono - previous.mono) : null,
              pacingGapMs: gapMs, timeBasis: 'local-monotonic-after-socket-send-return-not-network-arrival' } }); }
          catch { /* evidence failure is diagnostic only; never make sent bytes retryable */ }
          return true;
        } });
      // The full final check remains inside permit.claim's transaction, after
      // this I/O turn. Do not run that expensive identical check twice in one
      // synchronous send stack. No yield occurs between claim and socket.send.
      await new Promise(resolve => setImmediate(resolve));
      ensureActive(); contextCheck(proposal);
      assertWriteAdmission(contextOf(proposal));
      beginFlightStage(flight, 'rpc-await', 15 * 60_000);
      const responsePromise = preparedFrame.send(permit); flight.sendReturned = true;
      if (!flight.consumed) {
        flight.bypass = true; blockedTransports.add(actor.connection); responsePromise?.catch?.(() => {});
        throw problem('WRITE_TRANSPORT_BYPASS', '传输未同步消费凭证，本连接已隔离', 500);
      }
      const reply = await responsePromise;
      if (!reply || reply.transport !== 'answered' || reply.method !== proposal.method || reply.connectionEpoch !== proposal.connectionEpoch ||
          reply.wireKey !== binding.wireKey || reply.requestSequence !== binding.requestSequence || typeof reply.responseRef !== 'string' || !reply.responseRef ||
          !Number.isSafeInteger(reply.receivedDeviceMs)) throw problem('WRITE_RESPONSE_BINDING_INVALID', '写回包未绑定原请求');
      matchedReply = reply; flight.answerMatched = true;
      ledger.recordTransport({ operationId: proposal.operationId, transportState: 'answered', evidence: evidence('official-answer', {
        method: proposal.method, responseRef: reply.responseRef, wireKey: reply.wireKey, requestSequence: reply.requestSequence,
        connectionEpoch: reply.connectionEpoch, rejected: reply.rejected === true, receivedDeviceMs: reply.receivedDeviceMs }) });
      // Stop/rebind may have won while the matching Promise was queued. Keep
      // its original answer, but do not enter a new read after that revocation.
      ensureActive(); contextCheck(proposal, { checkConfig: false });
      beginFlightStage(flight, 'independent-postread', 15 * 60_000);
      const verification = await module.verify({ proposal, response: reply, signal: flight.controller.signal, connection: Object.freeze({
        isOpen: () => {
          if (flight.revoked || flight.controller.signal.aborted) return false;
          if (!postReadBridge) return actor.connection.isOpen();
          try { return validateBridge().current === true; } catch { return false; }
        },
        ...(descriptor.domain !== 'land' && descriptor.metadata.postRead.kind === 'after-close-login' ? { readSnapshotAfterClose } : {}),
        read: async (method, args = {}) => {
          ensureActive(); contextCheck(proposal, { checkConfig: false });
          const currentDescriptor = boundDescriptor(proposal, module), read = currentDescriptor.metadata.postRead;
          if (read.kind === 'after-close-login') throw problem('WRITE_POST_READ_BRIDGE_REQUIRED', '本操作必须先真实关闭再经租约正常登录读取');
          if (method !== read.method || !plainObject(args) || fingerprint(args) !== fingerprint(read.args)) throw problem('WRITE_POST_READ_METHOD_NOT_CONTRACTED', '独立后读方法或参数不在本操作有限合同中');
          const observed = await inFlightStage(flight, 'same-connection-postread', 15 * 60_000,
            () => actor.connection.read(method, args, { after: { connectionEpoch: proposal.connectionEpoch,
              requestSequence: binding.requestSequence, wireKey: binding.wireKey, responseRef: reply.responseRef } }));
          touchFlightStage(flight);
          ensureActive(); contextCheck(proposal, { checkConfig: false });
          boundDescriptor(proposal, module);
          if (!observed || observed.method !== method || observed.transport !== 'answered' || observed.source !== 'response' ||
              observed.connectionEpoch !== proposal.connectionEpoch || !Number.isSafeInteger(observed.requestSequence) || observed.requestSequence <= binding.requestSequence ||
              typeof observed.wireKey !== 'string' || !observed.wireKey || typeof observed.responseRef !== 'string' || !observed.responseRef) throw problem('WRITE_POST_READ_BARRIER_INVALID', '独立后读不满足原写之后的新发屏障');
          if (descriptor.domain !== 'land' && synchronously(descriptor.validateResponseCoverage, { proposal, response: reply, observation: observed }) !== true) {
            throw problem('WRITE_POST_READ_COVERAGE_UNPROVEN', '本次独立后读未覆盖原订单与成品核验域');
          }
          approvedPostReads.add(observed.responseRef);
          postReads.push(observed); return observed;
        } }) });
      // A verifier cannot leave a private close/login in flight after returning
      // an early unknown result. It must drain before settlement/lease release.
      if (bridgePromise) await bridgePromise;
      if (!verification || !['confirmed', 'rejected', 'unknown'].includes(verification.verdict) || !verification.evidence ||
          !verification.verificationVersion || !Array.isArray(verification.resourceResolutions)) throw problem('WRITE_VERIFICATION_INCOMPLETE', '单目标写后核验缺少明确证据或资源结论');
      // A refusal exit is the one settled verdict that does not need a post-read:
      // the official answer for this exact request already stated the action was
      // refused, and the verification must carry that same binding. Any other
      // non-unknown verdict still has to cite a real independent read.
      const refusalExit = (() => {
        if (verification.verdict !== 'rejected' || verification.verificationVersion !== 'rewards/official-refusal/v1') return false;
        const refusal = verification.rejection;
        return !!refusal && refusal.version === 'rewards/official-refusal/v1' &&
          Number.isSafeInteger(refusal.msgCode) && Number.isSafeInteger(refusal.connectionEpoch) &&
          typeof refusal.officialText === 'string' && refusal.officialText.length > 0 && refusal.noticeOnly !== true &&
          (refusal.class === 'consumed' || refusal.class === 'refused') &&
          refusal.method === proposal.method && refusal.responseRef === matchedReply.responseRef &&
          refusal.wireKey === matchedReply.wireKey && refusal.requestSequence === matchedReply.requestSequence &&
          refusal.connectionEpoch === proposal.connectionEpoch && matchedReply.rejected === true &&
          matchedReply.envelopeOk === true && matchedReply.dsName === 'G.ISyncData';
      })();
      const postReadRef = verification.postReadRef ?? postReads.at(-1)?.responseRef;
      if (!refusalExit && verification.verdict !== 'unknown' && !postReads.some(observed => observed.responseRef === postReadRef && observed.envelopeOk === true &&
          observed.dsName === 'G.ISyncData' && observed.rejected !== true && approvedPostReads.has(observed.responseRef))) throw problem('WRITE_POST_READ_REQUIRED', '业务确认必须引用本写之后的真实独立已覆盖读取');
      if (descriptor.domain !== 'land' && !refusalExit) {
        boundDescriptor(proposal, module);
        if (postReadBridge) validateBridge({ requireCurrent: false, phase: 'settling' });
        if (verification.verdict !== 'unknown' && synchronously(descriptor.validateTargetVerification, {
          proposal, response: reply, verification, postReads: Object.freeze([...postReads]), bridge: postReadBridge, postReadBridge, postReadBridgeProof }) !== true) {
          throw problem('WRITE_TARGET_VERIFICATION_UNPROVEN', '原顾客订单的业务结果尚无有限合同确认');
        }
      }
      freeze(verification);
      const result = settle(verification, true); flight.durableOutcome = true; flight.reasonCode = 'WRITE_SETTLED'; return result;
    } catch (error) {
      flight.revoked = true; flight.reasonCode = codeOf(error);
      if (bridgeInFlight) {
        flight.controller.abort(problem('WRITE_POST_READ_VERIFICATION_ABORTED', '原操作核验已结束，未完成的关闭后登录必须收口'));
        try { await bridgePromise; } catch { /* Keep the original failure; the lease is released only after durable unknown settlement. */ }
      }
      try {
        if (!flight.prepared) {
          // A failed/uncertain commit poisons the store and this read fails. A
          // clean prepare rejection sent nothing and needs no result rewrite.
          if (preparing) get('SELECT operation_id FROM backend_operations WHERE operation_id=?', proposal.operationId);
          flight.durableOutcome = true;
        } else if (!flight.consumed && !flight.byteSendStarted && !flight.bypass) {
          ledger.markNotSent({ operationId: proposal.operationId, nonSendProof: { permitConsumed: false, byteSendStarted: false, source: 'same-process-permit-never-consumed' },
            evidence: evidence('blocked-before-send', { code: codeOf(error), sendReturned: flight.sendReturned }) });
          flight.durableOutcome = true;
          // A prepared-but-never-sent operation is deterministically retryable
          // as the same business opportunity. Tell the owning feature so its
          // private claim is retired with the shared not-sent proof instead of
          // lingering until the day changes. The durable not-sent record stays
          // authoritative even if a feature hook fails.
          if (flight.prepared) {
            try { synchronously(onNotSent, { proposal, context: flight.context, code: codeOf(error),
              operation: ledger.operation(proposal.operationId) }); }
            catch { /* claim retirement is recoverable; never resurrect a send */ }
          }
        } else {
          const operation = ledger.operation(proposal.operationId);
          if (operation.business_verdict === 'unverified') {
            if (!flight.answerMatched) ledger.recordTransport({ operationId: proposal.operationId, transportState: 'unknown', releaseWriteSlot: false,
              evidence: evidence('possible-send-unverified', { code: codeOf(error), permitId, consumedInProcess: flight.consumed, byteSendStarted: flight.byteSendStarted }) });
            const unknown = { verdict: 'unknown', reasonCode: codeOf(error), verificationVersion: 'backend/incomplete-single-target/v2',
              evidence: { code: codeOf(error), officialAnswerRetained: flight.answerMatched, permitId },
              resourceResolutions: operation.resources.map(resource => ({ resourceKey: resource.resource_key, state: 'historical_footprint' })) };
            try { settle(unknown, true); }
            catch (hookOrCommitError) {
              // Domain-hook failure must never erase the only durable unknown.
              // A poisoned/uncertain commit also rejects this fallback, and the
              // drain below then remains explicitly unconfirmed.
              settle(unknown, false);
            }
          }
          flight.durableOutcome = true;
        }
      } catch (persistenceError) {
        flight.durableOutcome = false; flight.reasonCode = 'WRITE_DURABILITY_UNCONFIRMED'; recordSubjectFault(flight, flight.reasonCode);
        if (actor?.connection) blockedTransports.add(actor.connection);
      }
      if (flight.prepared && (flight.consumed || flight.byteSendStarted || flight.bypass) && !flight.answerMatched) {
        try { synchronously(onTransportUncertain, { proposal, context: flight.context, code: codeOf(error), mayHaveSent: true }); }
        catch { /* Never claim physical close; root retains the unresolved slot. */ }
      }
      if (codeOf(error) === 'ASYNC_SEND_FENCE_FORBIDDEN') {
        flight.durableOutcome = false; flight.reasonCode = 'ASYNC_SETTLEMENT_NOT_DRAINED'; recordSubjectFault(flight, flight.reasonCode);
      }
      if (SUPERSEDED_BEFORE_SEND.has(codeOf(error))) {
        try {
          const receipt = supersessionReceipt(proposal, module, flight, codeOf(error));
          if (receipt) Object.defineProperty(error, 'preSendSupersession', { value: receipt, enumerable: false });
        } catch { /* Missing current evidence is never permission to retry. */ }
      }
      throw error;
    } finally {
      let leaseReleaseFailed = false;
      if (leaseAttempted) {
        try {
          const released = await postReadLease.releaseReadSnapshotLease({ leaseRef: leasePacket?.leaseRef ?? null,
            operationId: proposal.operationId, durableOutcome: flight.durableOutcome });
          if (flight.durableOutcome && released?.released !== true) throw problem('WRITE_POST_READ_LEASE_RELEASE_UNCONFIRMED', '跨连接后验租约尚未可靠释放');
        } catch {
          leaseReleaseFailed = true; flight.durableOutcome = false; flight.reasonCode = 'WRITE_POST_READ_LEASE_RELEASE_UNCONFIRMED';
          recordSubjectFault(flight, flight.reasonCode);
        }
      }
      if (flight.prepared && typeof module.finishTechnicalReview === 'function') {
        try { synchronously(module.finishTechnicalReview, { proposal }); }
        catch {
          flight.durableOutcome = false; flight.reasonCode = 'WRITE_TECHNICAL_REVIEW_CLOSE_UNCONFIRMED';
          recordSubjectFault(flight, flight.reasonCode);
        }
      }
      for (const remove of unlink) remove();
      const receipt = Object.freeze({ operationId: flight.prepared ? proposal.operationId : null, durableOutcome: flight.durableOutcome,
        consumed: flight.consumed, byteSendStarted: flight.byteSendStarted, reasonCode: flight.reasonCode });
      const previous = finished.get(contextKey(flight.context));
      if (!previous || previous.receipt.durableOutcome !== false) {
        finished.set(contextKey(flight.context), { context: flight.context, receipt, completion: flight.completion });
      }
      if (flights.get(proposal.subjectRef) === flight) flights.delete(proposal.subjectRef);
      resolveDone(receipt);
      if (leaseReleaseFailed) throw problem('WRITE_POST_READ_LEASE_RELEASE_UNCONFIRMED', '原业务账已保留，后验租约收尾仍待核实');
    }
  }
  const activity = ({ subjectRef } = {}) => {
    const flight = flights.get(subjectRef);
    return freeze({ inFlight: !!flight, operationId: flight?.operationId ?? null, durableOutcome: flight?.durableOutcome ?? null });
  };
  return Object.freeze({ propose, submit, revoke, activity, healthSnapshot, holdForProcessRecovery, releaseProcessRecoveryHold, recoverSubjectFaults });
}
