import { canonical, fingerprint, freeze, newId } from '../../common.mjs';
import { planSpecialOrder } from './planning.mjs';
import { officialDateMs } from '../land/wire-facts.mjs';
import { SPECIAL_ORDER_CONTRACT_REF, SPECIAL_ORDER_DEFINITIONS, SPECIAL_ORDER_POST_READ,
  assertSpecialOrderProposal, specialOrderTargetVerification } from './rpc-contract.mjs';

const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const cell = (snapshot, key) => snapshot?.fields?.[key]?.state === 'known' ? snapshot.fields[key].value : undefined;
const wait = reasonCode => ({ state: 'waiting-facts', reasonCode, deviceDueMs: Date.now() + 15000 });
const mapEmpty = value => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(amount => amount === 0);
const positive = value => Number.isSafeInteger(value) && value > 0;
const DEFS = Object.values(SPECIAL_ORDER_DEFINITIONS);

export function createSpecialOrderRuntime({ store, facts, extensionForContext, clock, officialDay, dynamicState, ledgerView,
  resources, isCurrent, readConfiguration, openEligibility, methodAvailable, readEnter, appendOutbox = () => {} } = {}) {
  for (const port of [store?.get, store?.run, facts?.read, extensionForContext, clock, officialDay, dynamicState?.snapshot,
    ledgerView?.currentAdmission, resources?.budget, resources?.reservationSpec, resources?.currencyBudget,
    resources?.currencyReservationSpec, isCurrent, readConfiguration, openEligibility, methodAvailable, readEnter])
    if (typeof port !== 'function') throw new TypeError('Special orders require bounded current admission ports');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_special_order_claim_heads(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,kind TEXT NOT NULL,action TEXT NOT NULL,
    cycle_ref TEXT NOT NULL,state TEXT NOT NULL,operation_id TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,subject_ref,kind,action))`);
  const features = {}, enterFlights = new Map();
  const configFor = context => readConfiguration(context);
  function stateFor(context, kind) {
    const snapshot = facts.read(context, kind), extension = extensionForContext(context), time = clock(context.subjectRef), day = officialDay(context);
    if (!extension || time?.available !== true || time.connectionEpoch !== context.connectionEpoch) return null;
    return { snapshot, extension, clock: time, day };
  }
  function plan(context, config, kind, operationId = null) {
    const state = stateFor(context, kind);
    if (!state) return wait('SPECIAL_ORDER_CURRENT_RULES_REQUIRED');
    const candidate = planSpecialOrder({ kind, ...state, config: config.config, open: openEligibility(context, kind),
      itemBudget: input => resources.budget({ context, ...input, claimingOperationId: operationId, requireOwnReservation: !!operationId }),
      currencyBudget: input => resources.currencyBudget({ context, ...input, claimingOperationId: operationId, requireOwnReservation: !!operationId }) });
    return { ...candidate, stateSource: state };
  }
  function readFactBasis({ proposal, actor } = {}) {
    const kind = proposal?.specialOrder?.kind;
    if (!isCurrent(actor) || !features[kind]) return { current: false, reasonCode: 'SPECIAL_ORDER_CONTEXT_NOT_CURRENT' };
    const state = stateFor(actor, kind), config = configFor(actor);
    if (state?.snapshot?.current !== true) return { current: false, reasonCode: 'SPECIAL_ORDER_CURRENT_FACTS_REQUIRED' };
    const snapshot = dynamicState.snapshot({ context: actor, feature: features[kind], config, method: proposal.method, proposal });
    if (snapshot?.current !== true) return { current: false, reasonCode: snapshot?.reasonCode || 'SPECIAL_ORDER_DYNAMIC_FACTS_REQUIRED' };
    return freeze({ current: true, fingerprint: fingerprint({ axes: AXES.map(key => actor[key]),
      factsFingerprint: state.snapshot.fingerprint, extensionRef: state.extension.extensionRef,
      domains: snapshot.domains, candidate: proposal.specialOrder.cycleRef }) });
  }
  function evaluateAdmission({ proposal, actor, factBasis, boundary, ownReservation } = {}) {
    const deny = reasonCode => ({ allowed: false, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode });
    if (!proposal || !isCurrent(actor)) return deny('SPECIAL_ORDER_CONTEXT_NOT_CURRENT');
    const action = proposal.specialOrder, config = configFor(actor), own = boundary === 'before-send' &&
      ownReservation?.operationId === proposal.operationId ? proposal.operationId : null;
    const current = plan(actor, config, action.kind, own), basis = readFactBasis({ proposal, actor });
    if (current.state !== 'candidate' || current.action !== action.action || current.cycleRef !== action.cycleRef ||
        canonical(current.params) !== canonical(proposal.params) || !basis.current || basis.fingerprint !== factBasis?.fingerprint ||
        current.stateSource.snapshot.fingerprint !== action.sourceFingerprint || current.stateSource.extension.extensionRef !== action.extensionRef)
      return deny('SPECIAL_ORDER_TARGET_OR_BUDGET_SUPERSEDED');
    if ((current.itemId ?? null) !== action.itemId || (current.quantity ?? null) !== action.quantity ||
        (current.paid === true) !== action.paid) return deny('SPECIAL_ORDER_RESOURCE_BINDING_SUPERSEDED');
    const target = proposal.targets[0], expectedResource = current.itemId
      ? resources.reservationSpec({ context: actor, itemId: current.itemId, quantity: current.quantity, memberKey: target.memberKey, lifecycleRef: target.lifecycleRef })
      : current.paid ? resources.currencyReservationSpec({ context: actor, amount: current.quantity, currency: 'yuanbao',
        memberKey: target.memberKey, lifecycleRef: target.lifecycleRef }) : null;
    const expectedBindings = expectedResource ? [{ resourceKey: expectedResource.resourceKey, memberKey: target.memberKey, quantity: expectedResource.quantity }] : [];
    if (canonical(proposal.resources) !== canonical(expectedResource ? [expectedResource] : []) ||
        canonical(proposal.resourceBindings) !== canonical(expectedBindings) ||
        current.itemId && canonical(action.beforeItem) !== canonical(resources.balance({ context: actor, itemId: current.itemId }).base) ||
        current.paid && canonical(action.beforeCurrency) !== canonical(resources.currencyBalance({ context: actor, currency: 'yuanbao' })))
      return deny('SPECIAL_ORDER_RESOURCE_BINDING_SUPERSEDED');
    if (!methodAvailable(proposal.method)) return deny('SPECIAL_ORDER_TRANSPORT_CONTRACT_UNAVAILABLE');
    const claim = store.get(`SELECT * FROM backend_special_order_claim_heads WHERE owner_ref=? AND subject_ref=? AND kind=? AND action=?`,
      actor.ownerRef, actor.subjectRef, action.kind, action.action);
    if (claim?.state === 'unknown-held' || claim?.state === 'confirmed' && claim.cycle_ref === action.cycleRef)
      return deny(claim.state === 'unknown-held' ? 'SPECIAL_ORDER_PRIOR_TARGET_UNRESOLVED' : 'SPECIAL_ORDER_TARGET_ALREADY_CONFIRMED');
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef,
      featureIds: ['order.' + action.kind], targetRefs: proposal.targets.map(one => one.targetRef) });
    if (!admission || admission.activeOperation && admission.activeOperation.operation_id !== own ||
        (admission.unresolvedOperations || []).some(one => one.operation_id !== own)) return deny('SPECIAL_ORDER_PRIOR_OPERATION_UNRESOLVED');
    return { allowed: true, targetsCurrent: true, resourcesCurrent: true, historicalConstraintsChecked: true, currentInFlightChecked: true, reasonCode: null };
  }
  function assess(input, kind) {
    if (input.config.config.orders?.[kind]?.enabled !== true) return { state: 'disabled', reasonCode: 'SPECIAL_ORDER_DISABLED' };
    if (!isCurrent(input.context)) return wait('SPECIAL_ORDER_CONTEXT_NOT_CURRENT');
    const candidate = plan(input.context, input.config, kind), state = candidate.stateSource;
    if (candidate.state !== 'candidate') {
      const { stateSource, ...result } = candidate;
      return { ...result, deviceDueMs: candidate.deviceDueMs || Date.now() + 15000 };
    }
    if (candidate.action === 'enter') {
      // enter is an explicitly read-only RPC, never a write permit or claim.
      const key = input.context.subjectRef, at = Date.now(), previous = enterFlights.get(key);
      if (methodAvailable('orderPalace.enter', 'read') && (!previous || at >= previous.retryAt)) {
        const flight = { retryAt: at + 30000 }; enterFlights.delete(key); enterFlights.set(key, flight);
        while (enterFlights.size > 64) enterFlights.delete(enterFlights.keys().next().value);
        Promise.resolve(readEnter(input.context)).catch(() => {});
      }
      return wait(methodAvailable('orderPalace.enter', 'read') ? 'PALACE_ENTER_CURRENT_OFFER_REQUIRED' : 'PALACE_ENTER_TRANSPORT_UNAVAILABLE');
    }
    const definition = SPECIAL_ORDER_DEFINITIONS[kind + '-' + candidate.action];
    if (!definition || !methodAvailable(definition.method)) return wait('SPECIAL_ORDER_TRANSPORT_CONTRACT_UNAVAILABLE');
    const targetRef = `special-order:${input.context.subjectRef}:${kind}:${candidate.cycleRef}:${candidate.action}`;
    const target = { memberKey: 'special-order:' + fingerprint([kind, candidate.cycleRef, candidate.action]), targetKind: 'special-order',
      targetRef, lifecycleRef: candidate.cycleRef, targetFingerprint: fingerprint({ targetRef,
        sourceFingerprint: state.snapshot.fingerprint, extensionRef: state.extension.extensionRef }) };
    const resource = candidate.itemId ? resources.reservationSpec({ context: input.context, itemId: candidate.itemId,
      quantity: candidate.quantity, memberKey: target.memberKey, lifecycleRef: target.lifecycleRef }) : candidate.paid
      ? resources.currencyReservationSpec({ context: input.context, amount: candidate.quantity, currency: 'yuanbao',
        memberKey: target.memberKey, lifecycleRef: target.lifecycleRef }) : null;
    const proposal = { ...input.context, operationId: newId(), proposalId: newId(), featureId: definition.featureId, scope: definition.scope,
      method: definition.method, params: candidate.params, paramsFingerprint: fingerprint(candidate.params),
      configRevision: input.config.savedRevision, featureCancelEpoch: input.config.featureCancelEpochs[definition.featureId],
      semanticKey: `special-order:${kind}:${candidate.action}:${candidate.cycleRef}`, targets: [target],
      resources: resource ? [resource] : [], resourceBindings: resource ? [{ resourceKey: resource.resourceKey, memberKey: target.memberKey, quantity: resource.quantity }] : [],
      contractRef: SPECIAL_ORDER_CONTRACT_REF, specialOrder: { kind, action: candidate.action, cycleRef: candidate.cycleRef,
        params: candidate.params,
        officialUid: cell(state.snapshot, 'uid'), sourceFingerprint: state.snapshot.fingerprint, factSnapshot: state.snapshot,
        extension: state.extension, extensionRef: state.extension.extensionRef, sourcePin: state.extension.sourcePin,
        loginResponseRef: state.extension.loginResponseRef, versionEvidence: { loginResponseRef: state.extension.loginResponseRef },
        itemId: candidate.itemId ?? null, quantity: candidate.quantity ?? null, paid: candidate.paid === true,
        beforeItem: candidate.itemId ? resources.balance({ context: input.context, itemId: candidate.itemId }).base : null,
        beforeCurrency: candidate.paid ? resources.currencyBalance({ context: input.context, currency: 'yuanbao' }) : null } };
    proposal.factBasis = readFactBasis({ proposal, actor: input.context });
    if (!proposal.factBasis.current) return wait(proposal.factBasis.reasonCode);
    assertSpecialOrderProposal(proposal);
    const admission = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis });
    return admission.allowed ? { state: 'proposals', proposals: [freeze(proposal)], reasonCode: null } : wait(admission.reasonCode);
  }
  async function verify({ proposal, response, connection, signal } = {}) {
    const action = proposal.specialOrder, before = action.factSnapshot, value = key => cell(before, key);
    const evidence = { targetRef: proposal.targets[0].targetRef, kind: action.kind, action: action.action, extensionRef: action.extensionRef };
    const unknown = reasonCode => ({ verdict: 'unknown', reasonCode, verificationVersion: 'special-orders/target-postread/v1', evidence,
      resourceResolutions: proposal.resources.map(one => ({ resourceKey: one.resourceKey, state: 'historical_footprint' })) });
    let bridge; try { bridge = await connection.readSnapshotAfterClose(); } catch (error) { return unknown(error.code || 'SPECIAL_ORDER_POSTREAD_FAILED'); }
    signal?.throwIfAborted?.();
    const post = bridge?.newLoginObservation, after = bridge && facts.read(bridge.newContext, action.kind), extension = bridge && extensionForContext(bridge.newContext);
    if (!post || post.method !== 'index.login' || bridge.oldPhysicalCloseReceipt?.closed !== true || bridge.operationId !== proposal.operationId ||
        bridge.officialUid !== action.officialUid || after?.current !== true || cell(after, 'uid') !== action.officialUid ||
        !extension || extension.sourcePin !== action.sourcePin || extension.loginResponseRef !== post.responseRef ||
        after.source?.responseRef !== post.responseRef) return unknown('SPECIAL_ORDER_POSTREAD_NOT_CURRENT');
    const next = key => cell(after, key), source = { responseRef: response.responseRef, requestSequence: response.requestSequence,
      connectionEpoch: response.connectionEpoch, wireKey: response.wireKey };
    const flows = [];
    function itemEffect(itemId, delta, beforeAbsolute = null) {
      const flow = resources.matchedItemFlow({ context: proposal, source, method: proposal.method, itemId,
        featureId: proposal.featureId, contractRef: SPECIAL_ORDER_CONTRACT_REF, action });
      const actual = delta < 0 ? flow?.bo : flow?.bi, opposite = delta < 0 ? flow?.bi : flow?.bo,
        oppositeCoverage = delta < 0 ? flow?.biCoverage : flow?.boCoverage;
      const balance = resources.balance({ context: bridge.newContext, itemId });
      const noOpposite = !opposite && (oppositeCoverage?.presence === 'missing' || oppositeCoverage?.state === 'known' && oppositeCoverage.itemPresent === false) ||
        opposite?.state === 'known' && opposite.value === 0;
      const absolute = balance?.base?.known === true && balance.base.source?.responseRef === post.responseRef ? balance.base.value : null;
      const exact = !!flow && flow.responseRef === response.responseRef && flow.method === proposal.method && actual?.state === 'known' &&
        actual.value === Math.abs(delta) && noOpposite && (beforeAbsolute === null || Number.isSafeInteger(absolute) && absolute - beforeAbsolute === delta);
      if (flow) flows.push({ itemId, delta, exact, flow, absolute }); return exact;
    }
    let effect = false;
    if (action.kind === 'palace' && action.action === 'finish') effect = [true, 1].includes(next('isFinish')) &&
      next('flowerId') === value('flowerId') && next('num') === value('num') &&
      action.beforeItem?.known === true && itemEffect(action.itemId, -action.quantity, action.beforeItem.value);
    if (action.kind === 'team') {
      const sameCycle = next('npcId') === value('npcId') && next('startTime') === value('startTime');
      if (action.action === 'submit') effect = sameCycle && (next('orderNum') === value('orderNum') + 1 ||
        next('status') === 3 && next('orderNum') === extension.rules.teamOrderMax && next('orderNum') === value('orderNum')) &&
        action.beforeItem?.known === true && itemEffect(action.itemId, -action.quantity, action.beforeItem.value);
      if (['take','stored'].includes(action.action)) {
        effect = next('status') === 2 && positive(next('startTime')) && next('startTime') !== value('startTime') &&
          (action.action === 'stored' ? next('npcId') === proposal.params.npcId : next('npcId') === value('npcId'));
        if (action.action === 'stored') effect &&= Array.isArray(next('storedOrders')) &&
          !next('storedOrders').some(one => (one.npcId ?? one['0']) === proposal.params.npcId);
        if (action.paid) {
          const currency = resources.currencyBalance({ context: bridge.newContext, currency: 'yuanbao' });
          effect &&= action.beforeCurrency?.known === true && currency.known && currency.source?.responseRef === post.responseRef &&
            currency.value === action.beforeCurrency.value - action.quantity && itemEffect(1, -action.quantity);
        }
      }
      if (action.action === 'receive') {
        const reward = value('rwd'), entries = reward && Object.entries(reward).filter(([, amount]) => positive(amount));
        effect = next('status') === 0 && mapEmpty(next('rwd')) && !!entries?.length &&
          entries.every(([id, amount]) => itemEffect(Number(id), amount));
      }
    }
    if (!effect) return unknown('SPECIAL_ORDER_TARGET_EFFECT_UNPROVEN');
    return { verdict: 'confirmed', verificationVersion: 'special-orders/target-postread/v1', postReadRef: post.responseRef,
      resourceResolutions: proposal.resources.map(one => ({ resourceKey: one.resourceKey, state: 'released' })),
      evidence: { ...evidence, before, after, flows, writeResponseRef: response.responseRef,
        postReadRef: post.responseRef, bridgeFingerprint: bridge.bridgeFingerprint, postExtension: extension } };
  }
  function onSettled({ proposal, operation, verification } = {}) {
    const action = proposal.specialOrder, state = verification?.verdict === 'confirmed' ? 'confirmed'
      : verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent' ? 'unknown-held' : null;
    if (state) store.run(`INSERT INTO backend_special_order_claim_heads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,kind,action)
      DO UPDATE SET cycle_ref=excluded.cycle_ref,state=excluded.state,operation_id=excluded.operation_id,updated_at=excluded.updated_at
      WHERE backend_special_order_claim_heads.state!='unknown-held' OR backend_special_order_claim_heads.operation_id=excluded.operation_id`,
    proposal.ownerRef, proposal.subjectRef, action.kind, action.action, action.cycleRef, state, proposal.operationId, store.nowIso());
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'special-order-settlement:' + proposal.operationId, payload: { operationId: proposal.operationId,
        featureId: proposal.featureId, verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null,
        runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  for (const kind of ['palace','team']) {
    const definitions = DEFS.filter(one => one.kind === kind), featureId = 'order.' + kind;
    features[kind] = Object.freeze({ featureId, consumedDomains: ['special-order-' + kind,'inventory','profile','clock','customer-eligibility','customer-day'],
      consumedDomainsFor: ({ proposal } = {}) => proposal
        ? ['special-order-' + kind,'inventory','profile','clock','customer-eligibility','customer-day']
        : ['inventory','profile','clock','customer-eligibility','customer-day'],
      scopes: definitions.map(one => one.scope), methods: definitions.map(one => one.method),
      methodScopes: Object.fromEntries(definitions.map(one => [one.method, one.scope])),
      operationContracts: Object.fromEntries(definitions.map(one => [one.method, Object.freeze({ ...one, postRead: SPECIAL_ORDER_POST_READ,
        validateTargetVerification: specialOrderTargetVerification })])), operationContract: null,
      release: 'validation-only', implementationVersion: 'special-orders/1', contractRef: SPECIAL_ORDER_CONTRACT_REF,
      factDomains: ['special-order-' + kind], resourceKinds: ['item','currency'],
      scheduleUnits: [{ scheduleKey: featureId, wakeKey: featureId, assess: input => assess(input, kind) }],
      assess: input => assess(input, kind), qualify: evaluateAdmission, evaluateAdmission, readFactBasis, verify, onSettled,
      onCurrentVerified: () => {} });
  }
  function publicView(context) {
    const active = context && isCurrent(context), extension = active ? extensionForContext(context) : null,
      time = active ? clock(context.subjectRef) : null;
    return freeze(Object.fromEntries(['palace','team'].map(kind => {
      const snapshot = active ? facts.read(context, kind) : { current: false }, known = key => cell(snapshot, key),
        current = snapshot.current === true, sourceRef = snapshot.source?.responseRef ?? null;
      if (kind === 'palace') {
        const flowerId = known('flowerId'), finished = known('isFinish');
        return [kind, { available: current, boardCount: !current ? null : flowerId === 0 || [true,1].includes(finished) ? 0
          : positive(flowerId) && [false,0].includes(finished) ? 1 : null, flowerId: flowerId ?? null,
        quantity: known('num') ?? null, finished: finished ?? null, quality: extension?.rules?.palette?.[flowerId] ?? null,
        sourceRef, reasonCode: current ? null : 'SPECIAL_ORDER_CURRENT_FACTS_REQUIRED', sourceDiagnostic: snapshot.sourceDiagnostic ?? null }];
      }
      const status = known('status'), start = known('startTime'), duration = extension?.rules?.teamDurationSeconds;
      const effective = current && status === 2 && positive(start) && positive(duration) && time?.available === true &&
        time.connectionEpoch === context.connectionEpoch && time.lowerBoundMs > start + duration * 1000 ? 3 : status;
      const stored = known('storedOrders'), counts = new Map();
      if (Array.isArray(stored)) for (const one of stored) { const id = one.npcId ?? one['0']; counts.set(id,(counts.get(id)||0)+1); }
      const ready = current && Array.isArray(stored) && time?.available === true ? stored.filter(one => {
        const id = one.npcId ?? one['0'], expires = officialDateMs(one.expireTime ?? one['1']);
        return counts.get(id) === 1 && positive(expires) && expires > time.upperBoundMs + 2000;
      }).length : null;
      return [kind, { available: current, boardState: !current ? 'unobserved' : [0,1,2,3].includes(status) ? 'read' : 'unreadable',
        status: status ?? null, effectiveStatus: effective ?? null,
        statusWord: ({ 0: '暂无当前团单', 1: '待接单', 2: '进行中', 3: '待领奖' })[effective] ?? null,
        storedReadyCount: ready, remainingNum: known('remainingNum') ?? null,
        dailyReadable: false, dailyCount: null, sourceRef, reasonCode: current ? null : 'SPECIAL_ORDER_CURRENT_FACTS_REQUIRED', sourceDiagnostic: snapshot.sourceDiagnostic ?? null }];
    })));
  }
  return Object.freeze({ features: Object.values(features), readFactBasis, evaluateAdmission, onSettled, publicView, onCurrentVerified: () => {} });
}
