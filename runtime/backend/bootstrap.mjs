import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openBackendStore } from './persistence/store.mjs';
import { createSpaceMaintenance } from './persistence/space-maintenance.mjs';
import { recoverStorageImage, retireStorageImageBackup } from './migration/storage-image.mjs';
import { createBackendLedger } from './persistence/ledger.mjs';
import { hashLedgerBytes } from './persistence/json-contract.mjs';
import { createCredentialCipher } from './persistence/credential-cipher.mjs';
import { createAccountReaddRecovery } from './migration/account-readd.mjs';
import { createConfigService, CONFIG_FEATURE_IDS, CONFIG_FIELDS } from './config/index.mjs';
import { createConfigHistoryRetirement } from './config/retirement.mjs';
import { createLogHistoryRetirement } from './migration/log-retirement.mjs';
import { createFeatureRegistry } from './registry/index.mjs';
import { createSubjectSupervisor } from './session/supervisor.mjs';
import { createAccountRepository } from './session/accounts.mjs';
import { createNativeReconnectProjection } from './session/native-reconnect-projection.mjs';
import { createDeviceEgress } from './session/egress.mjs';
import { createReadOnlyInspection } from './session/inspection.mjs';
import { createInspectionRecovery } from './session/inspection-recovery.mjs';
import { createExecutionStateLedger } from './session/execution-state.mjs';
import { readLinuxProcessIdentity, compareNativeProcessIdentity } from './session/native-executor-identity.mjs';
import { createFactService } from './facts/service.mjs';
import { createDynamicStateCoordinator } from './facts/dynamic-state.mjs';
import { buildTypedDynamicCoverage } from './facts/typed-coverage.mjs';
import { createWaterwheelFacts } from './features/waterwheel/facts.mjs';
import { createWaterwheelRuntime } from './features/waterwheel/runtime.mjs';
import { createFreeWaterFacts } from './features/free-water/facts.mjs';
import { createFreeWaterRuntime } from './features/free-water/runtime.mjs';
import { createSpecialOrderFacts } from './features/special-orders/facts.mjs';
import { createSpecialOrderRuntime } from './features/special-orders/runtime.mjs';
import { SPECIAL_ORDER_DEFINITIONS } from './features/special-orders/rpc-contract.mjs';
import * as specialOrderTransport from './protocol/world-transport.mjs';
import { createRewardClaimFacts } from './features/rewards/facts.mjs';
import { createRewardRuntime } from './features/rewards/runtime.mjs';
import { CARD_BY_FEATURE, CLAIM_TABLE_NAMES } from './features/rewards/catalog.mjs';
import { createFlowerRackFacts } from './features/flower-rack/facts.mjs';
import { createFlowerRackPriceFacts } from './features/flower-rack/price-facts.mjs';
import { createFlowerRackRuntime } from './features/flower-rack/runtime.mjs';
import { createOfficialObservationIngestor, publicLoginProfile } from './facts/official-observations.mjs';
import { createScheduler, schedulerConsumerReplacementContracts } from './scheduler/service.mjs';
import { createOutboxConsumerRetirement } from './persistence/outbox-consumer-retirement.mjs';
import { createWriteGateway } from './execution/gateway.mjs';
import { createDebugStageHold } from './execution/debug-stage-hold.mjs';
import { createClosedWriteRecovery } from './execution/recovery.mjs';
import { createOfficialLandCatalogRegistry } from './features/land/catalog.mjs';
import { bindOfficialContract, OFFICIAL_CORE_CONTRACT_ID, officialContractCapability } from './official-version-profile.mjs';
import { bindOfficialServerVersionEvidence, SERVER_VERSION_PROTOCOL_CONTRACT, verifyOfficialServerVersionBinding }
  from './official-server-version-contract.mjs';
import { officialDataSnapshotForSourceVersion } from './official-data-snapshot.mjs';
import { createOfficialPublicDataCache } from './official-public-data.mjs';
import { createLandRuntime } from './features/land/runtime.mjs';
import { createCustomerReadModel } from './features/customer/projection.mjs';
import { createOfficialCustomerCatalog } from './features/customer/catalog.mjs';
import { createCustomerIdentity } from './features/customer/identity.mjs';
import { createCustomerHistoryRetirement } from './features/customer/history-retirement.mjs';
import { createCustomerAcceptance } from './features/customer/acceptance.mjs';
import { createCustomerAllocation } from './features/customer/allocation.mjs';
import { createCustomerRuntime } from './features/customer/runtime.mjs';
import { createCustomerGenerationFacts } from './features/customer/generation-facts.mjs';
import { evaluateCustomerGeneration } from './features/customer/generation.mjs';
import { createOfficialArtCatalog } from './features/art/catalog.mjs';
import { createArtRuntime } from './features/art/runtime.mjs';
import { createDailyArtRuntime } from './features/art/daily-runtime.mjs';
import { createCustomerArtBatchRuntime } from './features/art/customer-batch-runtime.mjs';
import { createArtFirstRewardRuntime } from './features/art/first-reward-runtime.mjs';
import { createOrderFlowerReadModel } from './features/order-flower/read-model.mjs';
import { ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS } from './features/order-flower/level-catalog.mjs';
import { createOfficialOrderFlowerCatalog } from './features/order-flower/catalog.mjs';
import { createOrderFlowerEligibility } from './features/order-flower/eligibility.mjs';
import { createOrderFlowerRuntime } from './features/order-flower/runtime.mjs';
import { composeOrderFlowerFeature } from './features/order-flower/composition.mjs';
import { createOrderFlowerAuxiliaryFacts } from './features/order-flower/auxiliary-facts.mjs';
import { createOrderFlowerAuxiliaryRuntime } from './features/order-flower/auxiliary-runtime.mjs';
import { createOrderFlowerVideoRequests } from './features/order-flower/video-request.mjs';
import { planOrderFlowerStock } from './features/order-flower/planning.mjs';
import { createSoftwareIdentity } from './software/index.mjs';
import { connectGame } from './protocol/world-transport.mjs';
import { createMigrationComposition } from './migration/composition.mjs';
import { createLegacyConstraints } from './migration/legacy-constraints.mjs';
import { createEgressReceiver } from './migration/egress-receiver.mjs';
import { createObservationLog, safeRecoveryPhase } from './observability/logs.mjs';
import { createCloudLogSync } from './observability/cloud-sync.mjs';
import { createLegacyLogging } from './observability/legacy-logging.mjs';
import { createLegacyHistory } from './observability/legacy-history.mjs';
import { createArchivedAccountReader } from './observability/archived-accounts.mjs';
import { readImportedEvidenceDigests } from './migration/evidence-digests.mjs';
import { createCurrentIsolationEvidence } from './migration/current-isolation.mjs';
import { createCurrentNeedLegacyPorts } from './execution/current-need-legacy-ports.mjs';
import { readCatalog, configCatalogs } from './compat/catalog.mjs';
import { BACKEND_BUILD_ID, BACKEND_SCHEMA_VERSION, BACKEND_STAGE } from './build-info.mjs';
import { canonical, fingerprint, newId, parseStored, plainObject, problem, safeBackendErrorPath } from './common.mjs';

const versionTextForTransport = value => typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+){1,5}$/.test(value);

