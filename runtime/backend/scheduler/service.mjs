import { canonical, fingerprint, newId, parseStored, problem } from '../common.mjs';

const RESULT_STATES = new Set(['no-action', 'waiting-facts', 'waiting-until', 'blocked', 'unimplemented', 'proposals', 'disabled', 'cap-wait']);
const CAP_CLOCK_RECHECK_MS = 60000;
const SUPERSESSION_CODES = new Set(['WRITE_FACTS_SUPERSEDED', 'WRITE_CONFIG_SUPERSEDED']);
const STAGE_NO_PROGRESS_LIMIT_MS = Object.freeze({
  'clock-reacquire': 5 * 60_000,
  'scheduled-fact-refresh': 5 * 60_000,
  'proposal-fact-refresh': 5 * 60_000,
  'branch-fact-refresh': 5 * 60_000,
  'feature-assess': 3 * 60_000,
});
const CONTEXT_AXES = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const sameContext = (left, right) => Boolean(left && right && CONTEXT_AXES.every(axis =>
  axis === 'accountRef' ? String(left[axis]) === String(right[axis]) : left[axis] === right[axis]));
const featureContextOf = context => Object.freeze(Object.fromEntries(CONTEXT_AXES.map(key => [key,
  key === 'accountRef' ? String(context[key]) : context[key]])));
const schedulerConfigFence = config => canonical({ savedRevision: config?.savedRevision ?? null,
  cancelEpoch: config?.cancelEpoch ?? null, featureCancelEpochs: config?.featureCancelEpochs ?? null });
const featureActivation = Object.freeze({
  plant: config => config?.config?.plantEnabled === true,
  harvest: config => config?.config?.harvestEnabled === true,
  water: config => config?.config?.waterEnabled === true,
  waterwheel: config => config?.config?.waterwheelEnabled === true,
  'free-water': config => config?.config?.freeWaterEnabled === true,
  'order.customer': config => config?.config?.orders?.customer?.enabled === true,
  'order.resident': config => config?.config?.orders?.resident?.enabled === true,
  'order.satin': config => config?.config?.orders?.satin?.enabled === true,
  'order.decorate': config => config?.config?.orders?.decorate?.enabled === true,
  'order.palace': config => config?.config?.orders?.palace?.enabled === true,
  'order.team': config => config?.config?.orders?.team?.enabled === true && config?.config?.orders?.team?.realWrite === true,
  'art.make': config => config?.config?.art?.makeEnabled === true,
  'art.first-album': config => config?.config?.art?.firstAlbumClaim === true,
  'art.first-share': config => config?.config?.art?.firstShareClaim === true,
  'art.customer-batch': config => config?.config?.art?.makeEnabled === true && config?.config?.orders?.customer?.enabled === true,
  'art.daily': config => config?.config?.art?.dailyMakeEnabled === true && config?.config?.art?.autoReplenish === true,
  'flower-rack': config => config?.config?.flowerRack?.enabled === true || config?.config?.flowerRack?.autoTakeDown === true ||
    config?.config?.flowerRack?.unlockEnabled === true,
});
const featureActive = (feature, config) => {
  if (feature?.parentFeatureId === 'land.acceleration') return config?.config?.accelerationMode === feature?.mode;
  if (feature?.featureId === 'flower-rack' && typeof feature.scheduleKey === 'string') {
    const rack = config?.config?.flowerRack || {};
    if (feature.scheduleKey === 'flower-rack:receive' || feature.scheduleKey === 'flower-rack:sell') return rack.enabled === true;
    if (feature.scheduleKey === 'flower-rack:maintenance') return rack.autoTakeDown === true;
    if (feature.scheduleKey === 'flower-rack:unlock') return rack.unlockEnabled === true;
  }
  const activation = featureActivation[feature?.parentFeatureId || feature?.featureId];
  return activation ? activation(config) : true;
};
const parentFeatureId = feature => feature?.parentFeatureId || feature?.featureId;
const scheduleKey = feature => feature?.scheduleKey || feature?.featureId;
const workUnits = registry => registry.modules().flatMap(parent => Array.isArray(parent.scheduleUnits) && parent.scheduleUnits.length
  ? parent.scheduleUnits.map(unit => Object.freeze({ ...parent, ...unit, parentFeatureId: parent.featureId,
    scheduleKey: unit.scheduleKey, scheduleUnits: undefined })) : [parent]);

export function schedulerConsumerReplacementContracts(registry){
  const active=new Set(workUnits(registry).map(scheduleKey)),allowed=new Set(['order.customer','order.resident','order.satin','order.decorate']);
  return registry.modules().filter(parent=>allowed.has(parent.featureId)&&!active.has(parent.featureId)
    &&Array.isArray(parent.scheduleUnits)&&parent.scheduleUnits.length).map(parent=>Object.freeze({
      parentFeatureId:parent.featureId,implementationVersion:parent.implementationVersion??null,
      successorUnits:parent.scheduleUnits.map(unit=>unit.scheduleKey).sort(),
      methods:[...(parent.methods||[])].sort(),scopes:[...(parent.scopes||[])].sort()}));
}

