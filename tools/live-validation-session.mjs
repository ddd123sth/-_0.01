import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ledgerObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function normalizeLedgerJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !ledgerObject(value)) throw new TypeError('Ledger original must contain JSON values only.');
  if (seen.has(value)) throw new TypeError('Ledger original must not contain cycles.');
  seen.add(value);
  const normalized = Array.isArray(value) ? value.map(item => normalizeLedgerJson(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeLedgerJson(value[key], seen)]));
  seen.delete(value);
  return normalized;
}
const ledgerJsonFingerprint = value => crypto.createHash('sha256')
  .update(JSON.stringify(normalizeLedgerJson(value))).digest('hex');

/**
 * Serial, evidence-preserving driver for a single device-local validation session.
 * It never retries a mutation, never starts a second run, and keeps waiting for
 * an in-flight write until the caller's explicit deadline.
 */
export class LiveValidationSession {
  constructor({ evidenceDir, adbPath, serial, packageName, accountId, officialUid, buildId,
    pollIntervalMs = 2000, getAttempts = 3 } = {}) {
    if (!path.isAbsolute(evidenceDir || '') || !adbPath || !serial || !packageName ||
        !Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(officialUid) || officialUid <= 0 ||
        !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || !Number.isSafeInteger(getAttempts) || getAttempts < 1 || getAttempts > 5)
      throw new TypeError('Live validation session requires an absolute evidence directory and explicit device/account identity.');
    if (fs.existsSync(evidenceDir)) {
      if (!fs.statSync(evidenceDir).isDirectory() || fs.readdirSync(evidenceDir).length)
        throw new Error('Live validation evidence directory must be unique and empty.');
    } else fs.mkdirSync(evidenceDir, { recursive: false });
    this.evidenceDir = evidenceDir;
    this.adbPath = adbPath;
    this.serial = serial;
    this.packageName = packageName;
    this.accountId = accountId;
    this.officialUid = officialUid;
    this.buildId = buildId || null;
    this.pollIntervalMs = pollIntervalMs;
    this.getAttempts = getAttempts;
    this.sequence = 0;
    this.fileSequence = 0;
    this.forwardSequence = 0;
    this.connection = null;
    this.stopConnection = null;
    this.queue = Promise.resolve();
    this.started = false;
    this.stopCommitted = false;
    this.restored = false;
    this.originalConfig = null;
    this.events = [];
    this.errors = [];
    this.writeSlots = new Map();
    this.writeFirstSeen = new Map();
    this.writeLastSeen = new Map();
    this.writeTerminal = new Map();
    this.writeDeadline = new Map();
    this.accountBaselines = new Map();
    this.writeAdmissionBlocked = false;
    this.writeRiskNotified = new Set();
    this.activeRunEpoch = null;
    this.discoveryCursor = null;
    this.latestDiscovery = null;
    this.expectedOwnerRef = null;
    this.expectedSubjectRef = null;
    this.expectedOwnerEpoch = null;
    this.expectedExecutorRef = null;
    this.acceptedExecutionContexts = new Map();
    this.currentExecutionContext = null;
    this.contextGeneration = 0;
    this.discoveryScannedGeneration = -1;
    this.discoveryWaitDeadlineAt = null;
    this.discoveryWaitGeneration = null;
    this.discoveryContextPending = null;
    this.operationOriginalFingerprints = new Map();
    this.operationAuditSnapshots = new Map();
    this.baselineOperationIds = new Set();
    this.unresolvedWriteIds = new Set();
    this.verifiedCurrentRunOperations = new Map();
    this.rackFenceComplete = false;
    this.startedUtc = new Date().toISOString();
    this.#save('driver-state.json', this.#state());
  }

  #save(name, value) {
    const target = path.resolve(this.evidenceDir, name);
    const relative = path.relative(this.evidenceDir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence path escaped its attempt directory.');
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  }

