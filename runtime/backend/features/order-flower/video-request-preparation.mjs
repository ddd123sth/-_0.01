import { canonical, clone, fingerprint, freeze } from '../../common.mjs';
import { performance } from 'node:perf_hooks';
import { orderFlowerContext, orderFlowerContextKey } from './wire-facts.mjs';
import { assertOrderFlowerVideoProposal } from './video-contract.mjs';

const sync = value => {
  if (value?.then) { value.catch?.(() => {}); throw new TypeError('Video request preparation guards must be synchronous'); }
  return value;
};
const safeCode = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code || '') ? error.code : 'ORDER_VIDEO_REQUEST_PREPARATION_FAILED';
const waiting = reasonCode => freeze({ state: 'waiting-facts', reasonCode });

// A bounded, process-local continuation of one ORIGINAL request preparation. It
// owns no sender and persists no token or response body. A result is
// useful only while its original actor, source facts and saved intent remain
// current; the gateway must still perform both normal admission boundaries.
export function createOrderFlowerVideoRequestPreparation({ videoRequestProvider = null, isCurrent, validateOriginal, validateRequestAdmission = null,
  appendOutbox, notify, maxEntries = 8, deadlineMs = 120000 } = {}) {
  for (const fn of [isCurrent, validateOriginal, appendOutbox, notify]) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') throw new TypeError('Video request preparation requires finite synchronous guard/event ports');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) throw new TypeError('Video request preparation queue must be bounded');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 300000) throw new TypeError('Video request preparation deadline must be between 1000 and 300000 milliseconds');
  const available = typeof videoRequestProvider?.complete === 'function' && typeof videoRequestProvider?.validateCapability === 'function' &&
    videoRequestProvider.validateCapability.constructor?.name !== 'AsyncFunction';
  const maxRetainedEntries = 256;
  const entries = new Map(), revoked = new Set();
  let closed = false;

  function current(context) {
    return !closed && !revoked.has(orderFlowerContextKey(context)) && sync(isCurrent(context)) === true;
  }
  function originalCurrent(entry, phase) {
    if (expire(entry)) return false;
    return !entry.controller.signal.aborted && current(entry.context) &&
      sync(validateOriginal({ proposal: entry.proposal, phase })) === true;
  }
  function clearDeadline(entry) {
    clearTimeout(entry.deadlineTimer); entry.deadlineTimer = null;
  }
  function discard(entry, reasonCode) {
    clearDeadline(entry);
    // A provider may ignore abort and resolve/reject much later. Preserve the
    // original terminal timeout/stop reason and never revive its proposal.
    if (entry.controller.signal.aborted && entry.state === 'waiting-facts') return;
    entry.controller.abort(reasonCode);
    entry.state = 'waiting-facts'; entry.reasonCode = reasonCode;
    // Tombstone the opportunity for this actor so each timer tick cannot start
    // another request after an ambiguous provider failure or revoked context.
    entry.proposal = null;
  }
  function expire(entry) {
    if (entry.state !== 'pending' || performance.now() < entry.deadlineAt) return false;
    discard(entry, 'ORDER_VIDEO_REQUEST_PREPARATION_DEADLINE_EXCEEDED');
    try { publish(entry, entry.reasonCode); } catch { /* Deadline notification cannot escape into the account loop. */ }
    return true;
  }
  function armDeadline(entry) {
    clearDeadline(entry);
    if (entry.state !== 'pending' || expire(entry)) return;
    // The timer requests a check; only actual process-monotonic elapsed time
    // expires a preparation. No official clock, day or server fact is changed.
    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      if (!expire(entry) && entry.state === 'pending') armDeadline(entry);
    }, Math.max(1, Math.ceil(entry.deadlineAt - performance.now())));
    entry.deadlineTimer.unref?.();
  }
  function sweep() {
    for (const [key, entry] of entries) {
      let active = false;
      try { active = current(entry.context); } catch { /* Current ownership must be proven. */ }
      if (!active) { discard(entry, 'ORDER_VIDEO_PREPARATION_CONTEXT_REVOKED'); entries.delete(key); }
      else expire(entry);
    }
  }
  function capacity(context = null) {
    const scoped = context ? canonical(context) : null;
    const result = { active: 0, retained: 0, terminal: 0 };
    for (const entry of entries.values()) {
      if (scoped !== null && canonical(entry.context) !== scoped) continue;
      result.retained += 1;
      if (['pending', 'completed'].includes(entry.state)) result.active += 1;
      else result.terminal += 1;
    }
    return result;
  }
  function publish(entry, reasonCode) {
    if (!current(entry.context)) return;
    appendOutbox({ ownerRef: entry.context.ownerRef, subjectRef: entry.context.subjectRef, eventType: 'FactsChanged',
      eventKey: 'order-video-preparation:' + entry.operationId + ':' + entry.state,
      payload: { domain: 'order-flower', operationId: entry.operationId, semanticKey: entry.semanticKey,
        connectionEpoch: entry.context.connectionEpoch, reasonCode, state: entry.state } });
    notify(clone(entry.context));
  }
  function abortableCompletion(entry, completion) {
    const signal = entry.controller.signal;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(Object.assign(new Error('Original request preparation was aborted'), { code: 'ORDER_VIDEO_PREPARATION_ABORTED' }));
      signal.addEventListener('abort', aborted, { once: true });
      // Both continuations are installed even if the provider ignores abort.
      // Their late result only settles an already-aborted local promise; it
      // cannot resume a preparation that timed out, stopped or shut down.
      Promise.resolve(completion).then(result => {
        signal.removeEventListener('abort', aborted); resolve(result);
      }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) { signal.removeEventListener('abort', aborted); aborted(); }
    });
  }
  async function complete(entry) {
    try {
      if (!originalCurrent(entry, 'before-request-start')) { discard(entry, 'ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED'); return; }
      const original = entry.proposal, preparation = original.orderFlowerVideo;
      const completed = await abortableCompletion(entry, videoRequestProvider.complete({ context: clone(entry.context), officialUid: preparation.officialUid,
        operationId: original.operationId, semanticKey: original.semanticKey, targets: clone(original.targets),
        shareId: preparation.publicArgs.shareId, adSlotTag: preparation.adSlotTag, configRevision: original.configRevision,
        featureCancelEpoch: original.featureCancelEpoch, preparation: clone(preparation),
        isOriginalCurrent: () => originalCurrent(entry, 'request-current-boundary'),
        isRequestAdmissionCurrent: () => typeof validateRequestAdmission === 'function' &&
          sync(validateRequestAdmission({ proposal: original })) === true, signal: entry.controller.signal }));
      if (!originalCurrent(entry, 'after-request-preparation')) { discard(entry, 'ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED'); return; }
      if (!completed?.capability || !completed?.params) { discard(entry, 'ORDER_VIDEO_REQUEST_PREPARATION_UNAVAILABLE'); publish(entry, entry.reasonCode); return; }
      const proposal = clone(original);
      proposal.params = clone(completed.params);
      proposal.paramsFingerprint = fingerprint(proposal.params);
      proposal.orderFlowerVideo.capability = clone(completed.capability);
      proposal.orderFlowerVideo.wireArgsFingerprint = proposal.paramsFingerprint;
      assertOrderFlowerVideoProposal(proposal);
      if (proposal.orderFlowerVideo.capability.kind !== 'legacy-api-request' ||
        sync(videoRequestProvider.validateCapability({ proposal, capability: proposal.orderFlowerVideo.capability, phase: 'after-request-preparation' })) !== true) {
        discard(entry, 'ORDER_VIDEO_REQUEST_PREPARATION_UNAVAILABLE'); publish(entry, entry.reasonCode); return;
      }
      entry.proposal = freeze(proposal);
      if (!originalCurrent(entry, 'before-request-ready-event')) { discard(entry, 'ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED'); return; }
      clearDeadline(entry);
      entry.state = 'completed'; entry.reasonCode = null;
      publish(entry, 'ORDER_VIDEO_LEGACY_API_REQUEST_READY');
    } catch (error) {
      const reasonCode = entry.controller.signal.aborted ? 'ORDER_VIDEO_PREPARATION_ABORTED' : safeCode(error);
      discard(entry, reasonCode);
      try { publish(entry, entry.reasonCode); } catch { /* No async exception can break account assessment. */ }
    } finally {
      if (entry.state !== 'pending') clearDeadline(entry);
    }
  }
  function readOrStart({ proposal } = {}) {
    try {
      const context = orderFlowerContext(proposal), preparation = proposal?.orderFlowerVideo, target = proposal?.targets?.[0];
      if (!context || !current(context)) return waiting('ORDER_VIDEO_PREPARATION_CONTEXT_REVOKED');
      if (!available) return waiting('ORDER_VIDEO_REQUEST_PROVIDER_UNAVAILABLE');
      if (!preparation || !target || !proposal.operationId || preparation.lifecycleRef !== target.lifecycleRef ||
        typeof proposal.semanticKey !== 'string' || proposal.targets.length !== 1) return waiting('ORDER_VIDEO_PREPARATION_TARGET_INVALID');
      sweep();
      const key = fingerprint([context, proposal.semanticKey, target.targetRef, target.lifecycleRef]);
      const found = entries.get(key);
      if (found) {
        if (['pending', 'completed'].includes(found.state) && !originalCurrent(found, 'before-request-queue-read')) {
          discard(found, 'ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED'); return waiting(found.reasonCode);
        }
        if (found.state !== 'completed') return waiting(found.reasonCode || 'ORDER_VIDEO_REQUEST_PREPARATION_PENDING');
        if (!originalCurrent(found, 'before-request-ready-transfer')) { discard(found, 'ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED'); return waiting(found.reasonCode); }
        // Return the ORIGINAL operation exactly once; later ticks cannot mint
        // another operation from the same completed callback or token.
        const ready = found.proposal;
        found.proposal = null; found.state = 'transferred'; found.reasonCode = 'ORDER_VIDEO_ORIGINAL_COMPLETION_ALREADY_TRANSFERRED';
        return { state: 'completed', reasonCode: null, proposal: ready };
      }
      if (entries.size >= maxRetainedEntries) return waiting('ORDER_VIDEO_PREPARATION_RETENTION_FULL');
      const active = capacity().active;
      if (active >= maxEntries) return waiting('ORDER_VIDEO_PREPARATION_QUEUE_FULL');
      const entry = { key, context, operationId: proposal.operationId, semanticKey: proposal.semanticKey, proposal: freeze(clone(proposal)),
        controller: new AbortController(), state: 'pending', reasonCode: 'ORDER_VIDEO_REQUEST_PREPARATION_PENDING',
        deadlineAt: performance.now() + deadlineMs, deadlineTimer: null };
      if (!originalCurrent(entry, 'before-request-queue')) return waiting('ORDER_VIDEO_PREPARATION_ORIGINAL_REVOKED');
      entries.set(key, entry);
      armDeadline(entry);
      // The scheduler does not await admission. This promise owns its error
      // handler before the request provider can throw or reject.
      void Promise.resolve().then(() => complete(entry)).catch(() => discard(entry, 'ORDER_VIDEO_REQUEST_PREPARATION_FAILED'));
      return waiting(entry.reasonCode);
    } catch (error) { return waiting(safeCode(error)); }
  }
  function stop(rawContext) {
    const context = orderFlowerContext(rawContext);
    if (!context) return;
    const key = orderFlowerContextKey(context);
    revoked.add(key);
    // Revocation is additionally enforced by the authoritative actor port;
    // keeping recent keys bounded avoids a process-lifetime memory journal.
    if (revoked.size > 64) revoked.delete(revoked.values().next().value);
    for (const [entryKey, entry] of entries) if (canonical(entry.context) === canonical(context)) {
      discard(entry, 'ORDER_VIDEO_PREPARATION_STOPPED'); entries.delete(entryKey);
    }
  }
  function shutdown() {
    closed = true;
    for (const entry of entries.values()) discard(entry, 'ORDER_VIDEO_PREPARATION_SHUTDOWN');
    entries.clear(); revoked.clear();
  }
  function status(context) {
    const current = context ? capacity(context) : { active: 0, retained: 0, terminal: 0 };
    return freeze({ current: { ...current, activeLimit: maxEntries, retainedLimit: maxRetainedEntries },
      global: { ...capacity(), activeLimit: maxEntries, retainedLimit: maxRetainedEntries } });
  }
  return Object.freeze({ readOrStart, stop, shutdown, status });
}
