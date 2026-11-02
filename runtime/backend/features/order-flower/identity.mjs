import { canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { knownOrderFlowerCell, orderFlowerContext, orderFlowerContextKey, orderFlowerSourceProofValid, sameOrderFlowerContext } from './wire-facts.mjs';
import { orderFlowerContent, orderFlowerLife } from './rpc-contract.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const scalar = value => knownOrderFlowerCell(value) ? value.value : null;
export function currentOrderFlowerRows(view) {
  const resident = view?.fields?.residentMap;
  return [...(resident?.current && knownOrderFlowerCell(resident) && resident.value?.complete === true
    ? resident.value.entries.map(row => ({ row, source: resident.source })) : []),
    ...['satin', 'decorate'].map(kind => ({ row: view?.fields?.[kind], source: view?.fields?.[kind]?.source }))]
    .filter(({ row }) => row?.readable === true && row.current !== false && knownOrderFlowerCell(row));
}
export function orderFlowerPlainRow(row) {
  return Object.fromEntries(Object.entries(row?.value?.fields || {}).map(([key, cell]) => [key, scalar(cell)]));
}

// A source refresh or a local identifier never creates another occurrence.
// A changed cTime must be an actual later server value from a complete login.
// Same-cTime content changes stay ambiguous; an old unknown is never upgraded.
export function createOrderFlowerIdentity({ store, isCurrent, clock }) {
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_lives(
    lifecycle_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,kind TEXT NOT NULL,box_id INTEGER NOT NULL,
    official_uid INTEGER NOT NULL,c_time INTEGER NOT NULL,content_fingerprint TEXT NOT NULL,content_json TEXT NOT NULL,
    prior_lifecycle_ref TEXT,boundary_kind TEXT NOT NULL,identity_known INTEGER NOT NULL,first_source_json TEXT NOT NULL,
    first_source_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL)`);
  store.run(`CREATE TABLE IF NOT EXISTS backend_order_flower_identity_heads(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,kind TEXT NOT NULL,box_id INTEGER NOT NULL,lifecycle_ref TEXT NOT NULL,
    context_json TEXT NOT NULL,source_json TEXT NOT NULL,source_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,kind,box_id))`);
  for (const action of ['UPDATE', 'DELETE']) store.run(`CREATE TRIGGER IF NOT EXISTS backend_order_flower_lives_no_${action.toLowerCase()}
    BEFORE ${action} ON backend_order_flower_lives BEGIN SELECT RAISE(ABORT,'order flower lives are append only'); END`);
  const sourceKnown = (source, context, uid) => source?.kind === 'response' && source.transport === 'answered' &&
    source.method === 'index.login' && source.contextKey === orderFlowerContextKey(context) &&
    source.connectionEpoch === context.connectionEpoch && positive(source.requestSequence) &&
    typeof source.responseRef === 'string' && orderFlowerSourceProofValid(source.version) &&
    source.version.loginResponseRef === source.responseRef && positive(uid);
  function reconcile({ context: supplied, view }) {
    const context = orderFlowerContext(supplied), uid = scalar(view?.identity?.uid);
    if (!context || !isCurrent(context) || !view?.available || !view.current || !sameOrderFlowerContext(context, view.context) ||
        !view.identity.verified || !positive(uid)) return freeze({ current: false, changed: false, identities: [] });
    const observedClock = clock(context.subjectRef);
    if (observedClock?.available !== true || observedClock.source !== 'official-anchor-monotonic' ||
        observedClock.connectionEpoch !== context.connectionEpoch || !Number.isFinite(observedClock.upperBoundMs)) {
      return freeze({ current: true, changed: false, identities: [], reasonCode: 'ORDER_FLOWER_IDENTITY_OFFICIAL_CLOCK_REQUIRED' });
    }
    return store.transaction(() => {
      const identities = [], contextJson = canonical(context); let changed = false;
      for (const { row, source } of currentOrderFlowerRows(view)) {
        if (!sourceKnown(source, context, uid)) continue;
        const { kind, boxId } = row.value, fields = orderFlowerPlainRow(row), content = orderFlowerContent(kind, boxId, fields);
        if (!positive(fields.cTime) || fields.cTime > observedClock.upperBoundMs) continue;
        const contentFingerprint = fingerprint(content), lifecycleRef = orderFlowerLife(context, kind, boxId, fields);
        const head = store.get(`SELECT * FROM backend_order_flower_identity_heads WHERE owner_ref=? AND subject_ref=? AND kind=? AND box_id=?`,
          context.ownerRef, context.subjectRef, kind, boxId);
        const prior = head && store.get('SELECT * FROM backend_order_flower_lives WHERE lifecycle_ref=?', head.lifecycle_ref);
        if (prior && (prior.content_fingerprint !== fingerprint(parseStored(prior.content_json, '鲜花订单原身份内容')) ||
            prior.first_source_fingerprint !== fingerprint(parseStored(prior.first_source_json, '鲜花订单原身份来源')) || prior.official_uid !== uid)) {
          throw problem('ORDER_FLOWER_IDENTITY_INTEGRITY', '鲜花订单原身份或主体来源不一致');
        }
        let life = store.get('SELECT * FROM backend_order_flower_lives WHERE lifecycle_ref=?', lifecycleRef);
        if (!life) {
          const known = !prior || fields.cTime > prior.c_time;
          store.run('INSERT INTO backend_order_flower_lives VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', lifecycleRef,
            context.ownerRef, context.subjectRef, kind, boxId, uid, fields.cTime, contentFingerprint, canonical(content),
            prior?.lifecycle_ref ?? null, !prior ? 'first-complete-login-observation' : known ? 'observed-later-server-generation-time' : 'same-or-older-time-content-ambiguous',
            known ? 1 : 0, canonical(source), fingerprint(source), store.nowIso());
          life = store.get('SELECT * FROM backend_order_flower_lives WHERE lifecycle_ref=?', lifecycleRef); changed = true;
        }
        if (life.owner_ref !== context.ownerRef || life.subject_ref !== context.subjectRef || life.official_uid !== uid ||
            life.content_fingerprint !== contentFingerprint || life.first_source_fingerprint !== fingerprint(parseStored(life.first_source_json, '订单身份来源'))) {
          throw problem('ORDER_FLOWER_IDENTITY_COLLISION', '鲜花订单身份引用与原事实不一致');
        }
        const currentBoundaryKnown = !prior || prior.lifecycle_ref === lifecycleRef || fields.cTime > prior.c_time;
        const sourceJson = canonical(source), sourceFingerprint = fingerprint(source);
        if (currentBoundaryKnown && (head?.lifecycle_ref !== lifecycleRef || head.context_json !== contextJson ||
            head.source_json !== sourceJson || head.source_fingerprint !== sourceFingerprint)) store.run(`INSERT INTO backend_order_flower_identity_heads VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(owner_ref,subject_ref,kind,box_id) DO UPDATE SET lifecycle_ref=excluded.lifecycle_ref,context_json=excluded.context_json,
          source_json=excluded.source_json,source_fingerprint=excluded.source_fingerprint,updated_at=excluded.updated_at`,
        context.ownerRef, context.subjectRef, kind, boxId, lifecycleRef, contextJson, sourceJson, sourceFingerprint, store.nowIso());
        identities.push({ kind, boxId, lifecycleRef, contentFingerprint, identityKnown: life.identity_known === 1 && currentBoundaryKnown,
          priorLifecycleRef: life.prior_lifecycle_ref, boundaryKind: life.boundary_kind,
          firstSource: parseStored(life.first_source_json, '订单首次来源'), source: clone(source), context: clone(context) });
      }
      return freeze({ current: true, changed, identities });
    });
  }
  function readCurrent({ context: supplied, view } = {}) {
    const context = orderFlowerContext(supplied), uid = scalar(view?.identity?.uid);
    if (!context || !isCurrent(context) || !view?.available || !view.current || !sameOrderFlowerContext(context, view.context) ||
        !view.identity?.verified || !positive(uid)) return freeze({ current: false, identities: [] });
    const identities = [];
    for (const { row, source } of currentOrderFlowerRows(view)) {
      if (!sourceKnown(source, context, uid)) continue;
      const { kind, boxId } = row.value, fields = orderFlowerPlainRow(row), content = orderFlowerContent(kind, boxId, fields);
      if (!positive(fields.cTime)) continue;
      const contentFingerprint = fingerprint(content), lifecycleRef = orderFlowerLife(context, kind, boxId, fields);
      const head = store.get(`SELECT lifecycle_ref FROM backend_order_flower_identity_heads WHERE owner_ref=? AND subject_ref=? AND kind=? AND box_id=?`,
        context.ownerRef, context.subjectRef, kind, boxId);
      const life = head?.lifecycle_ref === lifecycleRef ? store.get('SELECT * FROM backend_order_flower_lives WHERE lifecycle_ref=?', lifecycleRef) : null;
      const valid = !!life && life.owner_ref === context.ownerRef && life.subject_ref === context.subjectRef && life.kind === kind && life.box_id === boxId &&
        life.official_uid === uid && life.content_fingerprint === contentFingerprint && life.identity_known === 1 &&
        life.content_fingerprint === fingerprint(parseStored(life.content_json, '鲜花订单需求身份原文')) &&
        life.first_source_fingerprint === fingerprint(parseStored(life.first_source_json, '鲜花订单需求来源原文'));
      identities.push({ kind, boxId, lifecycleRef, contentFingerprint, identityKnown: valid,
        sourceRef: source.responseRef, identitySourceRef: valid ? life.first_source_json ? fingerprint(parseStored(life.first_source_json, '鲜花订单需求来源原文')) : null : null });
    }
    return freeze({ current: true, identities });
  }
  return Object.freeze({ reconcile, readCurrent });
}