export function createBackend({ dataDir, credentialKey, baseUrl, deviceProfilePath, stopFile,
  appVersion = '0.2.0-backend', appId = 'online.ainiannian.wujinxia' }) {
  if (appId !== 'online.ainiannian.wujinxia') throw problem('BACKEND_RELEASE_IDENTITY_INVALID', '新主干只能在独立新发行身份运行', 503);
  if (!path.isAbsolute(deviceProfilePath || '') || !fs.existsSync(deviceProfilePath)) throw problem('DEVICE_PROFILE_REQUIRED', '当前设备档案不可用', 503);
  recoverStorageImage({ dataDir });
  const store = openBackendStore({ dataDir });
  const executionStates = createExecutionStateLedger({ store });
  const officialPublicData = createOfficialPublicDataCache({ store });
  const storageInfo = store.get('SELECT sqlite_version() AS sqliteVersion,sqlite_source_id() AS sourceId');
  const ledger = createBackendLedger(store), cipher = createCredentialCipher(credentialKey), registry = createFeatureRegistry();
  const config = createConfigService({ store, appendOutbox: ledger.appendOutbox, catalogs: configCatalogs });
  const configHistoryRetirement = createConfigHistoryRetirement({ store, isQuiescent: context => {
    const actor = supervisor?.context(context.subjectRef);
    return actor?.isCurrent() === true && actor.ownerRef === context.ownerRef && actor.runEpoch === context.runEpoch &&
      actor.connectionEpoch === context.connectionEpoch && scheduler?.configurationHistoryQuiescent(context) === true &&
      gateway?.activity(context).inFlight === false && supervisor.verificationLease(context).active === false;
  } });
  const logs = createObservationLog({ store });
  const legacy = createLegacyConstraints({ store, cipher });
  const currentNeedLegacyPorts = createCurrentNeedLegacyPorts(legacy);
  const processGeneration = process.env.GARDEN_NATIVE_GENERATION || null;
  const processStartNonce = process.env.GARDEN_NATIVE_START_NONCE || null;
  const nativeTupleValid = typeof processGeneration === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(processGeneration) &&
    typeof processStartNonce === 'string' && /^[0-9a-f]{64}$/i.test(processStartNonce);
  const instanceId = nativeTupleValid ? processGeneration : newId();
  const initialProcessIdentity = readLinuxProcessIdentity(process.pid);
  let supervisor, scheduler, accounts, software, inspections, ingestor, gateway, dynamicState, landRuntime, waterwheelFacts, waterwheelRuntime, freeWaterFacts, freeWaterRuntime, specialOrderFacts, specialOrderRuntime, flowerRackFacts, flowerRackPriceFacts, flowerRackRuntime, dailyArtRuntime, customerArtBatchRuntime, artFirstRewardRuntime, customerRuntime, artRuntime, orderFlowerRuntime, orderFlowerAuxiliaryFacts, orderFlowerAuxiliaryRuntime, customerReadModel, customerGenerationFacts, customerIdentity, customerAcceptance, customerAllocation, orderFlowerReadModel, writeRecovery, rewardFacts, rewardRuntime,
    closing = false, draining = false, initialized = false, initializationError = null;
  let nativeReconnectProjection = null;
  let globalRecoveryHoldStartedMono = null;
  const globalRecoveryHeldSubjects = new Set();
  // Late-bound because the account repository is composed after the supervisor.
  let canonicalExecutionGuard = () => ({ enforced: false, reasonCode: 'OFFICIAL_SUBJECT_NOT_YET_OBSERVED' });
  const globalRecoveryDrainDeadlineMs = 15 * 60_000;
  const spaceMaintenance = createSpaceMaintenance({ store, isQuiescent: () => initialized && !draining && !closing &&
    !nativeStopLatchPending && !(stopFile && fs.existsSync(stopFile)) && !accounts?.verificationCount() && !inspections?.activeCount() &&
    gateway?.healthSnapshot().activeFlightCount === 0 && scheduler?.healthSnapshot().busyContexts.length === 0 });
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_engine_cleanup_incidents(
    incident_key TEXT PRIMARY KEY,target_json TEXT NOT NULL,started_at_ms INTEGER NOT NULL,
    restart_attempts INTEGER NOT NULL DEFAULT 0,next_restart_at_ms INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_engine_recovery_budgets(
    budget_key TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    restart_attempts INTEGER NOT NULL DEFAULT 0,next_restart_at_ms INTEGER NOT NULL DEFAULT 0,
    stable_since_ms INTEGER,stable_run_epoch INTEGER,stable_connection_epoch INTEGER,updated_at TEXT NOT NULL);`);
  const engineRestartTickets = new Map();
  const ENGINE_RESTART_TICKET_TTL_MS = 30_000;
  const engineCleanupIncident = row => store.get('SELECT * FROM backend_engine_cleanup_incidents WHERE incident_key=?', cleanupIncidentKey(row));
  function cleanupIncidentKey(row) {
    return fingerprint([row.ownerRef, String(row.accountRef), row.subjectRef, row.runEpoch, row.connectionEpoch]);
  }
  function cleanupBudgetKey(row) { return fingerprint([row.ownerRef, String(row.accountRef), row.subjectRef]); }
  function restartAuthorizationKey(report) {
    const identity = [report.instanceId, report.processGeneration, report.processStartNonce];
    // Account cleanup is account-scoped: it never authorizes a process-wide
    // restart. Only owner rebind, initialization failure or a provable shared
    // storage fault may escalate to the whole engine.
    if (report.ownerRestartRequired === true) return fingerprint({ kind: 'owner-rebind', identity, ownerRef: report.ownerRef });
    if (report.phase === 'failed') return fingerprint({ kind: 'initialization-failed', identity, code: report.code ?? null });
    if (report.phase === 'starting' || report.phase === 'binding') return fingerprint({ kind: report.phase, identity });
    if (report.databaseResponsive === false && report.responsive === true) return fingerprint({ kind: 'database-unhealthy', identity });
    return null;
  }
  let stopTimer = null, stopInFlight = null;
  let resumedIdentity = null;
  const inspectionRecovery = createInspectionRecovery({ store, appId });
  let nativeStopLatchPending = process.env.GARDEN_LOCAL_STOP_REQUESTED === '1';
  const nativeStopLatchId = process.env.GARDEN_LOCAL_STOP_LATCH_ID || '';
  let nativeStopReceipt = null;
  // Ordered device-level control records. A newer user start supersedes an
  // older STOP; the journal is a read-only projection Java can inspect before
  // it starts a passive engine, while SQLite remains the durable authority.
  const nativeControlUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const nativeControlJournalPath = path.join(dataDir, 'native-stop-control.json');
  function nativeControlRow() {
    try { return store.get('SELECT * FROM backend_native_stop_controls ORDER BY control_seq DESC LIMIT 1') || null; }
    catch { return null; }
  }
  function projectNativeControl(row) {
    if (!row) return { controlSeq: 0, commandId: '', kind: 'NONE', stopCommitted: false, cleanupComplete: false,
      scopeRef: '', sourceInstance: '', sourceGeneration: '', instanceRef: '', requestedAtMs: 0, recordedAt: null };
    return { controlSeq: Number(row.control_seq), commandId: row.command_id, kind: row.kind,
      stopCommitted: row.stop_committed === 1, cleanupComplete: row.cleanup_complete === 1, scopeRef: row.scope_ref,
      sourceInstance: row.source_instance, sourceGeneration: row.source_generation, instanceRef: row.instance_ref,
      requestedAtMs: Number(row.requested_at_ms), recordedAt: row.recorded_at };
  }
  function writeNativeControlJournal() {
    nativeReconnectProjection?.request();
    const text = canonical(projectNativeControl(nativeControlRow()));
    try {
      const temporary = nativeControlJournalPath + '.tmp';
      fs.writeFileSync(temporary, text);
      fs.renameSync(temporary, nativeControlJournalPath);
      return true;
    } catch {
      // A directory made read-only still permits truncating the existing
      // journal file; that is the path that keeps passive recovery fenced.
      try { fs.writeFileSync(nativeControlJournalPath, text); return true; }
      catch { return false; }
    }
  }
  function nativeControlFenceActive() {
    const latest = nativeControlRow();
    return Boolean(latest && latest.kind === 'STOP' && latest.stop_committed === 1);
  }
  function restoreNativeStopReceipt() {
    const row = store.get("SELECT * FROM backend_native_stop_controls WHERE kind='STOP' AND stop_committed=1 AND cleanup_complete=1 ORDER BY control_seq DESC LIMIT 1");
    if (!row) return;
    const latest = nativeControlRow();
    if (latest && latest.control_seq > row.control_seq) return;
    const control = projectNativeControl(row);
    let stored = null;
    try { stored = row.receipt_json ? parseStored(row.receipt_json, '本机停止收据') : null; }
    catch { stored = null; }
    // Preserve the instance and pid that actually performed the STOP. A new
    // engine must never present an old receipt as its own confirmation.
    nativeStopReceipt = { ...(stored || {}), latchId: control.commandId, commandId: control.commandId,
      stopCommitted: true, cleanupComplete: true, controlSeq: control.controlSeq,
      instanceId: stored?.instanceId || control.instanceRef, pid: Number.isSafeInteger(stored?.pid) ? stored.pid : 0 };
  }
  const seenStopRequests = new Set();
  const accountStopDirectory = typeof process.env.GARDEN_LOCAL_ACCOUNT_STOP_DIR === 'string' && path.isAbsolute(process.env.GARDEN_LOCAL_ACCOUNT_STOP_DIR)
    ? path.resolve(process.env.GARDEN_LOCAL_ACCOUNT_STOP_DIR) : null;
  const accountStopFlights = new Map(), invalidAccountStopRequests = new Set(), accountStopFileCursors = new Map();
  let accountStopConsumerPromise = null;
  let accountStopScopeCursor = '';
  const accountStopUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const accountStopTargetKey = ({ ownerRef, accountRef, subjectRef, officialUid }) => {
    if (typeof ownerRef !== 'string' || !ownerRef || typeof accountRef !== 'string' || !/^[1-9]\d{0,8}$/.test(accountRef) ||
        typeof subjectRef !== 'string' || !subjectRef || !Number.isSafeInteger(officialUid) || officialUid <= 0) return null;
    return crypto.createHash('sha256').update(`${ownerRef}\n${accountRef}\n${subjectRef}\n${officialUid}`, 'utf8').digest('hex');
  };
  function parseAccountStopRequest(filename, text) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(filename) ||
        typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4096) return null;
    let request;
    try { request = JSON.parse(text); } catch { return null; }
    const keys = ['latchId', 'commandId', 'ownerRef', 'accountRef', 'subjectRef', 'officialUid'];
    if (!plainObject(request) || Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) ||
        !accountStopUuid.test(request.latchId || '') || request.commandId !== request.latchId || filename !== request.latchId + '.json' ||
        typeof request.ownerRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.ownerRef) ||
        typeof request.accountRef !== 'string' || !/^[1-9]\d{0,8}$/.test(request.accountRef) ||
        typeof request.subjectRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.subjectRef) ||
         !Number.isSafeInteger(request.officialUid) || request.officialUid <= 0) return null;
    return request;
  }
  function readAccountStopFile(file, scopeKey = null) {
    const filename = path.basename(file);
    let text = null, readError = null;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { readError = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : 'READ_FAILED'; }
    return { file, text, scopeKey, request: text === null ? null : parseAccountStopRequest(filename, text), readError };
  }
  function accountStopRequests(limit = 16) {
    if (!accountStopDirectory) return [];
    let names;
    try { names = fs.readdirSync(accountStopDirectory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const scoped = names.filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/i.test(entry.name)).map(entry => entry.name).sort();
    const legacy = names.some(entry => entry.isFile() && accountStopUuid.test(entry.name.replace(/\.json$/i, '')) && entry.name.endsWith('.json'));
    const buckets = [...scoped, ...(legacy ? [''] : [])];
    if (!buckets.length) return [];
    const startIndex = Math.max(0, buckets.findIndex(key => key > accountStopScopeCursor));
    const orderedBuckets = [...buckets.slice(startIndex), ...buckets.slice(0, startIndex)];
    const filesByBucket = new Map();
    for (const scopeKey of orderedBuckets.slice(0, 64)) {
      const directory = scopeKey ? path.join(accountStopDirectory, scopeKey) : accountStopDirectory;
      let files;
      try { files = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json') && accountStopUuid.test(entry.name.slice(0, -5))).map(entry => entry.name).sort(); }
      catch (error) { if (error?.code === 'ENOENT') continue; filesByBucket.set(scopeKey, [{ file: directory, scopeKey, request: null, text: null, readError: 'DIRECTORY_READ_FAILED', directoryOnly: true }]); continue; }
      const cursor = accountStopFileCursors.get(scopeKey) || '';
      const next = files.findIndex(name => name > cursor);
      filesByBucket.set(scopeKey, next < 0 ? files : [...files.slice(next), ...files.slice(0, next)]);
    }
    const entries = [];
    let progressed = true;
    while (entries.length < limit && progressed) {
      progressed = false;
      for (const scopeKey of orderedBuckets.slice(0, 64)) {
        if (entries.length >= limit) break;
        const queue = filesByBucket.get(scopeKey);
        if (!queue?.length) continue;
        const name = queue.shift();
        if (name && typeof name === 'object') {
          entries.push(name);
          accountStopScopeCursor = scopeKey;
          progressed = true;
          continue;
        }
        const directory = scopeKey ? path.join(accountStopDirectory, scopeKey) : accountStopDirectory;
        const file = name.endsWith('.json') ? path.join(directory, name) : name;
        entries.push(readAccountStopFile(file, scopeKey || null));
        if (name.endsWith('.json')) accountStopFileCursors.set(scopeKey, name);
        accountStopScopeCursor = scopeKey;
        progressed = true;
      }
    }
    return entries;
  }
  function isAccountStopPending({ ownerRef, accountRef, subjectRef }) {
    const account = accounts.persistentStopIdentity(ownerRef, accountRef);
    const target = { ownerRef, accountRef: String(accountRef), subjectRef, officialUid: account.uid };
    const scopeKey = accountStopTargetKey(target);
    if (scopeKey) {
      const directory = path.join(accountStopDirectory || '', scopeKey);
      let names;
      try { names = fs.readdirSync(directory).filter(name => name.endsWith('.json') && accountStopUuid.test(name.slice(0, -5))); }
      catch (error) { if (error?.code === 'ENOENT') names = []; else return true; }
      for (const name of names) {
        const latchId = name.slice(0, -5), prior = accountStopAcknowledgement(latchId);
        if (prior && prior.owner_ref === target.ownerRef && prior.account_ref === target.accountRef &&
            prior.subject_ref === target.subjectRef && prior.official_uid === target.officialUid) continue;
        return true;
      }
    }
    // Read pre-scope latches by their complete body identity; malformed legacy
    // files have no target envelope and therefore cannot fence unrelated accounts.
    try {
      const legacyNames = fs.readdirSync(accountStopDirectory || '').filter(name => name.endsWith('.json') && accountStopUuid.test(name.slice(0, -5)));
      for (const name of legacyNames) {
        const entry = readAccountStopFile(path.join(accountStopDirectory, name));
        if (entry.request?.ownerRef === target.ownerRef && entry.request.accountRef === target.accountRef &&
            entry.request.subjectRef === target.subjectRef && entry.request.officialUid === target.officialUid) return true;
      }
    } catch (error) { if (error?.code !== 'ENOENT') return false; }
    return false;
  }
  function accountForStopScope(ownerRef, scopeKey) {
    if (!/^[0-9a-f]{64}$/i.test(scopeKey || '') || !ownerRef) return null;
    return accounts.listPersistentStopIdentities(ownerRef).find(account => accountStopTargetKey({ ownerRef: account.ownerRef,
      accountRef: String(account.accountRef), subjectRef: account.subjectRef, officialUid: account.uid }) === scopeKey) || null;
  }
  const waterwheelReadDiagnostics = new Set();
  const network = { online: null, transport: 'unknown' };
  const appendEvent = event => ledger.appendOutbox({ ...event, eventType: event.eventType || event.type,
    eventKey: event.eventKey || event.payload?.commandId || newId() });
  const log = (ownerRef, accountRef, message, level = 'info', detail = {}, category = '运行状态') => {
    if (!ownerRef) return;
    const code = detail.errorCode ?? detail.reasonCode ?? detail.reason ?? detail.code ?? null;
    logs.append({ ownerRef, accountRef, message, level, category, detail,
      eventType: detail.eventType ?? null, traceId: detail.traceId ?? null, operationId: detail.operationId ?? null,
      errorCode: typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : null,
      outcomeState: detail.outcomeState ?? detail.verdict ?? null, attempted: detail.attempted ?? null,
      runEpoch: detail.runEpoch ?? null, connectionEpoch: detail.connectionEpoch ?? null,
      phase: detail.phase ?? null, method: detail.method ?? null, retryAtMs: detail.retryAtMs ?? null });
  };
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_executor_isolation(
    subject_ref TEXT NOT NULL,evidence_ref TEXT NOT NULL UNIQUE,source_ref TEXT NOT NULL,proof_json TEXT NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(subject_ref,evidence_ref));
    CREATE TABLE IF NOT EXISTS backend_migration_pairings(
    pairing_ref TEXT PRIMARY KEY,target_owner_ref TEXT NOT NULL,source_owner_ref TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,source_authentication_json TEXT NOT NULL,target_authentication_ref TEXT NOT NULL,
    created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_device_settings(key TEXT PRIMARY KEY,value_cipher TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_native_stop_receipts(latch_id TEXT NOT NULL,instance_ref TEXT NOT NULL,pid INTEGER NOT NULL,
      receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(latch_id,instance_ref));
    CREATE TABLE IF NOT EXISTS backend_native_stop_controls(control_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,scope_ref TEXT NOT NULL,source_instance TEXT NOT NULL,
      source_generation TEXT NOT NULL,instance_ref TEXT NOT NULL,requested_at_ms INTEGER NOT NULL,
      stop_committed INTEGER NOT NULL,cleanup_complete INTEGER NOT NULL,receipt_json TEXT,recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_account_stop_acknowledgements(latch_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
      account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,receipt_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backend_official_public_resources(
      receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,
      source_response_ref TEXT NOT NULL,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_local_executors(
    executor_ref TEXT PRIMARY KEY,instance_ref TEXT NOT NULL,pid INTEGER NOT NULL,process_start_token TEXT,
    app_id TEXT NOT NULL,started_at TEXT NOT NULL,closed_at TEXT,process_boot_id TEXT);`);
  if (!store.all('PRAGMA table_info(backend_local_executors)').some(column => column.name === 'process_boot_id')) {
    store.run('ALTER TABLE backend_local_executors ADD COLUMN process_boot_id TEXT');
  }
  async function stopAll({ ownerRef = software?.ownerRef(), reasonCode = 'USER_STOPPED_ALL' } = {}) {
    if (!ownerRef) return { ok: true, stopCommitted: true, cleanupComplete: true, runningCount: 0, unconfirmed: false };
    const stopping = supervisor.stopAll(ownerRef, reasonCode);
    const cancelling = accounts?.cancelVerifications(ownerRef);
    const checking = inspections?.cancelAll(ownerRef);
    let timeout;
    const result = await Promise.race([Promise.all([stopping, cancelling, checking]), new Promise(resolve => {
      timeout = setTimeout(() => resolve(null), 13000);
    })]);
    clearTimeout(timeout);
    const stopped = result?.[0] || { ok: false, stopCommitted: true, cleanupComplete: false, runningCount: 0, unconfirmed: true };
    const recovery = inspectionRecovery.retireProvedDeadInspection({ ownerRef });
    const pending = (accounts?.verificationCount(ownerRef) || 0) + Math.max(inspections?.activeCount(ownerRef) || 0, recovery.remaining);
    return { ...stopped, ok: stopped.ok && pending === 0, cleanupComplete: stopped.ok && pending === 0,
      unconfirmed: stopped.unconfirmed || pending > 0, pendingVerifications: pending };
  }
  function installRefForControl() {
    try { return software?.status?.().installId || 'unbound'; }
    catch { return 'unbound'; }
  }
  function insertNativeControl({ commandId, kind, sourceInstance, sourceGeneration, requestedAtMs }) {
    store.transaction(() => {
      store.run(`INSERT INTO backend_native_stop_controls(command_id,kind,scope_ref,source_instance,source_generation,
        instance_ref,requested_at_ms,stop_committed,cleanup_complete,receipt_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,0,NULL,?)`,
        commandId, kind, 'device:' + installRefForControl(), sourceInstance, sourceGeneration, instanceId,
        requestedAtMs, kind === 'STOP' ? 1 : 0, store.nowIso());
      if (kind === 'STOP') {
        // Revocation is durable before any asynchronous drain begins.
        store.run("UPDATE backend_run_intents SET desired_running=0,run_epoch=run_epoch+1,state='STOPPING',reason_code='NATIVE_STOP_REQUESTED',updated_at=? WHERE desired_running=1", store.nowIso());
      }
    });
    nativeReconnectProjection?.request();
  }
  function nativeStopSupersededResult(row, commandId) {
    return { ok: false, commandId, stopCommitted: true, cleanupComplete: false, controlSeq: Number(row.control_seq),
      instanceId, superseded: true, pending: null, journalWritten: writeNativeControlJournal(),
      receipt: row.receipt_json ? parseStored(row.receipt_json, '本机停止收据') : null };
  }
  async function nativeStopAll(input = {}) {
    const commandId = String(input?.commandId || '');
    if (!nativeControlUuid.test(commandId)) throw problem('NATIVE_STOP_COMMAND_INVALID', '停止命令编号无效', 400);
    const sourceGeneration = typeof input.sourceGeneration === 'string' && /^[A-Za-z0-9-]{0,80}$/.test(input.sourceGeneration) ? input.sourceGeneration : '';
    const sourceInstance = typeof input.sourceInstance === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/.test(input.sourceInstance) ? input.sourceInstance : '';
    const requestedAtMs = Number.isSafeInteger(input.requestedAtMs) && input.requestedAtMs > 0 ? input.requestedAtMs : Date.now();
    let row = store.get('SELECT * FROM backend_native_stop_controls WHERE command_id=?', commandId);
    if (row && row.kind !== 'STOP') throw problem('NATIVE_STOP_COMMAND_CONFLICT', '该命令编号已属于其它控制记录', 409);
    if (row && row.cleanup_complete === 1) {
      const latest = nativeControlRow();
      return { ok: true, commandId, stopCommitted: true, cleanupComplete: true, controlSeq: Number(row.control_seq),
        instanceId, superseded: Boolean(latest && latest.control_seq > row.control_seq),
        journalWritten: writeNativeControlJournal(), receipt: row.receipt_json ? parseStored(row.receipt_json, '本机停止收据') : null };
    }
    if (row) {
      // A committed-but-not-drained STOP that has already been superseded is
      // a historical replay. It must not run a fresh drain over a newer start.
      const latestBefore = nativeControlRow();
      if (latestBefore && latestBefore.control_seq > row.control_seq) return nativeStopSupersededResult(row, commandId);
    }
    if (!row) {
      insertNativeControl({ commandId, kind: 'STOP', sourceInstance, sourceGeneration, requestedAtMs });
      row = store.get('SELECT * FROM backend_native_stop_controls WHERE command_id=?', commandId);
      writeNativeControlJournal();
    }
    {
      // Re-check immediately before the first drain so a user start that
      // arrived while this command was being recorded wins the ordering.
      const latestBeforeDrain = nativeControlRow();
      if (latestBeforeDrain && latestBeforeDrain.control_seq > row.control_seq) return nativeStopSupersededResult(row, commandId);
    }
    const owners = store.all('SELECT DISTINCT owner_ref FROM backend_subject_bindings').map(entry => entry.owner_ref);
    const receipts = await Promise.allSettled(owners.map(ownerRef => stopAll({ ownerRef, reasonCode: 'NATIVE_STOP_REQUESTED' })));
    const drained = receipts.every(result => result.status === 'fulfilled' && result.value.stopCommitted && result.value.cleanupComplete);
    let pending = 1;
    try {
      pending = (accounts?.verificationCount?.() || 0) +
        Math.max(inspections?.activeCount?.() || 0, inspectionRecovery.retireProvedDeadInspection({}).remaining);
    } catch { /* An unreadable pending count keeps cleanup incomplete. */ }
    const latest = nativeControlRow();
    const superseded = Boolean(latest && latest.control_seq > row.control_seq);
    // A newer user start owns the device now. This older STOP still reports
    // its own durable commitment, but it may not be presented as the final
    // device state or clear the newer decision.
    const cleanupComplete = !superseded && drained && pending === 0 &&
      !store.get('SELECT 1 FROM backend_run_intents WHERE desired_running=1 LIMIT 1') &&
      !store.get('SELECT 1 FROM backend_subject_owners WHERE active=1 LIMIT 1');
    const receipt = { latchId: commandId, commandId, stopCommitted: true, cleanupComplete,
      controlSeq: Number(row.control_seq), instanceId, pid: process.pid, superseded, pending };
    store.transaction(() => {
      store.run('UPDATE backend_native_stop_controls SET cleanup_complete=?,receipt_json=?,recorded_at=? WHERE command_id=?',
        cleanupComplete ? 1 : 0, canonical(receipt), store.nowIso(), commandId);
      store.run('INSERT OR REPLACE INTO backend_native_stop_receipts VALUES(?,?,?,?,?)',
        commandId, instanceId, process.pid, canonical(receipt), store.nowIso());
    });
    if (!superseded) nativeStopReceipt = receipt;
    const journalWritten = writeNativeControlJournal();
    return { ok: cleanupComplete, commandId, stopCommitted: true, cleanupComplete, controlSeq: Number(row.control_seq),
      instanceId, superseded, pending, journalWritten, receipt: { ...receipt, journalWritten } };
  }
  function nativeStartControl(input = {}) {
    const commandId = String(input?.commandId || '');
    if (!nativeControlUuid.test(commandId)) throw problem('NATIVE_START_COMMAND_INVALID', '用户启动命令编号无效', 400);
    const sourceGeneration = typeof input.sourceGeneration === 'string' && /^[A-Za-z0-9-]{0,80}$/.test(input.sourceGeneration) ? input.sourceGeneration : '';
    const sourceInstance = typeof input.sourceInstance === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/.test(input.sourceInstance) ? input.sourceInstance : '';
    const requestedAtMs = Number.isSafeInteger(input.requestedAtMs) && input.requestedAtMs > 0 ? input.requestedAtMs : Date.now();
    let row = store.get('SELECT * FROM backend_native_stop_controls WHERE command_id=?', commandId);
    if (row && row.kind !== 'USER_START') throw problem('NATIVE_START_COMMAND_CONFLICT', '该命令编号已属于其它控制记录', 409);
    if (!row) {
      insertNativeControl({ commandId, kind: 'USER_START', sourceInstance, sourceGeneration, requestedAtMs });
      row = store.get('SELECT * FROM backend_native_stop_controls WHERE command_id=?', commandId);
    }
    const journalWritten = writeNativeControlJournal();
    return { ok: true, commandId, kind: 'USER_START', controlSeq: Number(row.control_seq), instanceId,
      journalWritten, recordedAt: row.recorded_at };
  }
  async function suspendOwner(ownerRef, reasonCode = 'SOFTWARE_AUTHORIZATION_WAIT') {
    if (!ownerRef) return { ok: true, stopCommitted: true, cleanupComplete: true, suspended: true, runningCount: 0 };
    const result = await supervisor.suspendOwner(ownerRef, reasonCode);
    return { ...result, suspended: true };
  }
  software = createSoftwareIdentity({ store, cipher, baseUrl, stopAll, suspendOwner, onAuthorized: resumeQualifiedIntent, appVersion,
    log: event => log(software?.ownerRef(), '0', typeof event === 'string' ? event : '软件身份状态已更新', 'info') });
  let legacyHistory = null;
  const cloudSync = createCloudLogSync({ store, cloudRef: software.cloudRef, installId: software.installId, sourceInstallId: software.installId,
    appVersion, identity: software.status, sendLogs: software.sendLogsForOwner, network: () => network,
    labelForAccount: ({ ownerRef, accountRef }) => {
      if (accountRef === '0') return { nickname: '', serverName: '' };
      try { const found = accounts.publicAccount(ownerRef, accountRef); return { nickname: found.nickname, serverName: found.serverName }; }
      catch { return { nickname: '', serverName: '' }; }
    }, readHistoricalSource: input => legacyHistory?.manualUploadRow(input) || null });
  const legacyLogging = createLegacyLogging({ store, cipher, software, cloudSync });
  const logHistoryRetirement = createLogHistoryRetirement({ store, cloudRef: software.cloudRef, installId: software.installId,
    readRetention: () => legacyLogging.queueView()?.retention ?? null });
  legacyHistory = createLegacyHistory({ store, cipher, authorizeOwner: input => {
    software.authorize(input);
    return { authorized: true, ownerRef: software.ownerRef() };
  } });
  const archivedAccounts = createArchivedAccountReader({ store, authorizeOwner: input => {
    software.authorize(input);
    const identity = software.status();
    return { authorized: true, ownerRef: identity.ownerRef, identityEpoch: identity.identityEpoch };
  }, readers: {
    logs: input => legacyHistory.composePage({ ...input, currentLogs: logs }),
    'legacy-logs': input => ({ summary: legacyLogging.readAccount(input), ...legacyLogging.page(input) }),
    'migration-digests': input => readImportedEvidenceDigests({ ...input, store }),
    writes: input => {
      const limit = input.limit ?? 100, before = input.beforePreparedAt ?? null, beforeId = input.beforeOperationId ?? null;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw problem('ARCHIVED_WRITES_PAGE_INVALID', '历史操作页大小无效', 400);
      const where = ['owner_ref=?', 'subject_ref=?'], params = [input.ownerRef, input.subjectRef];
      if (before !== null || beforeId !== null) {
        if (typeof before !== 'string' || typeof beforeId !== 'string') throw problem('ARCHIVED_WRITES_CURSOR_INVALID', '历史操作游标字段不完整', 400);
        const anchor = store.get('SELECT prepared_at FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND operation_id=?', input.ownerRef, input.subjectRef, beforeId);
        if (!anchor || anchor.prepared_at !== before) throw problem('ARCHIVED_WRITES_CURSOR_INVALID', '历史操作游标不属于当前来源', 400);
        where.push('(prepared_at<? OR (prepared_at=? AND operation_id<?))'); params.push(before, before, beforeId);
      }
      const rows = store.all('SELECT operation_id,account_ref,method,feature_id,scope,business_verdict,transport_state,revision,config_revision,run_epoch,connection_epoch,prepared_at,updated_at FROM backend_operations WHERE ' + where.join(' AND ') + ' ORDER BY prepared_at DESC,operation_id DESC LIMIT ?', ...params, limit + 1);
      const selected = rows.slice(0, limit), historical = legacy.operationsPage({ ...input, limit: limit + 1 });
      return { scope: 'stable-subject-history', legacyEvidencePreserved: true,
        writes: selected.map(row => ({ operationId: row.operation_id, accountRef: row.account_ref,
        method: row.method, featureId: row.feature_id, scope: row.scope, status: row.business_verdict,
        transport: row.transport_state, verdict: row.business_verdict, revision: row.revision,
        configRevision: row.config_revision, runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch, updatedAt: row.updated_at })),
        page: { limit, hasMore: rows.length > limit, older: selected.length ? { beforePreparedAt: selected.at(-1).prepared_at, beforeOperationId: selected.at(-1).operation_id } : null },
        historical: historical.slice(0, limit).map(row => ({ ...row })), historicalPage: { limit, hasMore: historical.length > limit,
          afterOperationRef: historical.slice(0, limit).at(-1)?.operation_ref ?? input.afterOperationRef ?? null } };
    },
    configSnapshot: input => {
      const receipt = config.read(input);
      if (!receipt) throw problem('ARCHIVED_CONFIG_NOT_FOUND', '归档配置尚未保存，原资料已保留', 404);
      return { config: receipt.config, savedRevision: receipt.savedRevision, cancelEpoch: receipt.cancelEpoch,
        updatedAt: receipt.updatedAt, interpretationVersion: receipt.interpretationVersion,
        documentFingerprint: fingerprint(config.readDocument(input)), historical: true, effectiveNow: false };
    },
  } });
  const softwareStatus = () => {
    let queue;
    try {
      // The legacy cloud queue still ensures its cursor with INSERT OR IGNORE
      // while reading status. That optional projection must not consume the
      // control plane's lock budget or make the entire account roster fail.
      queue = store.inTransaction() ? legacyLogging.queueView() : store.withBusyTimeout(0, () => legacyLogging.queueView(), { maintenanceCommitRollback: true });
    } catch (error) {
      if (![5,6].includes(Number(error.errcode) & 255) && !/locked|busy/i.test(error.message || '')) throw error;
      queue = { available: false, current: false, reasonCode: 'LOCAL_STORAGE_BUSY', pending: null,
        uploadPolicy: { enabled: null, available: false, reasonCode: 'LOCAL_STORAGE_BUSY' } };
    }
    return { ...software.status(), queue, uploadPolicy: queue.uploadPolicy };
  };
  function owner() {
    const ownerRef = software.ownerRef();
    if (!ownerRef || !software.status().signedIn) throw problem('SOFTWARE_LOGIN_REQUIRED', '请先正常登录本项目的软件账号', 401);
    return ownerRef;
  }
  function isolation(subjectRef, previousOwner = null) {
    if (previousOwner?.active === 1) {
      const previous = store.get('SELECT * FROM backend_local_executors WHERE executor_ref=?', previousOwner.executor_ref);
      const currentIdentity = previous ? readLinuxProcessIdentity(previous.pid) : null;
      const exitState = previous ? compareNativeProcessIdentity({ pid: previous.pid, startToken: previous.process_start_token,
        bootId: previous.process_boot_id }, currentIdentity) : 'unproven';
      if (!previous || previous.app_id !== appId || process.env.GARDEN_LOCAL_NATIVE !== '1' || exitState !== 'exited') {
        throw problem('PREVIOUS_EXECUTOR_NOT_ISOLATED', '上一执行方尚未确认关闭，不能依据超时接管');
      }
      const evidenceRef = 'local-executor-exit:' + previous.executor_ref + ':' + previousOwner.owner_epoch;
      store.transaction(() => {
        store.run('INSERT OR IGNORE INTO backend_executor_isolation VALUES(?,?,?,?,?)', subjectRef, evidenceRef,
          'native-single-engine:' + appId, canonical({ stopped: true, currentInFlight: false, nativeExecutorExited: true, subjectRef,
            executorRef: previous.executor_ref, pid: previous.pid, previousProcessStartToken: previous.process_start_token,
            previousProcessBootId: previous.process_boot_id ?? null,
            currentProcessStartToken: currentIdentity.state === 'exited' ? 'exited' : currentIdentity.startToken,
            currentProcessBootId: currentIdentity.bootId, ownerEpoch: previousOwner.owner_epoch }), store.nowIso());
        store.run('UPDATE backend_subject_owners SET active=0,updated_at=? WHERE subject_ref=? AND executor_ref=? AND owner_epoch=?',
          store.nowIso(), subjectRef, previous.executor_ref, previousOwner.owner_epoch);
      });
      return { isolated: true, subjectRef, sourceRef: 'native-single-engine:' + appId, evidenceRef };
    }
    const row = store.get('SELECT * FROM backend_executor_isolation WHERE subject_ref=? ORDER BY created_at DESC LIMIT 1', subjectRef);
    if (!row) throw problem('PREVIOUS_EXECUTOR_NOT_ISOLATED', '该主体尚无来源停止与迁移栅栏证明');
    const proof = parseStored(row.proof_json, '迁移停止凭证');
    if (!(proof.sourceFenceCommitted === true || proof.nativeExecutorExited === true) || proof.currentInFlight !== false || proof.stopped !== true) throw problem('PREVIOUS_EXECUTOR_NOT_ISOLATED', '来源停止证明不完整');
    return { isolated: true, subjectRef, sourceRef: row.source_ref, evidenceRef: row.evidence_ref,
      ...(typeof proof.fenceRef === 'string' ? { sourceFenceRef: proof.fenceRef } : {}) };
  }
  const assertEgressStopped = () => {
    if (store.get('SELECT 1 FROM backend_run_intents WHERE desired_running=1 LIMIT 1') ||
        store.get('SELECT 1 FROM backend_subject_owners WHERE active=1 LIMIT 1') || accounts?.verificationCount() || inspections?.activeCount()) {
      throw problem('EGRESS_STOP_REQUIRED', '请先停止本机全部游戏连接和账号核对');
    }
  };
  const egress = createDeviceEgress({ store, cipher, assertStopped: assertEgressStopped });
  const proxy = egress.proxy;
  const configuration = context => config.read({ ownerRef: context.ownerRef, accountRef: String(context.accountRef) });
  const executionContext = context => Object.freeze(Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].map(key => [key, context[key]])));
  const compatibilityBindings = new WeakMap();
  const publicBindingDiagnostics = new Set();
  const logPublicBindingDiagnostic = (context, observation, stage, gates = {}) => {
    const responseRef = typeof observation?.responseRef === 'string' ? observation.responseRef : null;
    const key = `${context?.connectionEpoch}:${responseRef || 'missing'}:${stage}`;
    if (publicBindingDiagnostics.has(key)) return;
    publicBindingDiagnostics.add(key);
    if (publicBindingDiagnostics.size > 128) publicBindingDiagnostics.delete(publicBindingDiagnostics.values().next().value);
    const safeGates = Object.fromEntries(Object.entries(gates).filter(([name, value]) =>
      /^[A-Za-z][A-Za-z0-9]{0,48}$/.test(name) && (typeof value === 'boolean' || Number.isSafeInteger(value) ||
        typeof value === 'string' && value.length <= 96 && /^[A-Za-z0-9_.:-]+$/.test(value))));
    const failedGateNames = Object.entries(safeGates).filter(([, value]) => value === false).map(([name]) => name).slice(0, 32);
    const summary = Object.entries(safeGates).map(([name, value]) => `${name}=${String(value)}`).join('|').slice(0, 512);
    const actualReason = [safeGates.domainReason, safeGates.freeWaterReason, safeGates.customerReason, safeGates.replayReason, safeGates.reasonCode]
      .find(value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value));
    log(context.ownerRef, context.accountRef, '官服公开数据当前登录绑定阶段未通过；仅记录安全差异，不改变来源或准入。', 'info', {
      eventType: 'official-public-binding-diagnostic', method: 'index.login', connectionEpoch: context.connectionEpoch,
      ...(responseRef ? { responseRef } : {}), reasonCode: `OFFICIAL_PUBLIC_BIND_${stage.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`,
      sourcePath: `bootstrap.bindAndReplayCurrentLogin:${stage}`,
      ...(failedGateNames.length ? { failedGateNames } : {}), ...(summary ? { summary } : {}), ...(actualReason ? { reason: actualReason } : {}) });
  };
  const compatibilityEvidenceFields = Object.freeze(['profileBinding', 'contractId', 'dataSnapshotId', 'sourceDataVersion',
    'sourceProofs', 'staticArtifactRefs', 'dataSchemaContractId', 'tableHashes', 'resourceSha256', 'sourceIndexSha256', 'sourceConfigSha256',
    'reportedServerVersion', 'serverVersionBinding']);
  const projectCompatibilityEvidence = (versionEvidence, boundEvidence, context = null) => {
    if (!versionEvidence || !boundEvidence || versionEvidence.loginResponseRef !== boundEvidence.loginResponseRef ||
        versionEvidence.gameVersion !== boundEvidence.gameVersion) return versionEvidence;
    const reported = versionEvidence.reportedServerVersion ?? versionEvidence.protocolVersion;
    const boundReported = boundEvidence.reportedServerVersion ?? boundEvidence.serverVersionBinding?.reportedServerVersion ?? boundEvidence.protocolVersion;
    const reportMatches = reported === boundReported;
    const exactProtocol = versionEvidence.protocolVersion === boundEvidence.protocolVersion &&
      (!boundEvidence.serverVersionBinding || reportMatches);
    const semanticProtocol = !!context && verifyOfficialServerVersionBinding(boundEvidence.serverVersionBinding, {
      sourceVersion: boundEvidence.gameVersion, protocolVersion: boundEvidence.protocolVersion,
      reportedServerVersion: reported, loginResponseRef: versionEvidence.loginResponseRef, context,
      officialUid: boundEvidence.serverVersionBinding?.officialUid, bundleRef: boundEvidence.serverVersionBinding?.bundleRef });
    if ((!exactProtocol && !semanticProtocol) || semanticProtocol &&
        boundEvidence.profileBinding?.officialUid !== boundEvidence.serverVersionBinding?.officialUid) return versionEvidence;
    const projection = Object.fromEntries(compatibilityEvidenceFields.filter(key => Object.hasOwn(boundEvidence, key))
      .map(key => [key, boundEvidence[key]]));
    return { ...versionEvidence, ...projection, protocolVersion: boundEvidence.protocolVersion };
  };
  const currentContext = context => {
    const actor = supervisor?.context(context.subjectRef);
    // During process shutdown, already-admitted gateway operations retain
    // their exact context through matched response and post-read. New starts,
    // scheduling, and write permits are fenced by the supervisor drain flag.
    return Boolean(!closing && actor && actor.ownerRef === context.ownerRef && String(actor.accountRef) === String(context.accountRef) &&
      actor.subjectRef === context.subjectRef && actor.ownerEpoch === context.ownerEpoch && actor.runEpoch === context.runEpoch &&
      actor.connectionEpoch === context.connectionEpoch && actor.isCurrent() && software.ownerRef() === context.ownerRef &&
      software.status().authorized && !software.status().requiresEngineRestart);
  };
  const normalizeOfficialObservation = (context, rawObservation, activatedSnapshot = null) => {
    let versionEvidence = rawObservation?.method === 'index.login'
      ? rawObservation?.versionEvidence?.loginResponseRef === rawObservation?.responseRef ? rawObservation.versionEvidence : null
      : rawObservation?.versionEvidence || context.connection?.context?.versionEvidence || null;
    const boundContext = context.connection ? context : supervisor?.context(context.subjectRef);
    const sameBoundContext = boundContext && currentContext(context) && currentContext(boundContext) &&
      ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
        .every(key => boundContext[key] === context[key]);
    const boundEvidence = sameBoundContext && boundContext.connection
      ? compatibilityBindings.get(boundContext.connection) : null;
    versionEvidence = projectCompatibilityEvidence(versionEvidence, boundEvidence, executionContext(context));
    if (rawObservation?.method === 'index.login' && versionEvidence) {
      const loginIdentity = publicLoginProfile({ ...rawObservation, versionEvidence });
      const staticSnapshot = officialDataSnapshotForSourceVersion(versionEvidence.gameVersion);
      const sourceSnapshot = activatedSnapshot?.sourceVersion === versionEvidence.gameVersion ? activatedSnapshot : staticSnapshot;
      const reportedServerVersion = rawObservation.reportedServerVersion ?? versionEvidence.reportedServerVersion ??
        rawObservation.protocolVersion ?? versionEvidence.protocolVersion;
      const semanticProof = loginIdentity && sourceSnapshot?.validatedBundle === true
        ? officialPublicData.readServerVersionSemantics({ sourceKey: sourceSnapshot.sourceKey, sourceVersion: sourceSnapshot.sourceVersion,
          resourceSha256: sourceSnapshot.resourceSha256, baseDataSnapshotId: sourceSnapshot.dataSnapshotId, bundleRef: sourceSnapshot.bundleRef }) : null;
      const serverVersionBinding = semanticProof && versionTextForTransport(reportedServerVersion)
        ? bindOfficialServerVersionEvidence({ proof: semanticProof, bundleRef: sourceSnapshot.bundleRef, sourceVersion: sourceSnapshot.sourceVersion,
          dataSnapshotId: sourceSnapshot.dataSnapshotId, resourceSha256: sourceSnapshot.resourceSha256, reportedServerVersion,
          loginResponseRef: rawObservation.responseRef, context, officialUid: loginIdentity.uid }) : null;
      if (activatedSnapshot && !semanticProof) logPublicBindingDiagnostic(context, rawObservation, 'semantic-source-proof-missing', {
        snapshotPresent: !!sourceSnapshot, validatedBundle: sourceSnapshot?.validatedBundle === true,
        gameVersionEqual: sourceSnapshot?.sourceVersion === versionEvidence?.gameVersion,
        loginIdentityPresent: !!loginIdentity, reportedVersionPresent: !!versionTextForTransport(reportedServerVersion) });
      if (activatedSnapshot && semanticProof && !serverVersionBinding) logPublicBindingDiagnostic(context, rawObservation, 'semantic-evidence-bind-rejected', {
        proofPresent: true, bundleRefPresent: !!sourceSnapshot?.bundleRef, dataSnapshotIdPresent: !!sourceSnapshot?.dataSnapshotId,
        resourceSha256Present: /^[a-f0-9]{64}$/.test(sourceSnapshot?.resourceSha256 || ''),
        reportedVersionPresent: !!versionTextForTransport(reportedServerVersion), loginIdentityPresent: !!loginIdentity,
        contextCurrent: currentContext(context) });
      const contractVersionEvidence = serverVersionBinding
        ? { ...versionEvidence, protocolVersion: SERVER_VERSION_PROTOCOL_CONTRACT, reportedServerVersion, serverVersionBinding }
        : versionEvidence;
      const selected = loginIdentity && sourceSnapshot && bindOfficialContract(contractVersionEvidence, {
        ownerRef: context.ownerRef, accountRef: context.accountRef, subjectRef: context.subjectRef, officialUid: loginIdentity.uid,
        ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
        loginResponseRef: rawObservation.responseRef, dataSnapshotId: sourceSnapshot.dataSnapshotId });
      if (activatedSnapshot && loginIdentity && sourceSnapshot && !selected) logPublicBindingDiagnostic(context, rawObservation, 'profile-contract-bind-rejected', {
        semanticBindingPresent: !!serverVersionBinding, contractVersion: contractVersionEvidence.protocolVersion,
        snapshotIdPresent: !!sourceSnapshot.dataSnapshotId, loginRefEqual: contractVersionEvidence.loginResponseRef === rawObservation.responseRef,
        uidPresent: Number.isSafeInteger(loginIdentity.uid), contextCurrent: currentContext(context) });
      versionEvidence = selected ? { ...contractVersionEvidence, profileBinding: selected.binding,
        contractId: selected.profile.contractId, dataSnapshotId: sourceSnapshot.dataSnapshotId,
        sourceDataVersion: sourceSnapshot.sourceVersion,
        ...(sourceSnapshot.sourceProofs ? { sourceProofs: sourceSnapshot.sourceProofs,
          dataSchemaContractId: sourceSnapshot.dataSchemaContractId, tableHashes: sourceSnapshot.tableHashes,
          resourceSha256: sourceSnapshot.resourceSha256, sourceIndexSha256: sourceSnapshot.sourceIndexSha256,
          sourceConfigSha256: sourceSnapshot.sourceConfigSha256 } : {}),
        staticArtifactRefs: selected.profile.sourceRanges.map(range => range.name) }
        : { ...versionEvidence, contractId: null, dataSnapshotId: null, ...(activatedSnapshot ? { sourceProofs: activatedSnapshot.sourceProofs } : {}) };
    }
    return { ...rawObservation, reportedServerVersion: rawObservation.reportedServerVersion ?? rawObservation.protocolVersion ??
      versionEvidence?.reportedServerVersion ?? null, versionEvidence,
      receivedDeviceMs: Number.isSafeInteger(rawObservation?.receivedDeviceMs) ? rawObservation.receivedDeviceMs : Date.now() };
  };
  // Debug builds only: keep one bounded raw copy of the reward-relevant login
  // subtrees so field-index mistakes are found against the real frame instead of
  // guessed. Never stores credentials or the whole sync document.
  let rewardDebugReady = false;
  // Mail state is not part of index.login; the official client only gets it
  // from `mail.getList`. Fetch it once per connection (and once after the card
  // is enabled) instead of polling — the feature itself stays read-only here.
  const mailPrefetch = new Map();
  const scheduleMailPrefetch = context => {
    try {
      if (!context || !initialized || closing || !currentContext(context)) return false;
      const settings = configuration(context);
      if (settings?.config?.mail?.enabled !== true) return false;
      const key = context.subjectRef + ':' + context.connectionEpoch;
      if (mailPrefetch.has(key)) return false;
      mailPrefetch.set(key, Date.now());
      if (mailPrefetch.size > 64) mailPrefetch.delete(mailPrefetch.keys().next().value);
      // Bounded retries on the same connection; no polling loop and no reconnect.
      let attempt = 0;
      const runAttempt = () => {
        const timer = setTimeout(async () => {
          attempt += 1;
          try {
            const actor = supervisor.context(context.subjectRef);
            if (!actor || !actor.isCurrent() || actor.connectionEpoch !== context.connectionEpoch || !actor.connection?.isOpen()) return;
            await actor.connection.read('mail.getList', {});
          } catch {
            if (attempt < 3) runAttempt();
          }
        }, attempt === 0 ? 1200 : attempt === 1 ? 8000 : 25000);
        timer.unref?.();
      };
      runAttempt();
      return true;
    } catch { return false; }
  };
  const maybeMailPrefetch = ({ ownerRef, accountRef } = {}) => {
    try {
      const row = store.get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
      const actor = row ? supervisor.context(row.subject_ref) : null;
      if (!actor || !actor.isCurrent()) return false;
      const context = executionContext(actor);
      const key = context.subjectRef + ':' + context.connectionEpoch;
      mailPrefetch.delete(key);
      return scheduleMailPrefetch(context);
    } catch { return false; }
  };
  const taskCounterCellsFor = observation => {
    if (observation?.source !== 'response' || observation.transport !== 'answered' || observation.envelopeOk !== true ||
        observation.dsName !== 'G.ISyncData' || !plainObject(observation.value)) return null;
    const sync = observation.value, cells = {};
    const bounded = (value, limit = 128) => plainObject(value) && Object.keys(value).length <= limit
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => Number.isSafeInteger(v) || typeof v === 'boolean')
        .slice(0, limit)) : null;
    const taskTot = plainObject(sync['22']) ? sync['22'] : null;
    if (taskTot) {
      const tasks = {};
      for (const child of Object.values(taskTot)) {
        if (!plainObject(child)) continue;
        const keys = Object.keys(child);
        if (keys.includes('curTaskId')) {
          const main = bounded({ curTaskId: child['1'], curValue: child['2'], recvMap: bounded(child['4'], 256) }, 4);
          if (main && Number.isSafeInteger(main.curTaskId)) tasks.main = main;
          continue;
        }
        if (plainObject(child['100'])) {
          const taskMap = child['100'];
          const ids = Object.keys(taskMap).filter(key => /^\d{1,18}$/.test(key)).slice(0, 64);
          const rows = Object.fromEntries(ids.map(id => {
            const row = taskMap[id];
            const target = plainObject(row) ? (Number.isSafeInteger(row['1']) ? row['1'] : null) : null;
            return [id, target];
          }).filter(([, target]) => target !== null));
          const dly = bounded({ progress: bounded(child['1'], 128), recvMap: bounded(child['3'], 128),
            score: Number.isSafeInteger(child['4']) ? child['4'] : null,
            boxes: bounded(child['5'], 32), taskTargets: rows }, 6);
          if (dly) tasks.dly = dly;
          continue;
        }
        if (plainObject(child['3']) && plainObject(child['1'])) {
          const week = bounded({ progress: bounded(child['1'], 128), recvMap: bounded(child['3'], 128) }, 3);
          if (week) tasks.week = week;
        }
      }
      if (Object.keys(tasks).length) cells.tasks = tasks;
    }
    const user = plainObject(sync['7']) ? sync['7'] : null;
    if (user && plainObject(user['4'])) {
      const map = bounded(user['4'], 64);
      if (map) cells.counters = { cntMap: map };
    }
    if (!Object.keys(cells).length) return null;
    const source = { method: observation.method, responseRef: observation.responseRef,
      requestSequence: observation.requestSequence, connectionEpoch: observation.connectionEpoch,
      receivedDeviceMs: observation.receivedDeviceMs, receivedMonotonicMs: observation.receivedMonotonicMs };
    if (!Number.isSafeInteger(source.receivedDeviceMs) || !Number.isFinite(source.receivedMonotonicMs) ||
        !Number.isInteger(source.requestSequence) || typeof source.responseRef !== 'string') return null;
    return { cells, source };
  };
  let mailDebugReady = false;
  const recordMailDebugFrame = (context, observation) => {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1' || observation.method !== 'mail.getList' ||
        observation.envelopeOk !== true || !plainObject(observation.value)) return;
    if (!mailDebugReady) {
      store.db.exec(`CREATE TABLE IF NOT EXISTS backend_reward_debug_mail(
        owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,
        payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref));`);
      mailDebugReady = true;
    }
    const text = JSON.stringify(observation.value['19'] ?? observation.value);
    if (text.length > 524288) return;
    try {
      store.run(`INSERT OR REPLACE INTO backend_reward_debug_mail(owner_ref,subject_ref,connection_epoch,response_ref,payload_json,recorded_at)
        VALUES(?,?,?,?,?,?)`, context.ownerRef, context.subjectRef, context.connectionEpoch, observation.responseRef, text, store.nowIso());
    } catch { /* diagnostics only */ }
  };
  const mailDebugFrame = ({ ownerRef, subjectRef = null } = {}) => {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1') return null;
    try {
      const row = subjectRef
        ? store.get('SELECT subject_ref,connection_epoch,response_ref,payload_json,recorded_at FROM backend_reward_debug_mail WHERE owner_ref=? AND subject_ref=?', ownerRef, subjectRef)
        : store.get('SELECT subject_ref,connection_epoch,response_ref,payload_json,recorded_at FROM backend_reward_debug_mail WHERE owner_ref=? ORDER BY recorded_at DESC LIMIT 1', ownerRef);
      if (!row) return null;
      return { subjectRef: row.subject_ref, connectionEpoch: row.connection_epoch, responseRef: row.response_ref,
        recordedAt: row.recorded_at, payload: JSON.parse(row.payload_json) };
    } catch { return null; }
  };
  const recordRewardDebugFrame = (context, observation) => {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1' || observation.method !== 'index.login' ||
        observation.envelopeOk !== true || !plainObject(observation.value)) return;
    if (!rewardDebugReady) {
      store.db.exec(`CREATE TABLE IF NOT EXISTS backend_reward_debug_frames(
        owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,connection_epoch INTEGER NOT NULL,response_ref TEXT NOT NULL,
        frame_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,connection_epoch));`);
      rewardDebugReady = true;
    }
    const picked = {};
    for (const key of ['7', '19', '22', '25', '31', '101', '112', '113', '116', '118']) {
      const value = observation.value[key];
      if (value === undefined) continue;
      const text = JSON.stringify(value);
      if (text.length <= 262144) picked[key] = value;
    }
    try {
      store.run(`INSERT OR REPLACE INTO backend_reward_debug_frames(owner_ref,subject_ref,connection_epoch,response_ref,frame_json,recorded_at)
        VALUES(?,?,?,?,?,?)`, context.ownerRef, context.subjectRef, context.connectionEpoch, observation.responseRef,
      JSON.stringify(picked), store.nowIso());
    } catch { /* diagnostics never affect the business path */ }
  };
  // Coverage may only publish domains decoded from THIS observation. Reading the
  // whole head set would attribute an older response to the current frame.
  const rewardCoverageFor = (context, responseRef, allowDomains = null) => {
    try {
      const read = rewardFacts?.read(context);
      if (read?.current !== true) return null;
      const domains = Object.keys(read.values).filter(domain => read.sources[domain]?.responseRef === responseRef &&
        (!Array.isArray(allowDomains) || allowDomains.includes(domain)));
      if (!domains.length) return null;
      const pick = source => Object.fromEntries(domains.map(domain => [domain, source[domain]]));
      return { current: true, values: pick(read.values), sources: pick(read.sources) };
    } catch { return null; }
  };
  const ingestOfficialObservation = (context, normalizedObservation, identityEpoch, credential) => {
    const observation = { ...normalizedObservation };
    try {
      const profile = observation.source === 'late' ? null : publicLoginProfile(observation);
      if (profile) observation.currentIdentity = { verified: true, officialUid: profile.uid, responseRef: observation.responseRef };
      if (profile) accounts.recordOfficialIdentity({ ...context, identityEpoch, serverId: credential.serverId,
        uid: profile.uid, evidenceRef: observation.responseRef, sourceMethod: observation.method || 'index.login' });
      const observed = ingestor.ingest(context, observation);
      const domain = landRuntime.ingest({ context: executionContext(context), observation });
      const customerContext = executionContext(context);
      const customer = customerReadModel.ingest({ context: customerContext, observation });
      const customerView = customerReadModel.snapshot(customerContext);
      if (customerView.current) {
        const identityResult = customerIdentity.reconcile({ context: customerContext, view: customerView });
        if (identityResult?.accepted !== true && identityResult?.sourceIgnored !== true) log(context.ownerRef, context.accountRef,
          '顾客身份当前源未能更新；保留既有生命周期并继续等待新鲜来源。', 'info', {
            eventType: 'customer-identity-reconcile-deferred', method: observation.method || null,
            runEpoch: customerContext.runEpoch, connectionEpoch: customerContext.connectionEpoch,
            responseRef: typeof observation.responseRef === 'string' ? observation.responseRef : null,
            reasonCode: typeof identityResult?.reasonCode === 'string' ? identityResult.reasonCode : 'CUSTOMER_IDENTITY_RECONCILE_UNAVAILABLE' });
      }
      customerGenerationFacts.ingest({ context: customerContext, observation });
      const customerDay = customerGenerationFacts.read(customerContext);
      const waterwheelOperation = observation.operationId ? ledger.operation(observation.operationId)?.feature_id === 'waterwheel' : false;
      const waterwheel = waterwheelFacts && (observation.method === 'index.login' || observation.method === 'waterwheel.enter' ||
        ['waterwheel.recv', 'waterwheel.skip'].includes(observation.method) || observation.method === 'usr.share' && waterwheelOperation)
        ? waterwheelFacts.ingest({ context: customerContext, observation }) : null;
      const freeWaterScopes = { 'freeWater.recv': 'free-water-recv', 'usr.share': 'free-water-fallback' };
      const freeWaterOperationRow = observation.operationId && freeWaterScopes[observation.method] ? ledger.operation(observation.operationId) : null;
      const freeWaterOperation = freeWaterOperationRow?.feature_id === 'free-water' &&
        freeWaterOperationRow.operation_id === observation.operationId && freeWaterOperationRow.owner_ref === context.ownerRef &&
        freeWaterOperationRow.account_ref === String(context.accountRef) && freeWaterOperationRow.subject_ref === context.subjectRef &&
        hashLedgerBytes(freeWaterOperationRow.original_json) === freeWaterOperationRow.original_fingerprint &&
        freeWaterOperationRow.original?.ownerEpoch === context.ownerEpoch && freeWaterOperationRow.run_epoch === context.runEpoch &&
        freeWaterOperationRow.connection_epoch === context.connectionEpoch && freeWaterOperationRow.original?.featureId === 'free-water' &&
        freeWaterOperationRow.original?.method === observation.method && freeWaterOperationRow.original?.scope === freeWaterScopes[observation.method] &&
        freeWaterOperationRow.original?.operationId === observation.operationId;
      const freeWater = freeWaterFacts && (observation.method === 'index.login' || freeWaterOperation) &&
        (observation.method === 'index.login' || domain?.accepted === true)
        ? freeWaterFacts.ingest({ context: customerContext, observation }) : null;
      const rackScopes = { 'flowerRack.unlockStand': 'rack-unlock', 'flowerRack.sell': 'rack-sell',
        'flowerRack.recvSellMoney': 'rack-recv', 'flowerRack.cancelSell': 'rack-cancel' };
      const rackOperationRow = observation.operationId && rackScopes[observation.method] ? ledger.operation(observation.operationId) : null;
      const rackOperation = rackOperationRow?.feature_id === 'flower-rack' && rackOperationRow.operation_id === observation.operationId &&
        rackOperationRow.owner_ref === context.ownerRef && rackOperationRow.account_ref === String(context.accountRef) &&
        rackOperationRow.subject_ref === context.subjectRef && hashLedgerBytes(rackOperationRow.original_json) === rackOperationRow.original_fingerprint &&
        rackOperationRow.original?.ownerEpoch === context.ownerEpoch &&
        rackOperationRow.run_epoch === context.runEpoch && rackOperationRow.connection_epoch === context.connectionEpoch &&
        rackOperationRow.original?.featureId === 'flower-rack' && rackOperationRow.original?.method === observation.method &&
        rackOperationRow.original?.scope === rackScopes[observation.method] && rackOperationRow.original?.operationId === observation.operationId;
      const flowerRack = flowerRackFacts && (observation.method === 'index.login' || rackOperation && domain?.accepted === true)
        ? flowerRackFacts.ingest({ context: customerContext, observation }) : null;
      const flowerRackPrice = flowerRackPriceFacts && observation.method === 'index.login'
        ? flowerRackPriceFacts.ingest({ context: customerContext, observation }) : null;
      recordRewardDebugFrame(customerContext, observation);
      recordMailDebugFrame(customerContext, observation);
      if (observation.method === 'index.login') scheduleMailPrefetch(customerContext);
      // A reward decoder must never break the shared login observation (or the
      // connection). Failure degrades only these cards to waiting-facts.
      let rewardClaims = null;
      if (rewardFacts) {
        try {
          rewardClaims = rewardFacts.ingest({ context: customerContext, observation,
            officialUid: landRuntime.dynamicView(customerContext)?.identity?.uid?.state === 'known'
              ? landRuntime.dynamicView(customerContext).identity.uid.value : null });
        } catch (error) {
          rewardClaims = null;
          log(context.ownerRef, context.accountRef, '奖励卡片事实解码失败；其它功能继续，奖励卡片保持等待。', 'warn',
            { eventType: 'reward-claims-ingest-failed', reasonCode: typeof error?.code === 'string' ? error.code : 'REWARD_INGEST_FAILED',
              cause: String(error?.message || error).slice(0, 200), method: observation.method || null,
              connectionEpoch: context.connectionEpoch }, '状态核对');
        }
      }
      const waterwheelEnterAnchor = observation.method === 'waterwheel.enter'
        ? waterwheelRuntime?.recordEnterAnchor({ context: customerContext, observation, accepted: waterwheel?.accepted === true,
          sourceAccepted: domain?.accepted === true }) : null;
      if (observation.method === 'waterwheel.enter' && waterwheel?.accepted !== true && waterwheelEnterAnchor?.accepted !== true) {
        const diagnosticKey = `${context.subjectRef}:${context.connectionEpoch}:response`;
        if (!waterwheelReadDiagnostics.has(diagnosticKey)) {
          waterwheelReadDiagnostics.add(diagnosticKey);
          if (waterwheelReadDiagnostics.size > 16) waterwheelReadDiagnostics.delete(waterwheelReadDiagnostics.values().next().value);
          const sync = plainObject(observation.value) ? observation.value : null;
          const wheel = sync ? (sync['114'] ?? sync.waterwheel) : null;
          const rawUid = plainObject(wheel) ? (wheel.uid ?? wheel['0']) : undefined;
          const identity = landRuntime.dynamicView(customerContext)?.identity;
          const loginUid = identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known'
            ? identity.uid.value : null;
          const fieldNames = ['uid','count','advList','rTime','uTime','cTime','offlineNum','calcTime','maxNumTime'];
          const fieldTypes = fieldNames.map((name, index) => {
            const value = plainObject(wheel) ? (Object.hasOwn(wheel, name) ? wheel[name] : wheel[String(index)]) : undefined;
            return `${index}:${value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`;
          }).join(',');
          const wheelKeys = plainObject(wheel) ? Object.keys(wheel).filter(key => /^(?:[0-8]|[A-Za-z][A-Za-z0-9]{0,15})$/.test(key)).slice(0, 18).join(',') : '';
          const diagnosticPath = `114Present=${plainObject(wheel)};keys=${wheelKeys};types=${fieldTypes};uidMatchesLogin=${Number.isSafeInteger(rawUid) && Number.isSafeInteger(loginUid) ? rawUid === loginUid : 'unknown'}`;
          log(context.ownerRef, context.accountRef, '水车读取已收到响应，但没有形成可用的水车事实；功能保持等待。', 'info', {
            eventType: 'waterwheel-source-diagnostic', method: observation.method, connectionEpoch: context.connectionEpoch,
            ...(Number.isSafeInteger(observation.requestSequence) ? { requestSequence: observation.requestSequence } : {}),
            ...(typeof observation.responseRef === 'string' ? { responseRef: observation.responseRef } : {}),
            ...(typeof observation.dsName === 'string' ? { sourceNamespace: observation.dsName } : {}),
            ok: observation.envelopeOk === true, sourcePath: diagnosticPath,
            ...(typeof waterwheel?.reasonCode === 'string' ? { reasonCode: waterwheel.reasonCode } : {}),
          }, '状态核对');
        }
      }
      const flowerOrders = orderFlowerReadModel.ingest({ context: customerContext, observation });
      const flowerView = currentOrderFlowerView(customerContext);
      const flowerAuxiliary = orderFlowerAuxiliaryFacts.ingest({ context: customerContext, observation,
        acceptedProjection: domain?.accepted === true || customer?.accepted === true || flowerOrders?.accepted === true,
        flowerView, customerView });
      const flowerAuxiliaryView = orderFlowerAuxiliaryFacts.read(customerContext);
      const specialDefinition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.method === observation.method);
      const specialRow = specialDefinition && observation.operationId ? ledger.operation(observation.operationId) : null;
      const specialWrite = !!specialRow && specialRow.feature_id === specialDefinition.featureId && specialRow.owner_ref === context.ownerRef &&
        specialRow.account_ref === String(context.accountRef) && specialRow.subject_ref === context.subjectRef &&
        hashLedgerBytes(specialRow.original_json) === specialRow.original_fingerprint && specialRow.original?.ownerEpoch === context.ownerEpoch &&
        specialRow.run_epoch === context.runEpoch && specialRow.connection_epoch === context.connectionEpoch &&
        specialRow.original?.method === observation.method && specialRow.original?.scope === specialDefinition.scope &&
        specialRow.original?.operationId === observation.operationId;
      const specialOrders = specialOrderFacts && (observation.method === 'index.login' || specialWrite ||
        observation.method === 'orderPalace.enter' && !observation.operationId || observation.method === 'usr.heartTick' && domain?.accepted === true)
        ? specialOrderFacts.ingest({ context: customerContext, observation }) : null;
      // A mail.getList frame carries only module 19. Other models may accept it
      // from prior sources, so their coverage is suppressed explicitly rather
      // than misattributed to this response.
      const mailReadOnly = observation.method === 'mail.getList';
      // A write response can carry unrelated modules. Publish reward coverage
      // only for the domains this operation can affect; a login publishes all.
      const rewardWriteCard = () => {
        if (!observation.operationId) return null;
        try {
          const operation = ledger.operation(observation.operationId);
          return operation ? CARD_BY_FEATURE[operation.feature_id] || null : null;
        } catch { return null; }
      };
      const writeCard = rewardWriteCard();
      const rewardCoverageDomains = () => writeCard ? writeCard.domains : null;
      const suppressOtherCoverage = mailReadOnly || Boolean(writeCard);
      const dynamicObservation = dynamicState?.observe({ context: customerContext, observation,
        acceptedLandObservation: suppressOtherCoverage ? false : domain?.accepted === true,
        coverage: buildTypedDynamicCoverage(customerContext, observation, { land: suppressOtherCoverage ? null : domain,
          landView: suppressOtherCoverage ? null : landRuntime.dynamicView(customerContext),
          customer: suppressOtherCoverage ? null : customer, customerView: suppressOtherCoverage ? null : customerReadModel.snapshot(customerContext),
          flowerOrders: suppressOtherCoverage ? null : flowerOrders, flowerView: suppressOtherCoverage ? null : flowerView,
          flowerAuxiliary: suppressOtherCoverage ? null : flowerAuxiliaryView, customerDay,
          officialClock: suppressOtherCoverage ? null : facts.clock(context.subjectRef),
          waterwheel: suppressOtherCoverage ? false : waterwheel?.accepted === true,
          freeWater: suppressOtherCoverage ? false : freeWater?.accepted === true,
          flowerRack: suppressOtherCoverage ? null : flowerRack,
          taskCounters: suppressOtherCoverage ? null : taskCounterCellsFor(observation),
          rewardClaims: rewardClaims?.accepted === true ? rewardCoverageFor(customerContext, observation.responseRef, rewardCoverageDomains()) : null,
          flowerRackView: flowerRackFacts.read(customerContext), flowerRackPrice: flowerRackPriceFacts.read(customerContext),
          specialOrders: suppressOtherCoverage ? null : specialOrders, specialOrderViews: specialOrders?.accepted && !suppressOtherCoverage ? Object.fromEntries(specialOrders.kinds.map(kind => [kind, specialOrderFacts.read(customerContext, kind)])) : {} }) });
      if (customer?.changed) appendEvent({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'FactsChanged',
        eventKey: 'customer:' + customer.observationRef + ':' + customer.revision,
        payload: { domain: 'customer', responseRef: observation.responseRef, revision: customer.revision,
          connectionEpoch: context.connectionEpoch } });
      if (flowerOrders?.changed) appendEvent({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, eventType: 'FactsChanged',
        eventKey: 'order-flower:' + flowerOrders.observationRef + ':' + flowerOrders.revision,
        payload: { domain: 'order-flower', responseRef: observation.responseRef, revision: flowerOrders.revision,
          connectionEpoch: context.connectionEpoch } });
      if (observed.changed || domain?.changed || customer?.changed || flowerOrders?.changed || waterwheel?.changed || freeWater?.changed ||
          flowerRack?.changed || flowerRackPrice?.changed || waterwheelEnterAnchor?.changed || specialOrders?.changed || rewardClaims?.changed || dynamicObservation?.changed) scheduler?.notify(context);
      return { observed, domain, customer, flowerOrders, flowerAuxiliary, waterwheel, freeWater, flowerRack, flowerRackPrice,
        specialOrders, rewardClaims, dynamicObservation };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'OFFICIAL_OBSERVATION_FAILED';
      const path = safeBackendErrorPath(error);
      const rawDetails = plainObject(error?.details) ? error.details : null;
      const safePathValue = value => typeof value === 'string' && value.length <= 192 && /^[A-Za-z0-9._*\[\]-]+$/.test(value);
      let differenceTruncated = rawDetails?.truncated === true;
      const boundedPaths = (value, key) => {
        if (!Array.isArray(value)) return undefined;
        if (value.length > 16) differenceTruncated = true;
        const valid = value.filter(safePathValue).slice(0, 16);
        if (valid.length !== Math.min(value.length, 16)) differenceTruncated = true;
        return valid;
      };
      const changedPaths = Array.isArray(rawDetails?.changedPaths) ? rawDetails.changedPaths.slice(0, 16).flatMap(one => {
        const valid = plainObject(one) && safePathValue(one.path) &&
          (one.storedFingerprint === null || /^[a-f0-9]{64}$/.test(one.storedFingerprint || '')) &&
          (one.currentFingerprint === null || /^[a-f0-9]{64}$/.test(one.currentFingerprint || ''));
        if (!valid) { differenceTruncated = true; return []; }
        return [{ path: one.path, storedFingerprint: one.storedFingerprint, currentFingerprint: one.currentFingerprint }];
      }) : undefined;
      if (Array.isArray(rawDetails?.changedPaths) && rawDetails.changedPaths.length > 16) differenceTruncated = true;
      const removedPaths = boundedPaths(rawDetails?.removedPaths, 'removedPaths');
      const addedPaths = boundedPaths(rawDetails?.addedPaths, 'addedPaths');
      const stackPathValid = value => typeof value === 'string' && value.length <= 512 &&
        /^(?:backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+)(?: > backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+){0,5}$/.test(value);
      const safeDifference = rawDetails ? {
        ...(typeof rawDetails.domainId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(rawDetails.domainId) ? { domainId: rawDetails.domainId } : {}),
        ...(typeof rawDetails.difference === 'string' && /^[a-z0-9-]{1,64}$/.test(rawDetails.difference) ? { difference: rawDetails.difference } : {}),
        ...(changedPaths ? { changedPaths } : {}), ...(removedPaths ? { removedPaths } : {}), ...(addedPaths ? { addedPaths } : {}),
        ...(typeof rawDetails.rawAnchorMatches === 'boolean' ? { rawAnchorMatches: rawDetails.rawAnchorMatches } : {}),
        ...(typeof rawDetails.priorProjectionReceiptAvailable === 'boolean' ? { priorProjectionReceiptAvailable: rawDetails.priorProjectionReceiptAvailable } : {}),
        ...(typeof rawDetails.proofAdvanced === 'boolean' ? { proofAdvanced: rawDetails.proofAdvanced } : {}),
        ...(differenceTruncated ? { truncated: true } : {}) } : null;
      const logDetails = { code, method: typeof observation.method === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(observation.method) ? observation.method : null,
        connectionEpoch: context.connectionEpoch, ...(stackPathValid(path) ? { path } : {}),
        ...(safeDifference && Object.keys(safeDifference).length ? safeDifference : {}) };
      if (Buffer.byteLength(JSON.stringify(logDetails), 'utf8') > 4000) {
        delete logDetails.changedPaths; delete logDetails.removedPaths; delete logDetails.addedPaths;
        logDetails.truncated = true;
      }
      if (Buffer.byteLength(JSON.stringify(logDetails), 'utf8') > 4000) delete logDetails.path;
      try { log(context.ownerRef, context.accountRef, '本次官服事实解码未完成：' + code, 'error', logDetails); } catch { /* Preserve the original observation failure. */ }
      throw error;
    }
  };
  const resourceBaselineObservations = new Map();
  const registerResourceBaselineMaintenance = (context, key, baselineState) => {
    const baselineRef = baselineState?.resourceBaselineRef;
    if (typeof baselineRef !== 'string' || !baselineRef) return false;
    const registeredContext = executionContext(context);
    const sameAxes = candidate => candidate && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
      .every(axis => candidate[axis] === registeredContext[axis]);
    const live = candidate => {
      if (!candidate || candidate.signal?.aborted || resourceBaselineObservations.get(key) !== baselineState ||
          baselineState.resourceBaselineRef !== baselineRef || !sameAxes(candidate.context)) return false;
      return currentContext(candidate.context) === true;
    };
    return scheduler.registerMaintenance(context, { taskKey: 'resource-budget-baseline',
      sourceKey: 'resource-budget-baseline:' + fingerprint([context.ownerRef, String(context.accountRef), context.subjectRef, baselineRef]),
      sourceVersion: '1.0', refreshNow: true, retryBaseMs: 1000, retryMaxMs: 300000, successIntervalMs: 1800000,
      run: async ({ context: activeContext, signal }) => {
        let scanned = 0, linkedResources = 0, operations = 0, hasPending = false, hasMore = false, sweepComplete = false;
        for (let unit = 0; unit < 4; unit += 1) {
          await new Promise(resolve => setImmediate(resolve));
          const liveContext = { context: activeContext, signal };
          if (!live(liveContext)) return { reasonCode: 'RESOURCE_BASELINE_RECONCILIATION_STALE', successIntervalMs: 30000,
            scanned, linkedResources, operations, hasMore: true, hasPending: true, sweepComplete: false };
          const result = store.withBusyTimeout(0, () => ledger.reconcileCurrentResourceBaseline({ context: executionContext(activeContext), baselineRef,
            isCurrent: () => live(liveContext) }), { maintenanceCommitRollback: true });
          operations += 1;
          if (result.current !== true) return { reasonCode: 'RESOURCE_BASELINE_RECONCILIATION_STALE', successIntervalMs: 30000,
            scanned, linkedResources, operations, hasMore: true, hasPending: true, sweepComplete: false };
          scanned += Number(result.scanned || 0);
          linkedResources += Number(result.linkedResources || 0);
          hasPending = result.hasPending === true;
          hasMore = result.hasMore === true;
          sweepComplete = result.sweepComplete === true;
          if (sweepComplete || !hasMore) break;
        }
        const stillLive = live({ context: activeContext, signal });
        if (!stillLive) return { reasonCode: 'RESOURCE_BASELINE_RECONCILIATION_STALE', successIntervalMs: 30000,
          scanned, linkedResources, operations, hasMore: true, hasPending: true, sweepComplete: false };
        if (linkedResources > 0 && stillLive) {
          scheduler.notify(activeContext, ['inventory']);
          log(activeContext.ownerRef, activeContext.accountRef,
            '已更新当前资源预算核对；历史操作结果和资源足迹保持原样。', 'info',
            { baselineRef, scanned, linkedResources, operations, noGameRequestSent: true, accountingOnly: true,
              outcomeProven: false, resourceCoverageProven: false });
        }
        const reasonCode = hasMore && !sweepComplete ? 'RESOURCE_BASELINE_RECONCILIATION_CONTINUES'
          : hasPending ? 'RESOURCE_BASELINE_RECONCILIATION_PENDING' : 'RESOURCE_BASELINE_RECONCILIATION_COMPLETE';
        return { reasonCode, successIntervalMs: hasMore && !sweepComplete ? 1000 : (hasPending ? 30000 : 1800000),
          scanned, linkedResources, operations, hasMore, hasPending, sweepComplete };
      } });
  };
  const recordBoundLoginResources = (context, observation, uid, { registerMaintenance = false } = {}) => {
    const key = canonical([context.ownerRef, String(context.accountRef), context.subjectRef]);
    const stateKey = canonical([context.ownerRef, String(context.accountRef), context.subjectRef, context.ownerEpoch,
      context.runEpoch, context.connectionEpoch, observation.responseRef]);
    let baselineState = resourceBaselineObservations.get(key);
    if (!baselineState || baselineState.key !== stateKey) {
      baselineState = { key: stateKey, resourceBaselineRef: '', currencyRecorded: false };
      resourceBaselineObservations.set(key, baselineState);
    }
    if (!baselineState.resourceBaselineRef) {
      const resourceBaseline = ledger.recordCurrentResourceBaseline({ context: executionContext(context),
        responseRef: observation.responseRef, requestSequence: observation.requestSequence,
        connectionEpoch: context.connectionEpoch, executorIsolation: context.executorIsolation, officialUid: uid,
        versionEvidence: observation.versionEvidence });
      if (resourceBaseline.recorded) baselineState.resourceBaselineRef = resourceBaseline.baselineRef;
      if (resourceBaseline.recorded) log(context.ownerRef, context.accountRef,
        '已按本人完整背包建立当前资源核对基准；旧占用在后台逐笔核对，历史操作证据保持原样。', 'info',
        { baselineRef: resourceBaseline.baselineRef, operationWatermark: resourceBaseline.operationWatermark, replayed: resourceBaseline.replayed });
      else log(context.ownerRef, context.accountRef, '当前登录未满足历史资源占用隔离条件，仍按原资源足迹保守核算。', 'info',
        { reasonCode: resourceBaseline.reasonCode || 'RESOURCE_BASELINE_NOT_RECORDED' });
    }
    if (!baselineState.currencyRecorded) {
      const currencyBaseline = ledger.recordCurrentCurrencyBaseline({ context: executionContext(context),
        responseRef: observation.responseRef, requestSequence: observation.requestSequence,
        connectionEpoch: context.connectionEpoch, executorIsolation: context.executorIsolation, officialUid: uid,
        versionEvidence: observation.versionEvidence });
      if (currencyBaseline.recorded) baselineState.currencyRecorded = true;
      if (currencyBaseline.recorded) log(context.ownerRef, context.accountRef,
        '已按本次本人登录的金币绝对值建立共享货币预算基线；历史操作原账保持不变。', 'info',
        { baselineRef: currencyBaseline.baselineRef, linkedResources: currencyBaseline.linkedResources || 0 });
    }
    if (!baselineState.yuanbaoRecorded && store.get(`SELECT 1 AS found FROM backend_resource_budget_active a
      JOIN backend_operation_resources r ON r.operation_id=a.operation_id AND r.resource_key=a.resource_key
      WHERE a.owner_ref=? AND a.subject_ref=? AND ((a.resource_kind='currency' AND r.resource_ref='currency:yuanbao')
        OR (a.resource_kind='item' AND r.resource_ref='item:1')) LIMIT 1`,
    context.ownerRef, context.subjectRef)) {
      const result = ledger.recordCurrentCurrencyBaseline({ context: executionContext(context), currency: 'yuanbao',
        responseRef: observation.responseRef, requestSequence: observation.requestSequence, connectionEpoch: context.connectionEpoch,
        executorIsolation: context.executorIsolation, officialUid: uid, versionEvidence: observation.versionEvidence });
      if (result.recorded) baselineState.yuanbaoRecorded = true;
    }
    if (registerMaintenance && baselineState.resourceBaselineRef) registerResourceBaselineMaintenance(context, key, baselineState);
    const coverage = landRuntime.resources.reconcileOrderFlowerCoverage({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
      limit: 1, beginScanIfIdle: true });
    if (coverage.scanned || coverage.appended || coverage.blocked?.length || coverage.hasMore) log(context.ownerRef, context.accountRef,
      '已完成有界费用索引核对；原操作结果和资源足迹保留。', 'info', { scanned: coverage.scanned, indexedResourceCount: coverage.appended,
        blocked: (coverage.blocked || []).map(item => ({ operationId: item.operationId, reasonCode: item.reasonCode })),
        hasMore: coverage.hasMore, noGameRequestSent: true, originalOutcomesUnchanged: coverage.originalOutcomesUnchanged === true,
        originalFootprintsUnchanged: coverage.originalFootprintsUnchanged === true });
    if (coverage.hasMore && registerMaintenance) scheduler.registerMaintenance(context, { taskKey: 'official-item-coverage', sourceKey: 'official-item-coverage',
      sourceVersion: '1.0', refreshNow: true, retryBaseMs: 30000, retryMaxMs: 300000, successIntervalMs: 1800000,
      run: async ({ context: activeContext, signal }) => {
        let result = null;
        let scanned = 0;
        let appended = 0;
        let operations = 0;
        const blocked = [];
        for (let page = 0; page < 4; page += 1) {
          await new Promise(resolve => setImmediate(resolve));
          if (signal?.aborted || activeContext.ownerRef !== context.ownerRef || activeContext.subjectRef !== context.subjectRef ||
              activeContext.isCurrent?.() !== true) return { reasonCode: 'OFFICIAL_ITEM_COVERAGE_CONTEXT_STALE',
            coverageScan: { scanned, appended, blocked, operations, hasMore: true, noGameRequestSent: true } };
          result = store.withBusyTimeout(0, () => landRuntime.resources.reconcileOrderFlowerCoverage({ ownerRef: activeContext.ownerRef,
            subjectRef: activeContext.subjectRef, limit: 1 }), { maintenanceCommitRollback: true });
          operations += 1;
          scanned += Number.isSafeInteger(result?.scanned) ? result.scanned : 0;
          appended += Number.isSafeInteger(result?.appended) ? result.appended : 0;
          if (result?.scanned || result?.appended || result?.blocked?.length || result?.hasMore) log(activeContext.ownerRef, activeContext.accountRef,
            '已完成一页有界费用索引核对；原操作结果和资源足迹保留。', 'info', { scanned: result?.scanned || 0,
              indexedResourceCount: result?.appended || 0, blocked: (result?.blocked || []).map(item => ({ operationId: item.operationId,
                reasonCode: item.reasonCode })), blockedCount: result?.blocked?.length || 0, hasMore: result?.hasMore === true,
              noGameRequestSent: true, originalOutcomesUnchanged: result?.originalOutcomesUnchanged === true,
              originalFootprintsUnchanged: result?.originalFootprintsUnchanged === true });
          for (const item of result?.blocked || []) {
            if (blocked.length >= 128) break;
            blocked.push({ operationId: item.operationId, reasonCode: item.reasonCode });
          }
          if (!result.hasMore) break;
        }
        const hasMore = result?.hasMore === true;
        return { reasonCode: result?.hasMore ? 'OFFICIAL_ITEM_COVERAGE_SCAN_CONTINUES' : 'OFFICIAL_ITEM_COVERAGE_SCAN_COMPLETE',
          successIntervalMs: result?.hasMore ? 30000 : 1800000,
          coverageScan: { scanned, appended, blocked, operations, hasMore } };
      } });
    orderFlowerRuntime.reconcileDeliveryAccounting({ context });
  };
  const bindAndReplayCurrentLogin = ({ context, connection, observation, snapshot, identityEpoch, signal = null, isCurrent = null,
    registerMaintenance = false }) => {
    const active = () => !signal?.aborted && (isCurrent ? isCurrent() === true : context.isCurrent?.() === true) &&
      context.connectionEpoch === connection?.context?.connectionEpoch &&
      connection?.context?.loginObservation?.responseRef === observation?.responseRef;
    if (!snapshot || snapshot.validatedBundle !== true || snapshot.sourceVersion !== observation?.versionEvidence?.gameVersion ||
        observation?.method !== 'index.login' || observation.versionEvidence?.loginResponseRef !== observation.responseRef || !active()) {
      logPublicBindingDiagnostic(context, observation, 'input-guard', { snapshotPresent: !!snapshot,
        validatedBundle: snapshot?.validatedBundle === true, sourceVersionEqual: snapshot?.sourceVersion === observation?.versionEvidence?.gameVersion,
        loginMethod: observation?.method === 'index.login', loginRefEqual: observation?.versionEvidence?.loginResponseRef === observation?.responseRef,
        active: active() });
      return null;
    }
    const normalized = normalizeOfficialObservation(context, observation, snapshot);
    const normalizedGates = { normalizedPresent: !!normalized,
      loginRefEqual: normalized?.versionEvidence?.loginResponseRef === observation.responseRef,
      gameVersionEqual: normalized?.versionEvidence?.gameVersion === observation.versionEvidence.gameVersion,
      reportedVersionEqual: normalized?.reportedServerVersion === (observation.reportedServerVersion ?? observation.protocolVersion ?? observation.versionEvidence.reportedServerVersion ?? observation.versionEvidence.protocolVersion),
      protocolExact: normalized?.versionEvidence?.protocolVersion === observation.versionEvidence.protocolVersion,
      semanticBindingPresent: !!normalized?.versionEvidence?.serverVersionBinding,
      semanticBindingValid: normalized?.versionEvidence?.protocolVersion === observation.versionEvidence.protocolVersion ||
        verifyOfficialServerVersionBinding(normalized?.versionEvidence?.serverVersionBinding, {
          sourceVersion: normalized?.versionEvidence?.gameVersion, protocolVersion: normalized?.versionEvidence?.protocolVersion,
          reportedServerVersion: normalized?.reportedServerVersion, loginResponseRef: observation.responseRef,
          context: executionContext(context), officialUid: publicLoginProfile(normalized)?.uid, bundleRef: snapshot.bundleRef }),
      snapshotIdEqual: normalized?.versionEvidence?.dataSnapshotId === snapshot.dataSnapshotId,
      current: active() };
    if (!normalizedGates.normalizedPresent || !normalizedGates.loginRefEqual || !normalizedGates.gameVersionEqual ||
        !normalizedGates.reportedVersionEqual || !normalizedGates.semanticBindingValid || !normalizedGates.snapshotIdEqual || !normalizedGates.current) {
      logPublicBindingDiagnostic(context, observation, 'normalized-version-guard', normalizedGates);
      return null;
    }
    const bound = landRuntime.bindDataSnapshot({ context: executionContext(context), snapshot,
      versionEvidence: normalized.versionEvidence, loginResponseRef: observation.responseRef });
    if (!bound || !active()) {
      logPublicBindingDiagnostic(context, observation, 'land-snapshot-bind', { registered: !!bound, current: active(),
        protocolVersion: normalized.versionEvidence.protocolVersion, sourceVersion: normalized.versionEvidence.gameVersion,
        snapshotIdEqual: normalized.versionEvidence.dataSnapshotId === snapshot.dataSnapshotId,
        profileBindingPresent: !!normalized.versionEvidence.profileBinding, semanticBindingPresent: !!normalized.versionEvidence.serverVersionBinding });
      return null;
    }
    compatibilityBindings.set(connection, normalized.versionEvidence);
    const replay = ingestOfficialObservation(context, normalized, identityEpoch, { serverId: connection.context?.serverId });
    if (!active()) {
      logPublicBindingDiagnostic(context, observation, 'context-stale-after-replay', { domainAccepted: replay?.domain?.accepted === true,
        domainReason: replay?.domain?.reasonCode || 'none', customerAccepted: replay?.customer?.accepted === true,
        customerReason: replay?.customer?.reasonCode || 'none' });
      return null;
    }
    const usableProjection = replay?.domain?.accepted === true || replay?.domain?.coverageReplay === true;
    if (!usableProjection) {
      logPublicBindingDiagnostic(context, observation, 'replay-domain-not-accepted', { domainAccepted: replay?.domain?.accepted === true,
        domainCoverageReplay: replay?.domain?.coverageReplay === true, domainReason: replay?.domain?.reasonCode || 'none',
        customerAccepted: replay?.customer?.accepted === true, customerReason: replay?.customer?.reasonCode || 'none',
        freeWaterAccepted: replay?.freeWater?.accepted === true, freeWaterReason: replay?.freeWater?.reasonCode || 'none' });
      return null;
    }
    const identity = publicLoginProfile(normalized);
    if (identity?.uid) recordBoundLoginResources(context, normalized, identity.uid, { registerMaintenance });
    const publishedDomains = replay.dynamicObservation?.published || [];
    if (publishedDomains.length) scheduler.notify(context, publishedDomains);
    return { observation: normalized, snapshot, replay, publishedDomains };
  };
  supervisor = createSubjectSupervisor({ store, appendOutbox: appendEvent,
    onReconnectStateChange: () => nativeReconnectProjection?.request(),
    isAccountStopPending,
    assertCanonicalExecution: input => canonicalExecutionGuard(input),
    appendRecoveryLog: event => {
      if (store.get('SELECT 1 FROM backend_local_logs WHERE event_ref=?', event.eventRef)) return;
      const phase = safeRecoveryPhase(event.error?.phase) || 'connect';
      logs.append({ ownerRef: event.ownerRef, accountRef: event.accountRef,
      category: '连接恢复', level: event.status === 'blocked' ? 'error' : event.status === 'connected' ? 'info' : 'warn',
      message: ({ attempting: '正在尝试连接', scheduled: '连接失败，已安排自动重试', waiting_network: '连接失败，等待网络恢复后重试',
        cleanup_pending: '连接未完成，正在核实旧连接关闭并安排恢复', blocked: '连接失败，需要处理后才能继续', connected: '已建立连接' })[event.status] || '连接状态已更新',
      eventRef: event.eventRef, eventType: 'session-recovery', traceId: event.traceId,
      errorCode: event.reasonCode, attempted: event.attempted, runEpoch: event.runEpoch,
      connectionEpoch: event.connectionEpoch, retryAtMs: event.retryAtMs,
      detail: { eventState: event.eventState, phase,
        sourceNamespace: event.error?.sourceNamespace, loginKind: event.error?.loginKind,
        loginCode: event.error?.loginCode, remoteCode: event.error?.remoteCode,
        transportCode: event.error?.transportCode,
        loginCodeKey: event.error?.loginCodeKey, code: event.error?.code,
        action: event.error?.action || event.status, retryable: event.status === 'scheduled' || event.status === 'waiting_network',
        userActionRequired: event.error?.userActionRequired === true, retryAfterMs: event.error?.retryAfterMs,
        attempt: event.attempt, retryAtMs: event.retryAtMs, reasonCode: event.reasonCode,
        status: event.status, transportFailure: event.error?.transportFailure === true,
        closureProven: event.closureProven === true } });
    },
    authorizeDynamicRefresh: input => dynamicState?.authorizeRefreshRequest(input) === true,
    quiesceScheduling: context => scheduler?.quiesce(context) ?? Promise.resolve({ quiesced: false }),
    readWriteActivity: input => gateway?.activity(input) ?? { inFlight: true, operationId: null },
    readOfficialClock: subjectRef => facts.clock(subjectRef), authorize: input => {
    software.authorize(input);
    inspectionRecovery.retireProvedDeadInspection({ subjectRef: input.subjectRef });
    if (inspections?.hasSubject(input.subjectRef) || accounts?.hasVerification(input.subjectRef) ||
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='backend_read_inspection_slots'") && store.get('SELECT 1 FROM backend_read_inspection_slots WHERE subject_ref=?', input.subjectRef)) {
      throw problem('SUBJECT_READ_SESSION_BUSY', '这个游戏主体的只读核对尚未清理完成');
    }
    const account = store.get('SELECT migration_key FROM backend_accounts WHERE owner_ref=? AND account_id=?', input.ownerRef, Number(input.accountRef));
    if (account?.migration_key && store.get('SELECT state FROM backend_migration_imports WHERE transfer_id=?', account.migration_key)?.state !== 'imported') {
      throw problem('MIGRATION_ARCHIVE_INCOMPLETE', '原历史证据尚未完整归档，本主体暂不取得运行权');
    }
    return true;
  },
    prepareVerificationLogin: async ({ context, connection, observation, signal, isCurrent }) => {
      signal?.throwIfAborted();
      const rawVersion = observation?.versionEvidence, publicResources = connection?.context?.publicResources;
      if (!observation || observation.method !== 'index.login' || rawVersion?.loginResponseRef !== observation.responseRef ||
          publicResources?.source !== 'normal-auth-package-hop-public-config/v1' ||
          publicResources.gameVersion !== rawVersion.gameVersion ||
          typeof rawVersion.gameVersion !== 'string' || isCurrent?.() !== true) return null;
      const sourceKey = 'owner-data:' + fingerprint({ ownerRef: context.ownerRef, accountRef: context.accountRef, subjectRef: context.subjectRef });
      const head = officialPublicData.activatedHead(`${sourceKey}:g-data`, rawVersion.gameVersion);
      if (!head) return null;
      const snapshot = officialPublicData.readActivatedGDataSnapshot({ sourceKey: `${sourceKey}:g-data`,
        sha256: head.sha256, sourceVersion: rawVersion.gameVersion });
      if (!snapshot || snapshot.validatedBundle !== true || snapshot.sourceVersion !== rawVersion.gameVersion || isCurrent?.() !== true) return null;
      const prepared = bindAndReplayCurrentLogin({ context, connection, observation, snapshot,
        identityEpoch: software.status().identityEpoch, signal, isCurrent });
      signal?.throwIfAborted();
      if (isCurrent?.() !== true) return null;
      return prepared?.observation || null;
    },
    isolatePreviousExecutor: async input => isolation(input.subjectRef, input.previousOwner),
    revokeWrites: (context, options) => gateway ? gateway.revoke(context, options) : { captured: false, completion: Promise.resolve({ durableOutcome: true }) },
    connect: async context => {
      const credential = accounts.credentials(context.ownerRef, context.accountRef);
      const identityEpoch = software.status().identityEpoch;
      try {
        return await connectGame({ account: credential, ownerRef: context.ownerRef, subjectRef: context.subjectRef,
          allowEndpointPreference: context.allowEndpointPreference !== false,
          signal: context.signal, isCurrent: context.isCurrent, isTransportOwnerCurrent: context.isTransportOwnerCurrent,
          connectionEpoch: context.connectionEpoch, onClosed: context.onClosed,
          onObservation: rawObservation => ingestOfficialObservation(context,
            normalizeOfficialObservation(context, rawObservation), identityEpoch, credential),
          proxy: proxy(), deviceProfilePath });
      } finally { credential.username = ''; credential.password = ''; }
    },
    onConnected: async context => {
      const loginObservation = context.connection.context.loginObservation, profile = publicLoginProfile(loginObservation);
      if (!profile) throw problem('OFFICIAL_PROFILE_UNREADABLE', '官服当前主体资料尚未读到');
      if (context.connection.context.publicResources) store.run('INSERT INTO backend_official_public_resources VALUES(?,?,?,?,?,?,?)',
        newId(), context.ownerRef, context.subjectRef, context.connectionEpoch, loginObservation.responseRef,
        canonical(context.connection.context.publicResources), store.nowIso());
      const recovered = writeRecovery.recoverClosedWriteSlots({ context, checkpoint: { observation: loginObservation,
        factBasis: { version: 'matched-official-login/v1', responseRef: loginObservation.responseRef,
          requestSequence: loginObservation.requestSequence, officialUid: profile.uid } } });
      if (recovered.released.length || recovered.held.length) log(context.ownerRef, context.accountRef,
        '已按本次官服登录核对旧技术写位；原操作结论与资源足迹继续保留。', 'info', { released: recovered.released.length, held: recovered.held.length });
      const verificationLeases = supervisor.retireRecoveredVerificationLeases({ context });
      if (verificationLeases.remaining) throw problem('VERIFICATION_LEASE_RECOVERY_PENDING', '原操作后验租约尚未结清，当前连接只保留事实');
      scheduler.start({ ...context, signal: context.controller.signal });
      // R10 continuation of the two bounded reward repairs. The startup legacy
      // upgrade stops after its batches; this keeps finishing only this
      // account's remainder, and a second task keeps re-reading post-states for
      // held claims whose card is suspended by its own business cap. Neither
      // sends a game write and neither waits for a restart.
      {
        const registered = executionContext(context);
        const live = candidate => Boolean(candidate) && candidate.signal?.aborted !== true &&
          currentContext(candidate.context) === true &&
          ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
            .every(axis => candidate.context?.[axis] === registered[axis]);
        scheduler.registerMaintenance(context, { taskKey: 'reward-legacy-claim-migration',
          sourceKey: 'reward-legacy-claims:' + fingerprint([context.ownerRef, String(context.accountRef), context.subjectRef]),
          sourceVersion: '1.0', refreshNow: true, retryBaseMs: 30000, retryMaxMs: 600000, successIntervalMs: 1800000,
          run: async ({ context: activeContext, signal }) => {
            let migrated = 0, settled = 0, remaining = false;
            for (let batch = 0; batch < 2; batch += 1) {
              await new Promise(resolve => setImmediate(resolve));
              if (!live({ context: activeContext, signal })) return { reasonCode: 'REWARD_LEGACY_MIGRATION_STALE',
                successIntervalMs: 30000, migrated, settled, remaining };
              const result = rewardRuntime.migrateLegacyUnknowns({ ownerRef: registered.ownerRef,
                subjectRef: registered.subjectRef, limit: 512, maxBatches: 1 });
              migrated += result.migrated; settled += result.settled; remaining = result.remaining === true;
              if (!remaining) break;
            }
            return { reasonCode: remaining ? 'REWARD_LEGACY_MIGRATION_CONTINUES' : 'REWARD_LEGACY_MIGRATION_COMPLETE',
              successIntervalMs: remaining ? 1000 : 1800000, migrated, settled, remaining };
          } });
        scheduler.registerMaintenance(context, { taskKey: 'reward-unknown-reconcile',
          sourceKey: 'reward-unknown-reconcile:' + fingerprint([context.ownerRef, String(context.accountRef), context.subjectRef]),
          sourceVersion: '1.0', retryBaseMs: 60000, retryMaxMs: 900000, successIntervalMs: 1800000,
          run: async ({ context: activeContext, signal }) => {
            await new Promise(resolve => setImmediate(resolve));
            if (!live({ context: activeContext, signal })) return { reasonCode: 'REWARD_UNKNOWN_RECONCILE_STALE',
              successIntervalMs: 60000, checked: 0 };
            const result = rewardRuntime.reconcileHeldClaims({ context: executionContext(activeContext) });
            return { reasonCode: result.current === true ? 'REWARD_UNKNOWN_RECONCILE_CHECKED'
              : (typeof result.reasonCode === 'string' ? result.reasonCode : 'REWARD_UNKNOWN_RECONCILE_UNAVAILABLE'),
              successIntervalMs: result.checked > 0 ? 60000 : 1800000, checked: result.checked || 0 };
          } });
      }
      gateway.recoverSubjectFaults({ context, checkpoint: { observation: loginObservation,
        factBasis: { loginResponseRef: loginObservation.responseRef } } });
      recordExecutionTransition({ ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
        ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch },
      'state-rebased', 'LOGIN_READY', loginObservation.responseRef);
      recordExecutionTransition({ ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
        ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch },
      'ready', 'SESSION_READY', loginObservation.responseRef);
      const publicResources = context.connection.context.publicResources;
      const softwareIdentityEpoch = software.status().identityEpoch;
      if (publicResources?.source !== 'normal-auth-package-hop-public-config/v1') {
        recordBoundLoginResources(context, loginObservation, profile.uid, { registerMaintenance: true });
      }
      if (publicResources?.source === 'normal-auth-package-hop-public-config/v1') {
        const sourceKey = 'owner-data:' + fingerprint({ ownerRef: context.ownerRef, accountRef: context.accountRef, subjectRef: context.subjectRef });
        const bindAndReplay = snapshot => {
          if (!snapshot || snapshot.sourceVersion !== publicResources.gameVersion || context.isCurrent?.() !== true ||
              software.status().identityEpoch !== softwareIdentityEpoch ||
              context.connection.context.loginObservation?.responseRef !== loginObservation.responseRef) return null;
          return bindAndReplayCurrentLogin({ context, connection: context.connection, observation: loginObservation,
            snapshot, identityEpoch: softwareIdentityEpoch, isCurrent: context.isCurrent, registerMaintenance: true });
        };
        let cacheBoundCurrentLogin = false;
        const currentHead = officialPublicData.activatedHead(`${sourceKey}:g-data`, publicResources.gameVersion);
        if (currentHead) {
          const currentSnapshot = officialPublicData.readActivatedGDataSnapshot({ sourceKey: `${sourceKey}:g-data`,
            sha256: currentHead.sha256, sourceVersion: publicResources.gameVersion });
          cacheBoundCurrentLogin = Boolean(bindAndReplay(currentSnapshot));
        }
        const runSourceRefresh = async ({ signal }) => {
          try {
            const current = () => context.isCurrent?.() === true && software.status().identityEpoch === softwareIdentityEpoch &&
              context.connection.context.loginObservation?.responseRef === loginObservation.responseRef &&
              context.connection.context.versionEvidence?.gameVersion === publicResources.gameVersion;
            const receipt = await officialPublicData.fetchAndActivateSnapshot({ sourceKey, publicResources, signal, isCurrent: current });
            if (!(receipt.fresh === true || receipt.usableValidatedCache === true) || receipt.sourceVersion !== publicResources.gameVersion || !current()) {
              throw problem(receipt.reasonCode || 'OFFICIAL_PUBLIC_BUNDLE_UNAVAILABLE', '当前登录来源尚无可安全绑定的公开数据包');
            }
            const snapshot = officialPublicData.readActivatedGDataSnapshot({ sourceKey: `${sourceKey}:g-data`,
              sha256: receipt.resourceSha256, sourceVersion: receipt.sourceVersion, sourceProofs: receipt.sourceProofs });
            if (!snapshot || !current()) throw problem('OFFICIAL_PUBLIC_BUNDLE_REVALIDATION_FAILED', '官服公开数据完整来源包复核失败');
            const binding = bindAndReplay(snapshot);
            if (!binding || !current()) {
              logPublicBindingDiagnostic(context, loginObservation, binding ? 'refresh-current-context-changed' : 'refresh-bind-returned-null', {
                bindingReturned: !!binding, contextCurrent: current(), snapshotPresent: !!snapshot,
                sourceVersionEqual: snapshot.sourceVersion === publicResources.gameVersion,
                loginRefEqual: context.connection.context.loginObservation?.responseRef === loginObservation.responseRef,
                protocolVersion: context.connection.context.versionEvidence?.protocolVersion || 'missing' });
              throw problem('OFFICIAL_PUBLIC_CURRENT_LOGIN_BINDING_FAILED', '官服公开数据包不能绑定当前登录');
            }
            cacheBoundCurrentLogin = true;
            log(context.ownerRef, context.accountRef, receipt.usableValidatedCache === true
              ? '已按当前来源版本重新校验本地官服公开数据并绑定当前登录；本次网络更新仍会独立重试。'
              : '已校验并缓存本次官服公开静态数据；仅更新同一当前连接的土地目录。', 'info',
              { dataSnapshotId: snapshot.dataSnapshotId, sourceVersion: snapshot.sourceVersion, responseRef: loginObservation.responseRef,
                connectionEpoch: context.connectionEpoch, ownerEpoch: context.ownerEpoch, resourceSha256: snapshot.resourceSha256,
                bundleRef: snapshot.bundleRef, cacheState: receipt.cacheState || 'network-fresh', fresh: receipt.fresh === true });
            return { reasonCode: receipt.usableValidatedCache === true ? 'OFFICIAL_PUBLIC_REVALIDATED_CACHE_BOUND' : 'OFFICIAL_PUBLIC_BUNDLE_REFRESHED',
              publishedDomains: binding.publishedDomains };
          } catch (error) {
            if (context.isCurrent?.() === true && software.status().identityEpoch === softwareIdentityEpoch) {
              const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'OFFICIAL_PUBLIC_REFRESH_FAILED';
              const errorPath = safeBackendErrorPath(error);
              log(context.ownerRef, context.accountRef, `官服公开静态数据暂未更新（${code}）；保留此前已验证数据。`, 'info',
                { code, ...(errorPath ? { path: errorPath } : {}), connectionEpoch: context.connectionEpoch,
                  ownerEpoch: context.ownerEpoch, loginResponseRef: loginObservation.responseRef });
            }
            throw error;
          }
        };
        scheduler.registerMaintenance(context, { taskKey: 'official-public-data', sourceKey, sourceVersion: publicResources.gameVersion,
          refreshNow: !cacheBoundCurrentLogin, retryBaseMs: 30000, retryMaxMs: 21600000,
          successIntervalMs: 1800000, run: runSourceRefresh });
      }
      log(context.ownerRef, context.accountRef, '已连接官服并读取当前事实；种收浇为限定实服验收能力，按已保存设置逐项核对。', 'info', { runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch });
    },
    onStop: context => { scheduler?.stop(context); landRuntime?.stop(context); customerReadModel?.stop(context); orderFlowerReadModel?.stop(context); orderFlowerAuxiliaryFacts?.stop(context); orderFlowerAuxiliaryRuntime?.stop(context); facts.invalidateConnection(context.subjectRef); },
  });
  store.run('INSERT INTO backend_local_executors(executor_ref,instance_ref,pid,process_start_token,app_id,started_at,closed_at,process_boot_id) VALUES(?,?,?,?,?,?,NULL,?)', supervisor.executorRef, instanceId,
    process.pid, initialProcessIdentity.startToken, appId, store.nowIso(), initialProcessIdentity.bootId);
  const facts = createFactService({ store, isConnectionCurrent: supervisor.isConnectionCurrent, appendOutbox: appendEvent });
  dynamicState = createDynamicStateCoordinator({ store, isCurrent: currentContext,
    notify: (context, domains) => scheduler?.notify(context, domains), requestRefresh: input => {
      const currentCatalog = landRuntime?.catalogForContext(input.context);
      const identity = currentCatalog?.identity?.();
      if (!identity?.bundleRef || currentCatalog?.sourceBundleCurrent?.() !== true ||
          officialPublicData.isCurrentBundleBinding(identity) !== true) {
        return { accepted: false, reasonCode: 'OFFICIAL_PUBLIC_SOURCE_REFRESH_PENDING' };
      }
      return supervisor.refreshCurrent({ context: input.context, domains: input.domains,
        reasons: input.reasons, refreshRef: input.refreshRef });
    },
    emit: event => { try {
      const candidateEventState = typeof event.eventType === 'string' && event.eventType.startsWith('dynamic-refresh-')
        ? event.eventType.slice('dynamic-refresh-'.length) : null;
      const eventState = ['requested', 'not-started', 'completed', 'incomplete', 'failed'].includes(candidateEventState) ? candidateEventState : null;
      const reasonCode = event.errorCode ?? null;
      const message = eventState === 'requested' ? '当前动态事实不完整，已请求常规登录刷新。'
        : eventState === 'not-started' ? `常规登录刷新未启动（${reasonCode || '原因未知'}）；系统将在重试时间重新评估。`
          : eventState === 'failed' ? `常规登录刷新失败（${reasonCode || '原因未知'}）；系统将按恢复策略处理。`
            : eventState === 'completed' ? '常规登录刷新已完成，正在重新核对动态事实。'
              : `动态事实状态已更新：${event.phase || 'unknown'}。`;
      log(event.context?.ownerRef, event.context?.accountRef, message, event.outcomeState === 'failed' ? 'error' : 'info',
        { ...event.detail, eventType: event.eventType, eventState, outcomeState: null, attempted: event.attempted,
          runEpoch: event.runEpoch, connectionEpoch: event.connectionEpoch, phase: event.phase, method: event.method ?? null,
          retryAtMs: event.retryAtMs, errorCode: reasonCode, operationId: event.operationId, traceId: event.traceId }, '事实恢复');
    } catch { /* Diagnostics cannot change runtime admission. */ } } });
  const currentNeedFacts = input => {
    const feature = registry.get(input?.featureId);
    return feature ? dynamicState.currentNeedSnapshot({ ...input, feature })
      : { complete: false, reasonCode: 'DYNAMIC_CURRENT_NEED_FEATURE_NOT_REGISTERED', sourceProofs: [] };
  };
  const landCatalogRegistry = createOfficialLandCatalogRegistry({ sourceReadiness: identity => officialPublicData.isCurrentBundleBinding(identity),
    sourceReadinessScope: callback => officialPublicData.withSynchronousBundleRead(callback), capabilityPolicy: input => {
    const action = input.purpose === 'plant' ? 'land.plant' : input.purpose === 'water' ? 'land.water'
      : input.purpose === 'yield' ? 'land.harvest' : null;
    const actionContract = action ? officialContractCapability({ source: 'normal-package-hop-and-matched-world-login/v1',
      gameVersion: input.catalogIdentity.indexVersion, protocolVersion: input.catalogIdentity.protocolVersion,
      loginResponseRef: input.catalogIdentity.loginResponseRef }, action,
    { sourceProof: input.catalogIdentity.sourceProofs?.[action] }) : null;
    const requiredTables = actionContract?.requiredTables ?? [];
    const sourceReady = !input.catalogIdentity.bundleRef || officialPublicData.isCurrentBundleBinding(input.catalogIdentity);
    const snapshotSupported = sourceReady && actionContract?.supported === true && input.catalogIdentity.contractId === OFFICIAL_CORE_CONTRACT_ID &&
      typeof input.catalogIdentity.loginResponseRef === 'string' && !!input.catalogIdentity.loginResponseRef &&
      typeof input.catalogIdentity.dataSnapshotId === 'string' &&
      requiredTables.every(name => /^[a-f0-9]{64}$/.test(input.catalogIdentity.tableSha256?.[name] || ''));
    return { supported: snapshotSupported,
    reasonCode: snapshotSupported ? null : !sourceReady ? 'OFFICIAL_PUBLIC_SOURCE_REFRESH_PENDING' : 'OFFICIAL_ACTION_CONTRACT_OR_DATA_UNSUPPORTED',
    versionEvidenceRefs: [`data-snapshot:${input.catalogIdentity.dataSnapshotId ?? 'unknown'}`,
      `protocol-contract:${input.catalogIdentity.contractId ?? 'unknown'}`, ...requiredTables.map(name => `${name}:${input.catalogIdentity.tableSha256?.[name] || 'missing'}`)] };
  } });
  const catalog = landCatalogRegistry.resolve('480.0.27', '480.0.0');
  const customerCatalog = createOfficialCustomerCatalog({ landCatalog: catalog, landCatalogForContext: context => landRuntime?.catalogForContext(context) ?? null });
  customerReadModel = createCustomerReadModel({ store, isCurrent: currentContext });
  orderFlowerReadModel = createOrderFlowerReadModel({ store, isCurrent: currentContext });
  orderFlowerAuxiliaryFacts = createOrderFlowerAuxiliaryFacts({ store, isCurrent: currentContext });
  const orderFlowerCatalog = createOfficialOrderFlowerCatalog({ landCatalog: catalog,
    landCatalogForContext: context => landRuntime?.catalogForContext(context) ?? null });
  const orderFlowerEligibility = createOrderFlowerEligibility({ catalog: orderFlowerCatalog, isCurrent: currentContext, clock: facts.clock });
  customerGenerationFacts = createCustomerGenerationFacts({ store, isCurrent: currentContext, clock: facts.clock,
    readView: customerReadModel.snapshot, verificationLease: supervisor.verificationLease });
  customerIdentity = createCustomerIdentity({ store, isCurrent: currentContext });
  const customerHistoryRetirement = createCustomerHistoryRetirement({ store });
  customerAcceptance = createCustomerAcceptance({ catalog: customerCatalog, isCurrent: currentContext });
  const readLegacyOperation = input => {
    if (input.sourceTable !== 'game_write_operations') throw problem('LEGACY_ROW_SCOPE_INVALID', '此端口只读取精确原操作单行');
    const archived = store.get(`SELECT source_row_fingerprint,original_row_ciphertext FROM backend_legacy_archives
      WHERE archive_id=? AND transfer_id=? AND target_owner_ref=? AND target_account_ref=? AND target_subject_ref=? AND source_table=?`,
    input.archiveId, input.transferId, input.ownerRef, String(input.accountRef), input.subjectRef, input.sourceTable);
    if (!archived || archived.source_row_fingerprint !== input.expectedFingerprint) throw problem('LEGACY_ROW_SCOPE_INVALID', '原操作单行归属或指纹不匹配');
    const original = parseStored(cipher.decrypt(archived.original_row_ciphertext), '原操作准备证据');
    if (fingerprint(original) !== input.expectedFingerprint) throw problem('LEGACY_ROW_FINGERPRINT_INVALID', '原操作准备证据指纹不一致');
    // Exact immutable row, memory only. Neither domain receives a generic
    // archive/decryption route or access to credentials and unrelated rows.
    return original;
  };
  const readLegacyConstraint = input => {
    if (!['game_write_operation_targets', 'game_write_holds'].includes(input.sourceTable)) {
      throw problem('LEGACY_ROW_SCOPE_INVALID', '此端口只读取精确原目标或资源约束单行');
    }
    const archived = store.get(`SELECT source_row_fingerprint,source_primary_key_json,original_row_ciphertext FROM backend_legacy_archives
      WHERE archive_id=? AND transfer_id=? AND target_owner_ref=? AND target_account_ref=? AND target_subject_ref=? AND source_table=?`,
    input.archiveId, input.transferId, input.ownerRef, String(input.accountRef), input.subjectRef, input.sourceTable);
    if (!archived || archived.source_row_fingerprint !== input.expectedFingerprint ||
        canonical(parseStored(archived.source_primary_key_json, '原约束主键')) !== canonical(input.expectedPrimaryKey)) {
      throw problem('LEGACY_ROW_SCOPE_INVALID', '原约束行归属、主键或指纹不匹配');
    }
    const original = parseStored(cipher.decrypt(archived.original_row_ciphertext), '原迁入约束证据');
    if (fingerprint(original) !== input.expectedFingerprint || original.operation_id !== input.sourceOperationId ||
        input.kind === 'target' && (input.sourceTable !== 'game_write_operation_targets' || original.target_ref !== input.rawRef) ||
        input.kind === 'resource' && (input.sourceTable !== 'game_write_holds' || original.resource_key !== input.rawRef || original.quantity !== input.quantity)) {
      throw problem('LEGACY_ROW_FINGERPRINT_INVALID', '原约束行内容与索引身份不匹配');
    }
    return original;
  };
  const currentIsolation = createCurrentIsolationEvidence({ store, appId, isCurrent: currentContext,
    readCurrentLogin: context => {
      if (!currentContext(context)) return null;
      const login = supervisor.context(context.subjectRef).connection?.context.loginObservation;
      const profile = publicLoginProfile(login);
      if (!profile) return null;
      return { source: login.source, transport: login.transport, method: login.method, dsName: login.dsName,
        envelopeOk: login.envelopeOk, rejected: login.rejected, connectionEpoch: login.connectionEpoch,
        requestSequence: login.requestSequence, responseRef: login.responseRef, wireKey: login.wireKey,
        receivedDeviceMs: login.receivedDeviceMs, value: { '7': { '0': { '0': profile.uid } } } };
    },
    readLegacyOperation, readLegacyConstraint });
  landRuntime = createLandRuntime({ store, catalog, catalogRegistry: landCatalogRegistry, facts, ledgerView: Object.freeze({ operation: ledger.operation,retiredOperation:ledger.retiredOperation,
    listOperations: ledger.listOperations, currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis }),
    legacyConstraints: currentNeedLegacyPorts,
    isolationEvidence: Object.freeze({ read: currentIsolation.read }),
    appendOutbox: appendEvent, isCurrent: currentContext, additionalItemRule: (context, itemId, profileIdentity) => {
      const currentIdentity = landRuntime.catalogForContext(context)?.identity?.() || profileIdentity;
      if (itemId === 1001 && currentIdentity?.bundleSourceKey && currentIdentity?.bundleRef && currentIdentity?.loginResponseRef) {
        const acceleration = officialPublicData.readLandAccelerationExtension({ sourceKey: `${currentIdentity.bundleSourceKey}:g-data`,
          sourceVersion: currentIdentity.indexVersion, resourceSha256: currentIdentity.resourceSha256,
          baseDataSnapshotId: currentIdentity.dataSnapshotId, loginResponseRef: currentIdentity.loginResponseRef });
        if (acceleration && acceleration.bundleRef === currentIdentity.bundleRef && acceleration.tableHashes.c_item === currentIdentity.tableSha256?.c_item) {
          return { kind: 'land-speed-card', itemId: 1001, staticItemType: 1, ruleVersion: 'land-speed-card/extension-v1',
            staticResetRestoreLimitAbsent: acceleration.staticResetRestoreLimitAbsent === true,
            extensionId: acceleration.extensionId, extensionRef: acceleration.extensionRef,
            baseDataSnapshotId: acceleration.baseDataSnapshotId, loginResponseRef: acceleration.loginResponseRef,
            bundleRef: acceleration.bundleRef, itemTableSha256: acceleration.tableHashes.c_item };
        }
      }
      const versionEvidence = currentIdentity && { source: 'normal-package-hop-and-matched-world-login/v1',
        gameVersion: currentIdentity.indexVersion, protocolVersion: currentIdentity.protocolVersion,
        loginResponseRef: currentIdentity.loginResponseRef, dataSnapshotId: currentIdentity.dataSnapshotId,
        profileBinding: { dataSnapshotId: currentIdentity.dataSnapshotId }, sourceProofs: currentIdentity.sourceProofs };
      return customerCatalog.forContext(context)?.itemRule(itemId, versionEvidence) ?? null;
    },
    accelerationExtensionForContext: context => {
      const identity = landRuntime?.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readLandAccelerationExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef ? extension : null;
    },
    waterwheelExtensionForContext: context => {
      const identity = landRuntime?.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readWaterwheelExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef ? extension : null;
    },
    artFirstRewardExtensionForContext: context => {
      const identity = landRuntime?.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readArtFirstRewardExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null;
    },
    validatePostReadBridge: supervisor.validateReadSnapshotLease,
    // Runtime admits only the audited current version per real login. Its
    // sourcePolicy grants provided bag/itemExt replacement coverage, never a
    // complete land map merely because the object looks large.
    capabilities: { landMapComplete: false, bagComplete: false, itemExtComplete: false },
    dynamicState,
    readCurrent: async ({ context, method, params, after, signal }) => {
      signal?.throwIfAborted();
      if (!currentContext(context) || method !== 'usrLand.refresh' || !params || Object.keys(params).length) throw problem('LAND_READ_CONTEXT_INVALID', '本次土地读取不属于当前已核连接');
      const actor = supervisor.context(context.subjectRef);
      const reply = await actor.connection.read(method, params, { after: after ?? null });
      signal?.throwIfAborted();
      if (!currentContext(context)) throw problem('LAND_READ_CONTEXT_REVOKED', '旧连接读取不能更新当前执行');
      return reply;
    } });
  const currentOrderFlowerView = context => {
    const view = orderFlowerReadModel.snapshot(context), land = landRuntime.dynamicView(context);
    if (view.current && land.current && land.identity?.verified === true && land.identity.uid?.value === view.identity?.uid?.value) {
      const financial = { ...view.financial };
      for (const [target, sourceKey] of [['gold', 'gold'], ['yb', 'yuanbao'], ['lvlExp', 'lvlExp'], ['vipExp', 'vipExp']]) {
        const cell = land.profile?.[sourceKey];
        if (cell?.state === 'known' && cell.current === true && cell.source?.connectionEpoch === context.connectionEpoch)
          financial[target] = { ...cell };
      }
      const bag = land.inventory?.bag;
      if (bag?.state === 'known' && bag.source?.connectionEpoch === context.connectionEpoch) {
        const itemCell = id => bag.items?.[String(id)] || (bag.complete === true
          ? { presence: 'present', state: 'known', value: 0, source: bag.source, current: true } : null);
        for (const id of [1106, 1340]) {
          const item = itemCell(id);
          if (item?.state === 'known' && Number.isSafeInteger(item.value) && item.value >= 0)
            financial[String(id)] = { ...item };
        }
        if (bag.complete === true) {
          const rewards = ORDER_FLOWER_LEVEL_REWARD_ITEM_IDS.map(itemId => {
            const item = itemCell(itemId);
            return item?.state === 'known' && Number.isSafeInteger(item.value) && item.value >= 0
              ? { itemId, quantity: item.value, source: { ...item.source } } : null;
          });
          if (rewards.every(Boolean)) financial.levelRewardItems = { presence: 'present', state: 'known', value: rewards,
            source: { ...bag.source }, current: true };
        }
      }
      return { ...view, financial };
    }
    return view;
  };
  for (const feature of landRuntime.features) registry.register(feature);
  customerAllocation = createCustomerAllocation({ resources: landRuntime.resources, isCurrent: currentContext });
  customerRuntime = createCustomerRuntime({ store, readModel: customerReadModel, identity: customerIdentity,
    acceptance: customerAcceptance, allocation: customerAllocation, resources: landRuntime.resources, catalog: customerCatalog,
    ledgerView: Object.freeze({ operation: ledger.operation, listOperations: ledger.listOperations,
      currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis }),
    legacyConstraints: currentNeedLegacyPorts,
    isolationEvidence: Object.freeze({ read: currentIsolation.read }),
    isCurrent: currentContext, clock: facts.clock, validateReadSnapshotLease: supervisor.validateReadSnapshotLease,
    readProfile: landRuntime.artSourceFacts, readGenerationFacts: customerGenerationFacts.read,
    readArtFeasibility: (context, config) => artRuntime?.customerFeasibility(context, config) ?? null,
    requestFreshLogin: input => supervisor.refreshCurrent(input), appendOutbox: appendEvent, dynamicState, currentNeedFacts });
  registry.register(customerRuntime.feature);
  const artCatalog = createOfficialArtCatalog({ customerCatalog, landCatalog: catalog,
    landCatalogForContext: context => landRuntime?.catalogForContext(context) ?? null });
  artRuntime = createArtRuntime({ store, catalog: artCatalog, resources: landRuntime.resources,
    readView: customerReadModel.snapshot, readProfile: landRuntime.artSourceFacts, customerPlanning: customerRuntime.planning,
    readProfileBatch: landRuntime.artSourceFactsBatch,
    readShareEligibility: (context, openId) => customerRuntime.evaluateAdditionalOpen(context, openId),
    readShareOfficialDay: context => customerGenerationFacts.read(context),
    ledgerView: Object.freeze({ operation: ledger.operation, listOperations: ledger.listOperations,
      currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis }),
    legacyConstraints: currentNeedLegacyPorts,
    isolationEvidence: Object.freeze({ read: currentIsolation.read }),
    isCurrent: currentContext, clock: facts.clock, validateReadSnapshotLease: supervisor.validateReadSnapshotLease, appendOutbox: appendEvent,
    dynamicState, currentNeedFacts });
  registry.register(artRuntime.feature);
  artFirstRewardRuntime = createArtFirstRewardRuntime({ store, artRuntime, resources: landRuntime.resources, dynamicState,
    readConfiguration: configuration, isCurrent: currentContext, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }),
    appendOutbox: appendEvent,
    extensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readArtFirstRewardExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256, baseDataSnapshotId: identity.dataSnapshotId,
        loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; } });
  for (const feature of Object.values(artFirstRewardRuntime.features)) registry.register(feature);
  orderFlowerRuntime = createOrderFlowerRuntime({ store, readModel: orderFlowerReadModel, readView: currentOrderFlowerView, catalog: orderFlowerCatalog,
    resources: landRuntime.resources, ledgerView: Object.freeze({ operation: ledger.operation, listOperations: ledger.listOperations,
      currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis }),
    legacyConstraints: currentNeedLegacyPorts,
    isolationEvidence: Object.freeze({ read: currentIsolation.read }), readLegacyOperation, isCurrent: currentContext, clock: facts.clock,
    readGenerationFacts: customerGenerationFacts.read, validateReadSnapshotLease: supervisor.validateReadSnapshotLease,
    requestFreshLogin: input => supervisor.refreshCurrent(input), appendOutbox: appendEvent, dynamicState, currentNeedFacts });
  const orderFlowerVideoRequests = createOrderFlowerVideoRequests({ store, ledgerView: Object.freeze({ operation: ledger.operation }), isCurrent: currentContext,
    connectionFor: context => supervisor.context(context.subjectRef)?.connection,
    readGenerationFacts: customerGenerationFacts.read });
  orderFlowerAuxiliaryRuntime = createOrderFlowerAuxiliaryRuntime({ store, videoRequestProvider: orderFlowerVideoRequests, readAuxiliaryFacts: orderFlowerAuxiliaryFacts.read,
    readView: currentOrderFlowerView, reconcileIdentities: ({ context }) => orderFlowerRuntime.planning(context).identities,
    readEligibility: orderFlowerEligibility.evaluate, readGenerationFacts: customerGenerationFacts.read,
    readConfiguration: configuration, isCurrent: currentContext, clock: facts.clock,
    readStockPlanning: (context, ownOperationId) => orderFlowerRuntime.planning(context, undefined, ownOperationId).planning,
    ledgerView: Object.freeze({ operation: ledger.operation, currentAdmission: ledger.currentAdmission, recordAdmissionBasis: ledger.recordAdmissionBasis }),
    legacyConstraints: currentNeedLegacyPorts,
    isolationEvidence: Object.freeze({ read: currentIsolation.read }), readLegacyOperation,
    validateReadSnapshotLease: supervisor.validateReadSnapshotLease,
    requestFreshLogin: input => supervisor.refreshCurrent(input), appendOutbox: appendEvent,
    notify: context => scheduler?.notify(context),
    readCurrentInventory: context => landRuntime.dynamicView(context), currentNeedFacts });
  const readRelatedInputDemandBatch = ({ context, itemIds, excludeTargetRef = null, ignoreDemandKinds = [] }) => {
    if (!Array.isArray(itemIds) || itemIds.length > 8192 || itemIds.some(id => !Number.isSafeInteger(id) || id <= 0))
      return { current: false, items: {}, reasonCode: 'FLOWER_RACK_RELATED_DEMAND_ITEM_SET_INVALID' };
    const config = configuration(context), customer = customerRuntime.demandSnapshot(context, config);
    const orderSettings = config?.config?.orders || {};
    const ordinaryOrdersExplicitlyDisabled = ['resident', 'satin', 'decorate'].every(key => orderSettings[key]?.enabled === false);
    const acceptedOrderConfig = config && Number.isSafeInteger(config.savedRevision) && config.savedRevision > 0 &&
      config.acceptedRevision === config.savedRevision && config.ownerRef === context.ownerRef &&
      String(config.accountRef) === String(context.accountRef) && config.subjectRef === context.subjectRef && currentContext(context);
    const orders = ordinaryOrdersExplicitlyDisabled && acceptedOrderConfig
      ? { current: true, entries: [], protectedItems: {}, reasonCode: null, source: 'accepted-current-explicitly-disabled' }
      : orderFlowerRuntime.demandSnapshot(context, config);
    const artBatch = config?.config?.art?.makeEnabled === true
      ? artRuntime.customerBatchInputs(context, config)
      : { current: true, entries: [], inputDemands: [] };
    const commonReason = customer?.reasonCode || orders?.reasonCode || artBatch?.reasonCode || 'FLOWER_RACK_RELATED_DEMAND_NOT_CURRENT';
    if (customer?.current !== true || orders?.current !== true || artBatch?.current !== true)
      return { current: false, items: Object.fromEntries(itemIds.map(id => [id, { current: false, protectedQuantity: null, reasonCode: commonReason }])), reasonCode: commonReason };
    const wanted = new Set(itemIds);
    const customers = new Map(), orderInputs = new Map(), artInputs = new Map();
    for (const one of customer.entries) if (wanted.has(one.artId)) { const rows = customers.get(one.artId) || []; rows.push(one); customers.set(one.artId, rows); }
    for (const one of orders.entries) if (wanted.has(one.itemId)) { const rows = orderInputs.get(one.itemId) || []; rows.push(one); orderInputs.set(one.itemId, rows); }
    for (const one of artBatch.inputDemands || []) if (wanted.has(one.itemId)) { const rows = artInputs.get(one.itemId) || []; rows.push(one); artInputs.set(one.itemId, rows); }
    const items = {};
    const budgets = landRuntime.resources.budgetBatch({ context, itemIds, quantity: 0, keep: 0 });
    for (const itemId of new Set(itemIds)) {
      const demands = [...(customers.get(itemId) || []), ...(orderInputs.get(itemId) || []), ...(artInputs.get(itemId) || [])]
        .filter(one => (!excludeTargetRef || one.targetRef !== excludeTargetRef) && !ignoreDemandKinds.includes(one.kind));
      const budget = budgets[String(itemId)];
      if (budget?.known !== true || !Array.isArray(budget.otherUnreflectedReservations)) {
        items[itemId] = { current: false, protectedQuantity: null, reasonCode: budget?.reasonCode || 'FLOWER_RACK_DEMAND_RESERVATION_VIEW_UNKNOWN' };
        continue;
      }
      const protectedQuantity = demands.reduce((sum, demand) => {
        const covered = budget.otherUnreflectedReservations.filter(held => {
          const operation = ledger.operation(held.operationId), original = operation?.original;
          return original?.targets?.some(target => target.targetRef === demand.targetRef && target.memberKey === demand.memberKey &&
              target.lifecycleRef === demand.lifecycleRef) &&
            original?.resourceBindings?.some(binding => binding.resourceKey === held.resourceKey && binding.memberKey === demand.memberKey &&
              binding.quantity === held.quantity) &&
            original?.resources?.some(resource => resource.resourceKey === held.resourceKey && resource.resourceRef === 'item:' + itemId &&
              resource.quantity === held.quantity);
        }).reduce((heldSum, held) => heldSum + held.unreflectedQuantity, 0);
        return sum + Math.max(0, demand.quantity - covered);
      }, 0);
      const available = Math.max(0, budget.available - protectedQuantity);
      items[itemId] = { current: true, protectedQuantity, budget: { ...budget, keep: protectedQuantity, available,
        allowed: budget.known === true && available >= 0 }, proofRefs: demands.map(one => one.decisionRef || one.orderRef),
        targetRefs: demands.map(one => one.targetRef), reservationBasisRefs: budget.basisRefs };
    }
    return { current: true, items };
  };
  const readRelatedInputDemand = ({ context, itemId, excludeTargetRef = null, ignoreDemandKinds = [] }) => {
    const result = readRelatedInputDemandBatch({ context, itemIds: [itemId], excludeTargetRef, ignoreDemandKinds }).items?.[String(itemId)];
    if (!result) return { current: false, protectedQuantity: null, reasonCode: 'FLOWER_RACK_RELATED_DEMAND_NOT_CURRENT' };
    // Rack factBasis consumes only stable demand evidence. The daily batch path uses
    // the same-round budget from readRelatedInputDemandBatch directly; exposing it
    // here would make rack's fact hash change when its own reservation is created.
    return { current: result.current, protectedQuantity: result.protectedQuantity ?? null,
      proofRefs: result.proofRefs || [], targetRefs: result.targetRefs || [],
      reservationBasisRefs: result.reservationBasisRefs || [], reasonCode: result.reasonCode || null };
  };
  dailyArtRuntime = createDailyArtRuntime({ store, artRuntime, dynamicState, clock: facts.clock,
    contextFor: subjectRef => supervisor.context(subjectRef),
    readHistoryDay: context => { const value = customerGenerationFacts.read(context); return value?.current === true ? value.officialDay : null; },
    officialDay: context => { const day = customerGenerationFacts.read(context); return day?.current === true && day.officialDay?.known === true
      ? { current: true, key: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
        proofRef: day.officialDay.source?.responseRef || null } : { current: false, key: null, startMs: null, endMs: null }; },
    resources: landRuntime.resources, readProfile: landRuntime.artSourceFacts, readConfiguration: configuration, readInputDemand: readRelatedInputDemand,
    readInputDemandBatch: readRelatedInputDemandBatch,
    isCurrent: currentContext, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }),
    inFlight: input => gateway ? gateway.activity(input) : { inFlight: true, operationId: null },
    appendOutbox: appendEvent });
  registry.register(dailyArtRuntime.feature);
  customerArtBatchRuntime = createCustomerArtBatchRuntime({ store, artRuntime, resources: landRuntime.resources,
    readProfile: landRuntime.artSourceFacts, dynamicState, readConfiguration: configuration, readInputDemand: readRelatedInputDemand,
    isCurrent: currentContext, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }),
    appendOutbox: appendEvent });
  registry.register(customerArtBatchRuntime.feature);
  const orderRuntimeFor = proposal => orderFlowerAuxiliaryRuntime.handles(proposal) ? orderFlowerAuxiliaryRuntime : orderFlowerRuntime;
  const orderActionRuntime = Object.freeze({
    readFactBasis: input => orderRuntimeFor(input.proposal).readFactBasis(input),
    evaluateAdmission: input => orderRuntimeFor(input.proposal).evaluateAdmission(input),
    readAdmissionBoundary: input => {
      const result = orderFlowerRuntime.evaluateAdmission({ ...input, factBasis: input.proposal.factBasis, includeBoundaryBasis: true });
      const { boundaryFactBasis, ...admission } = result;
      return { contract: 'authoritative-facts-and-admission/v1', factBasis: boundaryFactBasis, admission,
        admissionFunction: orderActionRuntime.evaluateAdmission };
    },
    onSettled: input => orderRuntimeFor(input.proposal).onSettled(input),
    onCurrentVerified: input => orderRuntimeFor(input.proposal).onCurrentVerified(input),
  });
  waterwheelFacts = createWaterwheelFacts({ store, isCurrent: currentContext, officialUidForContext: context => {
    const identity = landRuntime.dynamicView(context)?.identity;
    return identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known' &&
      Number.isSafeInteger(identity.uid.value) ? identity.uid.value : null;
  } });
  freeWaterFacts = createFreeWaterFacts({ store, isCurrent: currentContext, officialUidForContext: context => {
    const identity = landRuntime.dynamicView(context)?.identity;
    return identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known' &&
      Number.isSafeInteger(identity.uid.value) ? identity.uid.value : null;
  } });
  const officialUidForFeatureContext = context => {
    const identity = landRuntime.dynamicView(context)?.identity;
    return identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known' &&
      Number.isSafeInteger(identity.uid.value) ? identity.uid.value : null;
  };
  specialOrderFacts = createSpecialOrderFacts({ store, isCurrent: currentContext, officialUidForContext: officialUidForFeatureContext });
  rewardFacts = createRewardClaimFacts({ store, isCurrent: currentContext, officialUidForContext: officialUidForFeatureContext });
  flowerRackFacts = createFlowerRackFacts({ store, isCurrent: currentContext, officialUidForContext: context => {
    const identity = landRuntime.dynamicView(context)?.identity;
    return identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known' &&
      Number.isSafeInteger(identity.uid.value) ? identity.uid.value : null;
  } });
  flowerRackPriceFacts = createFlowerRackPriceFacts({ store, isCurrent: currentContext, officialUidForContext: context => {
    const identity = landRuntime.dynamicView(context)?.identity;
    return identity?.verified === true && identity.uid?.presence === 'present' && identity.uid.state === 'known' &&
      Number.isSafeInteger(identity.uid.value) ? identity.uid.value : null;
  } });
  flowerRackRuntime = createFlowerRackRuntime({ store, facts: flowerRackFacts, clock: facts.clock,
    extensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readFlowerRackExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; },
    priceFacts: flowerRackPriceFacts,
    priceExtensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readFlowerRackPriceExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; },
    dynamicState, resources: landRuntime.resources, readProfile: landRuntime.artSourceFacts,
    readBag: context => landRuntime.dynamicView(context)?.inventory?.bag || null,
    catalogForContext: context => landRuntime.catalogForContext(context),
    readRelatedDemand: readRelatedInputDemand,
    readConfiguration: configuration, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }),
    isolationEvidence: Object.freeze({ read: currentIsolation.read }),
    gatewayActivity: input => gateway ? gateway.activity(input) : { inFlight: true, operationId: null },
    isCurrent: currentContext, appendOutbox: appendEvent });
  registry.register(flowerRackRuntime.feature);
  waterwheelRuntime = createWaterwheelRuntime({ store, facts: waterwheelFacts, clock: facts.clock,
    officialDay: context => { const day = customerGenerationFacts.read(context); return day?.current === true && day.officialDay?.known === true
      ? { current: true, key: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
        proofRef: day.officialDay.source?.responseRef || null }
      : { current: false, key: null, startMs: null, endMs: null }; },
    readEnter: async context => { const actor = supervisor.context(context.subjectRef);
      if (!actor?.isCurrent() || !actor.connection?.isOpen()) throw problem('WATERWHEEL_ENTER_CONTEXT_NOT_CURRENT', '水车读取不属于当前官服连接');
      try { return await actor.connection.read('waterwheel.enter', {}); }
      catch (error) {
        const diagnosticKey = `${context.subjectRef}:${context.connectionEpoch}:read-failure`;
        if (waterwheelReadDiagnostics.size <= 16 && !waterwheelReadDiagnostics.has(diagnosticKey) && actor.isCurrent()) {
          waterwheelReadDiagnostics.add(diagnosticKey);
          if (waterwheelReadDiagnostics.size > 16) waterwheelReadDiagnostics.delete(waterwheelReadDiagnostics.values().next().value);
          const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'WATERWHEEL_ENTER_READ_FAILED';
          log(context.ownerRef, context.accountRef, '水车官服读取未完成；功能保持等待并按现有重试计划重评。', 'error', {
            eventType: 'waterwheel-read-failed', reasonCode: code, method: 'waterwheel.enter', connectionEpoch: context.connectionEpoch,
            ...(Number.isSafeInteger(error?.requestSequence) ? { requestSequence: error.requestSequence } : {}),
            ...(typeof error?.wireKey === 'string' && /^[A-Za-z0-9_.:-]{1,240}$/.test(error.wireKey) ? { wireKey: error.wireKey } : {}),
            phase: 'read', attempted: error?.mayHaveSent === true,
          }, '事实恢复');
        }
        throw error;
      } },
    extensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readWaterwheelExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; },
    dynamicState, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }), resources: landRuntime.resources,
    isCurrent: currentContext, readConfiguration: configuration,
    openEligibility: context => customerRuntime.planning(context, configuration(context)).eligibility.waterwheelOpen,
    appendOutbox: appendEvent });
  registry.register(waterwheelRuntime.feature);
  freeWaterRuntime = createFreeWaterRuntime({ store, facts: freeWaterFacts, clock: facts.clock,
    officialDay: context => { const day = customerGenerationFacts.read(context); return day?.current === true && day.officialDay?.known === true
      ? { current: true, key: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
        proofRef: day.officialDay.source?.responseRef || null }
      : { current: false, key: null, startMs: null, endMs: null, proofRef: null }; },
    extensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readFreeWaterExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; },
    dynamicState, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }), resources: landRuntime.resources,
    isCurrent: currentContext, readConfiguration: configuration,
    openEligibility: context => customerRuntime.planning(context, configuration(context)).eligibility.freeWaterOpen,
    videoOpenEligibility: (context, openId) => customerRuntime.evaluateAdditionalOpen(context, openId),
    appendOutbox: appendEvent });
  registry.register(freeWaterRuntime.feature);
  specialOrderRuntime = createSpecialOrderRuntime({ store, facts: specialOrderFacts, clock: facts.clock,
    officialDay: context => { const day = customerGenerationFacts.read(context); return day?.current === true && day.officialDay?.known === true
      ? { current: true, key: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
        proofRef: day.officialDay.source?.responseRef || null } : { current: false }; },
    extensionForContext: context => { const identity = landRuntime.catalogForContext(context)?.identity?.();
      if (!identity?.bundleSourceKey || !identity.bundleRef || !identity.loginResponseRef) return null;
      const extension = officialPublicData.readSpecialOrdersExtension({ sourceKey: `${identity.bundleSourceKey}:g-data`,
        sourceVersion: identity.indexVersion, resourceSha256: identity.resourceSha256,
        baseDataSnapshotId: identity.dataSnapshotId, loginResponseRef: identity.loginResponseRef });
      return extension?.bundleRef === identity.bundleRef && extension.loginResponseRef === identity.loginResponseRef ? extension : null; },
    dynamicState, ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }), resources: landRuntime.resources,
    isCurrent: currentContext, readConfiguration: configuration,
    openEligibility: (context, kind) => customerRuntime.evaluateAdditionalOpen(context, kind === 'palace' ? 'sys_orderPalace' : 'sys_orderTeam'),
    methodAvailable: (method, kind = 'write') => {
      if (kind === 'read') return specialOrderTransport.READ_METHODS?.includes(method) === true;
      const definition = Object.values(SPECIAL_ORDER_DEFINITIONS).find(one => one.method === method);
      return !!definition && specialOrderTransport.WRITE_METHODS?.includes(method) === true &&
        supervisor.supportsVerificationContract?.({ featureId: definition.featureId, scope: definition.scope,
          method: definition.method, contractId: definition.contractId }) === true;
    },
    readEnter: async context => { const actor = supervisor.context(context.subjectRef);
      if (!actor?.isCurrent() || !actor.connection?.isOpen()) throw problem('PALACE_ENTER_CONTEXT_NOT_CURRENT', '宫廷读取不属于当前官服连接');
      return actor.connection.read('orderPalace.enter', {}); }, appendOutbox: appendEvent });
  for (const feature of specialOrderRuntime.features) registry.register(feature);
  const rewardSourceForContext = context => {
    const identity = landRuntime.catalogForContext(context)?.identity?.();
    return identity?.bundleSourceKey && identity.bundleRef && identity.loginResponseRef && identity.resourceSha256 ? identity : null;
  };
  const rewardTablesForContext = context => {
    const identity = rewardSourceForContext(context);
    if (!identity) return null;
    try {
      return officialPublicData.readBusinessTables({ sourceKey: `${identity.bundleSourceKey}:g-data`, sourceVersion: identity.indexVersion,
        resourceSha256: identity.resourceSha256, baseDataSnapshotId: identity.dataSnapshotId, tableNames: CLAIM_TABLE_NAMES });
    } catch { return null; }
  };
  const rewardStateView = ({ ownerRef, accountRef } = {}) => {
    try {
      const row = store.get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
      const actor = row ? supervisor.context(row.subject_ref) : null;
      if (!actor || !actor.isCurrent()) return { current: false, reasonCode: 'REWARD_STATE_CONTEXT_NOT_CURRENT' };
      const context = executionContext(actor), read = rewardFacts?.read(context);
      const view = landRuntime.dynamicView(context);
      const cell = name => view?.profile?.[name] ? { state: view.profile[name].state, value: view.profile[name].value,
        method: view.profile[name].source?.method || null, epoch: view.profile[name].source?.connectionEpoch || null } : null;
      const gold = landRuntime.resources?.currencyBalance({ context, currency: 'gold' });
      return { current: true, connectionEpoch: context.connectionEpoch, rewardFacts: read?.current === true ? {
        domains: Object.keys(read.values), sources: Object.fromEntries(Object.entries(read.sources).map(([domain, source]) =>
          [domain, [source.method, source.responseRef, source.requestSequence]])) } : { current: false, reasonCode: read?.reasonCode || null },
        profileGold: cell('gold'), profileUid: cell('uid'), profileLevel: cell('level'),
        currencyGold: gold ? { known: gold.known, value: gold.value, reasonCode: gold.reasonCode } : null,
        guild: read?.current === true ? (read.values['reward-guild'] || null) : null,
        mail: read?.current === true ? (read.values['reward-mail'] || null) : null };
    } catch (error) { return { current: false, reasonCode: typeof error?.code === 'string' ? error.code : 'REWARD_STATE_FAILED' }; }
  };
  const rewardTableStatus = ({ ownerRef, accountRef } = {}) => {
    try {
      const row = store.get('SELECT subject_ref FROM backend_subject_bindings WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef));
      const actor = row ? supervisor.context(row.subject_ref) : null;
      if (!actor || !actor.isCurrent()) return { current: false, reasonCode: 'REWARD_TABLE_CONTEXT_NOT_CURRENT' };
      const context = executionContext(actor), identity = rewardSourceForContext(context);
      if (!identity) return { current: true, reasonCode: 'REWARD_SOURCE_IDENTITY_MISSING' };
      const result = rewardTablesForContext(context);
      return { current: true, bundleRef: identity.bundleRef, sourceVersion: identity.indexVersion,
        resourceSha256Prefix: String(identity.resourceSha256 || '').slice(0, 12), dataSnapshotIdPrefix: String(identity.dataSnapshotId || '').slice(0, 20),
        available: result ? Object.keys(result.tables) : null, unsupported: result?.unsupported || null,
        tableHashes: result ? Object.keys(result.tableHashes).length : null };
    } catch (error) { return { current: false, reasonCode: typeof error?.code === 'string' ? error.code : 'REWARD_TABLE_STATUS_FAILED' }; }
  };
  const rewardProfileForContext = context => {
    const view = landRuntime.dynamicView(context);
    const cell = name => view?.profile?.[name]?.state === 'known' ? view.profile[name].value : null;
    return { uid: cell('uid'), level: cell('level'), gold: cell('gold') };
  };
  const rewardBagForContext = context => {
    const view = landRuntime.dynamicView(context);
    const items = view?.inventory?.bag?.items || {};
    const out = {};
    for (const [id, cell] of Object.entries(items)) {
      if (cell?.state === 'known' && Number.isSafeInteger(cell.value)) out[id] = cell.value;
    }
    return { items: out };
  };
  rewardRuntime = createRewardRuntime({ store, facts: rewardFacts, clock: facts.clock,
    officialDay: context => { const day = customerGenerationFacts.read(context); return day?.current === true && day.officialDay?.known === true
      ? { current: true, key: day.officialDay.key, startMs: day.officialDay.startMs, endMs: day.officialDay.endMs,
        proofRef: day.officialDay.source?.responseRef || null }
      : { current: false, key: null, startMs: null, endMs: null }; },
    extensionForContext: context => { const identity = rewardSourceForContext(context); return identity ? { bundleRef: identity.bundleRef,
      loginResponseRef: identity.loginResponseRef, bundleSourceKey: identity.bundleSourceKey, indexVersion: identity.indexVersion,
      resourceSha256: identity.resourceSha256, dataSnapshotId: identity.dataSnapshotId } : null; },
    tablesForContext: rewardTablesForContext, dynamicState,
    ledgerView: Object.freeze({ currentAdmission: ledger.currentAdmission, operation: ledger.operation }),
    resources: landRuntime.resources, isCurrent: currentContext, readConfiguration: configuration,
    readProfile: rewardProfileForContext, readBag: rewardBagForContext, appendOutbox: appendEvent,
    reportBasisMismatch: detail => log(detail?.ownerRef || '', String(detail?.accountRef ?? '0'),
      '奖励候选事实在发送前发生变化，已按最新事实重评。', 'info',
      { eventType: 'reward-basis-mismatch', featureId: detail?.featureId ?? null, action: detail?.action ?? null,
        diff: Array.isArray(detail?.diff) ? detail.diff.slice(0, 6) : [],
        currentDomains: detail?.current?.domains?.slice(0, 8) ?? null, originalDomains: detail?.original?.domains?.slice(0, 8) ?? null,
        currentSources: detail?.current?.sources ?? null, originalSources: detail?.original?.sources ?? null }, '状态核对') });
  for (const feature of rewardRuntime.features) registry.register(feature);
  for (const feature of orderFlowerRuntime.features) registry.register(composeOrderFlowerFeature({ feature,
    orderFlowerRuntime, auxiliaryRuntime: orderFlowerAuxiliaryRuntime, actionRuntime: orderActionRuntime }));
  const rewardFeatureIds = new Set(rewardRuntime.features.map(feature => feature.featureId));
  const runtimeFor = featureId => rewardFeatureIds.has(featureId) ? rewardRuntime : ['order.palace','order.team'].includes(featureId) ? specialOrderRuntime : featureId === 'waterwheel' ? waterwheelRuntime : featureId === 'free-water' ? freeWaterRuntime : featureId === 'flower-rack' ? flowerRackRuntime : featureId === 'art.daily' ? dailyArtRuntime : featureId === 'art.customer-batch' ? customerArtBatchRuntime : featureId.startsWith('art.first-') ? artFirstRewardRuntime.features[featureId] : featureId === 'order.customer' ? customerRuntime : featureId === 'art.make' ? artRuntime
    : ['order.resident', 'order.satin', 'order.decorate'].includes(featureId) ? orderActionRuntime : landRuntime;
  writeRecovery = createClosedWriteRecovery({ store, ledger, appId, isCurrent: currentContext,
    authorizeCurrent: context => software.authorize({ ownerRef: context.ownerRef, purpose: 'read-session' }) });
  const debugStageHold = createDebugStageHold();
  gateway = createWriteGateway({ store, ledger, registry, supervisor, readConfiguration: configuration,
    beforeSend: debugStageHold.beforeSend,
    dynamicState,
    authorizeFaultRecovery: input => writeRecovery.authorizeGatewayFaultRecovery(input),
    canBeginWrite: context => !supervisor.isShuttingDown(context.subjectRef),
    assertSourceReady: ({ proposal }) => {
      const currentCatalog = landRuntime.catalogForContext(executionContext(proposal));
      const identity = currentCatalog?.identity?.();
      if (!identity?.bundleRef || currentCatalog?.sourceBundleCurrent?.() !== true ||
          officialPublicData.isCurrentBundleBinding(identity) !== true) {
        throw problem('OFFICIAL_PUBLIC_SOURCE_REFRESH_PENDING', '当前已观察到新的官服公开来源，需重新验证当前来源后才能写入');
      }
    },
    authorize: input => software.authorize(input),
    postReadLease: Object.freeze({ readSnapshotAfterClose: supervisor.readSnapshotAfterClose,
      validateReadSnapshotLease: supervisor.validateReadSnapshotLease, releaseReadSnapshotLease: supervisor.releaseReadSnapshotLease }),
    readFactBasis: input => runtimeFor(input.proposal.featureId).readFactBasis(input),
    resolveAdmission: featureId => runtimeFor(featureId).evaluateAdmission,
    resolveAdmissionBoundary: proposal => ['orderFlower.finishOrder','orderFlower.finishSatinOrder','orderFlower.finishDecorateOrder'].includes(proposal.method)
      ? orderActionRuntime.readAdmissionBoundary : null,
    onSettled: input => {
      runtimeFor(input.proposal.featureId).onSettled(input);
      if (input.proposal.featureId === 'art.make' || input.proposal.featureId === 'art.daily' || input.proposal.featureId === 'art.customer-batch') {
        const coverage = landRuntime.resources.planCoverage({ context: executionContext(input.proposal), operation: input.operation,
          targetSettlement: input.targetSettlement, postRead: input.postReads.at(-1), sendBinding: input.sendBinding, postReadBridge: input.postReadBridge });
        landRuntime.resources.applyCoverage(coverage);
      }
      const label = { plant: '种花', water: '浇水', harvest: '收花', 'order.customer': '顾客交单', 'art.make': '花艺制作',
        'order.resident': '居民交单', 'order.satin': '绸缎交单', 'order.decorate': '建材交单' }[input.proposal.featureId] || '业务';
      const category = ['order.customer', 'order.resident', 'order.satin', 'order.decorate'].includes(input.proposal.featureId) ? '交订单' : undefined;
      log(input.proposal.ownerRef, input.proposal.accountRef,
        label + (input.verification.verdict === 'confirmed' ? '已按独立官服后态确认。' : input.verification.verdict === 'rejected' ? '已核实本次未生效。' : '结果尚未核清，原操作与资源足迹已保留，不重复发送。'),
        input.verification.verdict === 'unknown' ? 'warn' : 'info', { traceId: input.proposal.traceId, operationId: input.proposal.operationId,
          method: input.proposal.method, errorCode: input.verification.reasonCode ?? null, reasonCode: input.verification.reasonCode ?? null,
          cause: input.verification.evidence?.cause ?? input.verification.evidence?.reasonCode ?? input.verification.reasonCode ?? null,
          action: input.verification.evidence?.action ?? (input.verification.verdict === 'unknown' ? 'do_not_retry' : null),
          retryAtMs: input.verification.evidence?.retryAtMs ?? null, verdict: input.verification.verdict, visibility: input.visibility,
          ...(input.verification.evidence?.gateDiagnostics ? { gateDiagnostics: input.verification.evidence.gateDiagnostics } : {}) }, category);
    },
    onCurrentVerified: input => {
      const runtime = runtimeFor(input.proposal.featureId), module = registry.get(input.proposal.featureId);
      const hook = runtime?.onCurrentVerified ?? module?.onCurrentVerified;
      if (typeof hook === 'function') hook(input);
      scheduler?.notify(input.proposal);
    },
    onNotSent: input => {
      const runtime = runtimeFor(input.proposal.featureId);
      if (typeof runtime?.onNotSent === 'function') runtime.onNotSent(input);
    },
    onTransportUncertain: ({ context, code }) => {
      const actor = supervisor.context(context.subjectRef);
      if (!actor || !currentContext(context)) return;
      // Queue physical closure, never await the same gateway drain from inside
      // its uncertain-send callback. Only registered machine faults can recover.
      const connection = actor.connection;
      queueMicrotask(() => { void connection.close(code, false).catch(() => {}); });
    } });
  scheduler = createScheduler({ store, ledger, registry, facts, dynamicState, readConfiguration: configuration,
    beforeStage: process.env.GARDEN_DEBUG_TOOLS === '1' ? debugStageHold.beforeStage : null,
    canSchedule: context => !supervisor.isShuttingDown(context.subjectRef),
    isCurrent: currentContext,
    acceptConfiguration: (context, revision) => {
      config.accept({ ...context, accountRef: String(context.accountRef), revision, actorRef: instanceId + ':' + context.runEpoch,
        evidenceRef: 'accepted-by-new-actor:' + context.runEpoch + ':' + revision });
      for (const featureId of CONFIG_FEATURE_IDS) if (!registry.get(featureId)) config.recordPlan({ ...context, accountRef: String(context.accountRef),
        revision, featureId, state: 'unimplemented', reasonCode: 'FEATURE_NOT_REBUILT', evidenceRef: 'registry:G1-unimplemented' });
    },
    recordPlan: (context, result) => {
      const parent = registry.get(result.featureId);
      return config.recordPlan({ ownerRef: context.ownerRef, accountRef: String(context.accountRef), ...result,
        ...(parent?.primaryActionKey ? { primaryActionKey: parent.primaryActionKey } : {}),
        reasonCode: result.reasonCode || 'FEATURE_ASSESSMENT_RECORDED' });
    }, submitProposal: gateway.submit,
    onError: (context, error) => {
      const code = error.code || 'FEATURE_EVALUATION_FAILED', path = safeBackendErrorPath(error);
      const details = plainObject(error.details) ? error.details : null;
      const candidatePath = typeof details?.path === 'string' && details.path.length <= 192
        ? details.path.replaceAll('<redacted-key>', 'redacted-key') : null;
      const valuePath = candidatePath && /^[A-Za-z0-9.$_\[\]-]{1,192}$/.test(candidatePath) ? candidatePath : null;
      const actualType = ['undefined', 'function', 'symbol', 'non-finite-number'].includes(details?.actualType) ? details.actualType : null;
      const stackPathValid = typeof path === 'string' && path.length <= 512 &&
        /^(?:backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+)(?: > backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+){0,5}$/.test(path);
      const callsites = typeof error.stack === 'string' ? error.stack.split(/\r?\n/).slice(1).map(line => {
        const match = /(?:file:\/\/)?[^\s()]*(backend\/[A-Za-z0-9_.\/-]+\.mjs):(\d+):(\d+)/.exec(line);
        return match && !match[1].endsWith('backend/common.mjs') && !match[1].split('/').some(part => part === '.' || part === '..')
          ? `${match[1]}:${Number(match[2])}:${Number(match[3])}` : null;
      }).filter(Boolean).slice(0, 4).join(' > ') : '';
      const sourcePath = callsites && callsites.length <= 512 &&
        /^(?:backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+)(?: > backend\/[A-Za-z0-9_.\/-]+\.mjs:\d+:\d+){0,3}$/.test(callsites) ? callsites : null;
      log(context.ownerRef, context.accountRef, '当前功能等待核对：' + String(code), 'error',
        { errorCode: code, reasonCode: error.reasonCode || code || null, cause: error.causeCode || code || null,
          ...(typeof error.featureId === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.featureId) ? { featureId: error.featureId } : {}),
          ...(typeof error.scheduleKey === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(error.scheduleKey) ? { scheduleKey: error.scheduleKey } : {}),
          action: error.action || 'retry', retryAtMs: error.retryAtMs ?? null, traceId: error.traceId || null,
          operationId: error.operationId || null, phase: error.phase || null,
          ...(valuePath ? { path: valuePath } : stackPathValid ? { path } : {}), ...(sourcePath ? { sourcePath } : {}),
          ...(actualType ? { actualType } : {}) });
    } });
  ingestor = createOfficialObservationIngestor({ facts, store });
  accounts = createAccountRepository({ store, cipher, config, supervisor, authorize: input => software.authorize(input),
    onRosterChange: () => nativeReconnectProjection?.request(),
    executionState: (ownerRef, accountRef) => executionStates.current({ ownerRef, accountRef }),
    authorizeOwner: input => {
      software.authorize(input);
      const state = software.status();
      if (input.expectedIdentityEpoch !== state.identityEpoch) throw problem('SOFTWARE_OWNER_CHANGED', '官服身份核对对应旧软件代际');
      return { authorized: true, ownerRef: owner(), identityEpoch: state.identityEpoch };
    },
    assertSubjectAvailable: input => {
      inspectionRecovery.retireProvedDeadInspection({ subjectRef: input.subjectRef });
      if (inspections?.hasSubject(input.subjectRef) || store.get('SELECT 1 FROM backend_read_inspection_slots WHERE subject_ref=?', input.subjectRef)) throw problem('SUBJECT_READ_SESSION_BUSY', '该主体只读检查尚未结束');
    },
    projectRuntime: supervisor.project,
    verifyAccount: async input => {
      isolation(input.subjectRef);
      let connection, active = true;
      const epoch = Number(store.get('SELECT connection_epoch FROM backend_subject_connection_epochs WHERE subject_ref=?', input.subjectRef)?.connection_epoch || 0) + 1;
      store.run(`INSERT INTO backend_subject_connection_epochs VALUES(?,?) ON CONFLICT(subject_ref) DO UPDATE SET connection_epoch=excluded.connection_epoch`, input.subjectRef, epoch);
      try {
        connection = await connectGame({ account: input.account, ownerRef: input.ownerRef || null, subjectRef: input.subjectRef,
          allowEndpointPreference: false, signal: input.signal, isCurrent: () => active && !input.signal.aborted,
          connectionEpoch: epoch, proxy: proxy(), deviceProfilePath });
        const observation = connection.context.loginObservation, profile = publicLoginProfile(observation);
        if (!profile) throw problem('OFFICIAL_PROFILE_UNREADABLE', '官服登录没有返回可核实的当前游戏身份');
        const closed = await connection.close(); active = false;
        if (closed?.closed !== true || closed.connectionEpoch !== epoch || connection.isOpen()) throw problem('OFFICIAL_VERIFY_CONNECTION_OPEN', '账号核对连接尚未结束');
        return { verified: true, serverId: connection.context.serverId, ...profile, transportClosed: true,
          evidenceRef: observation.responseRef, authenticationRef: 'official-login:' + input.verificationId };
      } finally { active = false; if (connection) await connection.close(); }
    } });

  const accountReaddRecovery = createAccountReaddRecovery({store,cipher,accounts,config,authorize:input=>software.authorize(input)});
  const outboxConsumerRetirement=createOutboxConsumerRetirement({store,replacementContracts:schedulerConsumerReplacementContracts(registry)});
  canonicalExecutionGuard = input => accounts.assertUniqueCanonicalExecution(input);
  nativeReconnectProjection = createNativeReconnectProjection({ store, dataDir,
    readIdentity: () => {
      const identity = software.status(), control = projectNativeControl(nativeControlRow());
      if (!nativeTupleValid || initialProcessIdentity.state !== 'present' || !initialProcessIdentity.bootId ||
          control.controlSeq > 0 && control.scopeRef !== 'device:' + identity.installId) return null;
      return { scopeRef: 'device:' + identity.installId, nativeGeneration: processGeneration, instanceId, pid: process.pid,
        processStartToken: initialProcessIdentity.startToken, bootId: initialProcessIdentity.bootId,
        ownerRef: identity.ownerRef, identityEpoch: identity.identityEpoch, authorized: identity.authorized,
        requiresEngineRestart: identity.requiresEngineRestart, controlSeq: control.controlSeq, controlKind: control.kind,
        stopCommitted: control.stopCommitted,
        stopBlocked: nativeStopLatchPending || Boolean(stopFile && fs.existsSync(stopFile)) ||
          control.kind === 'STOP' && control.stopCommitted,
        publisherState: closing ? 'closing' : draining ? 'draining' : initialized ? 'ready' : 'initializing' };
    },
    onDiagnostic: event => log(software?.ownerRef() || '', '0', event.errorCode
      ? '原生重连截止投影暂不可用，既有运行意愿不变。' : '原生重连截止投影已恢复。', event.errorCode ? 'warn' : 'info',
    { eventType: 'native-reconnect-projection', reasonCode: event.errorCode || 'NATIVE_RECONNECT_PROJECTION_RECOVERED' }) });
  inspections = createReadOnlyInspection({ store, authorizeOwner: input => {
    software.authorize(input);
    const state = software.status();
    if (input.expectedIdentityEpoch !== null && input.expectedIdentityEpoch !== undefined && input.expectedIdentityEpoch !== state.identityEpoch) throw problem('SOFTWARE_OWNER_CHANGED', '只读核对的软件身份已变化');
    return { authorized: true, ownerRef: owner(), identityEpoch: state.identityEpoch };
  }, assertSubjectStoppedAndIsolated: input => {
    if (accounts.hasVerification(input.subjectRef) || supervisor.context(input.subjectRef)) throw problem('SUBJECT_READ_SESSION_BUSY', '该主体当前仍有连接或账号核对');
    const previousOwner = store.get('SELECT * FROM backend_subject_owners WHERE subject_ref=?', input.subjectRef);
    const proof = isolation(input.subjectRef, previousOwner);
    let previousInspectionClosed;
    if (input.previousInspection) {
      const previous = input.previousInspection, currentIdentity = readLinuxProcessIdentity(previous.pid);
      const priorToken = previous.processStartToken;
      const exitState = compareNativeProcessIdentity({ pid: previous.pid, startToken: priorToken, bootId: previous.processBootId }, currentIdentity);
      if (process.env.GARDEN_LOCAL_NATIVE !== '1' || exitState !== 'exited') throw problem('INSPECTION_PREVIOUS_CLEANUP_REQUIRED', '上一只读核对尚未证实关闭');
      const evidenceRef = 'native-inspection-process-exited:' + previous.inspectionId;
      store.run('INSERT OR IGNORE INTO backend_executor_isolation VALUES(?,?,?,?,?)', input.subjectRef, evidenceRef, 'native-single-engine:' + appId,
        canonical({ stopped: true, currentInFlight: false, nativeExecutorExited: true, subjectRef: input.subjectRef, inspectionId: previous.inspectionId, pid: previous.pid,
          previousProcessStartToken: priorToken, previousProcessBootId: previous.processBootId ?? null,
          currentProcessStartToken: currentIdentity.state === 'exited' ? 'exited' : currentIdentity.startToken, currentProcessBootId: currentIdentity.bootId }), store.nowIso());
      previousInspectionClosed = { inspectionId: previous.inspectionId, transportClosed: true, evidenceRef };
    }
    return { ...proof, stopped: true, ...(previousInspectionClosed ? { previousInspectionClosed } : {}) };
  }, connectGame, credentials: input => accounts.credentials(input.ownerRef, input.accountRef), proxy, deviceProfilePath: () => deviceProfilePath,
    onObservation: (context, projection) => {
      const uid = projection.profile?.uid, source = projection.profileCoverage?.uid?.source;
      if (Number.isSafeInteger(uid) && uid > 0 && source?.responseRef) {
        const row = accounts.row(context.ownerRef, context.accountRef);
        accounts.recordOfficialIdentity({ ...context, identityEpoch: software.status().identityEpoch, serverId: row.server_id,
          uid, evidenceRef: source.responseRef, sourceMethod: source.method || 'index.login' });
      }
    } });

  function authorizeMapping(input) {
    software.authorize({ ownerRef: input.targetOwnerRef });
    const pairing = store.get('SELECT * FROM backend_migration_pairings WHERE pairing_ref=? AND target_owner_ref=? AND source_owner_ref=?',
      input.authenticationRef, input.targetOwnerRef, input.sourceOwnerRef);
    if (!pairing) throw problem('MIGRATION_PAIRING_REQUIRED', '请先通过两端已认证本机通道建立迁移配对', 403);
    const descriptor = parseStored(pairing.descriptor_json, '来源配对');
    const observedDescriptor = input.sourceDescriptor || input.offer;
    if (observedDescriptor?.descriptorFingerprint && observedDescriptor.descriptorFingerprint !== descriptor.descriptorFingerprint ||
        observedDescriptor?.sourceDescriptorFingerprint && observedDescriptor.sourceDescriptorFingerprint !== descriptor.descriptorFingerprint) {
      throw problem('MIGRATION_SOURCE_CHANGED', '本次迁移来源公钥与正常配对不一致', 403);
    }
    const sourceAuthentication = parseStored(pairing.source_authentication_json, '来源认证证明');
    return { authorized: true, sourceOwnerRef: input.sourceOwnerRef, targetOwnerRef: input.targetOwnerRef, mappingRef: pairing.pairing_ref,
      sourceAuthenticationRef: sourceAuthentication.evidenceRef, targetAuthenticationRef: pairing.target_authentication_ref,
      targetIdentityEpoch: software.status().identityEpoch, sourceSoftwareUserId: sourceAuthentication.userId,
      ...(sourceAuthentication.installId ? { sourceInstallId: sourceAuthentication.installId } : {}) };
  }
  function assertMigrationOwnerCurrent({ targetOwnerRef, ownershipEvidence }) {
    software.authorize({ ownerRef: targetOwnerRef });
    if (ownershipEvidence?.targetIdentityEpoch !== software.status().identityEpoch) throw problem('MIGRATION_OWNER_EPOCH_CHANGED', '迁移处理的软件身份代际已变化，原资料保留');
    return true;
  }
  const migration = createMigrationComposition({ store, cipher,
    targetInfo: { appId, cloudRef: software.cloudRef, sourceVersion: BACKEND_BUILD_ID }, accounts, software,
    authorizeOwnerMapping: authorizeMapping, assertOwnerCurrent: assertMigrationOwnerCurrent, legacy, legacyLogging, legacyHistory, log });

  function pairMigration({ sourceDescriptor, sourceAuthentication }) {
    const targetOwnerRef = owner(); software.authorize({ ownerRef: targetOwnerRef });
    if (sourceAuthentication?.signedIn !== true || sourceAuthentication.authorized !== true || !sourceAuthentication.evidenceRef ||
        sourceAuthentication.sourceOwnerRef !== sourceDescriptor?.sourceOwnerRef || sourceAuthentication.transport !== 'authenticated-device-loopback') {
      throw problem('MIGRATION_SOURCE_AUTH_REQUIRED', '缺少来源设备正常软件身份与可信本机通道证明', 403);
    }
    const pairingRef = newId();
    store.run('INSERT INTO backend_migration_pairings VALUES(?,?,?,?,?,?,?)', pairingRef, targetOwnerRef, sourceDescriptor.sourceOwnerRef,
      canonical(sourceDescriptor), canonical(sourceAuthentication), 'normal-new-cloud-owner:' + software.cloudRef + ':' + software.status().identityEpoch, store.nowIso());
    return { pairingRef, targetOwnerRef, sourceOwnerRef: sourceDescriptor.sourceOwnerRef };
  }
  const egressMigration = createEgressReceiver({ store, cipher, targetInfo: { appId, cloudRef: software.cloudRef, sourceVersion: BACKEND_BUILD_ID },
    authorizeOwnerMapping: authorizeMapping, assertStopped: assertEgressStopped, applyEgress: egress.save });
  function readiness() {
    const info = software.status(), ownerBound = !info.requiresEngineRestart;
    return { ready: initialized && !draining && !closing && !initializationError && ownerBound, phase: draining || closing ? 'stopping' : initializationError ? 'failed' :
      !initialized ? 'starting' : !ownerBound ? 'binding' : 'ready', instanceId, pid: process.pid, softwareInitialized: initialized,
      ownerBound, requiresEngineRestart: info.requiresEngineRestart, code: initializationError || undefined };
  }
  function health() {
    const healthStartedMono = Number(process.hrtime.bigint()) / 1_000_000;
    const controlTimingsMs = {};
    const markHealthPhase = name => { controlTimingsMs[name] = Number((Number(process.hrtime.bigint()) / 1_000_000 - healthStartedMono).toFixed(3)); };
    const ready = readiness();
    markHealthPhase('readiness');
    let schedulerProgress = scheduler?.healthSnapshot?.() || { activeStages: [], busyContexts: [], stalled: false };
    let gatewayProgress = gateway?.healthSnapshot?.() || { activeStages: [], activeFlights: [], activeFlightCount: 0, stalled: false };
    let supervisorProgress = supervisor?.healthSnapshot?.() || { pendingCleanup: [], overdueCleanupCount: 0 };
    for (const stage of [...schedulerProgress.activeStages, ...gatewayProgress.activeStages].filter(one => one.overdue)) {
      supervisor?.recoverStalledSchedulerStage?.(stage);
    }
    if (schedulerProgress.activeStages.some(one => one.overdue) || gatewayProgress.activeStages.some(one => one.overdue)) {
      supervisorProgress = supervisor?.healthSnapshot?.() || supervisorProgress;
    }
    markHealthPhase('progressSnapshots');
    const nowMs = Date.now();
    const pendingRows = supervisorProgress.pendingCleanup || [];
    const activeRecoveryContexts = [...(schedulerProgress.activeStages || []), ...(schedulerProgress.busyContexts || []),
      ...(gatewayProgress.activeStages || []), ...(gatewayProgress.activeFlights || [])];
    const recoveryStableContext = context => !activeRecoveryContexts.some(row => row.ownerRef === context.ownerRef &&
      String(row.accountRef) === String(context.accountRef) && row.subjectRef === context.subjectRef &&
      row.ownerEpoch === context.ownerEpoch && row.runEpoch === context.runEpoch && row.connectionEpoch === context.connectionEpoch);
    const activeIncidentKeys = new Set();
    const pendingBudgetKeys = new Set(pendingRows.map(cleanupBudgetKey));
    const durableCleanup = pendingRows.map(row => {
      const incidentKey = cleanupIncidentKey(row), existing = engineCleanupIncident(row);
      const budgetKey = cleanupBudgetKey(row);
      let budget = store.get('SELECT * FROM backend_engine_recovery_budgets WHERE budget_key=?', budgetKey);
      if (!budget) {
        store.run(`INSERT INTO backend_engine_recovery_budgets(budget_key,owner_ref,account_ref,subject_ref,restart_attempts,next_restart_at_ms,updated_at)
          VALUES(?,?,?, ?,0,0,?)`, budgetKey, row.ownerRef, String(row.accountRef), row.subjectRef, store.nowIso());
        budget = store.get('SELECT * FROM backend_engine_recovery_budgets WHERE budget_key=?', budgetKey);
      }
      store.run('UPDATE backend_engine_recovery_budgets SET stable_since_ms=NULL,stable_run_epoch=NULL,stable_connection_epoch=NULL,updated_at=? WHERE budget_key=?',
        store.nowIso(), budgetKey);
      activeIncidentKeys.add(incidentKey);
      const startedAtMs = existing ? existing.started_at_ms : Math.max(0, nowMs - Math.max(0, row.ageMs || 0));
      if (!existing) store.run(`INSERT INTO backend_engine_cleanup_incidents(incident_key,target_json,started_at_ms,restart_attempts,next_restart_at_ms,state,updated_at)
        VALUES(?,?,?,?,?, 'active',?)`, incidentKey, canonical({ ownerRef: row.ownerRef, accountRef: row.accountRef,
          subjectRef: row.subjectRef, runEpoch: row.runEpoch, connectionEpoch: row.connectionEpoch }), startedAtMs,
          budget.restart_attempts, budget.next_restart_at_ms, store.nowIso());
      else if (existing.state !== 'active') store.run("UPDATE backend_engine_cleanup_incidents SET state='active',updated_at=? WHERE incident_key=?", store.nowIso(), incidentKey);
      const ageMs = Math.max(0, nowMs - startedAtMs);
      return { ...row, incidentKey, budgetKey, nextRestartAtMs: budget.next_restart_at_ms,
        ageMs, overdue: ageMs >= row.escalationLimitMs };
    });
    let healthBookkeepingBusy = false;
    const stableHealthyContexts = (supervisorProgress.healthyContexts || []).filter(recoveryStableContext);
    try { store.withBusyTimeout(0, () => {
    for (const row of store.all("SELECT incident_key FROM backend_engine_cleanup_incidents WHERE state='active'")) {
      if (!activeIncidentKeys.has(row.incident_key)) store.run("UPDATE backend_engine_cleanup_incidents SET state='resolved',updated_at=? WHERE incident_key=?", store.nowIso(), row.incident_key);
    }
    for (const budget of store.all('SELECT * FROM backend_engine_recovery_budgets')) {
      const intent = store.get('SELECT desired_running FROM backend_run_intents WHERE owner_ref=? AND account_ref=? AND subject_ref=?',
        budget.owner_ref, budget.account_ref, budget.subject_ref);
      if ((!intent || intent.desired_running !== 1) && (budget.restart_attempts !== 0 || budget.next_restart_at_ms !== 0 ||
          budget.stable_since_ms !== null || budget.stable_run_epoch !== null || budget.stable_connection_epoch !== null)) {
        store.run('UPDATE backend_engine_recovery_budgets SET restart_attempts=0,next_restart_at_ms=0,stable_since_ms=NULL,stable_run_epoch=NULL,stable_connection_epoch=NULL,updated_at=? WHERE budget_key=?',
          store.nowIso(), budget.budget_key);
      }
    }
    for (const context of stableHealthyContexts) {
      const budgetKey = cleanupBudgetKey(context);
      if (pendingBudgetKeys.has(budgetKey)) continue;
      const budget = store.get('SELECT * FROM backend_engine_recovery_budgets WHERE budget_key=?', budgetKey);
      if (!budget) continue;
      const sameHealthyEpoch = budget.stable_run_epoch === context.runEpoch && budget.stable_connection_epoch === context.connectionEpoch;
      const stableSince = sameHealthyEpoch && Number.isSafeInteger(budget.stable_since_ms) ? budget.stable_since_ms : nowMs;
      if (nowMs - stableSince >= 60_000 && (budget.restart_attempts !== 0 || budget.next_restart_at_ms !== 0)) store.run(`UPDATE backend_engine_recovery_budgets SET restart_attempts=0,next_restart_at_ms=0,
        stable_since_ms=?,stable_run_epoch=?,stable_connection_epoch=?,updated_at=? WHERE budget_key=?`,
      nowMs, context.runEpoch, context.connectionEpoch, store.nowIso(), budgetKey);
      else if (!sameHealthyEpoch || budget.stable_since_ms !== stableSince) store.run(`UPDATE backend_engine_recovery_budgets SET stable_since_ms=?,stable_run_epoch=?,stable_connection_epoch=?,updated_at=? WHERE budget_key=?`,
        stableSince, context.runEpoch, context.connectionEpoch, store.nowIso(), budgetKey);
    }
    const healthyBudgetKeys = new Set(stableHealthyContexts.map(cleanupBudgetKey));
    for (const budget of store.all('SELECT budget_key,stable_since_ms FROM backend_engine_recovery_budgets WHERE stable_since_ms IS NOT NULL')) {
      if (!healthyBudgetKeys.has(budget.budget_key) && !pendingBudgetKeys.has(budget.budget_key)) {
        store.run('UPDATE backend_engine_recovery_budgets SET stable_since_ms=NULL,stable_run_epoch=NULL,stable_connection_epoch=NULL,updated_at=? WHERE budget_key=?',
          store.nowIso(), budget.budget_key);
      }
    }
    }); } catch (error) {
      if (![5,6].includes(Number(error.errcode) & 255) && !/locked|busy/i.test(error.message || '')) throw error;
      // This is diagnostic/stability bookkeeping, not permission to send or a
      // successful recovery. Preserve it for the next sample without delaying
      // the fresh health read or changing any account's desired state.
      healthBookkeepingBusy = true;
    }
    markHealthPhase('cleanupAndStableBudgets');
    let globalRecoveryGate = null;
    const overdueCleanup = durableCleanup.filter(row => row.overdue === true);
    const overdueSubjects = [...new Set(overdueCleanup.map(row => row.subjectRef))];
    if (overdueCleanup.length) {
      if (globalRecoveryHoldStartedMono === null) globalRecoveryHoldStartedMono = Number(process.hrtime.bigint()) / 1_000_000;
      // A single account's unresolved cleanup fences only that account. New
      // and cleared subjects are applied incrementally so healthy accounts in
      // the same engine never lose their timers or send admission.
      const newlyHeld = overdueSubjects.filter(subjectRef => !globalRecoveryHeldSubjects.has(subjectRef));
      if (newlyHeld.length) {
        scheduler?.holdForProcessRecovery?.(newlyHeld);
        gateway?.holdForProcessRecovery?.(newlyHeld);
        for (const subjectRef of newlyHeld) globalRecoveryHeldSubjects.add(subjectRef);
      }
      const released = [...globalRecoveryHeldSubjects].filter(subjectRef => !overdueSubjects.includes(subjectRef));
      if (released.length) {
        scheduler?.releaseProcessRecoveryHold?.(released);
        gateway?.releaseProcessRecoveryHold?.(released);
        for (const subjectRef of released) globalRecoveryHeldSubjects.delete(subjectRef);
      }
      schedulerProgress = scheduler?.healthSnapshot?.() || schedulerProgress;
      gatewayProgress = gateway?.healthSnapshot?.() || gatewayProgress;
      supervisorProgress = supervisor?.healthSnapshot?.() || supervisorProgress;
      const leaseBelongsToTarget = (row, target) => {
        if (!row.operationId || row.ownerRef !== target.ownerRef || String(row.accountRef) !== String(target.accountRef) || row.subjectRef !== target.subjectRef) return false;
        const lease = supervisor?.verificationLease?.({ subjectRef: target.subjectRef, ownerRef: target.ownerRef });
        if (!lease?.active || lease.owned !== true || lease.operationId !== row.operationId || !lease.newContext) return false;
        const original = lease.originalContext, next = lease.newContext;
        return original?.ownerRef === target.ownerRef && String(original.accountRef) === String(target.accountRef) &&
          original.subjectRef === target.subjectRef && original.ownerEpoch === row.ownerEpoch && original.runEpoch === row.runEpoch &&
          row.runEpoch === target.runEpoch &&
          original.connectionEpoch === row.connectionEpoch &&
          next.ownerRef === target.ownerRef && String(next.accountRef) === String(target.accountRef) && next.subjectRef === target.subjectRef &&
          next.ownerEpoch === original.ownerEpoch && next.runEpoch === target.runEpoch && next.connectionEpoch === target.connectionEpoch;
      };
      const belongsToEscalatingTarget = row => overdueCleanup.some(target => {
        const sameTargetEpoch = target.ownerRef === row.ownerRef && String(target.accountRef) === String(row.accountRef) &&
          target.subjectRef === row.subjectRef && target.runEpoch === row.runEpoch && target.connectionEpoch === row.connectionEpoch;
        return sameTargetEpoch || leaseBelongsToTarget(row, target);
      });
      const schedulerBlockers = (schedulerProgress.busyContexts || []).filter(row => !belongsToEscalatingTarget(row));
      const gatewayBlockers = (gatewayProgress.activeFlights || []).filter(row => !belongsToEscalatingTarget(row));
      const supervisorBlockers = durableCleanup.filter(row => row.overdue !== true || !belongsToEscalatingTarget(row));
      const drained = schedulerBlockers.length === 0 && gatewayBlockers.length === 0 && supervisorBlockers.length === 0;
      const oldestOverdueStarted = Math.min(...overdueCleanup.map(row =>
        (engineCleanupIncident(row)?.started_at_ms ?? nowMs) + row.escalationLimitMs));
      const holdAgeMs = Math.max(0, nowMs - oldestOverdueStarted);
      const drainDeadlineExpired = holdAgeMs >= globalRecoveryDrainDeadlineMs;
      // Past the drain deadline the account is quarantined: its own execution
      // stays fenced and no second writer is started, while every healthy
      // account keeps running. Only a provable shared fault may escalate to a
      // process-level restart.
      if (drainDeadlineExpired) for (const row of overdueCleanup) {
        const existing = engineCleanupIncident(row);
        if (existing && existing.state !== 'quarantined') store.run("UPDATE backend_engine_cleanup_incidents SET state='quarantined',updated_at=? WHERE incident_key=?",
          store.nowIso(), row.incidentKey);
      }
      globalRecoveryGate = { state: drainDeadlineExpired ? 'quarantined' : 'holding',
        holdAgeMs, drainDeadlineMs: globalRecoveryDrainDeadlineMs, drained,
        incidentKeys: overdueCleanup.map(row => row.incidentKey),
        targetAccounts: overdueCleanup.map(({ ownerRef, accountRef, subjectRef, runEpoch, connectionEpoch, reasonCode }) =>
          ({ ownerRef, accountRef, subjectRef, runEpoch, connectionEpoch, reasonCode })),
        quarantined: drainDeadlineExpired ? overdueCleanup.map(({ ownerRef, accountRef, subjectRef, runEpoch, connectionEpoch,
          reasonCode, ageMs }) => ({ ownerRef, accountRef, subjectRef, runEpoch, connectionEpoch, reasonCode, ageMs })) : [],
        schedulerBlockers, gatewayBlockers, supervisorBlockers,
        mayInterruptHealthyAccounts: false };
    } else if (globalRecoveryHoldStartedMono !== null) {
      // The overdue cleanup cleared: release exactly the subjects that were
      // held. Ordinary STOP/quiesce state remains session-owned.
      const released = [...globalRecoveryHeldSubjects];
      scheduler?.releaseProcessRecoveryHold?.(released.length ? released : null);
      gateway?.releaseProcessRecoveryHold?.(released.length ? released : null);
      globalRecoveryHeldSubjects.clear();
      globalRecoveryHoldStartedMono = null;
      schedulerProgress = scheduler?.healthSnapshot?.() || schedulerProgress;
      gatewayProgress = gateway?.healthSnapshot?.() || gatewayProgress;
    }
    markHealthPhase('globalRecoveryGate');
    let healthOwnerRef = null;
    try { if (software.status().signedIn) healthOwnerRef = software.ownerRef(); } catch { healthOwnerRef = null; }
    let databaseResponsive = false, persisted = null;
    try {
      databaseResponsive = store.get('SELECT 1 AS responsive')?.responsive === 1;
      persisted = store.get('SELECT executor_ref,instance_ref,pid,process_start_token,process_boot_id FROM backend_local_executors WHERE executor_ref=?', supervisor.executorRef);
    } catch { databaseResponsive = false; }
    const current = readLinuxProcessIdentity(process.pid);
    const processTupleMatches = nativeTupleValid && current.state === 'present' && persisted?.instance_ref === instanceId &&
      persisted.pid === process.pid && persisted.process_start_token === current.startToken &&
      (persisted.process_boot_id ?? null) === (current.bootId ?? null);
    markHealthPhase('localProcessAndDb');
    const report = { responsive: current.state === 'present', databaseResponsive: databaseResponsive && processTupleMatches,
      processGeneration, processStartNonce, instanceId, pid: process.pid, processStartToken: current.startToken,
      ownerRef: healthOwnerRef, ownerRestartRequired: ready.requiresEngineRestart === true,
      requiresEngineRestart: ready.requiresEngineRestart === true,
      phase: ready.phase, ready: ready.ready,
      cleanupPendingCount: durableCleanup.length,
      recoveryStable: ready.ready && databaseResponsive && processTupleMatches && durableCleanup.length === 0 &&
        !globalRecoveryGate && activeRecoveryContexts.length === 0,
      code: overdueCleanup.length ? globalRecoveryGate?.state === 'quarantined' ? 'ACCOUNT_CLEANUP_QUARANTINED' : 'ACCOUNT_CLEANUP_DRAINING'
        : ready.code,
      schedulerProgress, gatewayProgress, supervisorProgress, globalRecoveryGate };
    const authorizationKey = restartAuthorizationKey(report);
    if (authorizationKey && !draining && !closing && !nativeStopLatchPending && !(stopFile && fs.existsSync(stopFile))) {
      const ticket = newId();
      engineRestartTickets.set(ticket, { authorizationKey, processGeneration, processStartNonce, issuedAtMs: nowMs });
      for (const [key, value] of engineRestartTickets) if (nowMs - value.issuedAtMs > ENGINE_RESTART_TICKET_TTL_MS) engineRestartTickets.delete(key);
      while (engineRestartTickets.size > 32) engineRestartTickets.delete(engineRestartTickets.keys().next().value);
      report.restartTicket = ticket;
    }
    markHealthPhase('total');
    report.controlTimingsMs = controlTimingsMs;
    report.bookkeepingPending = healthBookkeepingBusy;
    return report;
  }
  function authorizeEngineRestart(input = {}) {
    const ticket = typeof input.restartTicket === 'string' ? input.restartTicket : '';
    const issued = engineRestartTickets.get(ticket);
    engineRestartTickets.delete(ticket);
    if (!issued || Date.now() - issued.issuedAtMs > ENGINE_RESTART_TICKET_TTL_MS ||
        input.processGeneration !== processGeneration || input.processStartNonce !== processStartNonce ||
        issued.processGeneration !== processGeneration || issued.processStartNonce !== processStartNonce ||
        draining || closing || nativeStopLatchPending || stopFile && fs.existsSync(stopFile)) {
      return { accepted: false, reasonCode: 'ENGINE_RESTART_TICKET_INVALID' };
    }
    const fresh = health(), freshKey = restartAuthorizationKey(fresh);
    const cleanupRestart = Boolean(fresh.globalRecoveryGate && ['drained','deadline-expired'].includes(fresh.globalRecoveryGate.state));
    if (!freshKey || freshKey !== issued.authorizationKey || fresh.processGeneration !== processGeneration ||
        fresh.processStartNonce !== processStartNonce || !fresh.responsive || cleanupRestart && !fresh.databaseResponsive) {
      return { accepted: false, reasonCode: 'ENGINE_RESTART_HEALTH_CHANGED' };
    }
    if (fresh.globalRecoveryGate && ['drained','deadline-expired'].includes(fresh.globalRecoveryGate.state)) {
      store.transaction(() => {
        const updatedBudgets = new Set();
        for (const incidentKey of fresh.globalRecoveryGate.incidentKeys) {
          const row = store.get('SELECT restart_attempts,target_json FROM backend_engine_cleanup_incidents WHERE incident_key=? AND state=\'active\'', incidentKey);
          if (!row) throw problem('ENGINE_RESTART_INCIDENT_CHANGED', '账号收尾事件已变化');
          const target = parseStored(row.target_json, 'engine cleanup target'), budgetKey = cleanupBudgetKey(target),
            budget = store.get('SELECT restart_attempts FROM backend_engine_recovery_budgets WHERE budget_key=?', budgetKey);
          if (!budget) throw problem('ENGINE_RESTART_BUDGET_MISSING', '账号恢复退避预算未持久保存');
          const attempts = budget.restart_attempts + 1, delayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(5, attempts - 1)));
          store.run('UPDATE backend_engine_cleanup_incidents SET restart_attempts=?,next_restart_at_ms=?,updated_at=? WHERE incident_key=?',
            attempts, Date.now() + delayMs, store.nowIso(), incidentKey);
          if (!updatedBudgets.has(budgetKey)) {
            store.run('UPDATE backend_engine_recovery_budgets SET restart_attempts=?,next_restart_at_ms=?,stable_since_ms=NULL,stable_run_epoch=NULL,stable_connection_epoch=NULL,updated_at=? WHERE budget_key=?',
              attempts, Date.now() + delayMs, store.nowIso(), budgetKey);
            updatedBudgets.add(budgetKey);
          }
        }
      });
    }
    // Close every admission path in the same event-loop turn as ticket
    // acceptance. The later HTTP 202/shutdown callback cannot expose a window
    // where another START advances the very context that was just drained.
    supervisor?.holdForProcessRestart?.();
    scheduler?.holdForProcessRecovery?.();
    gateway?.holdForProcessRecovery?.();
    return { accepted: true, processGeneration, processStartNonce, instanceId };
  }
  const nativeRecoveryCauses = Object.freeze({
    health_mismatch: '本机自愈：连续本地健康核对未匹配，已请求重启执行器。',
    database_unhealthy: '本机自愈：数据库连续未就绪，已请求受控重启执行器。',
    health_transport_failure: '本机自愈：健康接口读取失败，已记录传输诊断并按策略恢复。',
    health_http_invalid: '本机自愈：健康接口返回不可用或无效状态，已记录HTTP诊断并按策略恢复。',
    engine_restart_required: '本机自愈：当前软件身份已要求重启执行器，已请求受控恢复。',
    progress_stalled: '本机自愈：执行器仍能响应，但调度或网关报告的任务阶段持续超期，已请求受控恢复。',
    account_cleanup_stalled: '本机自愈：单账号物理收尾超时，账号级恢复未闭合，已请求隔离执行器后恢复。',
    account_cleanup_drain_deadline: '本机自愈：单账号收尾仍未闭合且全局排空期限已到；共享进程重启可能中断健康账号，未知操作保持原账且不会重发。',
    startup_stalled: '本机自愈：执行器启动阶段超过恢复时限，已请求重启。',
    binding_stalled: '本机自愈：本地执行器绑定阶段超过恢复时限，已请求重启。',
    initialization_failed: '本机自愈：执行器初始化明确失败，已请求重启。',
    restart_request_failed: '本机自愈：优雅重启请求未确认，已保留强退兜底。',
    forced_exit_deadline: '本机自愈：重启请求后进程未退出，已触发专用进程兜底退出。',
    engine_start_failed: '本机自愈：执行器启动失败。',
    engine_exited: '本机自愈：Node执行器生命周期已结束。'
  });
  const nativeRecoveryStates = new Set(['requested','not-started','completed','incomplete','failed']);
  const nativeRecoverySymbol = value => typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value);
  const nativeHealthTimingKeys = new Set(['readiness','progressSnapshots','cleanupAndStableBudgets','globalRecoveryGate','localProcessAndDb','total',
    'controlPlaneHandlerMs','controlPlaneEventLoopLagP99Ms','controlPlaneEventLoopLagMaxMs']);
  const nativeHealthDiagnosticBooleanKeys = new Set(['controlPlaneEventLoopLagAvailable']);
  const validNativeHealthDiagnostics = value => plainObject(value) && Object.keys(value).every(key =>
    nativeHealthTimingKeys.has(key) && typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 120000 ||
    nativeHealthDiagnosticBooleanKeys.has(key) && typeof value[key] === 'boolean');
  function importNativeRecoveryEvents(events) {
    if (!Array.isArray(events) || events.length > 64 || Buffer.byteLength(canonical({ events }), 'utf8') > 64 * 1024)
      throw problem('NATIVE_RECOVERY_IMPORT_BOUNDS', '本机恢复诊断批次超出限制', 400);
    const acceptedIds = [];
    for (const event of events) {
      if (!event || Object.keys(event).some(key => !['eventId','cause','attempt','eventTimeMs','oldGeneration','ownerRef','eventState','phase','method','sourceNamespace','retryAtMs','httpStatus','readFailureKind',
            'healthRequestStartedAtMs','healthRequestFinishedAtMs','healthRequestDurationMs','healthRequestStartedElapsedMs','healthLaneBusy','healthLaneHealthy',
            'lastSuccessfulHealthDiagnosticsAtMs','lastSuccessfulHealthDiagnostics'].includes(key)) ||
          typeof event.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.eventId) ||
          !Object.hasOwn(nativeRecoveryCauses, event.cause) || !Number.isSafeInteger(event.attempt) || event.attempt < 0 || event.attempt > 10000 ||
          !Number.isSafeInteger(event.eventTimeMs) || event.eventTimeMs < 0 || typeof event.ownerRef !== 'string' ||
          !event.ownerRef || event.ownerRef.length > 240 || /[\u0000-\u001f\u007f]/.test(event.ownerRef) ||
          typeof event.oldGeneration !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.oldGeneration) ||
          event.eventState !== undefined && !nativeRecoveryStates.has(event.eventState) ||
          event.phase !== undefined && safeRecoveryPhase(event.phase) === null ||
          event.method !== undefined && !nativeRecoverySymbol(event.method) ||
          event.sourceNamespace !== undefined && !nativeRecoverySymbol(event.sourceNamespace) ||
          ['healthRequestStartedAtMs','healthRequestFinishedAtMs','healthRequestDurationMs','healthRequestStartedElapsedMs','lastSuccessfulHealthDiagnosticsAtMs'].some(key =>
            event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > Number.MAX_SAFE_INTEGER)) ||
          ['healthLaneBusy','healthLaneHealthy'].some(key => event[key] !== undefined && typeof event[key] !== 'boolean') ||
          event.lastSuccessfulHealthDiagnostics !== undefined && !validNativeHealthDiagnostics(event.lastSuccessfulHealthDiagnostics) ||
          event.readFailureKind !== undefined && (typeof event.readFailureKind !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(event.readFailureKind)))
        throw problem('NATIVE_RECOVERY_IMPORT_EVENT_INVALID', '本机恢复诊断事件格式无效', 400);
      const importedDiagnostic = {
        ...(event.eventState !== undefined ? { eventState: event.eventState } : {}),
        ...(event.phase !== undefined ? { phase: safeRecoveryPhase(event.phase) } : {}),
        ...(event.method !== undefined ? { method: event.method } : {}),
        ...(event.sourceNamespace !== undefined ? { sourceNamespace: event.sourceNamespace } : {}),
        ...Object.fromEntries(['healthRequestStartedAtMs','healthRequestFinishedAtMs','healthRequestDurationMs','healthRequestStartedElapsedMs',
          'healthLaneBusy','healthLaneHealthy','lastSuccessfulHealthDiagnosticsAtMs','lastSuccessfulHealthDiagnostics']
          .filter(key => event[key] !== undefined).map(key => [key, event[key]])),
      };
      const eventRef = 'native-recovery:' + event.eventId;
      const existing = store.get('SELECT owner_ref,category,detail_json FROM backend_local_logs WHERE event_ref=?', eventRef);
      if (existing) {
        const detail = parseStored(existing.detail_json, '已导入本机恢复诊断');
        if (existing.owner_ref !== event.ownerRef || existing.category !== '连接恢复' || detail.nativeRecoveryEventId !== event.eventId ||
            detail.nativeRecoveryCause !== event.cause || detail.attempt !== event.attempt || detail.nativeEventTimeMs !== event.eventTimeMs ||
            detail.oldGeneration !== event.oldGeneration || (detail.readFailureKind ?? null) !== (event.readFailureKind ?? null) ||
            Object.entries(importedDiagnostic).some(([key, value]) => canonical(detail[key] ?? null) !== canonical(value ?? null)))
          throw problem('NATIVE_RECOVERY_IMPORT_ID_CONFLICT', '本机恢复诊断编号冲突', 409);
      } else {
        logs.append({ ownerRef: event.ownerRef, accountRef: '0', category: '连接恢复', level: event.cause.endsWith('failed') ? 'error' : 'warn',
          message: nativeRecoveryCauses[event.cause], eventRef, eventType: 'native-recovery', errorCode: event.cause,
          ...(['health_mismatch','database_unhealthy','health_transport_failure','health_http_invalid','engine_restart_required','account_cleanup_stalled','account_cleanup_drain_deadline',
            'startup_stalled','binding_stalled','initialization_failed','forced_exit_deadline','restart_request_failed'].includes(event.cause) ? { attempted: true } : {}),
          detail: { nativeRecoveryEventId: event.eventId, nativeRecoveryCause: event.cause, attempt: event.attempt,
            nativeEventTimeMs: event.eventTimeMs, oldGeneration: event.oldGeneration,
            ...(Number.isSafeInteger(event.retryAtMs) && event.retryAtMs > 0 ? { retryAtMs: event.retryAtMs } : {}),
            ...(Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 ? { httpStatus: event.httpStatus } : {}),
            ...(typeof event.readFailureKind === 'string' ? { readFailureKind: event.readFailureKind } : {}),
            ...importedDiagnostic } });
      }
      const committed = store.get('SELECT owner_ref,category,detail_json FROM backend_local_logs WHERE event_ref=?', eventRef);
      const detail = committed && parseStored(committed.detail_json, '已提交本机恢复诊断');
      if (!committed || committed.owner_ref !== event.ownerRef || committed.category !== '连接恢复' || detail.nativeRecoveryEventId !== event.eventId ||
          detail.nativeRecoveryCause !== event.cause || detail.attempt !== event.attempt || detail.nativeEventTimeMs !== event.eventTimeMs ||
          detail.oldGeneration !== event.oldGeneration || (detail.readFailureKind ?? null) !== (event.readFailureKind ?? null) ||
          Object.entries(importedDiagnostic).some(([key, value]) => canonical(detail[key] ?? null) !== canonical(value ?? null)))
        throw problem('NATIVE_RECOVERY_IMPORT_NOT_COMMITTED', '本机恢复诊断尚未本地提交', 503);
      acceptedIds.push(event.eventId);
    }
    return { acceptedIds };
  }
  function status() {
    const info = softwareStatus(), ready = readiness();
    const currentAccounts = ready.ready && info.signedIn ? accounts.list(owner()) : [];
    const runningCount = currentAccounts.filter(account => account.state === 'running').length;
    const pendingCount = currentAccounts.filter(account => account.state !== 'running' && (account.desiredRunning || ['stopping', 'recovering', 'waiting_network', 'waiting_login', 'waiting_authorization'].includes(account.state))).length;
    return { platform: 'android', engine: 'nodejs-mobile', execution: 'device-local', scope: [...new Set(registry.modules().flatMap(module => module.scopes))], buildId: BACKEND_BUILD_ID,
      backend: { schemaVersion: BACKEND_SCHEMA_VERSION, stage: BACKEND_STAGE, release: 'validation-only', storage: { ...storageInfo,
        maintenance: spaceMaintenance.snapshot(), lockContention: store.lockContentionSnapshot(),
        nativeStatementCache: store.db.statementCacheStats?.() ?? null }, featureAvailability: registry.definitions() },
      metadata: readCatalog().metadata, accounts: currentAccounts, rosterReady: ready.ready, engineReadiness: ready, runningCount,
      runtime: { runningCount, pendingCount, state: runningCount ? 'running' : pendingCount ? 'recovering' : 'idle', buildId: BACKEND_BUILD_ID },
      network: { ...network }, software: info, nativeStop: nativeStopReceipt,
      nativeStopControl: projectNativeControl(nativeControlRow()) };
  }
  function accountStopRequestById(ownerRef, accountRef, commandId) {
    if (!accountStopDirectory || !accountStopUuid.test(commandId || '')) return null;
    const account = accounts.persistentStopIdentity(ownerRef, accountRef);
    const target = { ownerRef, accountRef: String(accountRef), subjectRef: account.subjectRef, officialUid: account.uid };
    const scopeKey = accountStopTargetKey(target);
    const candidates = [
      ...(scopeKey ? [{ file: path.join(accountStopDirectory, scopeKey, commandId + '.json'), scopeKey }] : []),
      { file: path.join(accountStopDirectory, commandId + '.json'), scopeKey: null }
    ];
    for (const candidate of candidates) {
      let text;
      try { text = fs.readFileSync(candidate.file, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        if (candidate.scopeKey && path.basename(path.dirname(candidate.file)) === candidate.scopeKey)
          return { ...candidate, text: null, readError: /^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : 'READ_FAILED',
            request: targetEnvelopeRequest(target, commandId) };
        throw error;
      }
      const request = parseAccountStopRequest(commandId + '.json', text);
      if (request) return { ...candidate, text, request };
      // A scoped path is a trusted target envelope written atomically by this app.
      // Keep malformed bytes unchanged, but let that one exact account drain.
      if (candidate.scopeKey && path.basename(path.dirname(candidate.file)) === candidate.scopeKey)
        return { ...candidate, text, request: targetEnvelopeRequest(target, commandId) };
      return { ...candidate, text, request: null };
    }
    return null;
  }
  function targetEnvelopeRequest(target, latchId) {
    return { latchId, commandId: latchId, ownerRef: target.ownerRef, accountRef: String(target.accountRef),
      subjectRef: target.subjectRef, officialUid: target.officialUid };
  }
  function accountStopAcknowledgement(commandId) {
    if (!accountStopUuid.test(commandId || '')) return null;
    return store.get('SELECT owner_ref,account_ref,subject_ref,official_uid,receipt_json FROM backend_account_stop_acknowledgements WHERE latch_id=?', commandId) || null;
  }
  function acknowledgedAccountStop(prior, commandId) {
    return { ...parseStored(prior.receipt_json, '已完成的单号停止回执'), commandId, latchId: commandId, latchAcknowledged: true };
  }
  function executionBoundaryContext(subjectRef, accountRef) {
    const actor = supervisor.context(subjectRef);
    if (!actor) return null;
    return { ownerRef: actor.ownerRef, accountRef: String(accountRef), subjectRef, ownerEpoch: actor.ownerEpoch,
      runEpoch: actor.runEpoch, connectionEpoch: actor.connectionEpoch };
  }
  function recordExecutionTransition(context, to, reasonCode, evidenceRef) {
    if (!context) return;
    try { executionStates.transition({ context, to, reasonCode, evidenceRef }); }
    catch (error) { log(context.ownerRef, context.accountRef, '账号执行阶段记录未写入；停止或恢复的实际结果不受影响。', 'warn',
      { eventType: 'execution-boundary-transition-failed', reasonCode: error?.code || 'EXECUTION_STATE_WRITE_FAILED' }); }
  }
  function debugSubjectHold({ ownerRef, accountRef, action }) {
    const account = accounts.row(ownerRef, String(accountRef));
    const subjects = [account.subject_ref];
    const schedulerState = action === 'hold' ? scheduler.holdForProcessRecovery(subjects) : scheduler.releaseProcessRecoveryHold(subjects);
    const gatewayState = action === 'hold' ? gateway.holdForProcessRecovery(subjects) : gateway.releaseProcessRecoveryHold(subjects);
    return { accountRef: String(accountRef), subjectRef: account.subject_ref,
      scheduler: { process: schedulerState.processRecoveryHold, subjects: schedulerState.recoveryHeldSubjects, stalled: schedulerState.stalled },
      gateway: { process: gatewayState.processRecoveryHold, subjects: gatewayState.recoveryHeldSubjects, stalled: gatewayState.stalled } };
  }
  function debugInvalidateCurrentFacts({ ownerRef, accountRef, featureId }) {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1') throw problem('DEBUG_TOOLS_DISABLED', '接口不存在', 404);
    const account = accounts.row(ownerRef, String(accountRef)), actor = supervisor.context(account.subject_ref);
    const context = actor ? executionContext(actor) : null, feature = registry.get(featureId);
    if (!context || context.ownerRef !== ownerRef || context.accountRef !== String(accountRef) || !currentContext(context) || !feature)
      throw problem('DEBUG_CURRENT_CONTEXT_REQUIRED', '故障验证需要本号当前正常连接', 409);
    if (store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef))
      throw problem('DEBUG_CURRENT_WRITE_MUST_DRAIN', '故障验证前需要当前写排空', 409);
    const state = dynamicState.snapshot({ context, feature, config: configuration(context).config });
    const domains = [...new Set(state.domains.map(one => one.domainId))];
    if (!domains.length || domains.length > 64) throw problem('DEBUG_FACT_DOMAINS_REQUIRED', '缺少有界当前事实域', 409);
    dynamicState.invalidate({ context, domains, reasonCode: 'DEBUG_REQUIRE_FRESH_FACT_READ' });
    scheduler.notify(context);
    return { subjectRef: context.subjectRef, connectionEpoch: context.connectionEpoch, domains, originalFactsUnchanged: true };
  }
  async function stopAccount({ ownerRef, accountRef, commandId }) {
    accountRef = String(accountRef);
    const entry = accountStopRequestById(ownerRef, accountRef, commandId);
    const prior = accountStopAcknowledgement(commandId);
    if (prior && entry?.request) {
      const request = entry.request;
      if (prior.owner_ref !== ownerRef || prior.account_ref !== accountRef ||
          prior.owner_ref !== request.ownerRef || prior.account_ref !== request.accountRef || prior.subject_ref !== request.subjectRef ||
          prior.official_uid !== request.officialUid) throw problem('ACCOUNT_STOP_ACK_IDENTITY_MISMATCH', '已完成停止回执与持久请求身份不一致', 409);
      try { if (fs.readFileSync(entry.file, 'utf8') === entry.text) fs.unlinkSync(entry.file); }
      catch { /* The exact ACK is durable; a stale file is retried on the next service pass. */ }
      return acknowledgedAccountStop(prior, commandId);
    }
    if (!entry) {
      if (prior) {
        if (prior.owner_ref !== ownerRef || prior.account_ref !== accountRef)
          throw problem('ACCOUNT_STOP_ACK_IDENTITY_MISMATCH', '已完成的本机停止回执与当前账号不一致', 409);
        return acknowledgedAccountStop(prior, commandId);
      }
      const boundary = executionBoundaryContext(accounts.row(ownerRef, accountRef).subject_ref, accountRef);
      recordExecutionTransition(boundary, 'fenced', 'STOP_REQUESTED', commandId);
      recordExecutionTransition(boundary, 'closing', 'STOP_REQUESTED', commandId);
      const quick = await supervisor.stop({ ownerRef, accountRef, commandId });
      if (quick?.cleanupComplete === true) {
        recordExecutionTransition(boundary, 'execution-ended-proven', quick.writeDrainComplete === true ? 'WRITE_DRAIN_COMPLETE' : 'CLEANUP_COMPLETE', commandId);
        recordExecutionTransition(boundary, 'stopped', 'USER_STOPPED', commandId);
      }
      return quick;
    }
    if (!entry.request) throw problem('ACCOUNT_STOP_LATCH_INVALID', '本机保存的单号停止请求无法核实，保持隔离且不执行其他账号操作', 409);
    const account = accounts.persistentStopIdentity(ownerRef, accountRef), request = entry.request;
    if (request.ownerRef !== ownerRef || request.accountRef !== accountRef || request.subjectRef !== account.subjectRef || request.officialUid !== account.uid) {
      if (!invalidAccountStopRequests.has(request.latchId)) {
        invalidAccountStopRequests.add(request.latchId);
        log(ownerRef, accountRef, '本机停止请求的账号身份与当前绑定不一致，未执行停止或清除请求。', 'warn', {
          eventType: 'account-stop-latch-identity-mismatch', reasonCode: 'ACCOUNT_STOP_LATCH_IDENTITY_MISMATCH',
          latchId: request.latchId, accountRef, subjectRefMatches: request.subjectRef === account.subjectRef,
          officialUidMatches: request.officialUid === account.uid });
      }
      throw problem('ACCOUNT_STOP_LATCH_IDENTITY_MISMATCH', '本机停止请求与当前账号UID或绑定不一致，原请求保留', 409);
    }
    const flightKey = `${ownerRef}\u0000${accountRef}\u0000${commandId}`;
    if (accountStopFlights.has(flightKey)) return accountStopFlights.get(flightKey);
    const flight = (async () => {
      const boundary = executionBoundaryContext(accounts.row(ownerRef, accountRef).subject_ref, accountRef);
      recordExecutionTransition(boundary, 'fenced', 'STOP_REQUESTED', commandId);
      recordExecutionTransition(boundary, 'closing', 'STOP_REQUESTED', commandId);
      const result = await supervisor.stop({ ownerRef, accountRef, commandId, reasonCode: 'USER_STOPPED' });
      if (result?.cleanupComplete === true) {
        recordExecutionTransition(boundary, 'execution-ended-proven', result.writeDrainComplete === true ? 'WRITE_DRAIN_COMPLETE' : 'CLEANUP_COMPLETE', commandId);
        recordExecutionTransition(boundary, 'stopped', 'USER_STOPPED', commandId);
      }
      const currentIntent = supervisor.intent(ownerRef, accountRef), currentAccount = supervisor.project(ownerRef, accountRef);
      let latchAcknowledged = false;
      if (result.stopCommitted === true && result.newWritesFenced === true && result.transportClosed === true &&
          result.cleanupComplete === true && result.writeDrainComplete === true && result.stopEpoch === currentIntent?.run_epoch &&
          currentIntent?.desired_running === 0 && currentIntent?.command_id === commandId && currentAccount.state === 'stopped' &&
          currentAccount.connected === false && currentAccount.desiredRunning === false) {
        try {
          const ackReceipt = { ...result, commandId, latchId: commandId, latchAcknowledged: true,
            acknowledgedIdentity: { ownerRef, accountRef, subjectRef: request.subjectRef, officialUid: request.officialUid } };
          store.transaction(() => {
            store.run(`INSERT OR IGNORE INTO backend_account_stop_acknowledgements(latch_id,owner_ref,account_ref,subject_ref,official_uid,receipt_json,recorded_at)
              VALUES(?,?,?,?,?,?,?)`, commandId, ownerRef, accountRef, request.subjectRef, request.officialUid, canonical(ackReceipt), store.nowIso());
            const saved = store.get('SELECT owner_ref,account_ref,subject_ref,official_uid,receipt_json FROM backend_account_stop_acknowledgements WHERE latch_id=?', commandId);
            if (!saved || saved.owner_ref !== ownerRef || saved.account_ref !== accountRef || saved.subject_ref !== request.subjectRef ||
                saved.official_uid !== request.officialUid || canonical(parseStored(saved.receipt_json, '单号停止ACK')) !== canonical(ackReceipt))
              throw problem('ACCOUNT_STOP_ACK_CONFLICT', '停止确认回执未能按原请求持久保存');
          });
          if (fs.readFileSync(entry.file, 'utf8') === entry.text) { fs.unlinkSync(entry.file); latchAcknowledged = true; }
        }
        catch { /* Keep the durable latch pending until its exact acknowledgement can be committed. */ }
      }
      return { ...result, commandId, latchId: commandId, latchAcknowledged,
        ...(latchAcknowledged ? {} : { cleanupComplete: false }) };
    })();
    accountStopFlights.set(flightKey, flight);
    try { return await flight; }
    finally { if (accountStopFlights.get(flightKey) === flight) accountStopFlights.delete(flightKey); }
  }
  async function consumeAccountStopRequestsOnce() {
    let entries;
    try { entries = accountStopRequests(); }
    catch (error) {
      const key = 'directory:' + String(error?.code || 'read-failed');
      if (!invalidAccountStopRequests.has(key)) {
        invalidAccountStopRequests.add(key);
        log(software?.ownerRef?.() || '', '0', '本机单号停止请求根目录暂不可读；仅目标账号的目录围栏生效。', 'warn', {
          eventType: 'account-stop-latch-read-failed', reasonCode: 'ACCOUNT_STOP_LATCH_DIRECTORY_UNREADABLE' });
      }
      return;
    }
    for (const entry of entries) {
      if (entry.directoryOnly) {
        const identity = software?.status?.() || {}, account = accountForStopScope(identity.ownerRef, entry.scopeKey);
        if (account) {
          const key = `directory:${entry.scopeKey}`;
          if (!invalidAccountStopRequests.has(key)) {
            invalidAccountStopRequests.add(key);
            log(account.ownerRef, account.accountRef, '该账号的本机停止请求目录暂不可读；仅阻止此账号继续运行。', 'warn', {
              eventType: 'account-stop-latch-read-failed', reasonCode: 'ACCOUNT_STOP_LATCH_DIRECTORY_UNREADABLE' });
          }
        }
        continue;
      }
      if (!entry.request) {
        const identity = software?.status?.() || {};
        const account = entry.scopeKey ? accountForStopScope(identity.ownerRef, entry.scopeKey) : null;
        const filename = path.basename(entry.file);
        const latchId = filename.toLowerCase().endsWith('.json') ? filename.slice(0, -5) : '';
        if (account && accountStopUuid.test(latchId)) {
          entry.request = targetEnvelopeRequest({ ownerRef: account.ownerRef, accountRef: String(account.accountRef),
            subjectRef: account.subjectRef, officialUid: account.uid }, latchId);
        }
      }
      if (!entry.request) {
        const key = path.basename(entry.file);
        if (!invalidAccountStopRequests.has(key)) {
          invalidAccountStopRequests.add(key);
          log(software?.ownerRef?.() || '', '0', '本机单号停止请求格式无法核实，保持隔离且不清除此文件。', 'warn', {
            eventType: 'account-stop-latch-invalid', reasonCode: 'ACCOUNT_STOP_LATCH_INVALID' });
        }
        continue;
      }
      try {
        const request = entry.request;
        const account = accounts.persistentStopIdentity(request.ownerRef, request.accountRef);
        const expectedScope = accountStopTargetKey({ ownerRef: request.ownerRef, accountRef: String(request.accountRef),
          subjectRef: account.subjectRef, officialUid: account.uid });
        if (entry.scopeKey && entry.scopeKey !== expectedScope) {
          const key = `scope:${entry.scopeKey}:${path.basename(entry.file)}`;
          if (!invalidAccountStopRequests.has(key)) {
            invalidAccountStopRequests.add(key);
            log(request.ownerRef, request.accountRef, '本机停止请求目录与当前账号绑定不一致，原件保留并隔离。', 'warn', {
              eventType: 'account-stop-latch-identity-mismatch', reasonCode: 'ACCOUNT_STOP_LATCH_IDENTITY_MISMATCH', latchId: request.latchId });
          }
          continue;
        }
        await stopAccount({ ownerRef: request.ownerRef, accountRef: request.accountRef, commandId: request.latchId });
      }
      catch { /* Failed or mismatched latches remain durable for a fresh bounded retry. */ }
    }
  }
  function consumeAccountStopRequests() {
    if (accountStopConsumerPromise) return accountStopConsumerPromise;
    const flight = consumeAccountStopRequestsOnce();
    accountStopConsumerPromise = flight;
    return flight.finally(() => { if (accountStopConsumerPromise === flight) accountStopConsumerPromise = null; });
  }
  async function consumeNativeStop() {
    const markerPresent = Boolean(stopFile && fs.existsSync(stopFile));
    if (stopInFlight || !nativeStopLatchPending && !markerPresent) return;
    let request, markerSnapshot = null;
    try { markerSnapshot = markerPresent ? fs.readFileSync(stopFile, 'utf8') : null; request = markerPresent ? JSON.parse(markerSnapshot) : { source: 'native-preference-stop-latch' }; }
    catch { request = { unreadable: true }; }
    const key = fingerprint(request);
    if (seenStopRequests.has(key)) return;
    const markerAt = Number(request.at);
    const latestBeforeMarker = nativeControlRow();
    if (markerPresent && Number.isSafeInteger(markerAt) && markerAt > 0 && latestBeforeMarker &&
        latestBeforeMarker.kind === 'USER_START' && latestBeforeMarker.requested_at_ms > markerAt) {
      // The user already started after this marker was written. Consume the
      // stale marker without draining the newer decision.
      nativeStopLatchPending = false;
      seenStopRequests.add(key);
      try { if (fs.existsSync(stopFile) && fs.readFileSync(stopFile, 'utf8') === markerSnapshot) fs.unlinkSync(stopFile); }
      catch { /* A durable marker may be retried; the control order still fences it. */ }
      return;
    }
    const markerLatchId = typeof request.latchId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(request.latchId) ? request.latchId : nativeStopLatchId;
    const commandId = nativeControlUuid.test(markerLatchId) ? markerLatchId : crypto.randomUUID();
    if (!store.get('SELECT 1 FROM backend_native_stop_controls WHERE command_id=?', commandId)) {
      insertNativeControl({ commandId, kind: 'STOP', sourceInstance: 'native-marker', sourceGeneration: '', requestedAtMs: Date.now() });
      writeNativeControlJournal();
    }
    const owners = store.all('SELECT DISTINCT owner_ref FROM backend_subject_bindings').map(row => row.owner_ref);
    // The native STOP covers the device, including an owner whose software
    // session is currently missing. Persist revocation before awaiting cleanup.
    store.transaction(() => {
      store.run("UPDATE backend_run_intents SET desired_running=0,run_epoch=run_epoch+1,state='STOPPING',reason_code='NATIVE_STOP_REQUESTED',updated_at=? WHERE desired_running=1", store.nowIso());
    });
    nativeReconnectProjection?.request();
    stopInFlight = Promise.all(owners.map(ownerRef => stopAll({ ownerRef, reasonCode: 'NATIVE_STOP_REQUESTED' })));
    try {
      const receipts = await stopInFlight;
      if (receipts.every(receipt => receipt.stopCommitted && receipt.cleanupComplete)) {
        const controlSeq = Number(store.get('SELECT control_seq FROM backend_native_stop_controls WHERE command_id=?', commandId)?.control_seq || 0);
        const latest = nativeControlRow();
        const superseded = Boolean(latest && latest.control_seq > controlSeq);
        const receipt = { latchId: commandId, commandId, stopCommitted: true, cleanupComplete: !superseded,
          controlSeq, instanceId, pid: process.pid, superseded };
        store.transaction(() => {
          if (store.get('SELECT 1 FROM backend_run_intents WHERE desired_running=1 LIMIT 1') || store.get('SELECT 1 FROM backend_subject_owners WHERE active=1 LIMIT 1') ||
              accounts.verificationCount() || inspections?.activeCount() || inspectionRecovery.retireProvedDeadInspection({}).remaining) throw problem('NATIVE_STOP_NOT_COMPLETE', '本机停止清理尚未完成');
          store.run('INSERT OR REPLACE INTO backend_native_stop_receipts VALUES(?,?,?,?,?)', commandId, instanceId, process.pid, canonical(receipt), store.nowIso());
          store.run('UPDATE backend_native_stop_controls SET cleanup_complete=?,receipt_json=?,recorded_at=? WHERE command_id=?',
            superseded ? 0 : 1, canonical(receipt), store.nowIso(), commandId);
        });
        nativeStopReceipt = receipt;
        nativeStopLatchPending = false;
        seenStopRequests.add(key);
        writeNativeControlJournal();
        if (markerPresent && fs.existsSync(stopFile) && fs.readFileSync(stopFile, 'utf8') === markerSnapshot) fs.unlinkSync(stopFile);
      }
    }
    finally { stopInFlight = null; }
  }
  async function initialize() {
    try { await software.initialize(); }
    catch (error) { initializationError = String(error.code || 'SOFTWARE_INITIALIZATION_FAILED'); throw error; }
    // Publish the current ordered control projection before resuming any
    // desire. Java reads this before it starts a passive engine, so a durable
    // STOP that survived an unwritable preference directory still fences it.
    try {
      if (!fs.existsSync(nativeControlJournalPath))
        fs.writeFileSync(nativeControlJournalPath, canonical(projectNativeControl(nativeControlRow())));
      else writeNativeControlJournal();
    } catch { /* The SQLite fence below still protects this process. */ }
    restoreNativeStopReceipt();
    await consumeNativeStop();
    await consumeAccountStopRequests();
    initialized = true;
    void retireStorageImageBackup({ dataDir, store }).catch(() => {});
    nativeReconnectProjection.request();
    cloudSync.start();
    resumeQualifiedIntent();
    stopTimer = setInterval(() => {
      void consumeNativeStop().then(consumeAccountStopRequests).then(resumeQualifiedIntent).catch(() => {});
    }, 300);
    return readiness();
  }
  let storageMaintenanceTurn = 0;
  function resumeQualifiedIntent(authorization = null) {
    if (initialized) void retireStorageImageBackup({ dataDir, store }).catch(() => {});
    if (initialized && !draining && !closing) {
      // Share one bounded storage turn among the fourteen maintenance families.
      // Maintenance must yield on a lock, never spend the business/control
      // connection's five-second lock budget before the next STOP poll.
      try { store.withBusyTimeout(0, () => {
        switch (storageMaintenanceTurn++ % 14) {
          case 0: return facts.retireSuperseded();
          case 1: return landRuntime?.retireHistory();
          case 2: return configHistoryRetirement.retire();
          case 3: return logHistoryRetirement.retire();
          case 4: return spaceMaintenance.maintain();
          case 5: return customerHistoryRetirement.retire();
          case 6: return waterwheelRuntime?.retireAnchors();
          case 7: return orderFlowerRuntime?.retireSources();
          case 8: return orderFlowerAuxiliaryFacts?.retireSources();
          case 9: return dailyArtRuntime?.retireHistory();
          case 10: return landRuntime?.retireGroupReceipts();
          case 11: return orderFlowerRuntime?.retireIdentities();
          case 12: return outboxConsumerRetirement.retire();
          case 13: return landRuntime?.retireKnownHistory();
        }
      }, { maintenanceCommitRollback: true }); } catch { /* Roll back failed proofs/Busy and retry a later fair slice; current intent is unchanged. */ }
    }
    const identity = software.status();
    // This existing 300ms maintenance call only checks in-memory dirty/retry
    // flags. The bounded roster SQL fallback runs at most once per 15s when
    // no direct post-transaction intent/roster notification was received.
    nativeReconnectProjection?.maintain(identity);
    if (authorization && (authorization.ownerRef !== identity.ownerRef || authorization.identityEpoch !== identity.identityEpoch)) return;
    if (!initialized || draining || closing || nativeStopLatchPending || stopFile && fs.existsSync(stopFile) ||
        nativeControlFenceActive() ||
        !identity.authorized || identity.requiresEngineRestart || !identity.ownerRef) {
      resumedIdentity = null;
      return;
    }
    const identityKey = canonical([identity.ownerRef, identity.identityEpoch]);
    if (resumedIdentity === identityKey) return;
    // A late normal grant after a startup network failure can resume only the
    // same durable desired intents. Revocation/STOP already changed them false.
    supervisor.resumeDesired(identity.ownerRef);
    resumedIdentity = identityKey;
  }
  async function shutdown() {
    if (draining || closing) return { cleanupComplete: false, desiredIntentsPreserved: true, alreadyShuttingDown: true };
    draining = true; clearInterval(stopTimer);
    nativeReconnectProjection?.request();
    const sessionShutdown = supervisor.shutdownForRestart();
    const result = await sessionShutdown;
    if (stopInFlight) await stopInFlight.catch(() => {});
    closing = true;
    orderFlowerAuxiliaryRuntime.shutdown();
    legacyHistory.shutdown();
    landRuntime.shutdown();
    customerReadModel.shutdown();
    orderFlowerReadModel.shutdown();
    orderFlowerAuxiliaryFacts.shutdown();
    customerIdentity.shutdown();
    await cloudSync.stop();
    await software.shutdown();
    nativeReconnectProjection?.close();
    if (result.cleanupComplete) {
      store.run('UPDATE backend_local_executors SET closed_at=? WHERE executor_ref=?', store.nowIso(), supervisor.executorRef);
      store.close();
    }
    return result;
  }
  function debugNativeNetworkObservations(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 20));
    const rows = store.all(`SELECT native_source_instance,observation_sequence,payload_json,recorded_at
      FROM backend_native_network_observations ORDER BY recorded_at DESC LIMIT ?`, bounded);
    return { observations: rows.map(row => ({ source: row.native_source_instance, sequence: row.observation_sequence,
      recordedAt: row.recorded_at, payload: parseStored(row.payload_json, '原生网络观察') })) };
  }
  const rewardDebugFrame = ({ ownerRef, subjectRef = null } = {}) => {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1') return null;
    let row = null;
    try {
      row = subjectRef
        ? store.get('SELECT subject_ref,connection_epoch,response_ref,frame_json,recorded_at FROM backend_reward_debug_frames WHERE owner_ref=? AND subject_ref=? ORDER BY connection_epoch DESC LIMIT 1', ownerRef, subjectRef)
        : store.get('SELECT subject_ref,connection_epoch,response_ref,frame_json,recorded_at FROM backend_reward_debug_frames WHERE owner_ref=? ORDER BY recorded_at DESC LIMIT 1', ownerRef);
    } catch { return null; }
    if (!row) return null;
    return { subjectRef: row.subject_ref, connectionEpoch: row.connection_epoch, responseRef: row.response_ref,
      recordedAt: row.recorded_at, frame: JSON.parse(row.frame_json) };
  };
  return Object.freeze({ initialize, shutdown, status, readiness, health, authorizeEngineRestart, importNativeRecoveryEvents, owner, software, accounts, config, supervisor, facts, scheduler, ledger,
    logs, registry, migration, legacy, legacyLogging, legacyHistory, archivedAccounts, inspections, egressMigration, pairMigration, store, proxy, egress, network, cloudSync, softwareStatus, stopAll, nativeStopAll, nativeStartControl, nativeReconnectProjection, debugNativeNetworkObservations, rewardDebugFrame, mailDebugFrame, rewardTableStatus, rewardStateView, maybeMailPrefetch, debugSubjectHold, debugStageHold, debugInvalidateCurrentFacts, accountReaddRecovery, stopAccount, isAccountStopPending, log, instanceId, landRuntime, specialOrderRuntime, customerReadModel, customerCatalog, orderFlowerReadModel, orderFlowerCatalog,
    customerPlanning: (input, options = {}) => {
      const actor = supervisor.context(input.subjectRef), context = actor ? executionContext(actor) : null;
      const validContext = context && context.ownerRef === input.ownerRef && context.accountRef === String(input.accountRef) && currentContext(context);
      if (!validContext) {
        const result = { current: false, writeEligible: false, reasonCode: 'CUSTOMER_PLANNING_CONTEXT_UNAVAILABLE' };
        return options.requestLocal === true ? { result, plan: null, settings: null, planSettings: null, context: null } : result;
      }
      const settings = configuration(context);
      // Keep this full internal plan local to the caller. It is read-only and
      // may be reused only by the same synchronous observations response.
      const currentPlan = customerRuntime.planning(context, settings);
      const { view, identities, decisions } = currentPlan;
      // Preserve the existing observations preview policy reference; this is
      // not the allocation policy used by the execution planner.
      const allocation = customerAllocation.plan({ context, identityView: identities, decisions,
        keepPolicy: { known: true, keep: 0, policyRef: 'customer.md/4+8.1/current-G3A-finished-stock/no-extra-business-reserve' } });
      const generationFacts = customerGenerationFacts.read(context);
      const generation = evaluateCustomerGeneration({ context, view, config: settings, eligibility: currentPlan.eligibility,
        clock: facts.clock(context.subjectRef), generationFacts });
      const result = { current: view.current, writeEligible: false, identities, decisions, allocation, eligibility: currentPlan.eligibility,
        generationFacts, generation };
      return options.requestLocal === true ? { result, plan: currentPlan, settings, planSettings: settings, context } : result;
    },
    orderFlowerPlanning: input => {
      const actor = supervisor.context(input.subjectRef), context = actor ? executionContext(actor) : null;
      if (!context || context.ownerRef !== input.ownerRef || context.accountRef !== String(input.accountRef) || !currentContext(context)) return {
        current: false, readOnly: true, writeEligible: false, reasonCode: 'ORDER_FLOWER_PLANNING_CONTEXT_UNAVAILABLE' };
      const view = orderFlowerReadModel.snapshot(context), currentClock = facts.clock(context.subjectRef), settings = configuration(context);
      const eligibility = orderFlowerEligibility.evaluate({ context, view, clock: currentClock });
      return { current: view.current, readOnly: true, writeEligible: false, eligibility, auxiliary: orderFlowerAuxiliaryFacts.read(context),
        auxiliaryReadiness: orderFlowerAuxiliaryRuntime.readiness(context),
        stock: planOrderFlowerStock({ context, view, config: settings, catalog: orderFlowerCatalog, resources: landRuntime.resources,
          eligibility, clock: currentClock, officialDay: customerGenerationFacts.read(context).officialDay,
          readPolicyCount: orderFlowerRuntime.readPolicyCount,
          keepPolicy: { known: true, keep: 0, policyRef: 'current-three-orders/confirmed-stock/no-additional-business-reserve/v1' } }) };
    },
    artPlanning: (input, requestLocal = null) => {
      const actor = supervisor.context(input.subjectRef), context = actor ? executionContext(actor) : null;
      if (!context || context.ownerRef !== input.ownerRef || context.accountRef !== String(input.accountRef) || !currentContext(context)) return { current: false, writeEligible: false, reasonCode: 'ART_PLANNING_CONTEXT_UNAVAILABLE' };
      const sameContext = requestLocal?.context && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch']
        .every(key => requestLocal.context[key] === context[key]);
      const reusable = sameContext && requestLocal.plan?.view?.current === true &&
        requestLocal.settings && requestLocal.settings === requestLocal.planSettings &&
        requestLocal.plan.view.context?.ownerRef === context.ownerRef && String(requestLocal.plan.view.context?.accountRef) === context.accountRef &&
        requestLocal.plan.view.context?.subjectRef === context.subjectRef && requestLocal.plan.view.context?.ownerEpoch === context.ownerEpoch &&
        requestLocal.plan.view.context?.runEpoch === context.runEpoch && requestLocal.plan.view.context?.connectionEpoch === context.connectionEpoch;
      const settings = reusable ? requestLocal.settings : configuration(context);
      return artRuntime.planning(context, settings, reusable ? requestLocal.plan : null);
    },
    readCurrentFacts: async ({ ownerRef, accountRef, subjectRef, normalLoginSyncProbe = false, normalReloginProbe = false }) => {
      software.authorize({ ownerRef });
      const actor = supervisor.context(subjectRef), context = actor ? executionContext(actor) : null;
      if (!context || context.ownerRef !== ownerRef || context.accountRef !== String(accountRef) || !currentContext(context) || !actor.connection?.isOpen()) throw problem('CURRENT_READ_CONTEXT_REQUIRED', '当前账号尚无可用官服连接');
      // Existing audited read only. Its customer-domain coverage is observed,
      // never inferred from the method's name or a successful envelope.
      if (normalLoginSyncProbe || normalReloginProbe) {
        const settings = config.read({ ownerRef, accountRef: String(accountRef) }).config;
        if (CONFIG_FIELDS.filter(field => field.type === 'boolean').some(field => field.dtoPath.split('.').reduce((node, key) => node?.[key], settings) !== false) ||
          store.get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', subjectRef)) throw problem('NORMAL_LOGIN_SYNC_PROBE_ALL_DISABLED_REQUIRED', '同步来源取证须全部业务意愿临时关闭且没有当前写');
      }
      const observation = normalReloginProbe ? await actor.connection.probeNormalRelogin() : normalLoginSyncProbe ? await actor.connection.probeNormalLoginSync() : await actor.connection.read('usrLand.refresh', {});
      software.authorize({ ownerRef });
      if (!currentContext(context)) throw problem('CURRENT_READ_CONTEXT_REVOKED', '旧代际读取不能作为当前结果');
      return { readOnly: !normalLoginSyncProbe && !normalReloginProbe, normalClientSyncProbe: normalLoginSyncProbe, normalClientReloginProbe: normalReloginProbe, businessPostReadAdmitted: false,
        method: observation.method, transport: observation.transport, envelopeOk: observation.envelopeOk,
        connectionEpoch: observation.connectionEpoch, requestSequence: observation.requestSequence, responseRef: observation.responseRef };
    }, buildId: BACKEND_BUILD_ID });
}
