import { canonical, clone, fingerprint, freeze, parseStored, plainObject } from '../../common.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';

export const SPECIAL_ORDER_METHODS = Object.freeze({
  palace: Object.freeze(['orderPalace.enter', 'orderPalace.finishOrder']),
  team: Object.freeze(['orderTeam.takeOrder', 'orderTeam.submitOrder', 'orderTeam.recvRwd', 'orderTeam.takeStoredOrder']),
});
const AXES = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
const same = (a, b) => a && b && AXES.every(key => key === 'accountRef' ? String(a[key]) === String(b[key]) : a[key] === b[key]);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
// The middle wire component identifies the socket, not the durable connection
// epoch. Bind the latter independently; the final component is the RPC sequence.
const matchedWire = observation => typeof observation?.wireKey === 'string' && /^ws\|[1-9]\d*\|[1-9]\d*$/.test(observation.wireKey) &&
  Number(observation.wireKey.split('|').at(-1)) === observation.requestSequence;
const has = (object, name, index) => Object.hasOwn(object, name) || Object.hasOwn(object, index);
const get = (object, name, index) => Object.hasOwn(object, name) ? object[name] : object[index];
const numMap = value => plainObject(value) && Object.keys(value).length <= 256 && Object.entries(value)
  .every(([key, amount]) => /^[1-9]\d{0,8}$/.test(key) && nonnegative(amount));
const storedOrders = value => Array.isArray(value) && value.length <= 64 && value.every(row => plainObject(row) &&
  positive(get(row, 'npcId', '0')) && officialDateMs(get(row, 'expireTime', '1')) !== null);
const DEFINITIONS = Object.freeze({
  palace: Object.freeze({ sync: ['orderPalaceTot', '108'], member: 'orderPalace', fields: [
    ['uid', '0', positive], ['flowerId', '1', nonnegative], ['num', '2', nonnegative],
    ['isFinish', '3', value => [0, 1, false, true].includes(value)],
    ['lTime', '4', 'date'], ['uTime', '5', 'date'], ['cTime', '6', 'date']] }),
  team: Object.freeze({ sync: ['orderTeamTot', '107'], member: 'orderTeam', fields: [
    ['uid', '0', positive], ['status', '1', value => Number.isSafeInteger(value) && value >= 0 && value <= 3],
    ['startTime', '2', 'date'], ['orderNum', '3', nonnegative], ['flowerId', '4', nonnegative], ['rwd', '5', numMap],
    ['remainingNum', '6', nonnegative], ['refreshNotCnt', '7', nonnegative], ['uTime', '8', 'date'],
    ['cTime', '9', 'date'], ['activeTime', '10', 'date'], ['activeCnt', '11', nonnegative],
    ['activeFlowerOrderNum', '12', nonnegative], ['rTime', '13', 'date'], ['npcId', '14', nonnegative],
    ['storedOrders', '15', storedOrders], ['highCntMap', '16', numMap]] }),
});