  #state() {
    return { startedUtc: this.startedUtc, updatedUtc: new Date().toISOString(), accountId: this.accountId,
      officialUid: this.officialUid, buildId: this.buildId, started: this.started, stopCommitted: this.stopCommitted,
      restored: this.restored, writeAdmissionBlocked: this.writeAdmissionBlocked, activeRunEpoch: this.activeRunEpoch,
      expectedOwnerRef: this.expectedOwnerRef, expectedSubjectRef: this.expectedSubjectRef,
      expectedOwnerEpoch: this.expectedOwnerEpoch, expectedExecutorRef: this.expectedExecutorRef,
      acceptedExecutionContexts: [...this.acceptedExecutionContexts.values()],
      operationAuditSnapshots: [...this.operationAuditSnapshots.entries()],
      currentExecutionContext: this.currentExecutionContext, contextGeneration: this.contextGeneration,
      discoveryScannedGeneration: this.discoveryScannedGeneration, discoveryCursor: this.discoveryCursor,
      discoveryWaitDeadlineAt: this.discoveryWaitDeadlineAt ? new Date(this.discoveryWaitDeadlineAt).toISOString() : null,
      discoveryContextPending: this.discoveryContextPending,
      unresolvedWriteIds: [...this.unresolvedWriteIds],
      rackFenceComplete: this.rackFenceComplete,
      forwardSequence: this.forwardSequence, events: this.events, errors: this.errors,
      pendingWrites: [...this.writeFirstSeen.keys()].filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id)).map(operationId => ({
        operationId, firstSeenUtc: this.writeFirstSeen.get(operationId), lastSeenUtc: this.writeLastSeen.get(operationId),
        deadlineUtc: this.writeDeadline.get(operationId), latest: this.writeSlots.get(operationId) || null })) };
  }

  #adb(args, timeoutMs = 30000) {
    return execFileSync(this.adbPath, ['-s', this.serial, ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  }

  #connect(label, deadlineAt = null) {
    const boundedTimeout = () => {
      const remaining = deadlineAt === null ? 30000 : deadlineAt - Date.now();
      if (remaining <= 0) throw Object.assign(new Error('REQUEST_DEADLINE_EXPIRED'), { code: 'REQUEST_DEADLINE_EXPIRED' });
      return Math.max(1, Math.min(30000, remaining));
    };
    const raw = this.#adb(['shell', 'run-as', this.packageName, 'cat', 'files/engine-session.json'], boundedTimeout());
    const session = JSON.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(session.token || '') || !Number.isSafeInteger(session.port)) throw new Error('DEVICE_SESSION_INVALID');
    const local = this.#adb(['forward', 'tcp:0', `tcp:${session.port}`], boundedTimeout()).trim();
    if (!/^\d+$/.test(local)) throw new Error('DEVICE_FORWARD_FAILED');
    const connection = { local, token: session.token, remotePort: session.port, label, openedUtc: new Date().toISOString(),
      close: (timeoutMs = 2000) => { try { this.#adb(['forward', '--remove', `tcp:${local}`], Math.max(1, Math.min(2000, timeoutMs))); } catch {} } };
    this.forwardSequence += 1;
    this.events.push({ type: 'forward-open', sequence: this.forwardSequence, label, localPort: Number(local),
      remotePort: session.port, at: connection.openedUtc });
    this.#save('driver-state.json', this.#state());
    return connection;
  }

  async #exclusive(callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await callback(); } finally { release(); }
  }

  async #requestOnce(connection, method, route, body, timeoutMs) {
    if (!route.startsWith('/api/local/')) throw new Error('LOCAL_API_ROUTE_REQUIRED');
    const sequence = ++this.sequence, startedUtc = new Date().toISOString();
    let response, raw;
    try {
      response = await fetch(`http://127.0.0.1:${connection.local}${route}`, { method,
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      raw = await response.text();
    } catch (error) {
      const event = { type: 'request-error', sequence, method, route, startedUtc, endedUtc: new Date().toISOString(), message: error?.message || String(error) };
      this.errors.push(event); this.events.push(event); this.#save('driver-state.json', this.#state()); throw error;
    }
    const rawName = `api-${String(sequence).padStart(5, '0')}-${method.toLowerCase()}-${route.replaceAll('/', '_').replaceAll('?', '_').replaceAll('&', '_')}.body.txt`;
    this.#save(rawName, raw);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`NON_JSON_HTTP_${response.status}:${route}`); }
    const event = { type: 'request', sequence, method, route, startedUtc, endedUtc: new Date().toISOString(),
      status: response.status, bytes: Buffer.byteLength(raw), bodyFile: rawName };
    this.events.push(event); this.#save('driver-state.json', this.#state());
    if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP_${response.status}`), { status: response.status, code: data?.code, details: data?.details });
    return data;
  }

  async request(method, route, body, { timeoutMs = 30000, label = 'main', deadlineAt = null } = {}) {
    return this.#exclusive(async () => {
      const attempts = method === 'GET' ? this.getAttempts : 1;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const remaining = deadlineAt === null ? Infinity : deadlineAt - Date.now();
        if (remaining <= 0) throw Object.assign(new Error('REQUEST_DEADLINE_EXPIRED'), { code: 'REQUEST_DEADLINE_EXPIRED' });
        let connection = label === 'stop' ? this.stopConnection : this.connection;
        if (!connection) {
          connection = this.#connect(attempt === 1 ? label : 'same-run-get-reconnect', deadlineAt);
          if (label === 'stop') this.stopConnection = connection; else this.connection = connection;
        }
        const requestRemaining = deadlineAt === null ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now() - 250);
        if (requestRemaining <= 0) throw Object.assign(new Error('REQUEST_DEADLINE_EXPIRED'), { code: 'REQUEST_DEADLINE_EXPIRED' });
        try { return await this.#requestOnce(connection, method, route, body, requestRemaining); }
        catch (error) {
          const event = { type: 'request-failed', method, route, attempt, at: new Date().toISOString(), status: error?.status || null,
            code: error?.code || null, message: error?.message || String(error) };
          this.errors.push(event); this.events.push(event); this.#save('driver-state.json', this.#state());
          if (method === 'GET' && !error?.status) {
            connection.close(deadlineAt === null ? 2000 : Math.max(1, deadlineAt - Date.now()));
            if (label === 'stop') this.stopConnection = null; else this.connection = null;
          }
          if (method !== 'GET' || error?.status || attempt === attempts || (deadlineAt !== null && Date.now() >= deadlineAt)) throw error;
          await sleep(400 * attempt);
        }
      }
      throw new Error('GET_RECOVERY_EXHAUSTED');
    });
  }

  async readBaseline() {
    const status = await this.request('GET', '/api/local/status');
    const account = await this.request('GET', `/api/local/accounts/${this.accountId}`);
    const config = await this.request('GET', `/api/local/accounts/${this.accountId}/config`);
    const writes = await this.request('GET', `/api/local/accounts/${this.accountId}/writes?limit=100`);
    if (this.buildId && status.runtime?.buildId !== this.buildId) throw new Error('BUILD_ID_MISMATCH');
    if (account.account?.uid !== this.officialUid) throw new Error('OFFICIAL_UID_MISMATCH');
    if (account.account?.state !== 'stopped' || account.account?.running !== false || account.account?.desiredRunning !== false)
      throw new Error('ACCOUNT_NOT_STOPPED_AT_BASELINE');
    if (writes.totals?.writeSlot !== 0) throw new Error('WRITE_SLOT_OCCUPIED_AT_BASELINE');
    this.expectedOwnerRef = status.software?.ownerRef || null;
    if (typeof this.expectedOwnerRef !== 'string' || !this.expectedOwnerRef) throw new Error('BASELINE_OWNER_IDENTITY_MISSING');
    const historyRows = [...(writes.writes || [])];
    let cursor = writes.page?.older || null, hasMore = writes.page?.hasMore === true, pages = 1;
    while (hasMore) {
      if (!cursor?.beforePreparedAt || !cursor?.beforeOperationId) throw new Error('BASELINE_WRITE_CURSOR_MISSING');
      const query = new URLSearchParams({ limit: '100', beforePreparedAt: cursor.beforePreparedAt, beforeOperationId: cursor.beforeOperationId });
      const page = await this.request('GET', `/api/local/accounts/${this.accountId}/writes?${query}`, undefined, { timeoutMs: 10000 });
      pages += 1;
      historyRows.push(...(page.writes || []));
      hasMore = page.page?.hasMore === true;
      cursor = page.page?.older || null;
    }
    for (const row of historyRows) if (typeof row.operationId === 'string') this.baselineOperationIds.add(row.operationId);
    let identity = null;
    for (const summary of historyRows) {
      const detail = await this.request('GET', `/api/local/accounts/${this.accountId}/writes/${summary.operationId}`, undefined, { timeoutMs: 5000 });
      if (detail.accountRef !== String(this.accountId) || detail.ownerRef !== this.expectedOwnerRef || !detail.subjectRef ||
          detail.original?.accountRef !== String(this.accountId) || detail.original?.ownerRef !== this.expectedOwnerRef ||
          detail.original?.subjectRef !== detail.subjectRef || !Number.isSafeInteger(detail.original?.ownerEpoch)) continue;
      identity = detail;
      this.expectedSubjectRef = detail.subjectRef;
      break;
    }
    if (!identity) throw new Error('BASELINE_ACCOUNT_SUBJECT_OWNER_EPOCH_UNVERIFIED');
    this.#save('baseline-operation-identities.json', { capturedUtc: new Date().toISOString(), accountId: this.accountId,
      officialUid: this.officialUid, ownerRef: this.expectedOwnerRef, subjectRef: this.expectedSubjectRef,
      historicalOwnerEpoch: identity.original.ownerEpoch, pages, operationIdCount: this.baselineOperationIds.size,
      operationIds: [...this.baselineOperationIds], identityOperationId: identity.operationId, identityDetail: identity });
    this.originalConfig = structuredClone(config.config);
    this.accountBaselines.set(this.accountId, { uid: this.officialUid, config: structuredClone(config.config) });
    const result = { status, account, config, writesTotals: writes.totals, capturedUtc: new Date().toISOString() };
    this.#save('baseline.json', result);
    return result;
  }

  recordAccountBaseline({ id, uid, config } = {}) {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(uid) || uid <= 0 || !config || typeof config !== 'object')
      throw new TypeError('Account baseline requires a complete account identity and config DTO.');
    this.accountBaselines.set(id, { uid, config: structuredClone(config) });
  }

  async startOnce() {
    this.assertWriteAdmissionAllowed();
    if (this.started) throw new Error('START_ALREADY_SENT_IN_THIS_ATTEMPT');
    const before = await this.request('GET', `/api/local/accounts/${this.accountId}`);
    if (before.account?.uid !== this.officialUid || before.account?.state !== 'stopped' ||
        before.account?.running !== false || before.account?.desiredRunning !== false ||
        !Number.isSafeInteger(before.account?.runEpoch) || before.account.runEpoch < 0)
      throw new Error('START_REQUIRES_FRESH_STOPPED_ACCOUNT_AND_RUN_EPOCH');
    // Treat the attempt as started before issuing the one POST. If the response
    // is lost after the device accepts it, callers still run the STOP cleanup.
    this.started = true;
    this.#save('start-attempt.json', { attemptedUtc: new Date().toISOString(), accountId: this.accountId,
      expectedPriorRunEpoch: before.account.runEpoch, account: before });
    this.#save('driver-state.json', this.#state());
    const response = await this.request('POST', `/api/local/accounts/${this.accountId}/start`,
      { expectedPriorRunEpoch: before.account.runEpoch }, { label: 'start' });
    this.#save('start-response.json', response);
    this.#save('driver-state.json', this.#state());
    return response;
  }

  async waitForConnected({ deadlineMs = 90000, pollMs = this.pollIntervalMs, observationTimeoutMs = 15000,
    requiredDomain = 'land' } = {}) {
    if (!this.started) throw new Error('START_REQUIRED');
    const deadline = Date.now() + deadlineMs;
    let last = null;
    while (Date.now() < deadline) {
      let account;
      try { account = await this.request('GET', `/api/local/accounts/${this.accountId}`, undefined, { timeoutMs: Math.min(10000, deadline - Date.now()), deadlineAt: deadline }); }
      catch (error) {
        last = { readError: error?.message || String(error), capturedUtc: new Date().toISOString() };
        this.#save(`ready-observation-error-${++this.fileSequence}.json`, last);
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (account.account?.uid !== this.officialUid || account.account?.desiredRunning !== true) throw new Error('STARTED_ACCOUNT_IDENTITY_OR_INTENT_CHANGED');
      if (account.account?.state === 'blocked') throw new Error(`ACCOUNT_BLOCKED:${account.account?.lastError || 'unknown'}`);
      if (account.account?.state === 'running') {
        let observation;
        try { observation = await this.request('GET', `/api/local/accounts/${this.accountId}/observations`, undefined,
          { timeoutMs: Math.min(observationTimeoutMs, deadline - Date.now()), deadlineAt: deadline }); }
        catch (error) {
          last = { account, observationError: error?.message || String(error), capturedUtc: new Date().toISOString() };
          this.#save(`ready-observation-error-${++this.fileSequence}.json`, last);
          await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
          continue;
        }
        last = { account, observation, capturedUtc: new Date().toISOString() };
        this.#save(`ready-observation-${++this.fileSequence}.json`, last);
        this.#adoptObservedExecutionContext(account, observation, { initial: true });
        const connected = observation.session?.connected === true && observation.session?.desiredRunning === true &&
          observation.available === true && observation.source === 'new-official-facts' &&
          Number.isSafeInteger(observation.session?.connectionEpoch) && observation.session.connectionEpoch > 0;
        const domain = observation[requiredDomain];
        const domainCurrent = domain?.available === true && domain?.current === true;
        if (connected && domainCurrent) {
          if (!this.currentExecutionContext) {
            last.ownerContextPending = true;
            this.#save(`ready-owner-context-pending-${++this.fileSequence}.json`, last);
            await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
            continue;
          }
          return last;
        }
      }
      await sleep(pollMs);
    }
    this.#save('ready-deadline.json', { deadlineUtc: new Date(deadline).toISOString(), observed: last });
    throw new Error('CONNECTED_CURRENT_LOGIN_DEADLINE');
  }

  observeOperation(row, { inFlightDeadlineMs = 90000 } = {}) {
    if (!row?.operationId) throw new TypeError('Operation row requires an operationId.');
    const id = row.operationId, now = new Date().toISOString();
    if (!this.writeFirstSeen.has(id)) this.writeFirstSeen.set(id, now);
    if (!this.writeDeadline.has(id)) this.writeDeadline.set(id, new Date(Date.parse(now) + inFlightDeadlineMs).toISOString());
    this.writeLastSeen.set(id, now);
    this.writeSlots.set(id, { verdict: row.verdict || null, transport: row.transport || null, writeSlot: row.writeSlot ?? null, reasonCode: row.reasonCode || null });
    const terminalVerdict = ['confirmed', 'rejected', 'unknown', 'not_applicable'].includes(row.verdict);
    const terminal = terminalVerdict;
    const drained = row.writeSlot === false && ['not_sent', 'answered', 'terminated', 'unknown'].includes(row.transport);
    if (['unknown', 'rejected'].includes(row.verdict)) this.writeAdmissionBlocked = true;
    if (terminal) this.writeTerminal.set(id, { at: now, verdict: row.verdict, transport: row.transport, writeSlot: row.writeSlot ?? null,
      drained, reasonCode: row.reasonCode || null,
      targetSettlements: row.targetSettlements || null });
    const overdue = (!terminal || !drained) && Date.now() >= Date.parse(this.writeDeadline.get(id));
    this.#save('driver-state.json', this.#state());
    return { operationId: id, terminal, businessTerminal: terminal, drained, inFlight: !terminal || !drained, overdue, firstSeenUtc: this.writeFirstSeen.get(id),
      deadlineUtc: this.writeDeadline.get(id), latest: this.writeSlots.get(id), terminalResult: this.writeTerminal.get(id) || null,
      writeAdmissionBlocked: this.writeAdmissionBlocked };
  }

  #operationDrained(operationId) {
    const latest = this.writeSlots.get(operationId);
    return latest?.writeSlot === false && ['not_sent', 'answered', 'terminated', 'unknown'].includes(latest.transport);
  }

  #operationReason(row) {
    return row?.targetSettlements?.map?.(settlement => settlement?.reason_code || settlement?.reasonCode || null).find(Boolean) ||
      row?.settlement?.reasonCode || row?.verification?.reasonCode || null;
  }

  async #handleWriteRisk(operationId, details, onRisk) {
    if (!onRisk || this.writeRiskNotified.has(operationId)) return false;
    try {
      const fence = await onRisk({ operationId, ...details, writesBlocked: true, continueDrainingKnownOperations: true });
      if (fence?.verified !== true) throw new Error('WRITE_RISK_CALLBACK_DID_NOT_VERIFY_DEVICE_FENCE');
      this.writeRiskNotified.add(operationId);
      this.rackFenceComplete = true;
      this.#save('driver-state.json', this.#state());
      return true;
    } catch (error) {
      const event = { type: 'write-risk-fence-incomplete', operationId, at: new Date().toISOString(),
        message: error?.message || String(error), writesBlocked: true, deviceFenceVerified: false };
      this.errors.push(event); this.events.push(event); this.#save('driver-state.json', this.#state());
      return false;
    }
  }

  #operationRows(page) {
    return (page?.writes || []).map(row => ({ operationId: row.operationId, verdict: row.verdict,
      transport: row.transport, writeSlot: row.writeSlot, reasonCode: this.#operationReason(row),
      targetSettlements: row.targetSettlements || null, preparedAt: row.preparedAt, runEpoch: row.runEpoch }));
  }

  #executionKey(context) { return JSON.stringify([context?.runEpoch, context?.ownerEpoch, context?.executorRef]); }

  #observedContext(account, observation) {
    const owner = observation?.sessionEvidence?.owner;
    const domains = [observation?.art?.planning, observation?.customer, observation?.orderFlower];
    const domain = domains.find(one => one?.available === true && one?.current === true && one?.context) || null;
    const context = domain?.context;
    if (!context || account?.account?.uid !== this.officialUid || account?.account?.desiredRunning !== true ||
        observation?.available !== true || observation?.source !== 'new-official-facts' || observation?.session?.connected !== true ||
        this.buildId && observation?.buildId !== this.buildId || owner?.active !== true ||
        !Number.isSafeInteger(owner.ownerEpoch) || typeof owner.executorRef !== 'string' || !owner.executorRef ||
        context.ownerRef !== this.expectedOwnerRef || context.accountRef !== String(this.accountId) ||
        context.subjectRef !== this.expectedSubjectRef || context.ownerEpoch !== owner.ownerEpoch ||
        context.runEpoch !== observation.session?.runEpoch || context.connectionEpoch !== observation.session?.connectionEpoch ||
        observation.session?.desiredRunning !== true || !Number.isSafeInteger(context.connectionEpoch) || context.connectionEpoch <= 0 ||
        !Number.isSafeInteger(context.runEpoch) || context.runEpoch <= 0) return null;
    return { ownerRef: context.ownerRef, accountRef: context.accountRef, subjectRef: context.subjectRef,
      officialUid: this.officialUid, buildId: this.buildId, ownerEpoch: context.ownerEpoch, runEpoch: context.runEpoch,
      connectionEpoch: context.connectionEpoch, executorRef: owner.executorRef };
  }

  #refreshBridgeReaches(observation, target) {
    const events = observation?.sessionEvidence?.snapshotRefreshes;
    if (!Array.isArray(events)) return false;
    const grouped = new Map();
    for (const event of events) {
      if (!event || typeof event.refreshRef !== 'string' || !event.originalContext) continue;
      const list = grouped.get(event.refreshRef) || [];
      list.push(event); grouped.set(event.refreshRef, list);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of grouped.values()) {
        const requested = group.find(event => event.kind === 'requested');
        const closed = group.find(event => event.kind === 'physical-close-proved');
        const login = group.find(event => event.kind === 'fresh-login-established');
        const original = requested?.originalContext, receipt = login?.receipt;
        if (!requested || !closed || !login || !original || !receipt) continue;
        // The event does not repeat executorRef. Match the durable axes and
        // require its original connection to be at least the last accepted
        // connection for that exact run/owner generation.
        const source = [...this.acceptedExecutionContexts.values()].find(context => context.ownerRef === original.ownerRef &&
          context.accountRef === original.accountRef && context.subjectRef === original.subjectRef &&
          context.ownerEpoch === original.ownerEpoch && context.runEpoch === original.runEpoch &&
          original.connectionEpoch >= context.connectionEpoch);
        const physicalClose = observation.sessionEvidence?.closures?.find(one => one.evidenceRef === closed.receipt?.closureEvidenceRef &&
          one.ownerEpoch === original.ownerEpoch && one.runEpoch === original.runEpoch &&
          one.connectionEpoch === original.connectionEpoch && one.proof?.closed === true &&
          one.executorRef === target.executorRef);
        if (!source || requested.receipt?.officialUid !== this.officialUid || closed.receipt?.closed !== true ||
            closed.receipt?.connectionEpoch !== original.connectionEpoch ||
            typeof closed.receipt?.closureEvidenceRef !== 'string' ||
            !physicalClose || source.executorRef !== physicalClose.executorRef ||
            login.originalContext?.ownerRef !== original.ownerRef || login.originalContext?.accountRef !== original.accountRef ||
            login.originalContext?.subjectRef !== original.subjectRef || login.originalContext?.ownerEpoch !== original.ownerEpoch ||
            login.originalContext?.runEpoch !== original.runEpoch || login.originalContext?.connectionEpoch !== original.connectionEpoch ||
            receipt.closureEvidenceRef !== closed.receipt.closureEvidenceRef || receipt.refreshed !== true ||
            receipt.loginSource?.kind !== 'response' || receipt.loginSource?.transport !== 'answered' ||
            receipt.loginSource?.method !== 'index.login' || receipt.loginSource?.officialUid !== this.officialUid ||
            !receipt.loginSource?.responseRef || !Number.isSafeInteger(receipt.loginSource?.requestSequence) || receipt.loginSource.requestSequence <= 0 ||
            typeof receipt.loginSource?.wireKey !== 'string' || !receipt.loginSource.wireKey.endsWith(`|${receipt.loginSource.requestSequence}`) ||
            receipt.loginSource?.connectionEpoch !== receipt.newContext?.connectionEpoch ||
            !receipt.newContext || receipt.newContext.ownerRef !== this.expectedOwnerRef ||
            receipt.newContext.accountRef !== String(this.accountId) || receipt.newContext.subjectRef !== this.expectedSubjectRef ||
            !Number.isSafeInteger(receipt.newContext.ownerEpoch) || !Number.isSafeInteger(receipt.newContext.runEpoch) ||
            !Number.isSafeInteger(receipt.newContext.connectionEpoch) || receipt.newContext.ownerEpoch <= original.ownerEpoch ||
            receipt.newContext.runEpoch <= original.runEpoch || receipt.newContext.connectionEpoch <= original.connectionEpoch ||
            closed.receipt.connectionEpoch !== physicalClose.proof?.connectionEpoch) continue;
        const next = { ownerRef: receipt.newContext.ownerRef, accountRef: receipt.newContext.accountRef,
          subjectRef: receipt.newContext.subjectRef, officialUid: this.officialUid, buildId: this.buildId,
          ownerEpoch: receipt.newContext.ownerEpoch, runEpoch: receipt.newContext.runEpoch,
          connectionEpoch: receipt.newContext.connectionEpoch, executorRef: physicalClose.executorRef };
        const key = this.#executionKey(next);
        if (!this.acceptedExecutionContexts.has(key)) {
          this.acceptedExecutionContexts.set(key, next); changed = true;
        }
      }
    }
    return this.acceptedExecutionContexts.has(this.#executionKey(target));
  }

  #adoptObservedExecutionContext(account, observation, { initial = false } = {}) {
    const candidate = this.#observedContext(account, observation);
    if (!candidate) return { accepted: false, reason: 'CURRENT_CONTEXT_OR_IDENTITY_NOT_VERIFIED' };
    const key = this.#executionKey(candidate), existing = this.acceptedExecutionContexts.get(key);
    if (existing) {
      if (candidate.connectionEpoch < existing.connectionEpoch) return { accepted: false, reason: 'CONNECTION_EPOCH_REGRESSED' };
      const next = { ...existing, connectionEpoch: candidate.connectionEpoch };
      this.acceptedExecutionContexts.set(key, next);
      this.currentExecutionContext = next;
      this.activeRunEpoch = candidate.runEpoch;
      this.expectedOwnerEpoch = candidate.ownerEpoch;
      this.expectedExecutorRef = candidate.executorRef;
      return { accepted: true, changed: false, context: next };
    }
    if (!this.acceptedExecutionContexts.size && initial && this.started) {
      this.acceptedExecutionContexts.set(key, candidate);
      this.contextGeneration += 1;
      this.discoveryCursor = null; this.discoveryScannedGeneration = -1;
      this.currentExecutionContext = candidate; this.activeRunEpoch = candidate.runEpoch;
      this.expectedOwnerEpoch = candidate.ownerEpoch; this.expectedExecutorRef = candidate.executorRef;
      this.discoveryWaitDeadlineAt = null; this.discoveryWaitGeneration = this.contextGeneration; this.discoveryContextPending = null;
      this.#save('driver-state.json', this.#state());
      return { accepted: true, changed: true, context: candidate, initial: true };
    }
    if (!this.#refreshBridgeReaches(observation, candidate)) return { accepted: false, reason: 'EXECUTION_CONTEXT_BRIDGE_UNVERIFIED', context: candidate };
    this.currentExecutionContext = candidate; this.activeRunEpoch = candidate.runEpoch;
    this.expectedOwnerEpoch = candidate.ownerEpoch; this.expectedExecutorRef = candidate.executorRef;
    this.contextGeneration += 1;
    this.discoveryWaitDeadlineAt = null; this.discoveryWaitGeneration = this.contextGeneration; this.discoveryContextPending = null;
    this.discoveryCursor = null; this.discoveryScannedGeneration = -1;
    this.#save(`execution-context-follow-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), context: candidate,
      refreshes: observation.sessionEvidence?.snapshotRefreshes || [], acceptedContexts: [...this.acceptedExecutionContexts.values()] });
    this.#save('driver-state.json', this.#state());
    return { accepted: true, changed: true, context: candidate };
  }

  #noteDiscoveredOperation(operationId) {
    if (this.baselineOperationIds.has(operationId)) return;
    if (!this.writeFirstSeen.has(operationId)) {
      const now = new Date();
      this.writeFirstSeen.set(operationId, now.toISOString());
      this.writeDeadline.set(operationId, new Date(now.getTime() + 90000).toISOString());
    }
  }

  async #verifyCurrentRunOperation(operationId, deadlineAt) {
    if (this.baselineOperationIds.has(operationId)) return null;
    if (this.verifiedCurrentRunOperations.has(operationId)) return this.verifiedCurrentRunOperations.get(operationId);
    const queryDeadline = Math.min(deadlineAt, Date.now() + 2000);
    const detail = await this.request('GET', `/api/local/accounts/${this.accountId}/writes/${operationId}`, undefined,
      { timeoutMs: Math.max(1, queryDeadline - Date.now()), deadlineAt: queryDeadline });
    const original = detail.original;
    const executionKey = this.#executionKey({ runEpoch: original?.runEpoch, ownerEpoch: original?.ownerEpoch, executorRef: original?.executorRef });
    let originalFingerprint = null;
    try { if (original && typeof original === 'object') originalFingerprint = ledgerJsonFingerprint(original); } catch { /* Invalid JSON-like projections remain unverified. */ }
    const priorFingerprint = this.operationOriginalFingerprints.get(operationId);
    const integrity = detail.originalIntegrity;
    const integrityValid = originalFingerprint !== null && integrity?.storedFingerprintVerified === true && integrity?.complete === true &&
      integrity?.hashContract === 'backend-ledger-json/v1' && detail.originalFingerprint === originalFingerprint &&
      integrity.projectionFingerprint === originalFingerprint;
    const valid = detail.operationId === operationId && detail.ownerRef === this.expectedOwnerRef &&
      detail.accountRef === String(this.accountId) && detail.subjectRef === this.expectedSubjectRef &&
      detail.runEpoch === original?.runEpoch && detail.connectionEpoch === original?.connectionEpoch && original?.operationId === operationId &&
      original.ownerRef === this.expectedOwnerRef && original.accountRef === String(this.accountId) &&
      original.subjectRef === this.expectedSubjectRef && integrityValid && this.acceptedExecutionContexts.has(executionKey) &&
      (!priorFingerprint || priorFingerprint === originalFingerprint);
    if (!valid) {
      this.#save(`out-of-scope-write-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), operationId,
        expected: { ownerRef: this.expectedOwnerRef, accountRef: String(this.accountId), subjectRef: this.expectedSubjectRef,
          ownerEpoch: this.expectedOwnerEpoch, runEpoch: this.activeRunEpoch,
          acceptedContexts: [...this.acceptedExecutionContexts.values()] }, observed: { operationId: detail.operationId,
          ownerRef: detail.ownerRef, accountRef: detail.accountRef, subjectRef: detail.subjectRef,
          ownerEpoch: original?.ownerEpoch, runEpoch: detail.runEpoch, originalRunEpoch: original?.runEpoch }, ignored: true });
      return null;
    }
    if (!priorFingerprint) this.operationOriginalFingerprints.set(operationId, originalFingerprint);
    this.verifiedCurrentRunOperations.set(operationId, detail);
    if (detail.auditProjection && typeof detail.auditProjection === 'object') this.operationAuditSnapshots.set(operationId, {
      originalFingerprint, capturedAtUtc: new Date().toISOString(), observedTerminalConfirmed: detail.verdict === 'confirmed',
      projection: detail.auditProjection });
    return detail;
  }

  async discoverWrites({ fullScan = false, pageLimit = 100, onRisk = null, deadlineAt = null } = {}) {
    if (!this.currentExecutionContext) throw new Error('VERIFIED_EXECUTION_CONTEXT_REQUIRED_FOR_WRITE_DISCOVERY');
    const discovered = [], observed = [], risks = [];
    let identityReadFailures = 0, identityMismatches = 0;
    let pages = 0, total = null, hasMore = false, cursor = null;
    const parentDeadline = deadlineAt ?? Date.now() + 15000;
    const readPage = async pageCursor => {
      const remainingMs = parentDeadline - Date.now();
      if (remainingMs <= 0) throw Object.assign(new Error('WRITE_DISCOVERY_DEADLINE_EXPIRED'), { code: 'WRITE_DISCOVERY_DEADLINE_EXPIRED' });
      const remainingPages = total === null ? 16 : Math.max(1, Math.min(16, Math.ceil(total / pageLimit) - pages));
      const queryDeadline = Math.min(parentDeadline, Date.now() + Math.max(1, Math.min(1500, Math.floor(remainingMs / remainingPages))));
      const query = new URLSearchParams({ limit: String(pageLimit) });
      if (pageCursor) { query.set('beforePreparedAt', pageCursor.beforePreparedAt); query.set('beforeOperationId', pageCursor.beforeOperationId); }
      return this.request('GET', `/api/local/accounts/${this.accountId}/writes?${query}`, undefined,
        { timeoutMs: Math.max(1, queryDeadline - Date.now()), deadlineAt: queryDeadline });
    };
    const recordPage = async page => {
      pages += 1;
      if (Number.isSafeInteger(page.totals?.total) && page.totals.total >= 0) total = page.totals.total;
      for (const row of this.#operationRows(page)) {
        if (this.baselineOperationIds.has(row.operationId)) continue;
        this.#noteDiscoveredOperation(row.operationId);
        let detail;
        try { detail = await this.#verifyCurrentRunOperation(row.operationId, parentDeadline); }
        catch (error) {
          identityReadFailures += 1;
          this.unresolvedWriteIds.add(row.operationId);
          this.errors.push({ type: 'write-identity-read-error', operationId: row.operationId,
            at: new Date().toISOString(), message: error?.message || String(error) });
          continue;
        }
        if (!detail) { identityMismatches += 1; this.unresolvedWriteIds.add(row.operationId); continue; }
        this.unresolvedWriteIds.delete(row.operationId);
        observed.push(row.operationId);
        const state = this.observeOperation(row);
        if (state.inFlight && !discovered.includes(row.operationId)) discovered.push(row.operationId);
        if (!state.terminal || !['unknown', 'rejected'].includes(row.verdict)) continue;
        risks.push(row.operationId);
        if (!onRisk || this.writeRiskNotified.has(row.operationId)) continue;
        let riskDetail = detail;
        try {
          if (!riskDetail?.targetSettlements) {
          const opDeadline = Date.parse(this.writeDeadline.get(row.operationId) || '') || parentDeadline;
          const detailDeadline = Math.min(parentDeadline, opDeadline, Date.now() + 2000);
          riskDetail = await this.request('GET', `/api/local/accounts/${this.accountId}/writes/${row.operationId}`, undefined,
            { timeoutMs: Math.max(1, detailDeadline - Date.now()), deadlineAt: detailDeadline });
          }
        } catch (error) {
          this.errors.push({ type: 'terminal-detail-read-error', operationId: row.operationId,
            at: new Date().toISOString(), message: error?.message || String(error) });
        }
        const reasonCode = this.#operationReason(riskDetail) || row.reasonCode || null;
        const terminalResult = this.writeTerminal.get(row.operationId);
        if (terminalResult && (reasonCode || riskDetail?.targetSettlements)) {
          terminalResult.reasonCode = reasonCode;
          terminalResult.targetSettlements = riskDetail?.targetSettlements || null;
        }
        await this.#handleWriteRisk(row.operationId, { verdict: row.verdict, reasonCode,
          targetSettlements: riskDetail?.targetSettlements || null, detail: riskDetail }, onRisk);
      }
      hasMore = page.page?.hasMore === true;
      cursor = page.page?.older || null;
      if (hasMore && (!cursor?.beforePreparedAt || !cursor?.beforeOperationId)) throw new Error('WRITE_PAGE_CURSOR_MISSING');
    };
    const newest = await readPage(null);
    await recordPage(newest);
    const firstOlder = newest.page?.older || null;
    if (fullScan && hasMore) {
      let historyCursor = this.discoveryCursor || firstOlder;
      for (let historyPage = 0; hasMore && historyCursor && historyPage < 16; historyPage += 1) {
        const page = await readPage(historyCursor);
        await recordPage(page);
        historyCursor = page.page?.older || null;
        this.discoveryCursor = hasMore ? historyCursor : null;
      }
      this.discoveryCursor = hasMore ? historyCursor : null;
      if (!hasMore && identityReadFailures === 0 && identityMismatches === 0 && this.unresolvedWriteIds.size === 0)
        this.discoveryScannedGeneration = this.contextGeneration;
    } else if (!hasMore) {
      this.discoveryCursor = null;
      if (identityReadFailures === 0 && identityMismatches === 0 && this.unresolvedWriteIds.size === 0)
        this.discoveryScannedGeneration = this.contextGeneration;
    }
    if (identityReadFailures > 0 || identityMismatches > 0 || this.unresolvedWriteIds.size > 0) {
      this.discoveryCursor = null;
      this.discoveryScannedGeneration = -1;
    }
    this.#save(`write-discovery-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), pages,
      total, fullScan, hasMore, nextCursor: this.discoveryCursor, discovered, observed, risks, identityReadFailures, identityMismatches,
      unresolvedWriteIds: [...this.unresolvedWriteIds],
      writeAdmissionBlocked: this.writeAdmissionBlocked });
    this.latestDiscovery = { pages, hasMore, discovered, risks, fullScan,
      observed, identityReadFailures, identityMismatches, unresolvedWriteIds: [...this.unresolvedWriteIds],
      complete: this.discoveryScannedGeneration === this.contextGeneration && identityReadFailures === 0 && identityMismatches === 0 &&
        this.unresolvedWriteIds.size === 0,
      writeAdmissionBlocked: this.writeAdmissionBlocked };
    return this.latestDiscovery;
  }

  assertWriteAdmissionAllowed() {
    if (this.writeAdmissionBlocked) throw new Error('WRITE_ADMISSION_BLOCKED_BY_UNKNOWN_OR_REJECTED_OPERATION');
    return true;
  }

  async fenceFlowerRackAdmissions({ reason = 'unknown-or-rejected-write', plannedWindowClose = false } = {}) {
    if ((!this.writeAdmissionBlocked && !plannedWindowClose) || !this.originalConfig?.flowerRack)
      throw new Error('RACK_FENCE_REQUIRES_BLOCKED_WRITE_OR_PLANNED_CLOSE_AND_FULL_BASELINE');
    const account = await this.request('GET', `/api/local/accounts/${this.accountId}`);
    if (account.account?.uid !== this.officialUid || !['running', 'starting'].includes(account.account?.state) ||
        account.account?.running !== true || account.account?.desiredRunning !== true)
      throw new Error('RACK_FENCE_REQUIRES_MATCHING_ACTIVE_OR_RECONNECTING_ACCOUNT');
    const before = await this.request('GET', `/api/local/accounts/${this.accountId}/config`);
    const intended = structuredClone(before.config);
    intended.flowerRack.enabled = false;
    intended.flowerRack.autoTakeDown = false;
    intended.flowerRack.unlockEnabled = false;
    const result = { capturedUtc: new Date().toISOString(), reason, account: account.account, before,
      intended, put: null, readback: null, verified: false };
    if (JSON.stringify(before.config) !== JSON.stringify(intended)) {
      result.put = await this.request('PUT', `/api/local/accounts/${this.accountId}/config`,
        { ...intended, expectedRevision: before.application?.savedRevision });
    }
    result.readback = await this.request('GET', `/api/local/accounts/${this.accountId}/config`);
    result.verified = JSON.stringify(result.readback.config) === JSON.stringify(intended) &&
      result.readback.config?.flowerRack?.enabled === false && result.readback.config?.flowerRack?.autoTakeDown === false &&
      result.readback.config?.flowerRack?.unlockEnabled === false;
    this.#save(`rack-write-fence-${++this.fileSequence}.json`, result);
    if (!result.verified) throw new Error('RACK_WRITE_FENCE_READBACK_MISMATCH');
    this.rackFenceComplete = true;
    return result;
  }

  async closeFlowerRackWindowAndDrain({ pollMs = this.pollIntervalMs, onRisk = null } = {}) {
    const fence = await this.fenceFlowerRackAdmissions({ reason: 'planned-window-close', plannedWindowClose: true });
    const drain = await this.waitForKnownOperations({ operationIds: [...this.writeFirstSeen.keys()], pollMs, onRisk });
    const operations = drain.results || [];
    const pending = operations.filter(row => row.terminal !== true || row.overdue === true);
    for (const operationId of drain.pendingIds || []) if (!pending.some(row => row.operationId === operationId))
      pending.push({ operationId, terminal: false, unresolved: this.unresolvedWriteIds.has(operationId) });
    const riskFenceIncomplete = this.writeAdmissionBlocked && !this.rackFenceComplete;
    const complete = drain.complete === true && fence.verified === true && pending.length === 0 && !riskFenceIncomplete &&
      this.latestDiscovery?.complete === true && this.latestDiscovery?.identityReadFailures === 0 &&
      this.latestDiscovery?.identityMismatches === 0;
    const result = { capturedUtc: new Date().toISOString(), fence, operations, pending, complete,
      riskFenceIncomplete, discovery: this.latestDiscovery, contextPending: drain.contextPending || null,
      drainDeadlineUtc: drain.deadlineUtc || null, drainReason: drain.reason || null,
      acceptance: drain.acceptance || null };
    this.#save(`rack-window-drain-${++this.fileSequence}.json`, result);
    return result;
  }

  async waitForOperation(operationId, { deadlineMs = 90000, pollMs = this.pollIntervalMs } = {}) {
    if (!this.writeDeadline.has(operationId)) {
      const firstSeen = this.writeFirstSeen.get(operationId) || new Date().toISOString();
      this.writeFirstSeen.set(operationId, firstSeen);
      this.writeDeadline.set(operationId, new Date(Date.parse(firstSeen) + deadlineMs).toISOString());
      this.#save('driver-state.json', this.#state());
    }
    const deadline = Date.parse(this.writeDeadline.get(operationId));
    if (this.writeTerminal.has(operationId) && this.#operationDrained(operationId)) return { row: null, state: { operationId, terminal: true,
      businessTerminal: true, drained: true, inFlight: false, overdue: false, latest: this.writeSlots.get(operationId), terminalResult: this.writeTerminal.get(operationId) } };
    while (Date.now() < deadline) {
      let row;
      try { row = await this.request('GET', `/api/local/accounts/${this.accountId}/writes/${operationId}`, undefined,
        { timeoutMs: Math.min(10000, deadline - Date.now()), deadlineAt: deadline }); }
      catch (error) {
        const event = { type: 'operation-poll-error', operationId, at: new Date().toISOString(), message: error?.message || String(error) };
        this.errors.push(event); this.events.push(event); this.#save('driver-state.json', this.#state());
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      const state = this.observeOperation({ operationId, verdict: row.verdict, transport: row.transport, writeSlot: row.writeSlot,
        reasonCode: this.#operationReason(row), targetSettlements: row.targetSettlements || null }, { inFlightDeadlineMs: deadlineMs });
      if (state.terminal && state.drained) return { row, state };
      await sleep(pollMs);
    }
    const pending = this.writeSlots.get(operationId) || null;
    this.#save(`operation-inflight-deadline-${operationId}-${++this.fileSequence}.json`, { operationId, deadlineUtc: new Date(deadline).toISOString(), latest: pending });
    return { row: null, state: { operationId, terminal: this.writeTerminal.has(operationId), businessTerminal: this.writeTerminal.has(operationId), drained: false,
      businessVerdict: this.writeTerminal.get(operationId)?.verdict || null, inFlight: true, overdue: true, latest: pending } };
  }

  async refreshKnownOperations(operationIds = [...this.writeFirstSeen.keys()], { onRisk = null, discoveryDeadlineAt = null } = {}) {
    const results = [];
    const ids = [...new Set(operationIds)];
    for (const id of ids) if (!this.writeDeadline.has(id)) {
      const firstSeen = this.writeFirstSeen.get(id) || new Date().toISOString();
      this.writeFirstSeen.set(id, firstSeen);
      this.writeDeadline.set(id, new Date(Date.parse(firstSeen) + 90000).toISOString());
    }
    const pending = ids.filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id));
    const soonestDeadline = pending.length ? Math.min(...pending.map(id => Date.parse(this.writeDeadline.get(id)))) : Date.now() + 15000;
    const fallbackDiscoveryDeadline = soonestDeadline > Date.now() ? soonestDeadline : Date.now() + 2000;
    const discoveryDeadline = Math.min(discoveryDeadlineAt || fallbackDiscoveryDeadline, fallbackDiscoveryDeadline);
    const fullScan = this.discoveryScannedGeneration !== this.contextGeneration;
    let discovery = { discovered: [], observed: [], risks: [], pages: 0, hasMore: true, complete: false,
      identityReadFailures: 0, identityMismatches: 0 }, discoveryError = null;
    let contextFollow = { accepted: false, reason: 'NOT_REFRESHED' };
    try {
      const account = await this.request('GET', `/api/local/accounts/${this.accountId}`, undefined,
        { timeoutMs: 10000, deadlineAt: discoveryDeadline });
      const observation = await this.request('GET', `/api/local/accounts/${this.accountId}/observations`, undefined,
        { timeoutMs: 15000, deadlineAt: discoveryDeadline });
      const context = this.#observedContext(account, observation);
      contextFollow = this.#adoptObservedExecutionContext(account, observation);
      this.#save(`discovery-current-context-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(),
        account, context: context || null, contextFollow });
      if (!contextFollow.accepted) {
        if (this.discoveryWaitGeneration !== this.contextGeneration || !this.discoveryWaitDeadlineAt) {
          this.discoveryWaitGeneration = this.contextGeneration;
          this.discoveryWaitDeadlineAt = Date.now() + 90000;
        }
        this.discoveryContextPending = { reason: contextFollow.reason || 'EXECUTION_CONTEXT_PENDING', context: context || null,
          deadlineUtc: new Date(this.discoveryWaitDeadlineAt).toISOString() };
      }
      else this.discoveryContextPending = null;
      if (this.currentExecutionContext) discovery = await this.discoverWrites({ fullScan, onRisk,
        deadlineAt: Math.min(discoveryDeadline, this.discoveryWaitDeadlineAt || discoveryDeadline) });
      else discovery = { ...discovery, complete: false, error: 'VERIFIED_EXECUTION_CONTEXT_UNAVAILABLE' };
    }
    catch (error) {
      discoveryError = error?.message || String(error);
      this.errors.push({ type: 'write-discovery-error', at: new Date().toISOString(), message: discoveryError });
      this.latestDiscovery = { ...(this.latestDiscovery || {}), complete: false, hasMore: true, error: discoveryError };
      this.#save('driver-state.json', this.#state());
    }
    for (const id of [...discovery.observed, ...discovery.discovered, ...discovery.risks]) {
      if (!ids.includes(id)) ids.push(id);
      if (!this.writeDeadline.has(id)) {
        const firstSeen = this.writeFirstSeen.get(id) || new Date().toISOString();
        this.writeFirstSeen.set(id, firstSeen);
        this.writeDeadline.set(id, new Date(Date.parse(firstSeen) + 90000).toISOString());
      }
    }
    const terminalIds = ids.filter(id => this.writeTerminal.has(id));
    for (const operationId of terminalIds) {
      let terminalResult = this.writeTerminal.get(operationId), detail = this.verifiedCurrentRunOperations.get(operationId) || null;
      if (!this.#operationDrained(operationId) || ['unknown', 'rejected'].includes(terminalResult.verdict) && !terminalResult.reasonCode) {
        try {
          detail = await this.#verifyCurrentRunOperation(operationId, discoveryDeadlineAt || Date.now() + 2000);
          if (detail) {
            this.unresolvedWriteIds.delete(operationId);
            this.observeOperation({ operationId, verdict: detail.verdict, transport: detail.transport, writeSlot: detail.writeSlot,
              reasonCode: this.#operationReason(detail), targetSettlements: detail.targetSettlements || null });
            terminalResult = this.writeTerminal.get(operationId) || terminalResult;
          } else this.unresolvedWriteIds.add(operationId);
        } catch (error) {
          this.unresolvedWriteIds.add(operationId);
          this.errors.push({ type: 'terminal-detail-read-error', operationId, at: new Date().toISOString(), message: error?.message || String(error) });
        }
      }
      results.push({ operationId, terminal: true, businessTerminal: true, drained: this.#operationDrained(operationId), latest: this.writeSlots.get(operationId), terminalResult, detail,
        auditProjectionEvidence: this.operationAuditSnapshots.get(operationId) || null });
      if (['unknown', 'rejected'].includes(terminalResult.verdict)) await this.#handleWriteRisk(operationId,
        { ...terminalResult, detail }, onRisk);
    }
    const pendingIds = ids.filter(id => !this.writeTerminal.has(id)).sort((a, b) =>
      Date.parse(this.writeDeadline.get(a) || '') - Date.parse(this.writeDeadline.get(b) || ''));
    for (let index = 0; index < pendingIds.length; index += 1) {
      const operationId = pendingIds[index];
      const deadline = Date.parse(this.writeDeadline.get(operationId));
      if (Date.now() >= deadline) {
        results.push({ operationId, terminal: false, overdue: true, latest: this.writeSlots.get(operationId) || null });
        continue;
      }
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const queryBudgetMs = Math.max(1, Math.min(2500, Math.floor(remaining / (pendingIds.length - index))));
        const queryDeadline = Math.min(deadline, Date.now() + queryBudgetMs);
        const row = await this.request('GET', `/api/local/accounts/${this.accountId}/writes/${operationId}`, undefined,
          { timeoutMs: queryBudgetMs, deadlineAt: queryDeadline });
        const state = this.observeOperation({ operationId, verdict: row.verdict, transport: row.transport, writeSlot: row.writeSlot,
          reasonCode: this.#operationReason(row), targetSettlements: row.targetSettlements || null });
        const knownOriginal = this.verifiedCurrentRunOperations.get(operationId);
        const integrity = row.originalIntegrity;
        const sameVerifiedOriginal = knownOriginal && row.originalFingerprint === knownOriginal.originalFingerprint &&
          integrity?.storedFingerprintVerified === true && integrity?.complete === true && integrity?.hashContract === 'backend-ledger-json/v1' &&
          integrity.projectionFingerprint === knownOriginal.originalFingerprint;
        if (sameVerifiedOriginal && row.auditProjection && typeof row.auditProjection === 'object') this.operationAuditSnapshots.set(operationId, {
          originalFingerprint: row.originalFingerprint, capturedAtUtc: new Date().toISOString(),
          observedTerminalConfirmed: state.terminal && row.verdict === 'confirmed', projection: row.auditProjection });
        results.push({ operationId, terminal: state.terminal, businessTerminal: state.businessTerminal, drained: state.drained,
          overdue: state.overdue, latest: state.latest, row,
          auditProjectionEvidence: this.operationAuditSnapshots.get(operationId) || null });
        if (state.terminal && ['unknown', 'rejected'].includes(row.verdict)) await this.#handleWriteRisk(operationId,
          { verdict: row.verdict, reasonCode: state.latest?.reasonCode || null,
            targetSettlements: row.targetSettlements || null, detail: row }, onRisk);
      } catch (error) {
        const event = { type: 'operation-poll-error', operationId, at: new Date().toISOString(), message: error?.message || String(error) };
        this.errors.push(event); this.events.push(event); this.#save('driver-state.json', this.#state());
        results.push({ operationId, terminal: false, overdue: Date.now() >= deadline, latest: this.writeSlots.get(operationId) || null, error: event.message });
      }
    }
    const allPendingIds = [...new Set([...ids.filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id)), ...this.unresolvedWriteIds])];
    const complete = discovery.complete === true && allPendingIds.length === 0;
    const outcomeById = new Map();
    for (const result of results) {
      const detail = result.detail || result.row || null;
      if (detail?.operationId) outcomeById.set(detail.operationId, result.auditProjectionEvidence || null);
    }
    const terminalConfirmedIds = [...ids].filter(id => this.writeTerminal.get(id)?.verdict === 'confirmed');
    const missingAuditIds = terminalConfirmedIds.filter(id => !outcomeById.get(id));
    const notRefreshedAuditIds = terminalConfirmedIds.filter(id => outcomeById.get(id)?.observedTerminalConfirmed !== true);
    const incompleteAuditIds = terminalConfirmedIds.filter(id => outcomeById.get(id)?.projection?.complete !== true);
    const notConfirmedIds = [...ids].filter(id => this.writeTerminal.has(id) && this.writeTerminal.get(id)?.verdict !== 'confirmed');
    const acceptance = {
      terminalDrainComplete: complete,
      operationVerdicts: { confirmed: terminalConfirmedIds, nonConfirmed: notConfirmedIds,
        pending: allPendingIds, slotDrainPending: [...ids].filter(id => this.writeTerminal.has(id) && !this.#operationDrained(id)),
        complete: complete && allPendingIds.length === 0 },
      auditProjection: { applicable: terminalConfirmedIds.length > 0,
        complete: terminalConfirmedIds.length > 0 && missingAuditIds.length === 0 && notRefreshedAuditIds.length === 0 && incompleteAuditIds.length === 0,
        missingOperationIds: missingAuditIds, notRefreshedForTerminalOperationIds: notRefreshedAuditIds,
        incompleteOperationIds: incompleteAuditIds,
        snapshots: Object.fromEntries(terminalConfirmedIds.filter(id => outcomeById.has(id)).map(id => [id, outcomeById.get(id)])) },
      businessAcceptance: { assessed: false, accepted: false, reason: 'PRODUCT_ACCEPTANCE_REQUIRES_SEPARATE_REVIEW' },
    };
    this.#save(`known-operations-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), discoveryError, contextFollow,
      discoveryPages: discovery.pages, discoveryHasMore: discovery.hasMore, results,
      complete, pendingIds: allPendingIds, contextPending: this.discoveryContextPending,
      writeAdmissionBlocked: this.writeAdmissionBlocked, acceptance });
    return { results, complete, pendingIds: allPendingIds, discovery: this.latestDiscovery, contextFollow,
      contextPending: this.discoveryContextPending, acceptance };
  }

  async waitForKnownOperations({ operationIds = [...this.writeFirstSeen.keys()], pollMs = this.pollIntervalMs, onRisk = null } = {}) {
    const ids = new Set(operationIds);
    for (const id of ids) if (!this.writeDeadline.has(id)) {
      const firstSeen = this.writeFirstSeen.get(id) || new Date().toISOString();
      this.writeFirstSeen.set(id, firstSeen);
      this.writeDeadline.set(id, new Date(Date.parse(firstSeen) + 90000).toISOString());
    }
    this.#save('driver-state.json', this.#state());
    let cycle = 0, results = [], waitDeadlineAt = Date.now() + 90000;
    while (true) {
      const pendingIdsNow = [...new Set([...ids].filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id)).concat([...this.unresolvedWriteIds]))];
      const pendingDeadlines = pendingIdsNow.map(id => Date.parse(this.writeDeadline.get(id) || '')).filter(Number.isFinite);
      const earliestOperationDeadline = pendingDeadlines.length ? Math.min(...pendingDeadlines) : waitDeadlineAt;
      const discoveryDeadlineAt = Math.min(waitDeadlineAt, earliestOperationDeadline);
      results = await this.refreshKnownOperations([...ids], { onRisk, discoveryDeadlineAt });
      for (const result of results.results || []) ids.add(result.operationId);
      const allKnownDrained = [...ids].every(id => this.writeTerminal.has(id) && this.#operationDrained(id));
      if (allKnownDrained && this.latestDiscovery?.complete && this.unresolvedWriteIds.size === 0 && (!this.writeAdmissionBlocked || this.rackFenceComplete))
        return { results: results.results || [], complete: true, pendingIds: [], discovery: this.latestDiscovery,
          acceptance: results.acceptance || null };
      const pendingIds = [...new Set([...ids].filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id)).concat([...this.unresolvedWriteIds]))];
      if (Date.now() >= discoveryDeadlineAt && (pendingIds.length || !this.latestDiscovery?.complete)) {
        const incomplete = { complete: false, results: results.results || [], pendingIds,
          discovery: this.latestDiscovery, contextPending: this.discoveryContextPending,
          deadlineUtc: new Date(discoveryDeadlineAt).toISOString(), reason: 'OPERATION_OR_CONTEXT_DISCOVERY_INCOMPLETE',
          acceptance: results.acceptance || null };
        this.#save(`known-operations-incomplete-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), ...incomplete });
        return incomplete;
      }
      const nextDeadline = Math.min(...[...ids].filter(id => !this.writeTerminal.has(id) || !this.#operationDrained(id))
        .concat([...this.unresolvedWriteIds]).map(id => Date.parse(this.writeDeadline.get(id) || ''))
        .filter(deadline => Number.isFinite(deadline) && deadline > Date.now()));
      if (Number.isFinite(nextDeadline)) await sleep(Math.min(pollMs, nextDeadline - Date.now()));
      else if (!this.latestDiscovery?.complete || this.writeAdmissionBlocked && !this.rackFenceComplete) await sleep(Math.min(pollMs, Math.max(1, discoveryDeadlineAt - Date.now())));
      else break;
      cycle += 1;
    }
    this.#save(`known-operations-deadline-${++cycle}-${++this.fileSequence}.json`, { capturedUtc: new Date().toISOString(), results,
      discovery: this.latestDiscovery, writeAdmissionBlocked: this.writeAdmissionBlocked });
    return { results: results.results || [], complete: false, pendingIds: [], discovery: this.latestDiscovery,
      reason: 'KNOWN_OPERATION_SCAN_DID_NOT_COMPLETE', acceptance: results.acceptance || null };
  }

  async stopAndRestore({ allAccountIds = [1, 3, 4], stopDeadlineMs = 60000 } = {}) {
    if (!this.started) {
      if (!this.originalConfig) return { stopped: true, restored: false, stop: null };
      const account = await this.request('GET', `/api/local/accounts/${this.accountId}`);
      if (account.account?.uid !== this.officialUid || account.account?.state !== 'stopped' || account.account?.running !== false || account.account?.desiredRunning !== false)
        throw new Error('PRESTART_RESTORE_REQUIRES_MATCHING_STOPPED_ACCOUNT');
      const before = await this.request('GET', `/api/local/accounts/${this.accountId}/config`);
      let restore = null;
      if (JSON.stringify(before.config) !== JSON.stringify(this.originalConfig)) {
        restore = await this.request('PUT', `/api/local/accounts/${this.accountId}/config`,
          { ...this.originalConfig, expectedRevision: before.application.savedRevision });
      }
      const check = await this.request('GET', `/api/local/accounts/${this.accountId}/config`);
      this.restored = JSON.stringify(check.config) === JSON.stringify(this.originalConfig);
      this.#save('prestart-restore-readback.json', check);
      if (!this.restored) throw new Error('PRESTART_FULL_CONFIG_RESTORE_MISMATCH');
      return { stopped: true, restored: true, restore, stop: null };
    }
    if (this.connection) { this.connection.close(); this.connection = null; }
    this.stopConnection = this.#connect('fresh-forward-stop-finally');
    let stop;
    try { stop = await this.request('POST', `/api/local/accounts/${this.accountId}/stop`, {}, { label: 'stop' }); }
    catch (error) {
      this.#save('stop-response-unconfirmed.json', { capturedUtc: new Date().toISOString(), error: error?.message || String(error),
        stopMayHaveBeenSent: true, cleanupProofAvailable: false, restoreAllowed: false });
      try {
        if (this.stopConnection) { this.stopConnection.close(); this.stopConnection = null; }
        const status = await this.request('GET', `/api/local/accounts/${this.accountId}`, undefined, { label: 'stop' });
        this.#save('stop-state-after-unconfirmed-response.json', status);
      } catch (readError) {
        this.#save('stop-state-after-unconfirmed-response-error.json', { capturedUtc: new Date().toISOString(),
          error: readError?.message || String(readError), cleanupProofAvailable: false, restoreAllowed: false });
      }
      throw new Error('STOP_RESPONSE_UNCONFIRMED; fresh read only; cleanup proof missing; configuration was not restored');
    }
    this.stopCommitted = stop.stopCommitted === true;
    this.#save('stop-response.json', stop);
    const deadline = Date.now() + stopDeadlineMs;
    let stopped = false;
    while (Date.now() < deadline) {
      const account = await this.request('GET', `/api/local/accounts/${this.accountId}`, undefined, { label: 'stop' });
      this.#save('stop-state-latest.json', account);
      if (account.account?.uid !== this.officialUid) throw new Error('STOPPED_ACCOUNT_UID_CHANGED');
      if (account.account?.state === 'stopped' && account.account?.running === false && account.account?.desiredRunning === false) { stopped = true; break; }
      await sleep(500);
    }
    if (!stopped) throw new Error('STOPPED_STATE_DEADLINE');
    const cleanupProof = { cleanupComplete: stop.cleanupComplete === true, transportClosed: stop.transportClosed === true,
      newWritesFenced: stop.newWritesFenced === true, writeDrainComplete: stop.writeDrainComplete === true,
      actualStopped: stopped, stopCommitted: stop.stopCommitted === true };
    this.#save('cleanup-proof-before-restore.json', cleanupProof);
    if (!Object.values(cleanupProof).every(Boolean)) throw new Error('STOP_CLEANUP_PROOF_INCOMPLETE; configuration was not restored');
    let restore = null;
    if (this.originalConfig) {
      const before = await this.request('GET', `/api/local/accounts/${this.accountId}/config`, undefined, { label: 'stop' });
      if (JSON.stringify(before.config) !== JSON.stringify(this.originalConfig)) {
        restore = await this.request('PUT', `/api/local/accounts/${this.accountId}/config`,
          { ...this.originalConfig, expectedRevision: before.application.savedRevision }, { label: 'stop' });
        this.#save('restore-put.json', restore);
      }
      const check = await this.request('GET', `/api/local/accounts/${this.accountId}/config`, undefined, { label: 'stop' });
      this.restored = JSON.stringify(check.config) === JSON.stringify(this.originalConfig);
      this.#save('restore-readback.json', check);
      if (!this.restored) throw new Error('FULL_CONFIG_RESTORE_MISMATCH');
    }
    const all = { capturedUtc: new Date().toISOString(), status: await this.request('GET', '/api/local/status', undefined, { label: 'stop' }), accounts: [] };
    for (const id of allAccountIds) {
      const account = await this.request('GET', `/api/local/accounts/${id}`, undefined, { label: 'stop' });
      const config = await this.request('GET', `/api/local/accounts/${id}/config`, undefined, { label: 'stop' });
      all.accounts.push({ id, account, config });
      this.#save(`final-account-${id}.json`, account);
      this.#save(`final-config-${id}.json`, config);
    }
    this.#save('all-accounts-final.json', all);
    const finalChecks = all.accounts.map(({ id, account, config }) => {
      const baseline = this.accountBaselines.get(id);
      return { id, uidMatches: baseline ? account.account?.uid === baseline.uid : null,
        stopped: account.account?.state === 'stopped' && account.account?.running === false && account.account?.desiredRunning === false,
        configRestored: baseline ? JSON.stringify(config.config) === JSON.stringify(baseline.config) : null };
    });
    const finalVerified = finalChecks.length === allAccountIds.length && finalChecks.every(check =>
      check.uidMatches === true && check.stopped && check.configRestored === true);
    this.#save('all-accounts-final-checks.json', { capturedUtc: new Date().toISOString(), checks: finalChecks, verified: finalVerified });
    this.stopConnection.close(); this.stopConnection = null;
    const result = { stop, stopped, restored: this.restored, restore, cleanupComplete: stop.cleanupComplete === true,
      transportClosed: stop.transportClosed === true, newWritesFenced: stop.newWritesFenced === true,
      writeDrainComplete: stop.writeDrainComplete === true, stopCommitted: stop.stopCommitted === true, finalVerified, finalChecks };
    this.#save('cleanup-summary.json', result);
    if (!finalVerified) throw new Error('FINAL_ALL_ACCOUNT_STOP_OR_CONFIG_CHECK_FAILED');
    return result;
  }

  async close() {
    if (this.connection) { this.connection.close(); this.connection = null; }
    if (this.stopConnection) { this.stopConnection.close(); this.stopConnection = null; }
  }
}

export function makeUniqueEvidenceDirectory(parent, name) {
  if (!path.isAbsolute(parent) || !/^[a-z0-9][a-z0-9-]{2,80}$/i.test(name)) throw new TypeError('Evidence path and name must be explicit and safe.');
  const target = path.resolve(parent, name);
  if (fs.existsSync(target)) throw new Error('Evidence attempt already exists.');
  fs.mkdirSync(target, { recursive: false });
  return target;
}