// Durable deadlines and per-feature outbox cursors are authoritative. Timers
// merely request another pass; a busy pass leaves new events unconsumed.
export function createScheduler({ store, ledger, registry, readConfiguration, acceptConfiguration, recordPlan,
  facts, submitProposal, isCurrent, deviceNow = () => Date.now(), monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  onError = () => {}, checksPerTurn = 8, beforeStage = null,
  maxSupersessionReplans = 3, replanBaseMs = 1000, replanMaxMs = 5000,
  canSchedule = null, readExternalHold = null, dynamicState = null, capClockRecheckMs = CAP_CLOCK_RECHECK_MS }) {
  if (![maxSupersessionReplans, replanBaseMs, replanMaxMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      maxSupersessionReplans > 8 || replanMaxMs > 60000 || replanMaxMs < replanBaseMs) throw new TypeError('Scheduler supersession replans require finite positive bounds');
  if (!Number.isSafeInteger(capClockRecheckMs) || capClockRecheckMs < 10 || capClockRecheckMs > 120000) throw new TypeError('Cap clock recovery interval is out of bounds');
  if (beforeStage !== null && typeof beforeStage !== 'function') throw new TypeError('Scheduler stage observer must be a function');
  for (const port of [canSchedule, readExternalHold]) if (port !== null &&
      (typeof port !== 'function' || port.constructor?.name === 'AsyncFunction')) throw new TypeError('Scheduler admission ports must be synchronous');
  if (!dynamicState || typeof dynamicState.snapshot !== 'function' || typeof dynamicState.ensureCurrent !== 'function') {
    throw new TypeError('Scheduler requires the shared dynamic-state coordinator');
  }
  // Recovery holds name the exact subjects whose own drain is unresolved.
  // A single account's stuck cleanup must not suspend admission for other
  // accounts in the same engine process.
  const recoveryHolds = { process: false, subjects: new Set() };
  const recoveryHeldFor = subjectRef => recoveryHolds.process || recoveryHolds.subjects.has(subjectRef);
  function admissionOpen(context) {
    if (recoveryHeldFor(context.subjectRef)) return false;
    try {
      if (readExternalHold && readExternalHold(context) === true) return false;
      return canSchedule ? canSchedule(context) === true : true;
    } catch { return false; }
  }
  const { get, all, run, transaction, nowIso } = store;
  function fairnessCredit(context, feature) {
    const row = get('SELECT skip_credit FROM backend_scheduler_fairness WHERE owner_ref=? AND subject_ref=? AND feature_id=?',
      context.ownerRef, context.subjectRef, scheduleKey(feature));
    const value = row?.skip_credit ?? '0';
    if (typeof value !== 'string' || !/^\d{1,128}$/.test(value)) throw problem('SCHEDULER_FAIRNESS_STATE_INVALID', '调度公平轮转状态损坏', 500);
    return BigInt(value);
  }
  function persistFairnessCredit(context, feature, credit) {
    run(`INSERT INTO backend_scheduler_fairness VALUES(?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
      DO UPDATE SET skip_credit=excluded.skip_credit,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef,
    scheduleKey(feature), credit.toString(), nowIso());
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_feature_wakes(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,wake_key TEXT NOT NULL,
    config_revision INTEGER NOT NULL,official_due_ms INTEGER,device_due_ms INTEGER,clock_revision INTEGER,
    last_checked_ms INTEGER,last_fact_basis_json TEXT NOT NULL,state TEXT NOT NULL,reason_code TEXT,
    wake_revision INTEGER NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,feature_id));
    CREATE TABLE IF NOT EXISTS backend_feature_failures(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,
    event_watermark INTEGER NOT NULL,config_revision INTEGER NOT NULL,reason_code TEXT NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id));
    CREATE TABLE IF NOT EXISTS backend_feature_replans(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,account_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    attempt INTEGER NOT NULL,max_attempts INTEGER NOT NULL,status TEXT NOT NULL,due_ms INTEGER,
    config_revision INTEGER NOT NULL,event_watermark INTEGER NOT NULL,reason_code TEXT NOT NULL,
    receipt_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id));
    CREATE TABLE IF NOT EXISTS backend_period_suspensions(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,quota_key TEXT NOT NULL,action_scope TEXT NOT NULL,
    period_kind TEXT NOT NULL,period_key TEXT NOT NULL,period_end_official_ms INTEGER NOT NULL,scope TEXT NOT NULL,
    used INTEGER NOT NULL,limit_value INTEGER NOT NULL,proof_refs_json TEXT NOT NULL,config_revision INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id,quota_key,period_key));
    CREATE TABLE IF NOT EXISTS backend_scheduler_maintenance_wakes(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,task_key TEXT NOT NULL,account_ref TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
      source_key TEXT NOT NULL,source_version TEXT NOT NULL,next_due_ms INTEGER NOT NULL,attempt INTEGER NOT NULL,
      state TEXT NOT NULL,reason_code TEXT NOT NULL,last_started_at TEXT,updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,task_key));
    CREATE TABLE IF NOT EXISTS backend_scheduler_fairness(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,skip_credit TEXT NOT NULL,
      updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id));`);
  const sessions = new Map();
  const storageBusy = error => [5,6].includes(Number(error?.errcode) & 255) || /locked|busy/i.test(error?.message || '');
  function deferStorage(context, session) {
    session.storageRetryAtMs = deviceNow() + 500;
    session.storageBusyReason = 'SCHEDULER_STORAGE_BUSY'; session.requested = true;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => notify(context), 500);
  }
  const key = context => canonical([context.ownerRef, context.subjectRef]);
  const sessionFor = context => {
    const session = sessions.get(key(context));
    return session && sameContext(session.context, context) ? session : null;
  };
  const consumer = (context, feature) => 'scheduler:' + context.ownerRef + ':' + context.subjectRef + ':' + scheduleKey(feature);
  function wakeRow(context, feature) {
    return get('SELECT * FROM backend_feature_wakes WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, scheduleKey(feature));
  }
  function persistCapWake(context, feature, { configRevision, officialDueMs, clockRevision = null, requestedDeviceDueMs = null,
    rearmDeviceDeadline = false, evidenceRef = null } = {}) {
    const unitKey = scheduleKey(feature), old = wakeRow(context, feature), session = sessionFor(context);
    const deviceDueMs = rearmDeviceDeadline ? requestedDeviceDueMs : (old?.device_due_ms ?? requestedDeviceDueMs);
    const oldDeadline = session?.wakeDeadlines.get(unitKey);
    const changed = !old || old.config_revision !== configRevision || old.official_due_ms !== officialDueMs ||
      old.device_due_ms !== deviceDueMs || old.state !== 'cap-wait' || old.reason_code !== 'PERIOD_CAP_WAIT';
    const revision = old ? old.wake_revision + Number(changed) : 1;
    const basis = canonical({ reasonCode: 'PERIOD_CAP_WAIT', inheritedQuotaKeys: feature.quotaKeys || [], evidenceRef });
    run(`INSERT INTO backend_feature_wakes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
      DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=excluded.official_due_ms,device_due_ms=excluded.device_due_ms,
      clock_revision=excluded.clock_revision,last_checked_ms=excluded.last_checked_ms,last_fact_basis_json=excluded.last_fact_basis_json,
      state='cap-wait',reason_code='PERIOD_CAP_WAIT',wake_revision=excluded.wake_revision,updated_at=excluded.updated_at`,
    context.ownerRef, context.subjectRef, unitKey, feature.wakeKey || unitKey, configRevision, officialDueMs, deviceDueMs,
    clockRevision, deviceNow(), basis, 'cap-wait', 'PERIOD_CAP_WAIT', revision, nowIso());
    if (session) {
      if (deviceDueMs === null) session.wakeDeadlines.delete(unitKey);
      else if (!rearmDeviceDeadline && oldDeadline && oldDeadline.wallDeadline === deviceDueMs) {
        session.wakeDeadlines.set(unitKey, { ...oldDeadline, revision });
      } else monotonicDeadline(session, session.wakeDeadlines, unitKey, revision, deviceDueMs);
    }
    return wakeRow(context, feature);
  }
  function capsFor(context, feature) {
    const parentId = parentFeatureId(feature), unitKey = scheduleKey(feature), legacyCapScope = unitKey === parentId || unitKey.endsWith(':delivery') ? 'feature' : unitKey;
    const quotaKeys = Array.isArray(feature.quotaKeys) ? feature.quotaKeys : [];
    return all('SELECT feature_id,quota_key,action_scope,scope,period_end_official_ms,config_revision FROM backend_period_suspensions WHERE owner_ref=? AND subject_ref=?',
      context.ownerRef, context.subjectRef).filter(cap => {
        const belongsToParent = cap.feature_id === parentId || cap.feature_id === unitKey || cap.feature_id.startsWith(parentId + ':');
        const actionMatch = (cap.feature_id === parentId || cap.feature_id === unitKey) &&
          (cap.action_scope === unitKey || cap.action_scope === legacyCapScope);
        return belongsToParent && (actionMatch || quotaKeys.includes(cap.quota_key));
      });
  }
  function monotonicDeadline(session, map, key, revision, wallDeadline) {
    if (wallDeadline === null) { map.delete(key); return null; }
    let saved = map.get(key);
    if (!saved || saved.revision !== revision || saved.wallDeadline !== wallDeadline) {
      saved = { revision, wallDeadline, dueMono: monotonicNow() + Math.max(0, wallDeadline - deviceNow()) };
      map.set(key, saved);
    }
    return saved.dueMono;
  }
  function wakeDue(context, wake) {
    if (!wake || wake.device_due_ms === null) return false;
    const session = sessionFor(context);
    if (!session) return wake.device_due_ms <= deviceNow();
    return monotonicDeadline(session, session.wakeDeadlines, wake.feature_id, wake.wake_revision, wake.device_due_ms) <= monotonicNow();
  }
  function relevant(event, feature) {
    const payload = event.payload;
    if (event.eventType === 'ConfigChanged') return payload.changedFeatures?.includes(parentFeatureId(feature)) === true;
    if (event.eventType === 'FactsChanged') return feature.factDomains?.includes(payload.domain) === true;
    if (event.eventType === 'ResourceChanged') return feature.resourceKinds?.includes(payload.resourceKind) === true;
    if (event.eventType === 'OperationVerified') return payload.featureId === parentFeatureId(feature) || feature.dependencyFeatures?.includes(payload.featureId) === true;
    if (Array.isArray(feature.eventTypes) && !feature.eventTypes.includes(event.eventType)) return false;
    return ['StartRequested', 'NetworkChanged'].includes(event.eventType);
  }
  function events(context, feature) {
    return store.withBusyTimeout(0, () => {
    const request = { consumerId: consumer(context, feature), ownerRef: context.ownerRef, subjectRef: context.subjectRef, limit: 1000 };
    const prefix = ledger.readPendingOutbox(request);
    const previousFailure = failure(context, scheduleKey(feature));
    // Failed relevant events must remain pending. They must not, however,
    // conceal a later meaningful event behind the first bounded page. Inspect
    // a second bounded window after the last actually attempted failure input.
    const later = previousFailure ? ledger.readPendingOutbox({ ...request, afterEventId: previousFailure.event_watermark }) : [];
    if (prefix.scanHasMore || later.scanHasMore) {
      const session = sessions.get(key(context)); if (session) session.requested = true;
    }
    const batch = [...new Map([...prefix, ...later].map(event => [event.eventId, event])).values()]
      .sort((left, right) => left.eventId - right.eventId);
    // Explicitly irrelevant events can advance independently of a business
    // assessment, so an old unrelated prefix cannot hide a later relevant event.
    const irrelevant = batch.filter(event => !relevant(event, feature));
    if (irrelevant.length) transaction(() => {
      for (const event of irrelevant) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
        receipt: { featureId: parentFeatureId(feature), scheduleKey: scheduleKey(feature), state: 'not-applicable-to-feature' } });
    });
    if ((prefix.length === 1000 || later.length === 1000) && irrelevant.length) {
      const session = sessions.get(key(context)); if (session) session.requested = true;
    }
    return batch.filter(event => relevant(event, feature));
    // Projection scans and explicitly irrelevant-event receipts have no
    // external effect. Roll back a Busy COMMIT and let drain retry the page.
    }, { maintenanceCommitRollback: true });
  }
  function failure(context, featureId) {
    return get('SELECT * FROM backend_feature_failures WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, featureId);
  }
  function replan(context, featureId, includeOtherContext = false) {
    const row = get('SELECT * FROM backend_feature_replans WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, featureId);
    const recorded = row && { ownerRef: row.owner_ref, accountRef: row.account_ref, subjectRef: row.subject_ref,
      ownerEpoch: row.owner_epoch, runEpoch: row.run_epoch, connectionEpoch: row.connection_epoch };
    return row && (includeOtherContext || sameContext(recorded, context)) ? row : null;
  }
  function newFailureTrigger(old, pendingEvents, revision) {
    return Boolean(old && (old.config_revision !== revision || pendingEvents.some(event => event.eventId > old.event_watermark)));
  }
  function clearReplan(context, featureId) {
    run(`DELETE FROM backend_feature_replans WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND account_ref=?
      AND owner_epoch=? AND run_epoch=? AND connection_epoch=?`, context.ownerRef, context.subjectRef, featureId,
    String(context.accountRef), context.ownerEpoch, context.runEpoch, context.connectionEpoch);
  }
  function beginFeatureAttempt(context, feature, pendingEvents, revision) {
    const key = scheduleKey(feature);
    return transaction(() => {
      if (!isCurrent(context)) return false;
      const old = replan(context, key, true);
      if (!old) return true;
      if (!replan(context, key) || newFailureTrigger(failure(context, key), pendingEvents, revision)) {
        run('DELETE FROM backend_feature_replans WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, key);
        return true;
      }
      if (old.status === 'scheduled') {
        const session = sessionFor(context);
        const dueMono = session ? monotonicDeadline(session, session.retryDeadlines, key, old.config_revision, old.due_ms)
          : old.due_ms;
        if (old.due_ms === null || (session ? dueMono > monotonicNow() : dueMono > deviceNow())) return false;
        run("UPDATE backend_feature_replans SET status='attempting',due_ms=NULL,updated_at=? WHERE owner_ref=? AND subject_ref=? AND feature_id=?",
          nowIso(), context.ownerRef, context.subjectRef, key);
      }
      return old.status !== 'exhausted' && old.status !== 'blocked';
    });
  }
  function validSupersession(error, context, feature, latest) {
    const receipt = error?.preSendSupersession;
    if (!receipt || receipt.version !== 'gateway-presend-supersession/v1' || receipt.kind !== 'superseded-before-send' ||
        !SUPERSESSION_CODES.has(error.code) || receipt.reasonCode !== error.code || receipt.featureId !== parentFeatureId(feature) ||
        !sameContext(receipt.context, context) || receipt.notSentVerified !== true || receipt.durableOutcome !== true ||
        receipt.consumed !== false || receipt.byteSendStarted !== false || receipt.currentConfigRevision !== latest.savedRevision ||
        receipt.currentFeatureCancelEpoch !== latest.featureCancelEpochs[parentFeatureId(feature)]) return null;
    const { receiptRef, ...body } = receipt;
    if (receiptRef !== 'presend-supersession:' + fingerprint(body) ||
        (error.code === 'WRITE_FACTS_SUPERSEDED' ? receipt.factsChanged !== true || receipt.originalBasisFingerprint === receipt.currentBasisFingerprint : receipt.configChanged !== true)) return null;
    const operation = ledger.operation(receipt.operationId);
    if (receipt.operationPrepared === false) { if (operation) return null; }
    else if (receipt.operationPrepared === true) {
      if (!operation || operation.transport_state !== 'not_sent' || operation.business_verdict !== 'not_applicable' || operation.write_slot !== 0 ||
          operation.owner_ref !== context.ownerRef || String(operation.account_ref) !== String(context.accountRef) || operation.subject_ref !== context.subjectRef ||
          operation.original.ownerEpoch !== context.ownerEpoch || operation.run_epoch !== context.runEpoch || operation.connection_epoch !== context.connectionEpoch) return null;
      const permit = get('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', receipt.operationId);
      if (!permit || permit.consumed !== 0 || permit.wire_key !== null || permit.request_sequence !== null) return null;
    } else return null;
    return isCurrent(context) ? receipt : null;
  }
  function retryEligible(context, feature, pendingEvents, revision) {
    const key = scheduleKey(feature);
    const old = failure(context, key);
    const scheduled = replan(context, key);
    const session = sessionFor(context);
    const retryDue = scheduled?.due_ms !== null && scheduled?.due_ms !== undefined &&
      (session ? monotonicDeadline(session, session.retryDeadlines, key, scheduled.config_revision, scheduled.due_ms) <= monotonicNow() : scheduled.due_ms <= deviceNow());
    return !old || newFailureTrigger(old, pendingEvents, revision) || scheduled?.status === 'scheduled' &&
      scheduled.config_revision === revision && retryDue;
  }
  function schedule(context) {
    const session = sessionFor(context);
    if (!session || !isCurrent(context)) return;
    clearTimeout(session.timer); session.timer = null;
    if (session.quiesced || recoveryHeldFor(context.subjectRef)) return;
    if (session.storageRetryAtMs > deviceNow()) {
      session.timer = setTimeout(() => notify(context), Math.max(1, session.storageRetryAtMs - deviceNow())); return;
    }
    if (!admissionOpen(context)) {
      const waits = [...session.maintenanceTasks.values()].filter(task => !task.running)
        .map(task => Math.max(0, task.nextDueMs - deviceNow()));
      if (waits.length) session.timer = setTimeout(() => {
        for (const task of session.maintenanceTasks.values()) void dispatchMaintenance(context, session, task);
        schedule(context);
      }, Math.min(2147483647, Math.min(...waits)));
      return;
    }
    const currentConfig = readConfiguration(context), revision = currentConfig.savedRevision;
    const rows = all('SELECT * FROM backend_feature_wakes WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef);
    const official = facts.clock(context.subjectRef);
    const unitByKey = new Map(workUnits(registry).map(feature => [scheduleKey(feature), feature]));
    const waits = rows.filter(row => {
      const feature = unitByKey.get(row.feature_id);
      return feature && featureActive(feature, currentConfig) &&
        (retryEligible(context, feature, events(context, feature), revision) || replan(context, scheduleKey(feature))?.status === 'scheduled');
    }).map(row => {
      const values = [];
      if (row.device_due_ms !== null) values.push(Math.max(0, monotonicDeadline(session, session.wakeDeadlines,
        row.feature_id, row.wake_revision, row.device_due_ms) - monotonicNow()));
      const pendingReplan = replan(context, row.feature_id);
      if (pendingReplan?.status === 'scheduled' && pendingReplan.due_ms !== null) values.push(Math.max(0,
        monotonicDeadline(session, session.retryDeadlines, row.feature_id, pendingReplan.config_revision, pendingReplan.due_ms) - monotonicNow()));
      if (row.official_due_ms !== null && official.available) values.push(Math.max(0, row.official_due_ms - official.nowMs));
          if (row.state === 'cap-wait' && row.official_due_ms !== null && !official.available) values.push(capClockRecheckMs);
      return values.length ? Math.min(...values) : null;
    }).filter(value => value !== null);
    for (const task of session.maintenanceTasks.values()) if (!task.running) waits.push(Math.max(0, task.nextDueMs - deviceNow()));
    if (waits.length) session.timer = setTimeout(() => {
      for (const task of session.maintenanceTasks.values()) void dispatchMaintenance(context, session, task);
      notify(context);
    }, Math.min(2147483647, Math.min(...waits)));
    // Close the window between reading deadlines and arming the timer. The
    // durable events remain available if this process is interrupted here.
    if (session.factWakeUnits.size || workUnits(registry).some(feature => {
      if (!featureActive(feature, currentConfig)) return false;
      const pendingEvents = events(context, feature);
      return pendingEvents.length && retryEligible(context, feature, pendingEvents, revision);
    }) || session.requested) {
      clearTimeout(session.timer); session.timer = setTimeout(() => notify(context), 0);
    }
  }
  async function inStage(session, context, feature, stage, action, candidate = null, operationId = null) {
    const startedMono = monotonicNow(), startedAtMs = deviceNow();
    const token = Symbol(stage);
    const stageLimitMs = STAGE_NO_PROGRESS_LIMIT_MS[stage] || 5 * 60_000;
    session.activeStage = { token, ownerRef: context.ownerRef, accountRef: String(context.accountRef), subjectRef: context.subjectRef,
      ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch, connectionEpoch: context.connectionEpoch,
      featureKey: scheduleKey(feature), operationId, stage, stageLimitMs, startedMono, startedAtMs, deadlineMono: startedMono + stageLimitMs,
      deadlineAtMs: startedAtMs + stageLimitMs,
      businessDueAtMs: candidate?.wake?.device_due_ms ?? null, officialDueAtMs: candidate?.wake?.official_due_ms ?? null };
    try {
      if (beforeStage) await beforeStage({ context, featureId: parentFeatureId(feature), stage, operationId, signal: context.signal });
      return await action();
    }
    finally { if (session.activeStage?.token === token) session.activeStage = null; }
  }
  async function drain(context) {
    const session = sessionFor(context);
    if (!session || session.busy || session.quiesced || !admissionOpen(context) || !isCurrent(context)) return;
    if (session.storageRetryAtMs > deviceNow()) return;
    session.storageRetryAtMs = 0; session.storageBusyReason = null; session.busy = true;
    try {
      do {
        session.requested = false;
        if (!admissionOpen(context) || !isCurrent(context)) return;
        const config = readConfiguration(context);
        if (session.acceptedRevision !== config.savedRevision) {
          transaction(() => {
            if (!isCurrent(context)) throw problem('RUN_INTENT_REVOKED', '运行意愿已撤销');
            acceptConfiguration(context, config.savedRevision);
          });
          session.acceptedRevision = config.savedRevision;
        }
        if (session.factWakeUnits.size) {
          const units = new Map(workUnits(registry).map(feature => [scheduleKey(feature), feature]));
          for (const unitKey of session.factWakeUnits) {
            const feature = units.get(unitKey);
            if (!feature || !featureActive(feature, config)) session.factWakeUnits.delete(unitKey);
          }
        }
        const registeredUnits = workUnits(registry);
        const candidateFence = schedulerConfigFence(config), candidates = [];
        let rebuildCandidates = false;
        for (let index = 0; index < registeredUnits.length; index += 1) {
          const feature = registeredUnits[index];
          candidates.push({ feature, wake: wakeRow(context, feature), events: events(context, feature) });
          if (index + 1 >= registeredUnits.length) continue;
          await new Promise(resolve => setImmediate(resolve));
          if (sessionFor(context) !== session || session.quiesced || !admissionOpen(context) || !isCurrent(context)) return;
          const latest = readConfiguration(context);
          if (schedulerConfigFence(latest) !== candidateFence) {
            rebuildCandidates = true;
            break;
          }
        }
        if (rebuildCandidates) { session.requested = true; continue; }
        let official = facts.clock(context.subjectRef);
        if (!official.available) {
          for (const candidate of candidates) {
            if (official.available) break;
            const feature = candidate.feature, parentId = parentFeatureId(feature), unitKey = scheduleKey(feature);
            const caps = capsFor(context, feature);
            if (!caps.length || !featureActive(feature, config)) continue;
            if (candidate.wake?.device_due_ms === null || !candidate.wake) {
              const dueMs = candidate.wake?.device_due_ms ?? deviceNow() + capClockRecheckMs;
              transaction(() => persistCapWake(context, feature, { configRevision: config.savedRevision,
                officialDueMs: Math.min(...caps.map(cap => cap.period_end_official_ms)), requestedDeviceDueMs: dueMs,
                clockRevision: null, evidenceRef: 'official-clock-reacquire:' + unitKey }));
              continue;
            }
            if (!wakeDue(context, candidate.wake)) continue;
            // A cap remains authoritative while the shared clock domain is
            // reacquired. This refresh cannot assess or submit game work.
            dynamicState.invalidate({ context: featureContextOf(context), domains: ['clock'], reasonCode: 'OFFICIAL_CLOCK_UNAVAILABLE' });
            const clockFeature = { ...feature, consumedDomains: ['clock'], consumedDomainsFor: () => ['clock'] };
            const refreshed = await inStage(session, context, feature, 'clock-reacquire', () => dynamicState.ensureCurrent({
              context: featureContextOf(context), feature: clockFeature, config: config.config,
              reasonCode: 'OFFICIAL_CLOCK_UNAVAILABLE', signal: context.signal }), candidate);
            if (!admissionOpen(context) || !isCurrent(context)) return;
            if (refreshed.newContext) { notify(refreshed.newContext); return; }
            official = facts.clock(context.subjectRef);
            const dueMs = official.available ? null : deviceNow() + capClockRecheckMs;
            transaction(() => persistCapWake(context, feature, { configRevision: config.savedRevision,
              officialDueMs: Math.min(...caps.map(cap => cap.period_end_official_ms)), requestedDeviceDueMs: dueMs,
              rearmDeviceDeadline: true, clockRevision: official.available ? official.revision ?? null : null,
              evidenceRef: 'official-clock-reacquire:' + unitKey }));
          }
        }
        // Inactive work units must not consume the bounded assessment window.
        // Old ConfigChanged events can make disabled units appear due; drain
        // their own cursor and persist a disabled wake before sorting/slicing.
        // This projection performs no dynamic refresh, fact assessment, cap
        // release, proposal or game write, and leaves suspension rows intact.
        for (const candidate of candidates) {
          const { feature, events: pendingEvents } = candidate;
          if (featureActive(feature, config)) continue;
          const unitKey = scheduleKey(feature), parentId = parentFeatureId(feature), wake = wakeRow(context, feature);
          if (pendingEvents.length || !wake || wake.state !== 'disabled' || wake.config_revision !== config.savedRevision) {
            transaction(() => {
              for (const event of pendingEvents) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
                receipt: { featureId: parentId, scheduleKey: unitKey, state: 'disabled' } });
              run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,config_revision,official_due_ms,device_due_ms,
                clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
                VALUES(?,?,?,?,?,NULL,NULL,NULL,?,'{}','disabled','FEATURE_DISABLED',1,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=NULL,device_due_ms=NULL,clock_revision=NULL,
                last_checked_ms=excluded.last_checked_ms,state='disabled',reason_code='FEATURE_DISABLED',
                wake_revision=backend_feature_wakes.wake_revision+1,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef,
              unitKey, feature.wakeKey || unitKey, config.savedRevision, deviceNow(), nowIso());
              session.wakeDeadlines.delete(unitKey); session.factWakeUnits.delete(unitKey);
              recordPlan(context, { revision: config.savedRevision, featureId: parentId, actionKey: unitKey,
                state: 'disabled', reasonCode: 'FEATURE_DISABLED', evidenceRef: 'config:' + config.savedRevision });
            });
            candidate.events = [];
            candidate.wake = wakeRow(context, feature);
          }
        }
        const selectionConfig = readConfiguration(context);
        const selectionFence = schedulerConfigFence(selectionConfig);
        const due = candidates.filter(({ feature, wake, events: pendingEvents }) => {
          if (!featureActive(feature, selectionConfig)) return false;
          const parentId = parentFeatureId(feature), unitKey = scheduleKey(feature);
          const persistedCaps = capsFor(context, feature);
          // Losing the official clock cannot prove a stored period expired.
          // Retain every cap until an authoritative clock demonstrates that
          // its period has ended; never fall through into business assessment.
          const activeCaps = official.available ? persistedCaps.filter(cap => cap.period_end_official_ms > official.nowMs) : persistedCaps;
          if (activeCaps.length) {
            const configTrigger = pendingEvents.some(event => event.eventType === 'ConfigChanged');
            if (!featureActive(feature, config)) {
              if (configTrigger || wake?.state !== 'disabled') {
                transaction(() => {
                  for (const event of pendingEvents) ledger.ackOutbox({ consumerId: consumer(context, feature),
                    eventId: event.eventId, receipt: { featureId: parentId, scheduleKey: unitKey, state: 'disabled' } });
                  if (wake) run(`UPDATE backend_feature_wakes SET config_revision=?,official_due_ms=NULL,device_due_ms=NULL,
                    last_checked_ms=?,state='disabled',reason_code='FEATURE_DISABLED',wake_revision=wake_revision+1,updated_at=?
                    WHERE owner_ref=? AND subject_ref=? AND feature_id=?`, config.savedRevision, deviceNow(), nowIso(),
                  context.ownerRef, context.subjectRef, unitKey);
                  session.wakeDeadlines.delete(unitKey);
                  recordPlan(context, { revision: config.savedRevision, featureId: parentId, actionKey: unitKey, state: 'disabled',
                    reasonCode: 'FEATURE_DISABLED', evidenceRef: 'config:' + config.savedRevision });
                });
              }
              return false;
            }
            const localOnlyRecheck = official.available && !activeCaps.some(cap => cap.scope === 'official') &&
              activeCaps.some(cap => cap.scope === 'local' && config.savedRevision > cap.config_revision);
            if (!localOnlyRecheck) {
              // The cap is a durable business suspension. Facts/resources and
              // unrelated wake events cannot turn it into an assessment or a
              // login refresh; consume them while preserving the official end
              // deadline. A local cap may be reconsidered by its own config edit.
              const projectionIsStale = wake?.config_revision !== config.savedRevision || wake?.state !== 'cap-wait';
          session.factWakeUnits.delete(unitKey);
          if (pendingEvents.length || projectionIsStale) transaction(() => {
                for (const event of pendingEvents) ledger.ackOutbox({ consumerId: consumer(context, feature),
                  eventId: event.eventId, receipt: { featureId: parentId, scheduleKey: unitKey, state: 'period-cap-still-active',
                    periodEndOfficialMs: Math.min(...activeCaps.map(cap => cap.period_end_official_ms)) } });
                persistCapWake(context, feature, { configRevision: config.savedRevision,
                  officialDueMs: Math.min(...activeCaps.map(cap => cap.period_end_official_ms)),
                  requestedDeviceDueMs: official.available ? null : deviceNow() + capClockRecheckMs,
                  clockRevision: official.available ? official.revision ?? null : null,
                  evidenceRef: 'period-cap-active:' + unitKey });
                const previousPlan = config.byFeature?.[parentId];
                recordPlan(context, { revision: config.savedRevision, featureId: parentId, actionKey: unitKey, state: 'cap-wait',
                  reasonCode: 'PERIOD_CAP_WAIT', evidenceRef: previousPlan?.evidenceRef || 'period-cap-active:' + unitKey });
              });
              return false;
            }
          }
          const scheduledRetryDue = replan(context, scheduleKey(feature))?.status === 'scheduled' &&
            retryEligible(context, feature, pendingEvents, config.savedRevision);
          const trustedFactsWake = session.factWakeUnits.has(unitKey);
          return (trustedFactsWake || retryEligible(context, feature, pendingEvents, config.savedRevision)) && (!wake ||
          trustedFactsWake || pendingEvents.some(event => relevant(event, feature)) || wakeDue(context, wake) ||
          wake.official_due_ms !== null && official.available && wake.official_due_ms <= official.nowMs || scheduledRetryDue);
        });
        const credits = new Map(due.map(candidate => [scheduleKey(candidate.feature), fairnessCredit(context, candidate.feature)]));
        due.sort((a, b) => {
          const priorityA = BigInt(Number.isSafeInteger(a.feature.priority) ? a.feature.priority : 0);
          const priorityB = BigInt(Number.isSafeInteger(b.feature.priority) ? b.feature.priority : 0);
          const scoreDiff = (priorityB + credits.get(scheduleKey(b.feature))) - (priorityA + credits.get(scheduleKey(a.feature)));
          if (scoreDiff !== 0n) return scoreDiff > 0n ? 1 : -1;
          return (a.wake?.last_checked_ms ?? 0) - (b.wake?.last_checked_ms ?? 0) ||
            scheduleKey(a.feature).localeCompare(scheduleKey(b.feature));
        });
        // Credit every due unit before entering the bounded slice. A unit only
        // loses that credit when beginFeatureAttempt actually claims work;
        // entries selected by the slice can still be skipped by an earlier
        // context switch, admission close, or failure.
        transaction(() => {
          for (const candidate of due) {
            const unitKey = scheduleKey(candidate.feature), credit = credits.get(unitKey);
            persistFairnessCredit(context, candidate.feature, credit + 1n);
          }
        });
        for (const candidate of due.slice(0, checksPerTurn)) {
          // Give the host a macrotask boundary between due work units. `await`
          // inside assess/send can settle through microtasks without letting
          // STOP, config writes, or other accounts run. This happens before
          // consuming the candidate's fact wake or claiming/resetting credit.
          await new Promise(resolve => setImmediate(resolve));
          if (sessionFor(context) !== session || session.quiesced || !admissionOpen(context) || !isCurrent(context)) return;
          if (schedulerConfigFence(readConfiguration(context)) !== selectionFence) {
            // Candidate events/wakes were built against the prior revision.
            // Rebuild on the next drain; ordinary notifications alone do not
            // discard the batch or starve later due units.
            session.requested = true;
            return;
          }
          const { feature } = candidate;
          const parentId = parentFeatureId(feature), unitKey = scheduleKey(feature), splitUnit = unitKey !== parentId;
          // A trusted publication for a consumed domain is itself a wake. Clear
          // before awaits so a newer publication during this assessment can
          // enqueue another pass without being lost.
          session.factWakeUnits.delete(unitKey);
          try {
          // Earlier work units in this same drain may have established a
          // shared quota cap. Recheck before facts, assessment or dispatch.
          const loopClock = facts.clock(context.subjectRef);
          const loopCaps = capsFor(context, feature).filter(cap => !loopClock.available || cap.period_end_official_ms > loopClock.nowMs);
          // Keep a local cap's older config revision until current facts prove
          // either remaining quota or the still-active cap. This lets later
          // fact wakes retry a user-updated limit without requiring another
          // ConfigChanged event, while the cap still blocks all writes.
          const localRecheck = loopClock.available && !loopCaps.some(cap => cap.scope === 'official') &&
            loopCaps.some(cap => cap.scope === 'local' && config.savedRevision > cap.config_revision);
          if (loopCaps.length && !localRecheck) {
            const dueMs = loopClock.available ? null : deviceNow() + capClockRecheckMs;
            transaction(() => {
              for (const event of candidate.events) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
                receipt: { featureId: parentId, scheduleKey: unitKey, state: 'period-cap-still-active',
                  periodEndOfficialMs: Math.min(...loopCaps.map(cap => cap.period_end_official_ms)) } });
              persistCapWake(context, feature, { configRevision: config.savedRevision,
                officialDueMs: Math.min(...loopCaps.map(cap => cap.period_end_official_ms)), requestedDeviceDueMs: dueMs,
                clockRevision: loopClock.available ? loopClock.revision ?? null : null,
                evidenceRef: 'shared-period-cap:' + unitKey });
              recordPlan(context, { revision: config.savedRevision, featureId: parentId, actionKey: unitKey, state: 'cap-wait',
                reasonCode: 'PERIOD_CAP_WAIT', evidenceRef: 'shared-period-cap:' + unitKey });
            });
            continue;
          }
          // Every await, including a previous feature's send, can have changed
          // the configuration. Assess this feature against the current revision.
          const currentConfig = readConfiguration(context);
          // Disabled modules do not consume dynamic facts and must never cause
          // a login refresh just because their old projection has expired.
          if (!featureActive(feature, currentConfig)) continue;
          const sourceCapability = typeof feature.sourceCapability === 'function'
            ? feature.sourceCapability({ context: featureContextOf(context), config: currentConfig.config }) : null;
          if (sourceCapability?.known === true && sourceCapability.supported === false) {
            const reason = 'ORDER_AUXILIARY_SOURCE_CONTRACT_UNSUPPORTED', retryAtMs = deviceNow() + 300000;
            session.factWakeUnits.delete(unitKey);
            transaction(() => {
              run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,config_revision,official_due_ms,device_due_ms,
                clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
                VALUES(?,?,?,?,?,NULL,?,NULL,?,?,'waiting-facts',?,1,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=NULL,device_due_ms=excluded.device_due_ms,
                clock_revision=NULL,last_checked_ms=excluded.last_checked_ms,last_fact_basis_json=excluded.last_fact_basis_json,
                state='waiting-facts',reason_code=excluded.reason_code,wake_revision=backend_feature_wakes.wake_revision+1,
                updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, unitKey, feature.wakeKey || unitKey,
              currentConfig.savedRevision, retryAtMs, deviceNow(), canonical({ version: 'order-flower-aux-source-gate/v1',
                sourceVersion: sourceCapability.sourceVersion, loginResponseRef: sourceCapability.loginResponseRef,
                proofFingerprint: sourceCapability.proofFingerprint }), reason, nowIso());
              for (const event of candidate.events) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
                receipt: { featureId: parentId, scheduleKey: unitKey, state: 'waiting-facts', reasonCode: reason, retryAtMs } });
              run('DELETE FROM backend_feature_failures WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, unitKey);
              clearReplan(context, unitKey);
              recordPlan(context, { revision: currentConfig.savedRevision, featureId: parentId, actionKey: unitKey,
                state: 'waiting-facts', reasonCode: reason, evidenceRef: sourceCapability.proofFingerprint });
            });
            const storedWake = wakeRow(context, feature);
            if (storedWake) monotonicDeadline(session, session.wakeDeadlines, unitKey, storedWake.wake_revision, storedWake.device_due_ms);
            continue;
          }
          if (!beginFeatureAttempt(context, feature, candidate.events, currentConfig.savedRevision)) continue;
          transaction(() => persistFairnessCredit(context, feature, 0n));
          const dynamic = dynamicState.snapshot({ context: featureContextOf(context), feature, config: currentConfig.config });
          if (!dynamic.current) {
            const refreshed = await inStage(session, context, feature, 'scheduled-fact-refresh', () => dynamicState.ensureCurrent({
              context: featureContextOf(context), feature, config: currentConfig.config,
              reasonCode: dynamic.reasonCode, signal: context.signal }), candidate);
            if (!isCurrent(context)) return;
            if (refreshed.newContext) { notify(refreshed.newContext); return; }
            if (!refreshed.current) {
              const retryAtMs = Number.isSafeInteger(refreshed.retryAtMs) && refreshed.retryAtMs > deviceNow()
                ? refreshed.retryAtMs : deviceNow() + 30000;
              const reason = refreshed.reasonCode || 'DYNAMIC_FACTS_REFRESH_PENDING';
              transaction(() => {
                if (!isCurrent(context)) return;
                run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,config_revision,official_due_ms,device_due_ms,
                  clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
                  VALUES(?,?,?,?,?,NULL,?,NULL,?,'{}','waiting-facts',?,1,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                  DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=NULL,device_due_ms=excluded.device_due_ms,
                  last_checked_ms=excluded.last_checked_ms,state='waiting-facts',reason_code=excluded.reason_code,
                  wake_revision=backend_feature_wakes.wake_revision+1,updated_at=excluded.updated_at`, context.ownerRef,
                context.subjectRef, unitKey, feature.wakeKey || unitKey, currentConfig.savedRevision, retryAtMs, deviceNow(), reason, nowIso());
                for (const event of candidate.events) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
                  receipt: { featureId: parentId, scheduleKey: unitKey, revision: currentConfig.savedRevision,
                    state: 'waiting-facts', reasonCode: reason, retryAtMs } });
                run('DELETE FROM backend_feature_failures WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, unitKey);
                clearReplan(context, unitKey);
                recordPlan(context, { revision: currentConfig.savedRevision, featureId: parentId, actionKey: unitKey,
                  state: 'waiting-facts', reasonCode: reason, evidenceRef: refreshed.refreshRef || 'dynamic-refresh-pending' });
              });
              const storedWake = wakeRow(context, feature);
              if (storedWake) monotonicDeadline(session, session.wakeDeadlines, unitKey, storedWake.wake_revision, storedWake.device_due_ms);
              continue;
            }
          }
          const factSet = facts.snapshot(context.subjectRef, feature.factRequirements || []);
          const featureContext = featureContextOf(context);
          const result = await inStage(session, context, feature, 'feature-assess', () => feature.assess(Object.freeze({
            context: featureContext, config: currentConfig, facts: factSet,
            clock: facts.clock(context.subjectRef), events: candidate.events.filter(event => relevant(event, feature)) })), candidate);
          // An assessment may finish after an external UI hold begins. Drop its
          // result without advancing wake/outbox state or submitting stale work.
          if (!admissionOpen(context)) return;
          if (!isCurrent(context)) return;
          if (!result || !RESULT_STATES.has(result.state)) throw problem('FEATURE_RESULT_INVALID', '新功能返回了未声明的评估结果', 500);
          if (Array.isArray(feature.allowedMethods) && (result.proposals || []).some(proposal => !feature.allowedMethods.includes(proposal?.method))) {
            throw problem('FEATURE_ACTION_METHOD_INVALID', '调度动作返回了不属于本动作的写方法', 409);
          }
          if (Array.isArray(feature.allowedScopes) && (result.proposals || []).some(proposal => !feature.allowedScopes.includes(proposal?.scope))) {
            throw problem('FEATURE_ACTION_SCOPE_INVALID', '调度动作返回了不属于本动作的业务范围', 409);
          }
          if (Array.isArray(result.refreshDomains) && result.refreshDomains.length) {
            const requestedDomains = [...new Set(result.refreshDomains)];
            if (requestedDomains.length !== result.refreshDomains.length) throw problem('DYNAMIC_REFRESH_DOMAINS_INVALID', '事实补读域重复', 500);
            dynamicState.invalidate({ context: featureContextOf(context), domains: requestedDomains,
              reasonCode: result.refreshReasonCode || 'DYNAMIC_ACTION_FACTS_REQUIRED' });
            const refreshed = await inStage(session, context, feature, 'proposal-fact-refresh', () => dynamicState.ensureCurrent({
              context: featureContextOf(context), feature, config: currentConfig.config, extraDomains: requestedDomains,
              reasonCode: result.refreshReasonCode || 'DYNAMIC_ACTION_FACTS_REQUIRED', signal: context.signal }), candidate);
            if (!admissionOpen(context) || !isCurrent(context)) return;
            if (refreshed.newContext) notify(refreshed.newContext);
            const retryAtMs = Number.isSafeInteger(refreshed.retryAtMs) && refreshed.retryAtMs > deviceNow()
              ? refreshed.retryAtMs : deviceNow() + 30000;
            const reason = refreshed.reasonCode || result.refreshReasonCode || 'DYNAMIC_ACTION_FACTS_REQUIRED';
            transaction(() => {
              if (!isCurrent(context)) return;
              run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,config_revision,official_due_ms,device_due_ms,
                clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
                VALUES(?,?,?,?,?,NULL,?,NULL,?,'{}','waiting-facts',?,1,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=NULL,device_due_ms=excluded.device_due_ms,
                last_checked_ms=excluded.last_checked_ms,state='waiting-facts',reason_code=excluded.reason_code,
                wake_revision=backend_feature_wakes.wake_revision+1,updated_at=excluded.updated_at`, context.ownerRef,
              context.subjectRef, unitKey, feature.wakeKey || unitKey, currentConfig.savedRevision, retryAtMs, deviceNow(), reason, nowIso());
              for (const event of candidate.events) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
                receipt: { featureId: parentId, scheduleKey: unitKey, state: 'waiting-facts', reasonCode: reason, retryAtMs } });
              clearReplan(context, unitKey);
              recordPlan(context, { revision: currentConfig.savedRevision, featureId: parentId, actionKey: unitKey,
                state: 'waiting-facts', reasonCode: reason, evidenceRef: refreshed.refreshRef || 'dynamic-action-refresh-pending' });
            });
            const storedWake = wakeRow(context, feature);
            if (storedWake) monotonicDeadline(session, session.wakeDeadlines, unitKey, storedWake.wake_revision, storedWake.device_due_ms);
            continue;
          }
          if (result.state === 'cap-wait') {
            const cap = result.suspension;
            if (!cap || cap.kind !== 'period-cap' || typeof cap.periodKind !== 'string' || !cap.periodKind ||
                typeof cap.quotaKey !== 'string' || !cap.quotaKey || cap.actionScope !== (splitUnit ? unitKey : 'feature') ||
                typeof cap.periodKey !== 'string' || !cap.periodKey || !Number.isSafeInteger(cap.periodEndOfficialMs) ||
                !['local', 'official'].includes(cap.scope) || !Number.isSafeInteger(cap.used) || cap.used < 0 ||
                !Number.isSafeInteger(cap.limit) || cap.limit < 0 || cap.used < cap.limit || !Array.isArray(cap.proofRefs) ||
                cap.proofRefs.length === 0 || !cap.proofRefs.every(value => typeof value === 'string' && value.length > 0 && value.length <= 512) ||
                cap.configRevision !== currentConfig.savedRevision || !official.available || cap.periodEndOfficialMs <= official.nowMs ||
                Array.isArray(feature.quotaKeys) && !feature.quotaKeys.includes(cap.quotaKey)) {
              throw problem('PERIOD_CAP_PROOF_INVALID', '周期限额缺少有效官服周期证明，当前周期保持待核', 409);
            }
          }
          if (readConfiguration(context).savedRevision !== currentConfig.savedRevision) { session.requested = true; continue; }
          const officialDueMs = result.state === 'cap-wait' ? result.suspension.periodEndOfficialMs : result.officialDueMs ?? null;
          // A long business wait must not outlive the earliest cell the active
          // feature consumed. The coordinator derives this deadline from the
          // cells' monotonic arrivals; persisting the resulting device time is
          // only a restart index, while the armed timer uses the remaining
          // duration computed here in this process.
          const dynamicSnapshot = result.state === 'cap-wait' ? null :
            dynamicState.snapshot({ context: featureContextOf(context), feature, config: currentConfig.config });
          const dynamicDeadline = result.state === 'cap-wait' ? null :
            dynamicSnapshot?.nextCheckAtMs ?? (Array.isArray(dynamicSnapshot?.domains)
              ? Math.min(...dynamicSnapshot.domains.map(domain => domain.nextCheckAtMs).filter(Number.isSafeInteger)) : null);
          const requestedDeviceDueMs = result.state === 'cap-wait' ? null : result.deviceDueMs ?? (deviceNow() + 120000);
          const deviceDueMs = requestedDeviceDueMs === null ? null : Number.isSafeInteger(dynamicDeadline)
            ? Math.max(deviceNow() + 1, Math.min(requestedDeviceDueMs, dynamicDeadline)) : requestedDeviceDueMs;
          for (const value of [officialDueMs, deviceDueMs]) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw problem('WAKE_TIME_INVALID', '功能截止时刻无效', 500);
          // A due timestamp with no change would otherwise spin the event loop.
          if (result.state !== 'proposals' && ((deviceDueMs !== null && deviceDueMs <= deviceNow()) ||
              officialDueMs !== null && official.available && officialDueMs <= official.nowMs)) throw problem('WAKE_ALREADY_DUE', '功能未推进已到期醒点', 500);
          transaction(() => {
            if (!isCurrent(context)) throw problem('RUN_INTENT_REVOKED', '运行意愿已撤销');
            if (result.state === 'cap-wait') {
              const cap = result.suspension;
              run(`INSERT INTO backend_period_suspensions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(owner_ref,subject_ref,feature_id,quota_key,period_key) DO UPDATE SET
                action_scope=excluded.action_scope,period_kind=excluded.period_kind,period_end_official_ms=excluded.period_end_official_ms,
                scope=excluded.scope,used=excluded.used,limit_value=excluded.limit_value,proof_refs_json=excluded.proof_refs_json,
                config_revision=MIN(backend_period_suspensions.config_revision,excluded.config_revision),recorded_at=excluded.recorded_at`, context.ownerRef, context.subjectRef,
              unitKey, cap.quotaKey, cap.actionScope, cap.periodKind, cap.periodKey, cap.periodEndOfficialMs, cap.scope,
              cap.used, cap.limit, canonical(cap.proofRefs), cap.configRevision, nowIso());
            } else if (result.state === 'proposals') {
              const releaseProofs = Array.isArray(result.capReleaseProofs) ? result.capReleaseProofs : [];
              const localCaps = all(`SELECT * FROM backend_period_suspensions WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND scope='local'`,
                context.ownerRef, context.subjectRef, unitKey);
              for (const cap of localCaps) {
                const proof = releaseProofs.find(one => one?.version === 'local-period-cap-release/v1' &&
                  one.ownerRef === context.ownerRef && String(one.accountRef) === String(context.accountRef) && one.subjectRef === context.subjectRef &&
                  one.ownerEpoch === context.ownerEpoch && one.runEpoch === context.runEpoch && one.connectionEpoch === context.connectionEpoch &&
                  one.quotaKey === cap.quota_key && one.actionScope === cap.action_scope && one.periodKind === cap.period_kind &&
                  one.periodKey === cap.period_key && Number.isSafeInteger(one.used) && Number.isSafeInteger(one.limit) && one.used < one.limit &&
                  one.periodEndOfficialMs === cap.period_end_official_ms && official.available === true &&
                  official.source === 'official-anchor-monotonic' && official.connectionEpoch === context.connectionEpoch &&
                  official.nowMs < one.periodEndOfficialMs && Array.isArray(one.proofRefs) && one.proofRefs.length >= 2 &&
                  one.proofRefs.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 512));
                if (proof) run(`DELETE FROM backend_period_suspensions WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND quota_key=?
                  AND action_scope=? AND period_kind=? AND period_key=? AND scope='local'`, context.ownerRef, context.subjectRef, unitKey,
                cap.quota_key, cap.action_scope, cap.period_kind, cap.period_key);
              }
            }
            run(`INSERT INTO backend_feature_wakes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
              DO UPDATE SET wake_key=excluded.wake_key,config_revision=excluded.config_revision,official_due_ms=excluded.official_due_ms,
              device_due_ms=excluded.device_due_ms,clock_revision=excluded.clock_revision,last_checked_ms=excluded.last_checked_ms,
              last_fact_basis_json=excluded.last_fact_basis_json,state=excluded.state,reason_code=excluded.reason_code,
              wake_revision=backend_feature_wakes.wake_revision+1,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef,
              unitKey, feature.wakeKey || unitKey, currentConfig.savedRevision, officialDueMs, deviceDueMs,
              official.revision ?? null, deviceNow(), canonical(result.state === 'cap-wait' ? { ...(result.factBasis || {}), suspension: result.suspension } : result.factBasis || {}),
              result.state, result.state === 'cap-wait' ? 'PERIOD_CAP_WAIT' : result.reasonCode ?? null, 1, nowIso());
            recordPlan(context, { revision: currentConfig.savedRevision, featureId: parentId, actionKey: unitKey, state: result.state,
              reasonCode: result.reasonCode || `FEATURE_${result.state.replaceAll('-', '_').toUpperCase()}`,
              evidenceRef: result.evidenceRef || 'assessment:' + newId() });
            for (const event of candidate.events) ledger.ackOutbox({ consumerId: consumer(context, feature), eventId: event.eventId,
              receipt: { featureId: parentId, scheduleKey: unitKey, revision: currentConfig.savedRevision, state: result.state } });
            run('DELETE FROM backend_feature_failures WHERE owner_ref=? AND subject_ref=? AND feature_id=?', context.ownerRef, context.subjectRef, unitKey);
            // A stable wait/disabled/no-action result has replaced the obsolete
            // candidate. Proposals keep the retry count until they really drain.
            if (result.state !== 'proposals') clearReplan(context, unitKey);
          });
          const storedWake = wakeRow(context, feature);
          if (storedWake?.device_due_ms === null || !storedWake) session.wakeDeadlines.delete(unitKey);
          else monotonicDeadline(session, session.wakeDeadlines, unitKey, storedWake.wake_revision, storedWake.device_due_ms);
          for (const proposal of result.proposals || []) {
            if (!admissionOpen(context)) return;
            if (!isCurrent(context)) return;
            const branchFacts = dynamicState.snapshot({ context: featureContextOf(context), feature, config: currentConfig.config,
              method: proposal.method, proposal });
            if (!branchFacts.current) {
              const refreshed = await inStage(session, context, feature, 'branch-fact-refresh', () => dynamicState.ensureCurrent({
                context: featureContextOf(context), feature, config: currentConfig.config, method: proposal.method,
                proposal, reasonCode: branchFacts.reasonCode, signal: context.signal }), candidate);
              if (!admissionOpen(context)) return;
              if (refreshed.newContext) notify(refreshed.newContext);
              // A proposal is bound to the facts that produced it. Discard it
              // after refresh and let the current desired run assess again.
              session.requested = true;
              break;
            }
            // The gateway owns the write/RPC/post-read progress clock. Do not
            // start a second scheduler deadline around the same promise.
            await submitProposal(proposal, context.signal);
            if (!isCurrent(context)) return;
            clearReplan(context, unitKey);
          }
          } catch (error) {
            if (!admissionOpen(context)) return;
            if (!isCurrent(context)) return;
            if (error && typeof error === 'object') { try { error.featureId = parentId; error.scheduleKey = unitKey; } catch { /* frozen error */ } }
            const reasonCode = String(error?.code || 'FEATURE_ASSESSMENT_FAILED');
            const latest = readConfiguration(context);
            const supersession = validSupersession(error, context, feature, latest);
            transaction(() => {
              if (!isCurrent(context)) throw problem('RUN_INTENT_REVOKED', '运行意愿已撤销');
              // A save may have won while the obsolete candidate awaited its
              // send boundary. Accept that real current revision before noting
              // its waiting plan; never label an unaccepted revision planned.
              if (session.acceptedRevision !== latest.savedRevision) acceptConfiguration(context, latest.savedRevision);
              // The prefix may contain old failed events while a later page
              // supplied the new trigger. Never move the failure watermark
              // backwards to that prefix, and never advance it for an event
              // which this assessment did not actually receive.
              const previousReplan = replan(context, unitKey);
              const previousFailure = failure(context, unitKey);
              const watermark = Math.max(Number(previousFailure?.event_watermark || 0), Number(previousReplan?.event_watermark || 0),
                ...candidate.events.map(event => event.eventId));
              const attempt = Number(previousReplan?.attempt || 0) + 1;
              const scheduled = true;
              const dueMs = deviceNow() + Math.min(300000, replanBaseMs * 2 ** Math.min(8, Math.max(0, attempt - 1)));
              const planReason = supersession ? 'PRESEND_SUPERSESSION_REPLAN_PENDING' : 'FEATURE_RECOVERY_RETRY_SCHEDULED';
              run(`INSERT INTO backend_feature_replans
                (owner_ref,subject_ref,feature_id,account_ref,owner_epoch,run_epoch,connection_epoch,attempt,max_attempts,status,due_ms,
                 config_revision,event_watermark,reason_code,receipt_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(owner_ref,subject_ref,feature_id) DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,
                run_epoch=excluded.run_epoch,connection_epoch=excluded.connection_epoch,attempt=excluded.attempt,max_attempts=excluded.max_attempts,
                status=excluded.status,due_ms=excluded.due_ms,config_revision=excluded.config_revision,event_watermark=excluded.event_watermark,
                reason_code=excluded.reason_code,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`,
              context.ownerRef, context.subjectRef, unitKey, String(context.accountRef), context.ownerEpoch, context.runEpoch, context.connectionEpoch,
              Math.min(attempt, 1000000), maxSupersessionReplans, 'scheduled', dueMs,
              latest.savedRevision, watermark, reasonCode, canonical(supersession || { version: 'feature-recovery-retry/v1', reasonCode,
                attempted: true, retryAtMs: dueMs }), nowIso());
              run(`INSERT INTO backend_feature_failures VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                DO UPDATE SET event_watermark=excluded.event_watermark,config_revision=excluded.config_revision,
                reason_code=excluded.reason_code,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, unitKey,
                watermark, latest.savedRevision, planReason, nowIso());
              run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,config_revision,official_due_ms,device_due_ms,
                clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
                VALUES(?,?,?,?,?,NULL,?,NULL,?,'{}','waiting-until',?,1,?) ON CONFLICT(owner_ref,subject_ref,feature_id)
                DO UPDATE SET config_revision=excluded.config_revision,official_due_ms=NULL,device_due_ms=excluded.device_due_ms,
                last_checked_ms=excluded.last_checked_ms,state='waiting-until',reason_code=excluded.reason_code,
                wake_revision=backend_feature_wakes.wake_revision+1,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef,
              unitKey, feature.wakeKey || unitKey, latest.savedRevision, dueMs, deviceNow(), planReason, nowIso());
              recordPlan(context, { revision: latest.savedRevision, featureId: parentId, actionKey: unitKey, state: scheduled ? 'waiting-until' : 'blocked', reasonCode: planReason,
                evidenceRef: supersession?.receiptRef || 'assessment-error:' + newId() });
            });
            session.acceptedRevision = latest.savedRevision;
            onError(context, error);
          }
        }
        if (due.length > checksPerTurn) session.requested = true;
        // Yield control after a bounded turn. The unfinished features have not
        // had their last_checked or event cursors advanced.
        if (session.requested) { if (admissionOpen(context) && !session.quiesced) session.timer = setTimeout(() => notify(context), 0); return; }
      } while (session.requested && isCurrent(context));
    } catch (error) {
      if (storageBusy(error)) deferStorage(context, session);
      else try { store.withBusyTimeout(0, () => onError(context, error)); } catch { /* Preserve the pending events when the diagnostic sink is busy. */ }
    }
    finally {
      session.busy = false;
      for (const resolve of session.idleWaiters) resolve();
      session.idleWaiters.clear();
      if (session.storageRetryAtMs > deviceNow()) { /* deferStorage already armed this bounded retry. */ }
      else try { store.withBusyTimeout(0, () => {
        if (session.requested && !session.quiesced && admissionOpen(context) && isCurrent(context)) { clearTimeout(session.timer); session.timer = setTimeout(() => notify(context), 0); }
        else schedule(context);
      }); } catch (error) { if (storageBusy(error)) deferStorage(context, session); }
    }
  }
  function registerMaintenance(context, { taskKey, sourceKey, sourceVersion, run: runTask, refreshNow = false, retryBaseMs = 30000,
    retryMaxMs = 21600000, successIntervalMs = 1800000 } = {}) {
    if (!sessionFor(context) || !isCurrent(context) || typeof taskKey !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(taskKey) ||
        typeof sourceKey !== 'string' || !/^[a-z0-9._:-]{1,128}$/i.test(sourceKey) ||
        typeof sourceVersion !== 'string' || !/^[0-9]+(?:\.[0-9]+){1,5}$/.test(sourceVersion) || typeof runTask !== 'function' ||
        ![retryBaseMs, retryMaxMs, successIntervalMs].every(value => Number.isSafeInteger(value) && value > 0) ||
        retryMaxMs < retryBaseMs || retryMaxMs > 86400000 || successIntervalMs > 86400000) {
      throw problem('SCHEDULER_MAINTENANCE_REGISTRATION_INVALID', '共享维护任务的身份或重试界限无效');
    }
    const session = sessionFor(context), old = get(`SELECT * FROM backend_scheduler_maintenance_wakes
      WHERE owner_ref=? AND subject_ref=? AND task_key=?`, context.ownerRef, context.subjectRef, taskKey);
    const sameSource = old?.source_key === sourceKey && old?.source_version === sourceVersion;
    const nextDueMs = !sameSource ? deviceNow()
      : old.state === 'in-flight' ? deviceNow() + retryBaseMs : refreshNow ? deviceNow() : old.next_due_ms;
    const attempt = sameSource ? old.attempt : 0;
    const task = { taskKey, sourceKey, sourceVersion, run: runTask, retryBaseMs, retryMaxMs, successIntervalMs,
      attempt, nextDueMs, running: false };
    session.maintenanceTasks.set(taskKey, task);
    run(`INSERT INTO backend_scheduler_maintenance_wakes(owner_ref,subject_ref,task_key,account_ref,owner_epoch,run_epoch,
      connection_epoch,source_key,source_version,next_due_ms,attempt,state,reason_code,last_started_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?,?) ON CONFLICT(owner_ref,subject_ref,task_key)
      DO UPDATE SET account_ref=excluded.account_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,
      connection_epoch=excluded.connection_epoch,source_key=excluded.source_key,source_version=excluded.source_version,
      next_due_ms=excluded.next_due_ms,attempt=excluded.attempt,state='scheduled',reason_code=excluded.reason_code,
      last_started_at=excluded.last_started_at,updated_at=excluded.updated_at`, context.ownerRef, context.subjectRef, taskKey, String(context.accountRef),
    context.ownerEpoch, context.runEpoch, context.connectionEpoch, sourceKey, sourceVersion, nextDueMs, attempt,
    sameSource && old.state === 'in-flight' ? 'MAINTENANCE_INTERRUPTED_RECOVERY' : refreshNow ? 'CURRENT_LOGIN_REVALIDATION_REQUIRED' :
      sameSource ? old.reason_code : 'CURRENT_SOURCE_REFRESH_REQUIRED', sameSource ? old.last_started_at : null, nowIso());
    schedule(context);
    return Object.freeze({ taskKey, sourceKey, sourceVersion, nextDueMs, attempt });
  }
  async function dispatchMaintenance(context, session, task) {
    const busy = error => [5,6].includes(Number(error?.errcode) & 255) || /locked|busy/i.test(error?.message || '');
    const local = callback => store.withBusyTimeout(0, callback);
    let claimed = false, attempt = Math.min(1000000, Math.max(0, Number(task.attempt) || 0) + 1);
    const reschedule = () => {
      if (sessionFor(context) !== session || session.quiesced) return;
      try { local(() => schedule(context)); }
      catch {
        // An exclusive external lock can also prevent the deadline read. Keep
        // a bounded memory retry; a cold start rebuilds from the durable wake.
        clearTimeout(session.timer);
        session.timer = setTimeout(reschedule, Math.max(300, task.retryBaseMs));
      }
    };
    try {
    if (task.running || sessionFor(context) !== session || task.nextDueMs > deviceNow()) return;
    task.running = true; claimed = true;
    const eligible = local(() => !recoveryHeldFor(context.subjectRef) && isCurrent(context));
    if (!eligible) return;
    const stored = local(() => get(`SELECT account_ref,owner_epoch,run_epoch,connection_epoch,source_key,source_version,next_due_ms,attempt,state
      FROM backend_scheduler_maintenance_wakes WHERE owner_ref=? AND subject_ref=? AND task_key=?`, context.ownerRef, context.subjectRef, task.taskKey));
    if (!stored || stored.account_ref !== String(context.accountRef) || stored.owner_epoch !== context.ownerEpoch ||
        stored.run_epoch !== context.runEpoch || stored.connection_epoch !== context.connectionEpoch ||
        stored.source_key !== task.sourceKey || stored.source_version !== task.sourceVersion) return;
    if (stored.next_due_ms > deviceNow()) { task.nextDueMs = stored.next_due_ms; task.attempt = stored.attempt; task.persistencePending = false; return; }
    attempt = Math.min(1000000, Math.max(0, Number(stored.attempt) || 0) + 1);
    const started = local(() => run(`UPDATE backend_scheduler_maintenance_wakes SET attempt=?,state='in-flight',reason_code='MAINTENANCE_REFRESH_RUNNING',
      last_started_at=?,updated_at=? WHERE owner_ref=? AND subject_ref=? AND task_key=? AND account_ref=? AND owner_epoch=?
      AND run_epoch=? AND connection_epoch=? AND source_key=? AND source_version=?`, attempt, nowIso(), nowIso(), context.ownerRef,
    context.subjectRef, task.taskKey, String(context.accountRef), context.ownerEpoch, context.runEpoch, context.connectionEpoch,
    task.sourceKey, task.sourceVersion));
    if (Number(started.changes) !== 1) return;
      const result = await task.run({ context, signal: context.controller?.signal, sourceKey: task.sourceKey,
        sourceVersion: task.sourceVersion, attempt });
      if (sessionFor(context) !== session || !isCurrent(context)) return;
      const requestedInterval = result?.successIntervalMs;
      const successIntervalMs = Number.isSafeInteger(requestedInterval) && requestedInterval > 0 && requestedInterval <= 86400000
        ? requestedInterval : task.successIntervalMs;
      const nextDueMs = deviceNow() + successIntervalMs;
      const completed = local(() => run(`UPDATE backend_scheduler_maintenance_wakes SET next_due_ms=?,attempt=0,state='waiting-until',reason_code=?,updated_at=?
        WHERE owner_ref=? AND subject_ref=? AND task_key=? AND account_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?
        AND source_key=? AND source_version=?`, nextDueMs,
      typeof result?.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(result.reasonCode) ? result.reasonCode : 'MAINTENANCE_REFRESH_SUCCEEDED',
      nowIso(), context.ownerRef, context.subjectRef, task.taskKey, String(context.accountRef), context.ownerEpoch,
      context.runEpoch, context.connectionEpoch, task.sourceKey, task.sourceVersion));
      if (Number(completed.changes) !== 1) return;
      task.attempt = 0; task.nextDueMs = nextDueMs; task.persistencePending = false;
      if (Array.isArray(result?.publishedDomains) && result.publishedDomains.length) notify(context, result.publishedDomains);
    } catch (error) {
      if (!claimed || sessionFor(context) !== session) return;
      const delay = Math.min(task.retryMaxMs, task.retryBaseMs * (2 ** Math.min(20, Math.max(0, attempt - 1))));
      const nextDueMs = deviceNow() + delay;
      task.attempt = attempt; task.nextDueMs = nextDueMs;
      const reasonCode = busy(error) ? 'SCHEDULER_MAINTENANCE_STORAGE_BUSY' : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)
        ? error.code : 'MAINTENANCE_REFRESH_FAILED';
      task.deferredReasonCode = reasonCode; task.persistencePending = true;
      try { const deferred = local(() => run(`UPDATE backend_scheduler_maintenance_wakes SET next_due_ms=?,attempt=?,state='waiting-until',reason_code=?,updated_at=?
        WHERE owner_ref=? AND subject_ref=? AND task_key=? AND account_ref=? AND owner_epoch=? AND run_epoch=? AND connection_epoch=?
        AND source_key=? AND source_version=?`, nextDueMs, attempt, reasonCode, nowIso(), context.ownerRef, context.subjectRef,
      task.taskKey, String(context.accountRef), context.ownerEpoch, context.runEpoch, context.connectionEpoch, task.sourceKey, task.sourceVersion));
      task.persistencePending = Number(deferred.changes) !== 1;
      } catch { /* The original wake is intact; retry metadata after the lock clears. */ }
      if (!busy(error)) try { local(() => onError(context, error)); } catch { /* An unavailable diagnostic sink cannot reject this async root. */ }
    } finally {
      if (claimed) { task.running = false; reschedule(); }
    }
  }
  function notify(context, changedDomains = null) {
    const session = sessionFor(context);
    if (!session) return;
    if (Array.isArray(changedDomains) && changedDomains.length) {
      const activeConfig = readConfiguration(context);
      for (const feature of workUnits(registry)) {
        if (!featureActive(feature, activeConfig)) continue;
        let selected = feature.consumedDomains || [];
        try {
          if (typeof feature.consumedDomainsFor === 'function') selected = feature.consumedDomainsFor({
            context: featureContextOf(context), config: activeConfig.config, method: null, proposal: null });
        } catch { continue; }
        const consumed = new Set(Array.isArray(selected) ? selected : []);
        if (changedDomains.some(domain => consumed.has(domain))) session.factWakeUnits.add(scheduleKey(feature));
      }
    }
    session.requested = true;
    if (admissionOpen(context)) session.quiesced = false;
    if (!session.busy && !session.quiesced && admissionOpen(context)) void drain(context);
  }
  function start(context) {
    const old = sessions.get(key(context));
    if (old) clearTimeout(old.timer);
    // Old permanently exhausted plans were produced by earlier scheduler
    // versions. Give them a durable bounded wake so service recovery is automatic.
    const recoveryAt = deviceNow() + 300000;
    const interruptedAt = deviceNow() + 5000;
    const modules = workUnits(registry);
    transaction(() => {
      for (const feature of modules) {
        const unitKey = scheduleKey(feature);
        run(`UPDATE backend_feature_replans SET status='scheduled',due_ms=?,reason_code='SCHEDULER_ATTEMPT_INTERRUPTED_RECOVERY',
          updated_at=? WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND status='attempting'`, interruptedAt, nowIso(),
        context.ownerRef, context.subjectRef, unitKey);
        run(`UPDATE backend_feature_wakes SET state='waiting-until',device_due_ms=?,reason_code='SCHEDULER_ATTEMPT_INTERRUPTED_RECOVERY',
          wake_revision=wake_revision+1,updated_at=? WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND state='blocked'`,
        interruptedAt, nowIso(), context.ownerRef, context.subjectRef, unitKey);
        const legacy = get(`SELECT reason_code FROM backend_feature_replans WHERE owner_ref=? AND subject_ref=? AND feature_id=?
          AND status IN ('exhausted','blocked')`, context.ownerRef, context.subjectRef, unitKey);
        run(`UPDATE backend_feature_replans SET status='scheduled',due_ms=?,reason_code='LEGACY_EXHAUSTED_AUTO_RECOVERY',
          updated_at=? WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND status IN ('exhausted','blocked')`,
        recoveryAt, nowIso(), context.ownerRef, context.subjectRef, unitKey);
        run(`UPDATE backend_feature_wakes SET device_due_ms=?,state='waiting-until',reason_code='LEGACY_EXHAUSTED_AUTO_RECOVERY',
          updated_at=? WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND state='blocked'`,
        recoveryAt, nowIso(), context.ownerRef, context.subjectRef, unitKey);
        if (legacy && !wakeRow(context, feature)) run(`INSERT INTO backend_feature_wakes(owner_ref,subject_ref,feature_id,wake_key,
          config_revision,official_due_ms,device_due_ms,clock_revision,last_checked_ms,last_fact_basis_json,state,reason_code,wake_revision,updated_at)
          VALUES(?,?,?,?,?,NULL,?,NULL,?,'{}','waiting-until','LEGACY_EXHAUSTED_AUTO_RECOVERY',1,?)`, context.ownerRef, context.subjectRef,
        unitKey, feature.wakeKey || unitKey, readConfiguration(context).savedRevision, recoveryAt, deviceNow(), nowIso());
      }
    });
    sessions.set(key(context), { context, timer: null, busy: false, requested: true, acceptedRevision: null,
      quiesced: false, idleWaiters: new Set(), wakeDeadlines: new Map(), retryDeadlines: new Map(), factWakeUnits: new Set(),
      maintenanceTasks: new Map() });
    notify(context);
  }
  async function quiesce(context) {
    const session = sessionFor(context);
    if (!session) return Object.freeze({ quiesced: true, busy: false });
    session.quiesced = true; session.requested = false;
    clearTimeout(session.timer); session.timer = null;
    if (session.busy) await new Promise(resolve => session.idleWaiters.add(resolve));
    return Object.freeze({ quiesced: true, busy: false });
  }
  function stop(context) {
    const old = sessionFor(context);
    if (old) { clearTimeout(old.timer); sessions.delete(key(context)); }
  }
  function holdForProcessRecovery(subjects = null) {
    if (Array.isArray(subjects) && subjects.length) {
      for (const subjectRef of subjects) if (typeof subjectRef === 'string' && subjectRef) recoveryHolds.subjects.add(subjectRef);
    } else recoveryHolds.process = true;
    for (const session of sessions.values()) if (recoveryHeldFor(session.context.subjectRef)) {
      clearTimeout(session.timer); session.timer = null;
    }
    return healthSnapshot();
  }
  function releaseProcessRecoveryHold(subjects = null) {
    if (Array.isArray(subjects) && subjects.length) {
      for (const subjectRef of subjects) recoveryHolds.subjects.delete(subjectRef);
    } else { recoveryHolds.process = false; recoveryHolds.subjects.clear(); }
    for (const session of sessions.values()) if (!session.quiesced && admissionOpen(session.context)) notify(session.context);
    return healthSnapshot();
  }
  function snapshot(context, { summary = false } = {}) {
    const registeredUnits = workUnits(registry);
    const currentConfig = readConfiguration(context);
    const business = all(summary ? `SELECT feature_id,state,reason_code,official_due_ms,device_due_ms,last_checked_ms,wake_revision,config_revision
      FROM backend_feature_wakes WHERE owner_ref=? AND subject_ref=?` :
      'SELECT * FROM backend_feature_wakes WHERE owner_ref=? AND subject_ref=?', context.ownerRef, context.subjectRef)
      .filter(row => registeredUnits.some(one => scheduleKey(one) === row.feature_id))
      .map(row => { const retry = summary ? null : get('SELECT status,attempt,max_attempts,due_ms,reason_code,run_epoch,connection_epoch,receipt_json FROM backend_feature_replans WHERE owner_ref=? AND subject_ref=? AND feature_id=?',
      context.ownerRef, context.subjectRef, row.feature_id);
      const feature = registeredUnits.find(one => scheduleKey(one) === row.feature_id), parentId = parentFeatureId(feature), unitKey = scheduleKey(feature);
      const parentPlan = currentConfig?.byFeature?.[parentId], primaryPlan = parentPlan?.actions?.[feature?.primaryActionKey];
      const currentPrimary = feature?.primaryActionKey === unitKey && parentPlan?.plannedRevision === currentConfig?.savedRevision &&
        primaryPlan?.plannedRevision === currentConfig?.savedRevision;
      return { featureKey: currentPrimary ? parentId : unitKey, actionKey: unitKey,
      state: row.state, reasonCode: row.reason_code, officialDueAtMs: row.official_due_ms,
      fallbackDueAtMs: row.device_due_ms, lastCheckedAtMs: row.last_checked_ms, revision: row.wake_revision,
      configRevision: row.config_revision, ...(summary ? { enabled: featureActive(feature, currentConfig) }
        : { factBasis: parseStored(row.last_fact_basis_json, '功能事实依据') }),
      supersessionReplan: retry ? { status: retry.status, attempt: retry.attempt, maxAttempts: retry.max_attempts, dueAtMs: retry.due_ms,
        reasonCode: retry.reason_code, runEpoch: retry.run_epoch, connectionEpoch: retry.connection_epoch,
        receiptRef: parseStored(retry.receipt_json, '候选过期重规划依据').receiptRef } : null }; });
    const activeSession = sessions.get(key(context));
    const maintenance = all(`SELECT task_key,source_key,source_version,next_due_ms,attempt,state,reason_code,last_started_at,updated_at,
      account_ref,owner_epoch,run_epoch,connection_epoch
      FROM backend_scheduler_maintenance_wakes WHERE owner_ref=? AND subject_ref=?`, context.ownerRef, context.subjectRef)
      .map(row => {
        const live = activeSession?.context, task = live && String(live.accountRef) === row.account_ref &&
          live.ownerEpoch === row.owner_epoch && live.runEpoch === row.run_epoch && live.connectionEpoch === row.connection_epoch
          ? activeSession.maintenanceTasks.get(row.task_key) : null;
        const pending = task?.persistencePending === true;
        return { featureKey: 'internal-maintenance', actionKey: row.task_key, sourceKey: row.source_key,
          sourceVersion: row.source_version, state: pending ? 'waiting-until' : row.state,
          reasonCode: pending ? task.deferredReasonCode : row.reason_code, attempt: pending ? task.attempt : row.attempt,
          fallbackDueAtMs: pending ? task.nextDueMs : row.next_due_ms, persistencePending: pending,
          lastStartedAt: row.last_started_at, updatedAt: row.updated_at };
      });
    return [...business, ...maintenance];
  }
  function healthSnapshot() {
    const nowMono = monotonicNow(), nowMs = deviceNow();
    const activeStages = [...sessions.values()].map(session => session.activeStage).filter(Boolean).map(stage => ({
      ownerRef: stage.ownerRef, accountRef: stage.accountRef, subjectRef: stage.subjectRef,
      ownerEpoch: stage.ownerEpoch, runEpoch: stage.runEpoch,
      connectionEpoch: stage.connectionEpoch, featureKey: stage.featureKey, stage: stage.stage,
      startedAtMs: stage.startedAtMs, ageMs: Math.max(0, Math.floor(nowMono - stage.startedMono)),
      stageLimitMs: stage.stageLimitMs, deadlineAtMs: stage.deadlineAtMs, operationId: stage.operationId,
      businessDueAtMs: stage.businessDueAtMs, officialDueAtMs: stage.officialDueAtMs,
      overdue: nowMono >= stage.deadlineMono }));
    const busyContexts = [...sessions.values()].filter(session => session.busy || [...session.maintenanceTasks.values()].some(task => task.running))
      .map(session => ({ ownerRef: session.context.ownerRef, accountRef: String(session.context.accountRef),
        subjectRef: session.context.subjectRef, ownerEpoch: session.context.ownerEpoch, runEpoch: session.context.runEpoch,
        connectionEpoch: session.context.connectionEpoch, schedulerBusy: session.busy,
        maintenanceBusy: [...session.maintenanceTasks.values()].some(task => task.running),
        stage: session.activeStage?.stage || null, operationId: session.activeStage?.operationId || null }));
    const storageRetryContexts = [...sessions.values()].filter(session => session.storageRetryAtMs > nowMs).map(session => ({
      ownerRef: session.context.ownerRef, accountRef: String(session.context.accountRef), subjectRef: session.context.subjectRef,
      runEpoch: session.context.runEpoch, connectionEpoch: session.context.connectionEpoch, retryAtMs: session.storageRetryAtMs,
      reasonCode: session.storageBusyReason }));
    return { activeStages, busyContexts, storageRetryContexts, processRecoveryHold: recoveryHolds.process,
      recoveryHeldSubjects: [...recoveryHolds.subjects].sort(), stalled: activeStages.some(stage => stage.overdue), sampledAtMs: nowMs,
      stageNoProgressLimitMs: activeStages.length ? Math.min(...activeStages.map(stage =>
        Math.max(0, stage.deadlineAtMs - stage.startedAtMs))) : null };
  }
  const configurationHistoryQuiescent = ({ ownerRef, subjectRef } = {}) => ![...sessions.values()].some(session =>
    session.context.ownerRef === ownerRef && session.context.subjectRef === subjectRef &&
    (session.busy || session.requested || session.activeStage || [...session.maintenanceTasks.values()].some(task => task.running)));
  return Object.freeze({ start, stop, notify, quiesce, snapshot, healthSnapshot, configurationHistoryQuiescent, holdForProcessRecovery,
    releaseProcessRecoveryHold, registerMaintenance });
}