// There is one replaceable head per stable subject and order family. Proposal
// originals retain the full admitted snapshot; this table is not another log.
export function createSpecialOrderFacts({ store, isCurrent, officialUidForContext } = {}) {
  for (const port of [store?.get, store?.run, store?.transaction, isCurrent, officialUidForContext])
    if (typeof port !== 'function') throw new TypeError('Special orders require current bounded fact ports');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_special_order_heads(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('palace','team')),
    frame_json TEXT NOT NULL,frame_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,kind))`);
  const observations = new Map();

  function ingest({ context, observation } = {}) {
    const uid = officialUidForContext(context);
    if (context?.subjectRef && ['index.login','orderPalace.enter',...SPECIAL_ORDER_METHODS.team].includes(observation?.method)) {
      const checks = { current: isCurrent(context) === true, identityKnown: positive(uid), response: observation.source === 'response',
        answered: observation.transport === 'answered', envelope: observation.envelopeOk === true,
        syncData: observation.dsName === 'G.ISyncData', epoch: observation.connectionEpoch === context.connectionEpoch,
        wire: matchedWire(observation),
        clock: nonnegative(observation.receivedDeviceMs), value: plainObject(observation.value) };
      observations.delete(context.subjectRef);
      observations.set(context.subjectRef, { context: clone(context), method: observation.method, responseRef: observation.responseRef,
        checks, branches: Object.fromEntries(Object.entries(DEFINITIONS).map(([kind, definition]) => {
          const total = plainObject(observation.value) ? get(observation.value, ...definition.sync) : null,
            raw = plainObject(total) ? get(total, definition.member, '0') : null;
          return [kind, { provided: plainObject(raw), uidProvided: plainObject(raw) && has(raw,'uid','0'),
            uidMatches: plainObject(raw) && get(raw,'uid','0') === uid }];
        })) });
      while (observations.size > 64) observations.delete(observations.keys().next().value);
    }
    if (!context || !isCurrent(context) || !positive(uid) || observation?.source !== 'response' ||
        observation.transport !== 'answered' || observation.envelopeOk !== true || observation.dsName !== 'G.ISyncData' ||
        observation.rejected === true || observation.connectionEpoch !== context.connectionEpoch ||
        typeof observation.responseRef !== 'string' || !observation.responseRef || !positive(observation.requestSequence) ||
        !matchedWire(observation) ||
        !nonnegative(observation.receivedDeviceMs) ||
        !plainObject(observation.value)) return { accepted: false, changed: false, reasonCode: 'SPECIAL_ORDER_SOURCE_NOT_CURRENT' };
    const accepted = [], changed = [];
    store.transaction(() => {
      for (const [kind, definition] of Object.entries(DEFINITIONS)) {
        if (!['index.login', 'usr.heartTick', ...SPECIAL_ORDER_METHODS[kind]].includes(observation.method)) continue;
        const total = get(observation.value, ...definition.sync), raw = plainObject(total) ? get(total, definition.member, '0') : null;
        if (!plainObject(raw)) continue;
        const row = store.get('SELECT frame_json,frame_fingerprint FROM backend_special_order_heads WHERE owner_ref=? AND subject_ref=? AND kind=?',
          context.ownerRef, context.subjectRef, kind);
        const previous = row && parseStored(row.frame_json, 'special-order head');
        const current = previous && fingerprint(previous) === row.frame_fingerprint && same(context, previous.context) ? previous : null;
        if (current && current.source.requestSequence >= observation.requestSequence) continue;
        if (has(raw, 'uid', '0') && get(raw, 'uid', '0') !== uid || !has(raw, 'uid', '0') && current?.fields?.uid?.value !== uid) continue;
        const fields = current ? clone(current.fields) : {};
        const source = { responseRef: observation.responseRef, method: observation.method,
          requestSequence: observation.requestSequence, wireKey: observation.wireKey, connectionEpoch: observation.connectionEpoch,
          receivedDeviceMs: observation.receivedDeviceMs, operationId: observation.operationId ?? null };
        for (const [name, index, validate] of definition.fields) {
          if (!has(raw, name, index)) continue;
          const value = get(raw, name, index), converted = validate === 'date' ? value === null ? null : officialDateMs(value) : value;
          const valid = validate === 'date' ? value === null || converted !== null : validate(value);
          fields[name] = { state: valid ? 'known' : 'unreadable', value: valid ? clone(converted) : null, source };
        }
        const semantic = Object.fromEntries(Object.entries(fields).map(([key, cell]) => [key, { state: cell.state, value: cell.value }]));
        const semanticFingerprint = fingerprint(semantic);
        const frame = { version: 'special-order-facts/v1', kind,
          context: Object.fromEntries(AXES.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]])),
          fields, source, semanticFingerprint };
        store.run(`INSERT INTO backend_special_order_heads VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,kind)
          DO UPDATE SET frame_json=excluded.frame_json,frame_fingerprint=excluded.frame_fingerprint,updated_at=excluded.updated_at`,
        context.ownerRef, context.subjectRef, kind, canonical(frame), fingerprint(frame), store.nowIso());
        accepted.push(kind); if (current?.semanticFingerprint !== semanticFingerprint) changed.push(kind);
      }
    });
    return { accepted: accepted.length > 0, changed: changed.length > 0, kinds: accepted, changedKinds: changed };
  }
  function read(context, kind) {
    if (!Object.hasOwn(DEFINITIONS, kind) || !context || !isCurrent(context)) return { current: false, reasonCode: 'SPECIAL_ORDER_CONTEXT_NOT_CURRENT' };
    const row = store.get('SELECT frame_json,frame_fingerprint FROM backend_special_order_heads WHERE owner_ref=? AND subject_ref=? AND kind=?',
      context.ownerRef, context.subjectRef, kind);
    const frame = row && parseStored(row.frame_json, 'special-order head');
    if (!frame || fingerprint(frame) !== row.frame_fingerprint || !same(context, frame.context) ||
        frame.fields?.uid?.state !== 'known' || frame.fields.uid.value !== officialUidForContext(context))
      return { current: false, reasonCode: 'SPECIAL_ORDER_CURRENT_FACTS_REQUIRED', sourceDiagnostic:
        same(context, observations.get(context.subjectRef)?.context) ? observations.get(context.subjectRef) : null };
    return freeze({ current: true, ...frame, fingerprint: row.frame_fingerprint });
  }
  return Object.freeze({ ingest, read });
}
