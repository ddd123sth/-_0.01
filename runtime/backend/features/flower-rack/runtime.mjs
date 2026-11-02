import { canonical, fingerprint, freeze, newId, parseStored } from '../../common.mjs';
import { FLOWER_RACK_PRICE_SOURCE_PIN } from '../../official-flower-rack-price-extension.mjs';
import { FLOWER_RACK_CONTRACT_REF, FLOWER_RACK_DEFINITIONS, FLOWER_RACK_METHODS, FLOWER_RACK_SCOPES,
  FLOWER_RACK_POST_READ, assertFlowerRackProposal, flowerRackTargetVerification } from './rpc-contract.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';

const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const operationContracts = Object.freeze(Object.fromEntries(Object.entries(FLOWER_RACK_DEFINITIONS).map(([kind, definition]) =>
  [definition.method, Object.freeze({ ...definition, postRead: FLOWER_RACK_POST_READ, validateTargetVerification: flowerRackTargetVerification })])));
const scopeFor = Object.freeze(Object.fromEntries(Object.entries(FLOWER_RACK_METHODS).map(([kind, method]) => [method, FLOWER_RACK_SCOPES[kind]])));
const stableContext = context => Object.fromEntries(AXES.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]]));
const currentClock = (clock, context) => {
  const value = clock(context.subjectRef);
  return value?.available === true && value.connectionEpoch === context.connectionEpoch &&
    Number.isSafeInteger(value.lowerBoundMs) && Number.isSafeInteger(value.upperBoundMs) && value.lowerBoundMs <= value.upperBoundMs ? value : null;
};

export function createFlowerRackRuntime({ store, facts, priceFacts, extensionForContext, priceExtensionForContext, dynamicState, clock, resources, readProfile,
  catalogForContext, readBag, readRelatedDemand, readConfiguration, ledgerView, isolationEvidence, gatewayActivity, isCurrent, appendOutbox = () => {} } = {}) {
  for (const fn of [store?.run,store?.get,store?.all,store?.transaction,store?.nowIso,facts?.read,facts?.readHistoricalReceipt,priceFacts?.read,extensionForContext,priceExtensionForContext,dynamicState?.snapshot,
    clock,resources?.balance,resources?.budget,resources?.reservationSpec,resources?.matchedItemFlow,readProfile,catalogForContext,readBag,
    readRelatedDemand,readConfiguration, resources?.currencyBalance, resources?.currencyBudget, resources?.currencyReservationSpec,
    ledgerView?.currentAdmission,ledgerView?.operation,isolationEvidence?.read,gatewayActivity,isCurrent,appendOutbox]) if (typeof fn !== 'function')
    throw new TypeError('Flower-rack runtime requires bounded shared ports');
  const { get, run, transaction, nowIso } = store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_flower_rack_claims(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,target_ref TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,target_ref));
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_claims_no_delete BEFORE DELETE ON backend_flower_rack_claims
      BEGIN SELECT RAISE(ABORT,'flower rack action history is retained'); END;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_flower_rack_slot_lifecycles(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,rack_id INTEGER NOT NULL,generation INTEGER NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,official_uid,rack_id));
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_slot_lifecycles_no_delete BEFORE DELETE ON backend_flower_rack_slot_lifecycles
      BEGIN SELECT RAISE(ABORT,'flower rack lifecycle history is retained'); END;`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_flower_rack_slot_transitions(
    transition_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,rack_id INTEGER NOT NULL,
    operation_id TEXT NOT NULL,old_response_ref TEXT NOT NULL,new_response_ref TEXT NOT NULL,payload_json TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
    UNIQUE(owner_ref,subject_ref,operation_id));
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_slot_transitions_no_update BEFORE UPDATE ON backend_flower_rack_slot_transitions
      BEGIN SELECT RAISE(ABORT,'flower rack transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_slot_transitions_no_delete BEFORE DELETE ON backend_flower_rack_slot_transitions
      BEGIN SELECT RAISE(ABORT,'flower rack transitions are append only'); END;
    CREATE TABLE IF NOT EXISTS backend_flower_rack_empty_generation_checkpoints(
      checkpoint_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,rack_id INTEGER NOT NULL,
      old_generation INTEGER NOT NULL,old_sell_operation_id TEXT NOT NULL,consuming_operation_id TEXT NOT NULL,
      old_sell_original_fingerprint TEXT NOT NULL,consuming_original_fingerprint TEXT NOT NULL,old_response_ref TEXT NOT NULL,
      current_response_ref TEXT NOT NULL,isolation_receipt_ref TEXT NOT NULL,isolation_receipt_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,recorded_at TEXT NOT NULL,
      UNIQUE(owner_ref,subject_ref,official_uid,rack_id,old_generation,old_sell_operation_id,consuming_operation_id));
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_empty_generation_checkpoints_no_update BEFORE UPDATE ON backend_flower_rack_empty_generation_checkpoints
      BEGIN SELECT RAISE(ABORT,'flower rack generation checkpoints are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_flower_rack_empty_generation_checkpoints_no_delete BEFORE DELETE ON backend_flower_rack_empty_generation_checkpoints
      BEGIN SELECT RAISE(ABORT,'flower rack generation checkpoints are append only'); END;`);
  const configFor = context => readConfiguration(context);
  const orderDemandDomains = settings => {
    const orders = settings?.orders || {}, selected = [];
    if (orders.customer?.enabled === true) selected.push('customer','customer-eligibility');
    if (['resident','satin','decorate'].some(key => orders[key]?.enabled === true))
      selected.push('order-flower','order-flower-counter','order-flower-eligibility','order-flower-butler');
    return selected;
  };
  const actionDomains = (kind, config) => {
    const settings = config?.config ?? config ?? {}, rackConfig = settings.flowerRack || {};
    const base = ['flower-rack','profile','clock'];
    if (kind === 'receive' || kind === 'unlock') return base;
    if (kind === 'cancel') return [...base,'inventory'];
    if (kind === 'sell') return [...base,'inventory',...orderDemandDomains(settings)];
    return rackConfig.enabled === true ? [...base,'inventory'] : base;
  };
  const actionKindForMethod = method => Object.keys(FLOWER_RACK_METHODS).find(kind => FLOWER_RACK_METHODS[kind] === method) || null;
  function stateFor(context) {
    if (!context || !isCurrent(context)) return null;
    const extension = extensionForContext(context), state = facts.read(context), time = currentClock(clock, context);
    if (!extension || state?.current !== true || !time || !positive(state.value?.uid) ||
        extension.loginResponseRef !== state.source?.responseRef || !extension.bundleRef) return null;
    return { extension, state, clock: time, rules: extension.rules };
  }
  function domains(context, proposal, actionKind = null) {
    const selectedFeature = actionKind ? { ...feature, consumedDomainsFor: ({ config, method, proposal: currentProposal }) =>
      actionDomains(currentProposal?.flowerRack?.kind || actionKindForMethod(method) || actionKind, config) } : feature;
    const snapshot = dynamicState.snapshot({ context, feature: selectedFeature, config: configFor(context), method: proposal?.method, proposal });
    if (snapshot?.current !== true) return null;
    return snapshot.domains.map(domain => Object.fromEntries(['domainId','current','semanticRevision','semanticFingerprint','sourceRef',
      'sourceKind','method','requestSequence','observedAtMs','coverage','sourceProofs','dirty','reasonCode'].map(key => [key, domain[key]])));
  }
  function relatedDemand(context, proposal) {
    if (proposal?.flowerRack?.kind !== 'sell') return { current: true, protectedQuantity: 0, proofRefs: [] };
    const value = readRelatedDemand({ context, itemId: proposal.flowerRack.artId, kind: 'finished-art' });
    return value?.current === true && nonnegative(value.protectedQuantity) && Array.isArray(value.proofRefs)
      ? value : { current: false, protectedQuantity: null, proofRefs: [], reasonCode: value?.reasonCode || 'FLOWER_RACK_RELATED_DEMAND_NOT_CURRENT' };
  }
  function readFactBasis({ proposal, actor } = {}) {
    if (!actor || !isCurrent(actor)) return { current: false, reasonCode: 'FLOWER_RACK_CONTEXT_NOT_CURRENT' };
    const context = stableContext(actor), state = stateFor(context), snapshotDomains = domains(context, proposal);
    if (!state || !snapshotDomains) return { current: false, reasonCode: 'FLOWER_RACK_FACTS_NOT_CURRENT' };
    const demand = relatedDemand(context, proposal);
    if (demand.current !== true) return { current: false, reasonCode: demand.reasonCode || 'FLOWER_RACK_RELATED_DEMAND_NOT_CURRENT' };
    return freeze({ current: true, fingerprint: fingerprint({ context: stableContext(actor), extensionRef: state.extension.extensionRef,
      factsFingerprint: state.state.fingerprint, source: state.state.source, dynamicDomains: snapshotDomains,
      target: proposal?.flowerRack?.targetKey ?? null, relatedDemand: demand }) });
  }
  function priceFor(context, artId) {
    const catalog = catalogForContext(context), identity = catalog?.identity?.(), row = catalog?.table?.('c_flowerArt')?.[String(artId)];
    const extension = priceExtensionForContext(context), factsValue = priceFacts.read(context), priceState = factsValue?.value, rackState = facts.read(context);
    const now = currentClock(clock, context);
    const extensionBody = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
    if (!identity || catalog?.sourceBundleCurrent?.() !== true || !row || row.id !== artId || !Array.isArray(row.flowers) || !row.flowers.length ||
        !row.flowers.every(positive) || !/^[a-f0-9]{64}$/.test(identity.tableSha256?.c_flowerArt || '') ||
        !/^[a-f0-9]{64}$/.test(identity.tableSha256?.c_flower || '') || !identity.bundleRef || !identity.dataSnapshotId || !identity.loginResponseRef ||
        !extension || extension.bundleRef !== identity.bundleRef || extension.loginResponseRef !== identity.loginResponseRef || !extensionBody ||
        extension.extensionRef !== 'sha256:' + fingerprint(extensionBody) ||
        extension.baseDataSnapshotId !== identity.dataSnapshotId || extension.sourcePin !== FLOWER_RACK_PRICE_SOURCE_PIN ||
        !factsValue?.current || factsValue.responseRef !== identity.loginResponseRef || factsValue.source?.method !== 'index.login' ||
        factsValue.source?.connectionEpoch !== context.connectionEpoch || rackState?.current !== true ||
        rackState.source?.responseRef !== identity.loginResponseRef || !positive(priceState?.uid) || priceState.uid !== rackState.value?.uid || !now)
      return null;
    const flowers = catalog.table('c_flower'), rowCost = [];
    let sum = 0, skillBonusBasis = 0;
    for (const flowerId of row.flowers) {
      const flower = flowers?.[String(flowerId)], member = priceState.cultivate?.entries?.[String(flowerId)];
      if (!flower || flower.id !== flowerId || !nonnegative(flower.gld) || !member || member.uid !== priceState.uid || member.flowerId !== flowerId)
        return null;
      sum += flower.gld;
      const skillGroups = new Map(), rowSkills = [];
      for (const [slotText, slot] of Object.entries(member.slots || {})) {
        if (!slot.skillId) continue;
        const skill = extension.skills?.[String(slot.skillId)];
        if (!skill || skill.id !== slot.skillId || !positive(skill.skillType) || !positive(skill.valueType)) return null;
        const value = skill['value' + slotText];
        if (!nonnegative(value)) return null;
        const group = skillGroups.get(skill.skillType) || { valueType: skill.valueType, raw: 0, slots: [] };
        group.raw += value; group.slots.push({ slot: Number(slotText), skillId: skill.id, valueType: skill.valueType, value });
        skillGroups.set(skill.skillType, group);
        rowSkills.push({ slot: Number(slotText), skillId: skill.id, skillType: skill.skillType, valueType: skill.valueType, value });
      }
      const normalizedGroups = Object.fromEntries([...skillGroups].map(([type, group]) => [type,
        group.valueType === 2 ? group.raw / 1e4 : group.raw]));
      const skillTypeOne = normalizedGroups['1'] || 0;
      if (!Object.values(normalizedGroups).every(value => Number.isFinite(value) && value >= 0)) return null;
      rowCost.push({ flowerId, gld: flower.gld, skillTypeOne, skills: rowSkills });
      skillBonusBasis += skillTypeOne > 0 ? Math.max(Math.round(2.3 * (flower.gld * skillTypeOne) / (1 + extension.videoGldAdd / 1e4)), 1) : 0;
    }
    const skillIds = rowCost.filter(item => item.skillTypeOne > 0).map(item => item.flowerId);
    let multiplierEligibility = { required: skillIds.length > 0, gldAdd: 0 };
    if (skillIds.length) {
      let paidMultiplier, paidState = 'unknown';
      const card = priceState.card;
      if (card?.presence === 'present' && card.value?.uid === priceState.uid) {
        if (card.value.isMain) { paidMultiplier = true; paidState = 'main-active'; }
        else if (!card.value.invalidTime || card.value.invalidTime.presence === 'missing' || card.value.invalidTime.presence === 'unreadable') return null;
        else if (card.value.invalidTime.value === null) { paidMultiplier = false; paidState = 'inactive'; }
        else if (card.value.invalidTime.value > now.upperBoundMs) { paidMultiplier = true; paidState = 'expiry-active'; }
        else if (card.value.invalidTime.value <= now.lowerBoundMs) { paidMultiplier = false; paidState = 'inactive'; }
      }
      let videoMultiplier, videoState = 'unknown';
      const video = priceState.video;
      if (video?.presence === 'present' && video.value?.uid === priceState.uid && video.value.eTime?.presence === 'present') {
        if (video.value.eTime.value === null) { videoMultiplier = false; videoState = 'inactive'; }
        else if (video.value.eTime.value > now.upperBoundMs) { videoMultiplier = true; videoState = 'active'; }
        else if (video.value.eTime.value <= now.lowerBoundMs) { videoMultiplier = false; videoState = 'inactive'; }
      }
      let gldAdd;
      if (paidMultiplier === true || videoMultiplier === true) gldAdd = extension.videoGldAdd / 1e4;
      else if (paidMultiplier === false && videoMultiplier === false) gldAdd = 0;
      else return null;
      multiplierEligibility = { required: true, card: paidState, video: videoState, gldAdd };
      skillBonusBasis = rowCost.reduce((sumValue, item) => sumValue + (item.skillTypeOne > 0
        ? Math.max(Math.round(2.3 * (item.gld * item.skillTypeOne) / (1 + gldAdd)), 1) : 0), 0);
    }
    const value = row.sPrice;
    let currencyId, amount, priceRule;
    if (value !== undefined && value !== null && Array.isArray(value) && value.length === 2 && positive(value[0]) && nonnegative(value[1])) {
      currencyId = value[0]; amount = value[1] + skillBonusBasis; priceRule = 'official-sPrice-plus-skill-bonus';
    } else if (value === undefined || value === null || Array.isArray(value) && value.length === 0) {
      currencyId = 11; amount = Math.round(sum * 2.3) + skillBonusBasis; priceRule = 'official-calSPrice-plus-skill-bonus';
    } else return null;
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    const body = { version: 'flower-rack/current-table-price/v2', artId, currencyId, amount, priceRule, rowFingerprint: fingerprint(row),
      flowerRows: rowCost, flowerTableSha256: identity.tableSha256.c_flower, tableSha256: identity.tableSha256.c_flowerArt,
      priceExtensionRef: extension.extensionRef, priceSourcePin: extension.sourcePin, priceFactsFingerprint: factsValue.fingerprint,
      priceFactsSource: factsValue.source, bundleRef: identity.bundleRef, dataSnapshotId: identity.dataSnapshotId,
      loginResponseRef: identity.loginResponseRef, officialUid: priceState.uid, multiplierEligibility };
    return freeze({ ...body, priceRef: 'flower-rack-price:' + fingerprint(body) });
  }
  function makeProposal({ context, input, state, kind, rack, artId = null, quantity = null, balance = null, priceProof = null, selectionEvidence = null }) {
    const method = FLOWER_RACK_METHODS[kind], params = kind === 'unlock' ? { standId: rack.rackId } :
      kind === 'sell' ? { rackId: rack.rackId, iid: artId, num: quantity } : { rackId: rack.rackId };
    const resolvedArtId = kind === 'unlock' ? null : positive(artId) ? artId : positive(rack.iid) ? rack.iid : null;
    const saleIdentity = positive(rack.sellStartTime) ? `${rack.iid}:${rack.sellStartTime}` : `${rack.iid || 0}:${rack.num || 0}`;
    let generation = 0;
    if (kind === 'sell') {
      const prior = get('SELECT generation FROM backend_flower_rack_slot_lifecycles WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=?',
        context.ownerRef, context.subjectRef, state.state.value.uid, rack.rackId);
      generation = prior?.generation || 0;
    }
    const stableTarget = kind === 'unlock' ? `uid:${state.state.value.uid}:stand:${rack.rackId}:locked` :
      kind === 'sell' ? `uid:${state.state.value.uid}:rack:${rack.rackId}:empty:g${generation}` :
        `uid:${state.state.value.uid}:rack:${rack.rackId}:sale:${saleIdentity}`;
    const targetKey = `${kind}:${stableTarget}`;
    const targetRef = `flower-rack:${context.subjectRef}:${targetKey}`;
    const targetArtId = kind === 'unlock' ? 0 : resolvedArtId || 0;
    const memberKey = 'flower-rack:' + fingerprint([targetKey, targetArtId]);
    const target = { memberKey, targetKind: 'flower-rack', targetRef, lifecycleRef: state.extension.bundleRef,
      targetFingerprint: fingerprint({ targetRef, sourceRef: state.state.source.responseRef, extensionRef: state.extension.extensionRef }) };
    const stand = state.rules.stands[rack.rackId];
    const unlockCost = kind === 'unlock' ? stand?.unlockCost : null;
    const reservations = kind === 'sell' ? [resources.reservationSpec({ context, itemId: artId, quantity, memberKey, lifecycleRef: state.extension.extensionRef })] :
      kind === 'unlock' && unlockCost?.[0] === 11 && unlockCost[1] > 0 ? [resources.currencyReservationSpec({ context, amount: unlockCost[1], memberKey,
        lifecycleRef: state.extension.extensionRef, currency: 'gold' })] : [];
    const itemBefore = balance || (resolvedArtId ? resources.balance({ context, itemId: resolvedArtId }) : null);
    const profile = readProfile({ context }), gold = profile?.profile?.gold;
    const proposal = { ...stableContext(context), operationId: newId(), proposalId: newId(), featureId: 'flower-rack', scope: FLOWER_RACK_SCOPES[kind], method,
      contractRef: FLOWER_RACK_CONTRACT_REF, semanticKey: `${FLOWER_RACK_CONTRACT_REF}:${context.subjectRef}:${targetKey}`,
      params, paramsFingerprint: fingerprint(params), configRevision: input.config.savedRevision,
      featureCancelEpoch: input.config.featureCancelEpochs['flower-rack'], targets: [target], resources: reservations,
      resourceBindings: reservations.map(one => ({ resourceKey: one.resourceKey, memberKey, quantity: one.quantity })),
      flowerRack: { kind, targetKey, officialUid: state.state.value.uid, rackId: rack.rackId, artId: resolvedArtId,
        quantity: quantity || rack.num || unlockCost?.[1] || null, sortStrategy: kind === 'sell' ? input.config.config.flowerRack.sortStrategy : null,
        configPutCount: kind === 'sell' ? input.config.config.flowerRack.putCount : null,
        configFingerprint: kind === 'sell' ? fingerprint({ enabled: input.config.config.flowerRack.enabled,
          artIds: input.config.config.flowerRack.artIds, sortStrategy: input.config.config.flowerRack.sortStrategy,
          putCount: input.config.config.flowerRack.putCount }) : null,
        sourceRef: state.state.source.responseRef, sourceFingerprint: state.state.fingerprint,
        sourceMethod: state.state.source.method, sourceSequence: state.state.source.requestSequence,
          extensionRef: state.extension.extensionRef, extension: state.extension, bundleRef: state.extension.bundleRef,
        loginResponseRef: state.extension.loginResponseRef, sourceMap: state.state.value.map,
        beforeGold: gold?.state === 'known' && nonnegative(gold.value) ? gold.value : null, beforeGoldSource: gold?.source || null,
        beforeItem: itemBefore?.base?.known === true ? itemBefore.base.value : null, beforeItemSource: itemBefore?.base?.source || null } };
    if (priceProof) proposal.flowerRack.priceProof = priceProof;
    if (selectionEvidence) proposal.flowerRack.selectionEvidence=selectionEvidence;
    proposal.traceId = fingerprint({ featureId: proposal.featureId, semanticKey: proposal.semanticKey, sourceRef: proposal.flowerRack.sourceRef });
    assertFlowerRackProposal(proposal);
    proposal.factBasis = readFactBasis({ proposal, actor: context });
    return proposal;
  }
  function evaluateAdmission({ proposal, actor, factBasis: supplied, boundary, ownReservation } = {}) {
    if (!proposal || !actor || !isCurrent(actor)) return { allowed: false, reasonCode: 'FLOWER_RACK_CONTEXT_NOT_CURRENT' };
    const context = stableContext(actor), state = stateFor(context), basis = readFactBasis({ proposal, actor }), kind = proposal.flowerRack?.kind;
    const flags = { historicalConstraintsChecked: true, currentInFlightChecked: true };
    if (!state || !basis.current || supplied?.fingerprint !== basis.fingerprint ||
        state.extension.extensionRef !== proposal.flowerRack.extensionRef || state.state.source.responseRef !== proposal.flowerRack.sourceRef)
      return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_FACTS_SUPERSEDED' };
    const config = configFor(context)?.config?.flowerRack;
    if (kind === 'sell' && config?.enabled !== true || kind === 'cancel' && config?.autoTakeDown !== true ||
        kind === 'unlock' && config?.unlockEnabled !== true || kind === 'receive' && config?.enabled !== true)
      return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_ACTION_DISABLED' };
    if (kind === 'sell' && (!Array.isArray(config?.artIds) || config.artIds.length > 0 && !config.artIds.includes(proposal.flowerRack.artId) ||
        config.sortStrategy !== proposal.flowerRack.sortStrategy || config.putCount !== proposal.flowerRack.configPutCount ||
        fingerprint({ enabled: config.enabled, artIds: config.artIds, sortStrategy: config.sortStrategy, putCount: config.putCount }) !== proposal.flowerRack.configFingerprint))
      return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_CONFIGURATION_CHANGED' };
    if (kind === 'sell' && config?.sortStrategy === 'max_price') {
      const price = priceFor(context, proposal.flowerRack.artId);
      if (!price || canonical(price) !== canonical(proposal.flowerRack.priceProof))
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_PRICE_SOURCE_CHANGED' };
    }
    if (kind === 'unlock') {
      const stand = state.rules.stands[proposal.flowerRack.rackId], cost = stand?.unlockCost;
      const budget = cost?.[0] === 11 && cost[1] > 0 ? resources.currencyBudget({ context, currency: 'gold',
        quantity: cost[1], keep: config?.unlockKeepGold || 0, claimingOperationId: proposal.operationId, requireOwnReservation: ownReservation?.required === true }) : null;
      if (!budget?.allowed || proposal.resources.length !== 1 || proposal.resources[0].resourceRef !== 'currency:gold' ||
          proposal.resources[0].quantity !== cost?.[1]) return { ...flags, allowed: false, reasonCode: budget?.reasonCode || 'FLOWER_RACK_GOLD_BUDGET_UNKNOWN' };
    }
    const row = state.state.value.map?.[String(proposal.flowerRack.rackId)];
    if (kind === 'unlock') {
      const stand = state.rules.stands[proposal.flowerRack.rackId];
      if (!stand || stand.rackIds.some(id => Object.hasOwn(state.state.value.map || {}, String(id))))
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_STAND_ALREADY_UNLOCKED_OR_UNKNOWN' };
    } else if (!row || row.rackId !== proposal.flowerRack.rackId) return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_MEMBER_NOT_CURRENT' };
    if (kind === 'sell' && (row.iid > 0 || proposal.flowerRack.quantity > state.rules.maxSellNum)) return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_SLOT_OR_LIMIT_CHANGED' };
    if (['receive','cancel'].includes(kind) && row.iid !== proposal.flowerRack.artId) return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_TARGET_CHANGED' };
    if (['receive','cancel'].includes(kind)) {
      const sale = proposal.flowerRack, before = sale.sourceMap?.[String(sale.rackId)];
      const suffix = `uid:${state.state.value.uid}:rack:${sale.rackId}:sale:${row.iid}:${row.sellStartTime}`;
      const keys = ['receive:', 'cancel:'].map(prefix => `${FLOWER_RACK_CONTRACT_REF}:${context.subjectRef}:${prefix}${suffix}`);
      if (!positive(row.num) || !positive(row.sellStartTime) || before?.iid !== row.iid || before.num !== row.num ||
          before.sellStartTime !== row.sellStartTime || sale.targetKey !== `${kind}:${suffix}` ||
          proposal.targets?.[0]?.targetRef !== `flower-rack:${context.subjectRef}:${kind}:${suffix}`)
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_SALE_IDENTITY_CHANGED' };
      const doneAt = row.sellStartTime + row.num * state.rules.sellTimeSeconds * 1000;
      const heldUntil = row.sellStartTime + Math.max(state.rules.lockTimeSeconds * 1000, config.keepMinutes * 60000);
      if (!Number.isSafeInteger(doneAt) || !Number.isFinite(heldUntil) ||
          kind === 'receive' && state.clock.lowerBoundMs < doneAt ||
          kind === 'cancel' && (state.clock.lowerBoundMs <= heldUntil || state.clock.upperBoundMs >= doneAt))
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_FINALIZATION_WINDOW_CHANGED' };
      // Different action names still consume the same physical sale.
      const prior = get(`SELECT operation_id,business_verdict FROM backend_operations WHERE owner_ref=? AND subject_ref=?
        AND feature_id='flower-rack' AND semantic_key IN (?,?) AND operation_id<>? AND transport_state!='not_sent'
        AND business_verdict IN ('unknown','unverified','confirmed')
        ORDER BY CASE WHEN business_verdict='confirmed' THEN 1 ELSE 0 END,prepared_at DESC LIMIT 1`,
        context.ownerRef, context.subjectRef, keys[0], keys[1], proposal.operationId);
      if (prior) {
        const old = ledgerView.operation(prior.operation_id), preparation = readImmutableRackPreparation(old);
        if (!old || !preparation || !assertStoredRackOperation(old, preparation) ||
            preparation.officialUid !== state.state.value.uid || preparation.rackId !== sale.rackId ||
            preparation.artId !== row.iid || preparation.sourceMap?.[String(sale.rackId)]?.sellStartTime !== row.sellStartTime)
          return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_PRIOR_FINALIZATION_EVIDENCE_UNREADABLE' };
        return { ...flags, allowed: false, reasonCode: prior.business_verdict === 'confirmed'
          ? 'FLOWER_RACK_SALE_ALREADY_FINALIZED' : 'FLOWER_RACK_SALE_FINALIZATION_HELD' };
      }
    }
    if (['receive','unlock'].includes(kind) && (!nonnegative(proposal.flowerRack.beforeGold) || proposal.flowerRack.beforeGoldSource?.kind !== 'response' ||
        proposal.flowerRack.beforeGoldSource.connectionEpoch !== actor.connectionEpoch || !positive(proposal.flowerRack.beforeGoldSource.requestSequence) ||
        !proposal.flowerRack.beforeGoldSource.responseRef)) return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_BEFORE_GOLD_NOT_CURRENT' };
    if (boundary === 'before-send') {
      if (kind === 'unlock') {
        const cost = state.rules.stands[proposal.flowerRack.rackId]?.unlockCost;
        const keep = config?.unlockKeepGold;
        const budget = cost?.[0] === 11 && Number.isSafeInteger(keep) ? resources.currencyBudget({ context, currency: 'gold',
          quantity: cost[1], keep, claimingOperationId: proposal.operationId, requireOwnReservation: ownReservation?.required === true }) : null;
        if (budget?.allowed !== true) return { ...flags, allowed: false, reasonCode: budget?.reasonCode || 'FLOWER_RACK_GOLD_BUDGET_UNKNOWN' };
      }
      if (kind === 'sell') {
        const demand = relatedDemand(context, proposal);
        const budget = demand.current === true ? resources.budget({ context, itemId: proposal.flowerRack.artId,
          quantity: proposal.flowerRack.quantity, keep: demand.protectedQuantity, claimingOperationId: proposal.operationId,
          requireOwnReservation: ownReservation?.required === true }) : null;
        if (demand.current !== true || budget?.allowed !== true)
          return { ...flags, allowed: false, reasonCode: demand.current !== true ? demand.reasonCode : budget?.reasonCode || 'FLOWER_RACK_RELATED_DEMAND_PROTECTED' };
      }
      if (ownReservation?.required === true && kind === 'sell') {
        const result = resources.budget({ context, itemId: proposal.flowerRack.artId, quantity: proposal.flowerRack.quantity,
          keep: 0, claimingOperationId: proposal.operationId, requireOwnReservation: true });
        const own = result?.ownReservation, resource = proposal.resources.find(one => one.resourceRef === 'item:' + proposal.flowerRack.artId);
        if (result?.allowed !== true || own?.valid !== true || own.operationId !== proposal.operationId || own.quantity !== proposal.flowerRack.quantity ||
            !resource || !Array.isArray(own.resources) || own.resources.length !== 1 || own.resources[0].resourceKey !== resource.resourceKey ||
            own.resources[0].quantity !== resource.quantity || own.resources[0].unreflectedQuantity !== resource.quantity ||
            !['reserved','in_flight'].includes(own.resources[0].state))
          return { ...flags, allowed: false, reasonCode: result?.reasonCode || 'FLOWER_RACK_OWN_RESERVATION_MISSING' };
      } else if (ownReservation?.required === true && kind === 'unlock') {
        const cost = state.rules.stands[proposal.flowerRack.rackId]?.unlockCost;
        const budget = cost?.[0] === 11 && Number.isSafeInteger(config?.unlockKeepGold)
          ? resources.currencyBudget({ context, currency: 'gold', quantity: cost[1], keep: config.unlockKeepGold,
            claimingOperationId: proposal.operationId, requireOwnReservation: true }) : null;
        const own = budget?.ownReservation, resource = proposal.resources.find(one => one.resourceRef === 'currency:gold');
        if (budget?.allowed !== true || own?.valid !== true || own.operationId !== proposal.operationId || own.quantity !== cost?.[1] ||
            !resource || !Array.isArray(own.resources) || own.resources.length !== 1 || own.resources[0].resourceKey !== resource.resourceKey ||
            own.resources[0].quantity !== resource.quantity || !['reserved','in_flight'].includes(own.resources[0].state))
          return { ...flags, allowed: false, reasonCode: budget?.reasonCode || 'FLOWER_RACK_GOLD_OWN_RESERVATION_MISSING' };
      } else if (ownReservation?.required === true && ['receive','cancel'].includes(kind) &&
          (proposal.resources.length !== 0 || proposal.resourceBindings.length !== 0)) {
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_UNEXPECTED_RESOURCE_RESERVATION' };
      }
    }
    const targetRefs = proposal.targets.map(one => one.targetRef), resourceKeys = proposal.resources.map(one => one.resourceKey);
    const admission = ledgerView.currentAdmission({ ownerRef: actor.ownerRef, subjectRef: actor.subjectRef, targetRefs, resourceKeys });
    if (!Array.isArray(admission?.unresolvedOperations)) return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_HISTORY_UNREADABLE' };
    for (const row of admission.unresolvedOperations) {
      if (row.operation_id === proposal.operationId) continue;
      const old = ledgerView.operation(row.operation_id);
      if (old?.business_verdict === 'unknown' && old.targets?.some(one => one.target_ref === proposal.targets[0].targetRef))
        return { ...flags, allowed: false, reasonCode: 'FLOWER_RACK_PRIOR_UNKNOWN_HELD' };
    }
    return { ...flags, allowed: true, targetsCurrent: true, resourcesCurrent: true, reasonCode: null };
  }
  function readImmutableRackPreparation(operation) {
    if (!operation || ledgerJsonFingerprint(operation.original) !== operation.original_fingerprint ||
        operation.original?.operationId !== operation.operation_id || operation.original?.ownerRef !== operation.owner_ref ||
        String(operation.original?.accountRef) !== String(operation.account_ref) || operation.original?.subjectRef !== operation.subject_ref ||
        !Number.isSafeInteger(operation.original?.ownerEpoch) || operation.original.ownerEpoch <= 0 ||
        operation.original?.runEpoch !== operation.run_epoch ||
        operation.original?.connectionEpoch !== operation.connection_epoch) return null;
    const evidence = get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
      WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1' AND kind='finite-domain-preparation'
        AND source='backend/write-gateway/v2'`, operation.operation_id);
    if (!evidence) return null;
    const payload = parseStored(evidence.payload_json, '花架不可变准备证据');
    if (ledgerJsonFingerprint({ kind: evidence.kind, source: evidence.source, payload, observedAt: evidence.observed_at }) !== evidence.payload_fingerprint ||
        payload?.domain !== operation.scope || payload.domain !== operation.original.scope || !payload.preparation ||
        operation.original.featureId !== 'flower-rack' || operation.original.method !== operation.method ||
        operation.original.semanticKey !== operation.semantic_key) return null;
    return payload.preparation;
  }
  function assertStoredRackOperation(operation, preparation) {
    const kind = preparation?.kind, params = kind === 'sell' ? { rackId: preparation.rackId, iid: preparation.artId, num: preparation.quantity }
      : ['receive','cancel'].includes(kind) ? { rackId: preparation.rackId } : null;
    if (!params || operation.method !== FLOWER_RACK_METHODS[kind] || operation.scope !== FLOWER_RACK_SCOPES[kind]) return false;
    try { assertFlowerRackProposal({ ...operation.original, contractRef: FLOWER_RACK_CONTRACT_REF, params, flowerRack: preparation }); }
    catch { return false; }
    return true;
  }
  function advanceConsumedEmptyGeneration({ context, input, state, rackId, generation, emptySemanticKey, oldSellOperationId } = {}) {
    const reject = reasonCode => ({ advanced: false, reasonCode });
    if (!isCurrent(context)) return reject('FLOWER_RACK_EMPTY_CHECKPOINT_CONTEXT_STALE');
    const config = configFor(context);
    if (config?.savedRevision !== input.config?.savedRevision || config?.config?.flowerRack?.enabled !== true)
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_CONFIG_CHANGED');
    const current = stateFor(context), currentRow = current?.state?.value?.map?.[String(rackId)];
    if (!current || current.state.value.uid !== state.state.value.uid || current.state.source?.method !== 'index.login' ||
        current.state.source?.connectionEpoch !== context.connectionEpoch || !positive(current.state.source?.requestSequence) ||
        typeof current.state.source?.responseRef !== 'string' || !current.state.source.responseRef ||
        current.state.source?.responseRef !== current.extension.loginResponseRef || currentRow?.rackId !== rackId ||
        currentRow.iid !== 0 || currentRow.num !== 0 || currentRow.sellStartTime !== null)
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_CURRENT_LOGIN_NOT_EMPTY');
    if (gatewayActivity({ subjectRef: context.subjectRef })?.inFlight !== false)
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_SUBJECT_IN_FLIGHT');
    if (get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef))
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_SUBJECT_WRITE_SLOT_ACTIVE');
    if (get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', context.subjectRef))
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_VERIFICATION_LEASE_ACTIVE');

    const oldSell = ledgerView.operation(oldSellOperationId), sellPreparation = readImmutableRackPreparation(oldSell);
    const expectedSellTarget = `sell:uid:${current.state.value.uid}:rack:${rackId}:empty:g${generation}`;
    if (!oldSell || oldSell.transport_state === 'not_sent' || oldSell.write_slot !== 0 || oldSell.business_verdict !== 'confirmed' ||
        oldSell.feature_id !== 'flower-rack' || oldSell.method !== FLOWER_RACK_METHODS.sell ||
        oldSell.scope !== FLOWER_RACK_SCOPES.sell || oldSell.semantic_key !== emptySemanticKey || !sellPreparation ||
        !assertStoredRackOperation(oldSell, sellPreparation) ||
        sellPreparation.kind !== 'sell' || sellPreparation.officialUid !== current.state.value.uid || sellPreparation.rackId !== rackId ||
        sellPreparation.targetKey !== expectedSellTarget || oldSell.owner_ref !== context.ownerRef ||
        String(oldSell.account_ref) !== String(context.accountRef) || oldSell.subject_ref !== context.subjectRef ||
        oldSell.original?.targets?.[0]?.targetRef !== `flower-rack:${context.subjectRef}:${expectedSellTarget}`)
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_SELL_NOT_CLOSED_CONFIRMED');
    const sellSettlement = oldSell.targetSettlements?.find(one => one.verdict === 'confirmed');
    if (!sellSettlement || ledgerJsonFingerprint(sellSettlement.result) !== sellSettlement.result_fingerprint)
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_SELL_SETTLEMENT_INVALID');
    const sellPayload = sellSettlement.result?.evidence?.payload;
    const soldRow = sellPayload?.postValue?.map?.[String(rackId)];
    if (sellSettlement.result?.evidence?.kind !== 'domain-verification' || sellPayload?.kind !== 'sell' ||
        sellPayload.targetRef !== oldSell.original.targets[0].targetRef || sellPayload.rackId !== rackId ||
        sellPayload.postValue?.uid !== current.state.value.uid || !positive(sellPayload.artId) || !positive(sellPayload.quantity) ||
        sellPreparation?.officialUid !== current.state.value.uid || sellPreparation?.artId !== sellPayload.artId ||
        sellPreparation?.quantity !== sellPayload.quantity ||
        soldRow?.uid !== current.state.value.uid || soldRow?.rackId !== rackId || soldRow.iid !== sellPayload.artId ||
        soldRow.num !== sellPayload.quantity || !positive(soldRow.sellStartTime))
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_SALE_OCCUPANCY_UNPROVEN');
    const saleIdentity = `${soldRow.iid}:${soldRow.sellStartTime}`;
    const receiveTarget = `receive:uid:${current.state.value.uid}:rack:${rackId}:sale:${saleIdentity}`;
    const cancelTarget = `cancel:uid:${current.state.value.uid}:rack:${rackId}:sale:${saleIdentity}`;
    const consumerRows = store.all(`SELECT operation_id FROM backend_operations WHERE owner_ref=? AND account_ref=? AND subject_ref=? AND feature_id='flower-rack'
      AND semantic_key IN (?,?) AND transport_state!='not_sent' AND write_slot=0 ORDER BY prepared_at DESC,operation_id DESC LIMIT 4`,
      context.ownerRef, String(context.accountRef), context.subjectRef,
      `${FLOWER_RACK_CONTRACT_REF}:${context.subjectRef}:${receiveTarget}`, `${FLOWER_RACK_CONTRACT_REF}:${context.subjectRef}:${cancelTarget}`);
    let consuming = null, consumingPreparation = null, isolation = null;
    for (const candidate of consumerRows) {
      const operation = ledgerView.operation(candidate.operation_id), rack = readImmutableRackPreparation(operation);
      const priorRow = rack?.sourceMap?.[String(rackId)];
      if (!operation || operation.business_verdict === 'confirmed' || operation.owner_ref !== context.ownerRef ||
          String(operation.account_ref) !== String(context.accountRef) || operation.subject_ref !== context.subjectRef ||
          !['receive','cancel'].includes(rack?.kind) || !assertStoredRackOperation(operation, rack) || operation.method !== FLOWER_RACK_METHODS[rack.kind] ||
          operation.scope !== FLOWER_RACK_SCOPES[rack.kind] || rack.officialUid !== current.state.value.uid || rack.rackId !== rackId ||
          priorRow?.uid !== current.state.value.uid || priorRow?.rackId !== rackId ||
          !positive(priorRow.iid) || priorRow.iid !== soldRow.iid || !positive(priorRow.num) || priorRow.num !== soldRow.num ||
          !positive(priorRow.sellStartTime) || priorRow.sellStartTime !== soldRow.sellStartTime ||
          `${priorRow.iid}:${priorRow.sellStartTime}` !== saleIdentity || rack.targetKey !== `${rack.kind}:uid:${current.state.value.uid}:rack:${rackId}:sale:${saleIdentity}` ||
          operation.semantic_key !== `${FLOWER_RACK_CONTRACT_REF}:${context.subjectRef}:${rack.targetKey}` ||
          operation.original?.targets?.[0]?.targetRef !== `flower-rack:${context.subjectRef}:${rack.targetKey}`) continue;
      const proof = isolationEvidence.read({ context, operationId: operation.operation_id });
      const receipt = proof && { version: proof.version, currentCheckpoint: proof.currentCheckpoint, previousExecution: proof.previousExecution,
        original: proof.original, outcomeProven: proof.outcomeProven, resourceCoverageProven: proof.resourceCoverageProven };
      const previous = proof?.previousExecution, isolated = proof?.original;
      if (proof?.available !== true || previous?.closed !== true || previous.executionClosed !== true ||
          !['backend-physical-closure','backend-physical-close-only','backend-native-executor-exit'].includes(previous.kind) ||
          isolated?.kind !== 'backend' || isolated.operationId !== operation.operation_id || isolated.originalFingerprint !== operation.original_fingerprint ||
          isolated.ownerRef !== operation.owner_ref || String(isolated.accountRef) !== String(operation.account_ref) || isolated.subjectRef !== operation.subject_ref ||
          isolated.ownerEpoch !== operation.original?.ownerEpoch || isolated.runEpoch !== operation.run_epoch ||
          isolated.connectionEpoch !== operation.connection_epoch || isolated.executorRef !== operation.original?.executorRef ||
          previous.ownerRef !== operation.owner_ref || String(previous.accountRef) !== String(operation.account_ref) || previous.subjectRef !== operation.subject_ref ||
          previous.ownerEpoch !== operation.original?.ownerEpoch || previous.runEpoch !== operation.run_epoch || previous.connectionEpoch !== operation.connection_epoch ||
          previous.executorRef !== operation.original?.executorRef || !previous.evidenceRef || !/^[a-f0-9]{64}$/.test(previous.evidenceHash || '') ||
          proof.version !== 'current-execution-isolation/v1' || fingerprint(receipt) !== proof.receiptHash ||
          proof.receiptRef !== 'current-isolation:' + proof.receiptHash) continue;
      const checkpoint = proof.currentCheckpoint;
      if (!checkpoint || !AXES.every(key => checkpoint[key] === stableContext(context)[key]) || checkpoint.uid !== current.state.value.uid ||
          checkpoint.responseRef !== current.state.source.responseRef || checkpoint.requestSequence !== current.state.source.requestSequence ||
          typeof checkpoint.wireKey !== 'string' || !checkpoint.wireKey) continue;
      consuming = operation; consumingPreparation = rack; isolation = proof; break;
    }
    if (!consuming || !isolation) return reject('FLOWER_RACK_EMPTY_CHECKPOINT_CONSUMING_OPERATION_NOT_ISOLATED');
    if (gatewayActivity({ subjectRef: context.subjectRef })?.inFlight !== false ||
        get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef) ||
        get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', context.subjectRef))
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_EXECUTION_BECAME_ACTIVE');
    const priorLife = get(`SELECT generation FROM backend_flower_rack_slot_lifecycles WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=?`,
      context.ownerRef, context.subjectRef, current.state.value.uid, rackId);
    if ((priorLife?.generation ?? 0) !== generation) return reject('FLOWER_RACK_EMPTY_CHECKPOINT_GENERATION_CHANGED');
    const checkpointKey = [context.ownerRef, context.subjectRef, current.state.value.uid, rackId, generation, oldSell.operation_id, consuming.operation_id];
    const checkpointRef = 'flower-rack-empty-checkpoint:' + fingerprint(checkpointKey);
    if (get('SELECT 1 FROM backend_flower_rack_empty_generation_checkpoints WHERE checkpoint_ref=?', checkpointRef))
      return reject('FLOWER_RACK_EMPTY_CHECKPOINT_ALREADY_RECORDED');
    const evidence = { version: 'flower-rack/consumed-empty-generation-checkpoint/v1', context: stableContext(context), officialUid: current.state.value.uid,
      rackId, oldGeneration: generation, oldSellOperationId: oldSell.operation_id, oldSellOriginalFingerprint: oldSell.original_fingerprint,
      oldSale: { artId: soldRow.iid, quantity: soldRow.num, sellStartTime: soldRow.sellStartTime, responseRef: sellPayload.postReadRef || null },
      consumingOperationId: consuming.operation_id, consumingOriginalFingerprint: consuming.original_fingerprint,
      oldConsumingSourceRef: consumingPreparation.sourceRef, currentResponseRef: current.state.source.responseRef,
      currentSourceFingerprint: current.state.fingerprint, currentMember: currentRow, isolationReceiptRef: isolation.receiptRef,
      isolationReceiptHash: isolation.receiptHash, gatewayInFlight: false, activeVerificationLease: false };
    return transaction(() => {
      if (!isCurrent(context) || configFor(context)?.savedRevision !== input.config?.savedRevision ||
          gatewayActivity({ subjectRef: context.subjectRef })?.inFlight !== false ||
          get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef) ||
          get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', context.subjectRef))
        return reject('FLOWER_RACK_EMPTY_CHECKPOINT_FINAL_FENCE_CHANGED');
      run(`INSERT OR IGNORE INTO backend_flower_rack_slot_lifecycles(owner_ref,subject_ref,official_uid,rack_id,generation,updated_at)
        VALUES(?,?,?,?,0,?)`, context.ownerRef, context.subjectRef, current.state.value.uid, rackId, nowIso());
      const changed = run(`UPDATE backend_flower_rack_slot_lifecycles SET generation=generation+1,updated_at=?
        WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=? AND generation=?`, nowIso(), context.ownerRef, context.subjectRef,
        current.state.value.uid, rackId, generation);
      if (Number(changed.changes) !== 1) return reject('FLOWER_RACK_EMPTY_CHECKPOINT_GENERATION_CAS_FAILED');
      const evidenceJson = canonical(evidence), evidenceFingerprint = fingerprint(evidence);
      const inserted = run(`INSERT OR IGNORE INTO backend_flower_rack_empty_generation_checkpoints
        (checkpoint_ref,owner_ref,subject_ref,official_uid,rack_id,old_generation,old_sell_operation_id,consuming_operation_id,
         old_sell_original_fingerprint,consuming_original_fingerprint,old_response_ref,current_response_ref,isolation_receipt_ref,isolation_receipt_hash,
         evidence_json,evidence_fingerprint,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, checkpointRef, context.ownerRef, context.subjectRef,
        current.state.value.uid, rackId, generation, oldSell.operation_id, consuming.operation_id, oldSell.original_fingerprint,
        consuming.original_fingerprint, consumingPreparation.sourceRef, current.state.source.responseRef, isolation.receiptRef,
        isolation.receiptHash, evidenceJson, evidenceFingerprint, nowIso());
      if (Number(inserted.changes) !== 1) throw new Error('FLOWER_RACK_EMPTY_CHECKPOINT_APPEND_CONFLICT');
      return { advanced: true, reasonCode: null, checkpointRef };
    });
  }
  function advanceAnsweredEmptyGeneration({ context, input, state, rackId, generation, emptySemanticKey, oldSellOperationId } = {}) {
    const reject = reasonCode => ({ advanced: false, reasonCode });
    if (!isCurrent(context)) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_CONTEXT_STALE');
    const config = configFor(context);
    if (config?.savedRevision !== input.config?.savedRevision || config?.config?.flowerRack?.enabled !== true)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_CONFIG_CHANGED');
    const current = stateFor(context), currentRow = current?.state?.value?.map?.[String(rackId)];
    const idle = () => gatewayActivity({ subjectRef: context.subjectRef })?.inFlight === false &&
      !get('SELECT 1 FROM backend_operations WHERE subject_ref=? AND write_slot=1 LIMIT 1', context.subjectRef) &&
      !get('SELECT 1 FROM backend_session_verification_leases WHERE subject_ref=? AND active=1 LIMIT 1', context.subjectRef);
    if (!current || current.state.value.uid !== state.state.value.uid || current.state.source?.method !== 'index.login' ||
        current.state.source?.connectionEpoch !== context.connectionEpoch || !positive(current.state.source?.requestSequence) ||
        current.state.source?.responseRef !== current.extension.loginResponseRef || currentRow?.uid !== current.state.value.uid ||
        currentRow.rackId !== rackId || currentRow.iid !== 0 || currentRow.num !== 0 || currentRow.sellStartTime !== null)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_CURRENT_LOGIN_NOT_EMPTY');
    if (!idle()) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_EXECUTION_ACTIVE');

    const oldSell = ledgerView.operation(oldSellOperationId), sellPreparation = readImmutableRackPreparation(oldSell);
    const uid = current.state.value.uid, targetKey = `sell:uid:${uid}:rack:${rackId}:empty:g${generation}`;
    const oldContext = oldSell && stableContext({ ownerRef: oldSell.owner_ref, accountRef: oldSell.account_ref,
      subjectRef: oldSell.subject_ref, ownerEpoch: oldSell.original?.ownerEpoch, runEpoch: oldSell.run_epoch,
      connectionEpoch: oldSell.connection_epoch });
    if (!oldSell || oldSell.transport_state !== 'answered' || oldSell.write_slot !== 0 ||
        !['unknown','unverified'].includes(oldSell.business_verdict) ||
        (oldSell.targetSettlements || []).some(one => one.verdict !== oldSell.business_verdict ||
          ledgerJsonFingerprint(one.result) !== one.result_fingerprint) || oldSell.feature_id !== 'flower-rack' ||
        oldSell.method !== FLOWER_RACK_METHODS.sell || oldSell.scope !== FLOWER_RACK_SCOPES.sell ||
        oldSell.semantic_key !== emptySemanticKey || !sellPreparation || !assertStoredRackOperation(oldSell, sellPreparation) ||
        sellPreparation.kind !== 'sell' || sellPreparation.officialUid !== uid || sellPreparation.rackId !== rackId ||
        sellPreparation.targetKey !== targetKey || oldSell.owner_ref !== context.ownerRef || String(oldSell.account_ref) !== String(context.accountRef) ||
        oldSell.subject_ref !== context.subjectRef || oldSell.original?.targets?.[0]?.targetRef !== `flower-rack:${context.subjectRef}:${targetKey}` ||
        !positive(oldContext?.ownerEpoch) || !positive(oldContext?.runEpoch) || !positive(oldContext?.connectionEpoch))
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_SELL_NOT_ELIGIBLE');

    const priorEmpty = facts.readHistoricalReceipt({ ownerRef: oldContext.ownerRef, accountRef: String(oldContext.accountRef),
      subjectRef: oldContext.subjectRef, ownerEpoch: oldContext.ownerEpoch, runEpoch: oldContext.runEpoch,
      connectionEpoch: oldContext.connectionEpoch, requestSequence: sellPreparation.sourceSequence,
      responseRef: sellPreparation.sourceRef, officialUid: uid });
    const priorEmptyRow = priorEmpty?.value?.map?.[String(rackId)];
    if (priorEmpty?.current !== false || priorEmpty.source?.method !== 'index.login' ||
        priorEmpty.source.responseRef !== sellPreparation.sourceRef || priorEmpty.source.requestSequence !== sellPreparation.sourceSequence ||
        priorEmpty.source.connectionEpoch !== oldContext.connectionEpoch || priorEmpty.fingerprint !== sellPreparation.sourceFingerprint ||
        canonical(priorEmpty.value?.map) !== canonical(sellPreparation.sourceMap) || priorEmpty.value?.uid !== uid ||
        priorEmptyRow?.uid !== uid || priorEmptyRow.rackId !== rackId || priorEmptyRow.iid !== 0 ||
        priorEmptyRow.num !== 0 || priorEmptyRow.sellStartTime !== null)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_PRIOR_EMPTY_NOT_PROVEN');

    const answerRows = store.all(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at,recorded_at
      FROM backend_operation_evidence WHERE operation_id=? AND kind='official-answer' AND source='backend/write-gateway/v2'
      ORDER BY evidence_id LIMIT 3`, oldSell.operation_id);
    if (answerRows.length !== 1) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ANSWER_NOT_UNIQUE');
    const answerRow = answerRows[0]; let answer;
    try { answer = parseStored(answerRow.payload_json, '花架已答复卖出原件'); } catch { answer = null; }
    const permit = get('SELECT * FROM backend_send_permits WHERE operation_id=?', oldSell.operation_id);
    if (!answer || ledgerJsonFingerprint({ kind: answerRow.kind, source: answerRow.source, payload: answer, observedAt: answerRow.observed_at }) !== answerRow.payload_fingerprint ||
        answer.method !== oldSell.method || answer.connectionEpoch !== oldSell.connection_epoch || !positive(answer.requestSequence) ||
        typeof answer.responseRef !== 'string' || !answer.responseRef || typeof answer.wireKey !== 'string' || !answer.wireKey ||
        !positive(answer.receivedDeviceMs) || answer.rejected !== false || !permit || permit.owner_ref !== oldSell.owner_ref ||
        permit.subject_ref !== oldSell.subject_ref ||
        permit.owner_epoch !== oldContext.ownerEpoch || permit.run_epoch !== oldSell.run_epoch || permit.connection_epoch !== oldSell.connection_epoch ||
        permit.method !== oldSell.method || permit.params_fingerprint !== oldSell.params_fingerprint || permit.consumed !== 1 ||
        permit.request_sequence !== answer.requestSequence || permit.wire_key !== answer.wireKey)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ANSWER_INVALID');

    let releaseRow = null, release = null, termination = null, checkpoint = null, factBasis = null, leaseEvent = null, recovered = null,
      newContext = null, login = null, previousExecution = null;
    const answerOccupied = facts.readHistoricalReceipt({ ownerRef: oldContext.ownerRef, accountRef: String(oldContext.accountRef),
      subjectRef: oldContext.subjectRef, ownerEpoch: oldContext.ownerEpoch, runEpoch: oldContext.runEpoch,
      connectionEpoch: oldContext.connectionEpoch, requestSequence: answer.requestSequence, responseRef: answer.responseRef, officialUid: uid });
    const answerOccupiedRow = answerOccupied?.value?.map?.[String(rackId)];
    const answerReceiptMissing = answerOccupied?.reasonCode === 'FLOWER_RACK_HISTORICAL_RECEIPT_NOT_FOUND';
    if (!answerReceiptMissing && (answerOccupied?.current !== false || !answerOccupied.value || answerOccupied.reasonCode))
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ANSWER_RECEIPT_INVALID');
    const answerOccupiedValid = answerOccupied?.current === false && answerOccupied.source?.method === oldSell.method &&
      answerOccupied.source.responseRef === answer.responseRef && answerOccupied.source.requestSequence === answer.requestSequence &&
      answerOccupied.source.connectionEpoch === oldContext.connectionEpoch && answerOccupied.source.receivedDeviceMs === answer.receivedDeviceMs &&
      answerOccupied.value?.uid === uid && answerOccupiedRow?.uid === uid && answerOccupiedRow.rackId === rackId &&
      answerOccupiedRow.iid === sellPreparation.artId && answerOccupiedRow.num === sellPreparation.quantity && positive(answerOccupiedRow.sellStartTime);
    if (!answerReceiptMissing && answerOccupiedRow && !answerOccupiedValid)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ANSWER_RECEIPT_CONFLICT');
    if (!answerReceiptMissing && !answerOccupiedRow && (!answerOccupied.source || answerOccupied.source.method !== oldSell.method ||
        answerOccupied.source.responseRef !== answer.responseRef || answerOccupied.source.requestSequence !== answer.requestSequence ||
        answerOccupied.source.connectionEpoch !== oldContext.connectionEpoch || answerOccupied.source.receivedDeviceMs !== answer.receivedDeviceMs ||
        answerOccupied.value?.uid !== uid))
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ANSWER_RECEIPT_INVALID');
    let occupied = answerOccupiedValid ? answerOccupied : null;
    let occupiedRow = answerOccupiedValid ? answerOccupiedRow : null;
    let occupiedContext = answerOccupiedValid ? oldContext : null;
    if (!occupied) {
    const releaseRows = store.all(`SELECT evidence_id,kind,source,payload_json,payload_fingerprint,observed_at,recorded_at
      FROM backend_operation_evidence WHERE operation_id=? AND kind='historical-write-slot-release'
        AND source='backend/closed-write-recovery/v1' ORDER BY evidence_id LIMIT 3`, oldSell.operation_id);
    if (releaseRows.length !== 1) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_SLOT_RELEASE_NOT_UNIQUE');
    releaseRow = releaseRows[0];
    try { release = parseStored(releaseRow.payload_json, '花架旧槽位技术释放原件'); } catch { release = null; }
    termination = release?.transportTermination; checkpoint = release?.checkpoint; factBasis = checkpoint?.factBasis;
    if (!release || ledgerJsonFingerprint({ kind: releaseRow.kind, source: releaseRow.source, payload: release, observedAt: releaseRow.observed_at }) !== releaseRow.payload_fingerprint ||
        release.technicalSlotOnly !== true || termination?.ended !== true || termination.operationId !== oldSell.operation_id ||
        termination.connectionEpoch !== oldSell.connection_epoch || termination.source !== 'stored-native-executor-isolation' ||
        typeof termination.evidenceRef !== 'string' || !termination.evidenceRef || release.closureOrIsolationRef !== termination.evidenceRef ||
        release.executorIsolation?.isolated !== true || release.executorIsolation.executorRef !== oldSell.original?.executorRef ||
        release.executorIsolation.ownerRef !== oldSell.owner_ref || release.executorIsolation.ownerEpoch !== oldContext.ownerEpoch ||
        release.executorIsolation.runEpoch !== oldSell.run_epoch || release.executorIsolation.connectionEpoch !== oldSell.connection_epoch ||
        release.executorIsolation.evidenceRef !== termination.evidenceRef || checkpoint?.subjectRef !== context.subjectRef ||
        checkpoint.source !== 'current-matched-official-login' ||
        checkpoint.runEpoch <= oldSell.run_epoch || checkpoint.connectionEpoch <= oldSell.connection_epoch ||
        checkpoint.checkpointRef !== release.currentCheckpointRef || factBasis?.version !== 'matched-official-login/v1' ||
        factBasis.officialUid !== uid || factBasis.responseRef !== factBasis.checkpointResponseRef ||
        factBasis.requestSequence !== factBasis.checkpointRequestSequence || factBasis.checkpointConnectionEpoch !== checkpoint.connectionEpoch ||
        checkpoint.checkpointRef !== release.currentCheckpointRef || checkpoint.checkpointRef !== factBasis.responseRef ||
        !positive(factBasis.requestSequence) || !positive(factBasis.checkpointRequestSequence) ||
        !positive(checkpoint.connectionEpoch) || !positive(checkpoint.runEpoch))
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_SLOT_RELEASE_INVALID');

    const leaseEvents = store.all(`SELECT l.lease_ref,l.operation_id,l.owner_ref,l.account_ref,l.subject_ref,l.executor_ref,l.owner_epoch,l.run_epoch,
        l.original_connection_epoch,l.new_connection_epoch,l.active,l.state,e.event_ref,e.event_kind,e.receipt_json,e.recorded_at
      FROM backend_session_verification_leases l JOIN backend_session_verification_events e ON e.lease_ref=l.lease_ref
      WHERE l.operation_id=? AND l.owner_ref=? AND l.account_ref=? AND l.subject_ref=? AND l.executor_ref=? AND l.owner_epoch=? AND
        l.run_epoch=? AND l.original_connection_epoch=? AND e.event_kind='recovered-technical-isolation-retired'
      ORDER BY e.recorded_at,e.event_ref LIMIT 3`, oldSell.operation_id, oldSell.owner_ref, String(oldSell.account_ref),
      oldSell.subject_ref, oldSell.original?.executorRef, oldContext.ownerEpoch, oldSell.run_epoch, oldSell.connection_epoch);
    if (leaseEvents.length !== 1) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_RECOVERY_EVENT_NOT_UNIQUE');
    leaseEvent = leaseEvents[0];
    try { recovered = parseStored(leaseEvent.receipt_json, '花架旧槽位隔离恢复事件'); } catch { recovered = null; }
    newContext = recovered?.newContext; login = recovered?.currentLoginSource; previousExecution = recovered?.previousExecution;
    if (!recovered || leaseEvent.operation_id !== oldSell.operation_id || leaseEvent.active !== 0 || leaseEvent.state !== 'recovered-retired' ||
        leaseEvent.new_connection_epoch !== null && (!positive(leaseEvent.new_connection_epoch) ||
          leaseEvent.new_connection_epoch <= oldSell.connection_epoch || leaseEvent.new_connection_epoch > checkpoint.connectionEpoch) ||
        recovered.operationId !== oldSell.operation_id ||
        (oldSell.business_verdict === 'unverified' ? recovered.recoveryEvidenceId !== releaseRow.evidence_id :
          recovered.recoveryEvidenceId !== null) || recovered.originalVerdict !== oldSell.business_verdict ||
        recovered.originalOutcomeAndResourcesUnchanged !== true || canonical(stableContext(recovered.originalContext)) !== canonical(oldContext) ||
        !newContext || !positive(newContext.ownerEpoch) || !positive(newContext.runEpoch) || !positive(newContext.connectionEpoch) ||
        newContext.ownerRef !== oldContext.ownerRef || String(newContext.accountRef) !== oldContext.accountRef ||
        newContext.subjectRef !== oldContext.subjectRef ||
        newContext.runEpoch !== checkpoint.runEpoch || newContext.connectionEpoch !== checkpoint.connectionEpoch ||
        login?.kind !== 'response' || login.transport !== 'answered' || login.method !== 'index.login' || login.officialUid !== uid ||
        login.responseRef !== factBasis.responseRef || login.requestSequence !== factBasis.requestSequence ||
        login.connectionEpoch !== checkpoint.connectionEpoch || login.versionEvidence?.source !== 'normal-package-hop-and-matched-world-login/v1' ||
        login.versionEvidence.loginResponseRef !== login.responseRef || !positive(login.serverId) || typeof login.wireKey !== 'string' ||
        !login.wireKey || !positive(login.receivedDeviceMs) ||
        previousExecution?.kind !== 'stored-native-executor-exit' || previousExecution.evidenceRef !== termination.evidenceRef ||
        previousExecution.executionConnectionEpoch !== (leaseEvent.new_connection_epoch ?? leaseEvent.original_connection_epoch) ||
        leaseEvent.recorded_at < releaseRow.recorded_at ||
        releaseRow.recorded_at < answerRow.recorded_at)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_RECOVERY_EVENT_INVALID');

    occupied = facts.readHistoricalReceipt({ ownerRef: newContext.ownerRef, accountRef: String(newContext.accountRef),
      subjectRef: newContext.subjectRef, ownerEpoch: newContext.ownerEpoch, runEpoch: newContext.runEpoch,
      connectionEpoch: newContext.connectionEpoch, requestSequence: login.requestSequence, responseRef: login.responseRef, officialUid: uid });
    occupiedRow = occupied?.value?.map?.[String(rackId)];
    occupiedContext = newContext;
    if (occupied?.current !== false || occupied?.source?.method !== 'index.login' || occupied.source.responseRef !== login.responseRef ||
        occupied.source.requestSequence !== login.requestSequence || occupied.source.connectionEpoch !== newContext.connectionEpoch ||
        occupied.source.receivedDeviceMs !== login.receivedDeviceMs || occupied.value?.uid !== uid || occupiedRow?.uid !== uid ||
        occupiedRow?.rackId !== rackId || occupiedRow.iid !== sellPreparation.artId || occupiedRow.num !== sellPreparation.quantity ||
        !positive(occupiedRow.sellStartTime) || occupied.source.receivedDeviceMs < answer.receivedDeviceMs ||
        priorEmpty.source.receivedDeviceMs > answer.receivedDeviceMs)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_OCCUPANCY_NOT_PROVEN');
    }
    if (!occupied || priorEmpty.source.requestSequence >= answer.requestSequence ||
        priorEmpty.source.receivedDeviceMs > answer.receivedDeviceMs ||
        occupied.source.receivedDeviceMs < answer.receivedDeviceMs)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_OCCUPANCY_TIME_INVALID');

    const isolation = isolationEvidence.read({ context, operationId: oldSell.operation_id });
    const proof = isolation && { version: isolation.version, currentCheckpoint: isolation.currentCheckpoint, previousExecution: isolation.previousExecution,
      original: isolation.original, outcomeProven: isolation.outcomeProven, resourceCoverageProven: isolation.resourceCoverageProven };
    const previous = isolation?.previousExecution, original = isolation?.original, currentCheckpoint = isolation?.currentCheckpoint;
    if (isolation?.available !== true || isolation.version !== 'current-execution-isolation/v1' ||
        isolation.outcomeProven !== false || isolation.resourceCoverageProven !== false || previous?.closed !== true || previous.executionClosed !== true ||
        !['backend-physical-closure','backend-physical-close-only','backend-native-executor-exit'].includes(previous.kind) ||
        termination && previous.evidenceRef !== termination.evidenceRef || previous.connectionEpoch !== oldSell.connection_epoch ||
        !/^[a-f0-9]{64}$/.test(previous.evidenceHash || '') ||
        previous.ownerRef !== oldSell.owner_ref || String(previous.accountRef) !== String(oldSell.account_ref) || previous.subjectRef !== oldSell.subject_ref ||
        previous.ownerEpoch !== oldContext.ownerEpoch || previous.runEpoch !== oldSell.run_epoch || previous.executorRef !== oldSell.original?.executorRef ||
        original?.kind !== 'backend' || original.operationId !== oldSell.operation_id || original.originalFingerprint !== oldSell.original_fingerprint ||
        original.ownerRef !== oldSell.owner_ref || String(original.accountRef) !== String(oldSell.account_ref) || original.subjectRef !== oldSell.subject_ref ||
        original.ownerEpoch !== oldContext.ownerEpoch || original.runEpoch !== oldSell.run_epoch || original.connectionEpoch !== oldSell.connection_epoch ||
        original.executorRef !== oldSell.original?.executorRef || original.transportState !== oldSell.transport_state ||
        original.businessVerdict !== oldSell.business_verdict || original.writeSlot !== oldSell.write_slot || !currentCheckpoint ||
        !Number.isFinite(Date.parse(previous.recordedAt)) || current.state.source.receivedDeviceMs < Date.parse(previous.recordedAt) ||
        !AXES.every(key => currentCheckpoint[key] === stableContext(context)[key]) ||
        currentCheckpoint.uid !== uid || currentCheckpoint.responseRef !== current.state.source.responseRef ||
        currentCheckpoint.requestSequence !== current.state.source.requestSequence || typeof currentCheckpoint.wireKey !== 'string' || !currentCheckpoint.wireKey ||
        login && login.serverId !== currentCheckpoint.serverId ||
        fingerprint(proof) !== isolation.receiptHash || isolation.receiptRef !== 'current-isolation:' + isolation.receiptHash)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_OLD_EXECUTION_NOT_ISOLATED');
    if (!occupiedContext || context.ownerRef !== occupiedContext.ownerRef || String(context.accountRef) !== String(occupiedContext.accountRef) ||
        context.subjectRef !== occupiedContext.subjectRef || context.runEpoch < occupiedContext.runEpoch ||
        context.connectionEpoch <= occupiedContext.connectionEpoch || current.state.source.responseRef === occupied.source.responseRef ||
        current.state.source.receivedDeviceMs <= occupied.source.receivedDeviceMs)
      return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_CURRENT_LOGIN_NOT_LATER');

    const priorLife = get(`SELECT generation FROM backend_flower_rack_slot_lifecycles WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=?`,
      context.ownerRef, context.subjectRef, uid, rackId);
    if ((priorLife?.generation ?? 0) !== generation) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_GENERATION_CHANGED');
    if (get(`SELECT 1 FROM backend_flower_rack_slot_transitions WHERE owner_ref=? AND subject_ref=? AND operation_id=? LIMIT 1`,
      context.ownerRef, context.subjectRef, oldSell.operation_id)) return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_ALREADY_RECORDED');
    const transition = { version: 'flower-rack/answered-sell-empty-retirement/v1', operationId: oldSell.operation_id,
      oldSellOriginalFingerprint: oldSell.original_fingerprint, oldSemanticKey: emptySemanticKey, officialUid: uid, rackId,
      oldGeneration: generation, oldOccupied: { responseRef: occupied.source.responseRef, fingerprint: occupied.fingerprint,
        requestSequence: occupied.source.requestSequence, connectionEpoch: occupied.source.connectionEpoch,
        receivedDeviceMs: occupied.source.receivedDeviceMs, member: occupiedRow },
      occupiedContext: stableContext(occupiedContext),
      priorEmpty: { responseRef: priorEmpty.source.responseRef, fingerprint: priorEmpty.fingerprint,
        requestSequence: priorEmpty.source.requestSequence, connectionEpoch: priorEmpty.source.connectionEpoch,
        receivedDeviceMs: priorEmpty.source.receivedDeviceMs, member: priorEmptyRow },
      officialAnswer: { evidenceId: answerRow.evidence_id, fingerprint: answerRow.payload_fingerprint, responseRef: answer.responseRef,
        requestSequence: answer.requestSequence, connectionEpoch: answer.connectionEpoch, wireKey: answer.wireKey },
      slotRelease: releaseRow ? { evidenceId: releaseRow.evidence_id, fingerprint: releaseRow.payload_fingerprint, observedAt: releaseRow.observed_at,
        transportTermination: termination, currentCheckpointRef: release.currentCheckpointRef } : null,
      recoveredIsolationEvent: leaseEvent ? { leaseRef: leaseEvent.lease_ref, eventRef: leaseEvent.event_ref, receiptFingerprint: fingerprint(recovered), recordedAt: leaseEvent.recorded_at,
        newContext: stableContext(newContext), currentLoginSource: { responseRef: login.responseRef, requestSequence: login.requestSequence,
          connectionEpoch: login.connectionEpoch, receivedDeviceMs: login.receivedDeviceMs }, previousExecution } : null,
      isolationReceiptRef: isolation.receiptRef, isolationReceiptHash: isolation.receiptHash,
      currentEmpty: { responseRef: current.state.source.responseRef, requestSequence: current.state.source.requestSequence,
        connectionEpoch: current.state.source.connectionEpoch, fingerprint: current.state.fingerprint, member: currentRow },
      currentContext: stableContext(context), gatewayInFlight: false, activeVerificationLease: false };
    const transitionRef = 'flower-rack-transition:' + fingerprint([context.ownerRef, context.subjectRef, oldSell.operation_id, transition]);
    return transaction(() => {
      if (!isCurrent(context) || configFor(context)?.savedRevision !== input.config?.savedRevision || !idle())
        return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_FINAL_FENCE_CHANGED');
      const finalCurrent = stateFor(context), finalRow = finalCurrent?.state?.value?.map?.[String(rackId)];
      const finalLife = get(`SELECT generation FROM backend_flower_rack_slot_lifecycles WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=?`,
        context.ownerRef, context.subjectRef, uid, rackId);
      if (!finalCurrent || finalCurrent.state.source?.responseRef !== current.state.source.responseRef || finalRow?.uid !== uid ||
          finalRow.rackId !== rackId || finalRow.iid !== 0 || finalRow.num !== 0 || finalRow.sellStartTime !== null ||
          (finalLife?.generation ?? 0) !== generation || get(`SELECT 1 FROM backend_flower_rack_slot_transitions
            WHERE owner_ref=? AND subject_ref=? AND operation_id=? LIMIT 1`, context.ownerRef, context.subjectRef, oldSell.operation_id))
        return reject('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_FINAL_FACTS_CHANGED');
      run(`INSERT OR IGNORE INTO backend_flower_rack_slot_lifecycles(owner_ref,subject_ref,official_uid,rack_id,generation,updated_at)
        VALUES(?,?,?,?,0,?)`, context.ownerRef, context.subjectRef, uid, rackId, nowIso());
      const inserted = run(`INSERT OR IGNORE INTO backend_flower_rack_slot_transitions
        (transition_ref,owner_ref,subject_ref,official_uid,rack_id,operation_id,old_response_ref,new_response_ref,payload_json,payload_fingerprint,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, transitionRef, context.ownerRef, context.subjectRef, uid, rackId, oldSell.operation_id,
        occupied.source.responseRef, current.state.source.responseRef, canonical(transition), fingerprint(transition), nowIso());
      if (Number(inserted.changes) !== 1) throw new Error('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_APPEND_CONFLICT');
      const changed = run(`UPDATE backend_flower_rack_slot_lifecycles SET generation=generation+1,updated_at=?
        WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=? AND generation=?`, nowIso(), context.ownerRef,
        context.subjectRef, uid, rackId, generation);
      if (Number(changed.changes) !== 1) throw new Error('FLOWER_RACK_ANSWERED_EMPTY_RETIREMENT_GENERATION_CAS_FAILED');
      return { advanced: true, reasonCode: null, transitionRef };
    });
  }
  function assess(input) {
    const cfg = input.config?.config?.flowerRack;
    const actionKind = input.actionKind || 'all';
    const doReceive = actionKind === 'all' || actionKind === 'receive';
    const doSell = actionKind === 'all' || actionKind === 'sell';
    const doCancel = actionKind === 'all' || actionKind === 'cancel';
    const doUnlock = actionKind === 'all' || actionKind === 'unlock';
    if (![cfg?.enabled, cfg?.autoTakeDown, cfg?.unlockEnabled].some(value => value === true)) return { state: 'disabled', reasonCode: 'FLOWER_RACK_DISABLED' };
    if (!isCurrent(input.context)) return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_CONTEXT_NOT_CURRENT', deviceDueMs: Date.now() + 30000 };
    const state = stateFor(input.context), snapshotDomains = domains(input.context, null, actionKind === 'all' ? null : actionKind);
    if (!state || !snapshotDomains) return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_FACTS_NOT_CURRENT', deviceDueMs: Date.now() + 15000 };
    const map = state.state.value.map;
    if (!map) return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_MAP_NOT_SUPPLIED', deviceDueMs: Date.now() + 30000 };
    // Unknown/absent members are never synthesized. Only a server-provided
    // member with no iid is an eligible empty slot.
    const rows = Object.values(map);
    let checkpointBlockReason = null;
    for (const row of rows) {
      const started = row.sellStartTime;
      if (positive(row.iid) && positive(row.num) && positive(started)) {
        const elapsedUpper = state.clock.lowerBoundMs - started;
        const doneAt = started + row.num * state.rules.sellTimeSeconds * 1000;
        if (doReceive && cfg.enabled === true && elapsedUpper >= row.num * state.rules.sellTimeSeconds * 1000) {
          const proposal = makeProposal({ context: input.context, input, state, kind: 'receive', rack: row });
          const admitted = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
          if (admitted.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis };
          checkpointBlockReason ||= admitted.reasonCode;
          continue;
        }
        const minimumHold = Math.max(state.rules.lockTimeSeconds * 1000, cfg.keepMinutes * 60000);
        if (doCancel && cfg.autoTakeDown === true && state.clock.lowerBoundMs > started + minimumHold && state.clock.upperBoundMs < doneAt) {
          // Cancellation returns the sold item. Capture the current known
          // inventory amount before sending so the after-close login can prove
          // the returned quantity. A missing balance cannot satisfy the
          // existing effect contract and must wait instead of creating an
          // answered-but-unverifiable write.
          const bag = readBag(input.context), balance = resources.balance({ context: input.context, itemId: row.iid }), base = balance?.base;
          if (bag?.complete !== true || bag?.state !== 'known' || bag.source?.connectionEpoch !== input.context.connectionEpoch ||
              base?.known !== true || !nonnegative(base.value) || base.source?.connectionEpoch !== input.context.connectionEpoch ||
              base.source?.responseRef !== bag.source?.responseRef) {
            return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_CANCEL_CURRENT_ITEM_BALANCE_REQUIRED', deviceDueMs: Date.now() + 30000 };
          }
          const proposal = makeProposal({ context: input.context, input, state, kind: 'cancel', rack: row, balance });
          if (proposal.flowerRack.beforeItem !== base.value || proposal.flowerRack.beforeItemSource?.responseRef !== base.source.responseRef) {
            return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_CANCEL_BEFORE_ITEM_SOURCE_MISMATCH', deviceDueMs: Date.now() + 30000 };
          }
          const admitted = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
          if (admitted.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis };
          checkpointBlockReason ||= admitted.reasonCode;
          continue;
        }
      }
    }
    if (doSell && cfg.enabled === true) {
      const bag = readBag(input.context), catalog = catalogForContext(input.context);
      if (bag?.complete !== true || bag?.state !== 'known' || bag.source?.connectionEpoch !== input.context.connectionEpoch ||
          !bag.items || !Object.values(bag.items).every(cell => cell?.presence === 'present' && cell.state === 'known' && nonnegative(cell.value)))
        return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_COMPLETE_CURRENT_BAG_REQUIRED', deviceDueMs: Date.now() + 30000 };
      const allowed = Array.isArray(cfg.artIds) && cfg.artIds.length > 0 ? new Set(cfg.artIds) : null;
      const stockedCandidates = Object.entries(bag.items).flatMap(([key, cell]) => {
        const id = Number(key);
        // Honor the exact selected IDs and stock before querying a current
        // catalog row; unrelated bag members cannot become sale candidates.
        if (!(Number.isSafeInteger(id) && id > 0 && cell.value > 0 && (!allowed || allowed.has(id)))) return [];
        const item = catalog?.item?.(id);
        if (item?.bType !== 3) return [];
        return [{ id, stock: cell.value }];
      });
      const selected = stockedCandidates.map(one => ({ ...one, price: cfg.sortStrategy === 'max_price' ? priceFor(input.context, one.id) : null }));
      if (cfg.sortStrategy === 'max_price' && selected.some(one => !one.price))
        return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_CURRENT_PRICE_NOT_PROVEN', deviceDueMs: Date.now() + 30000 };
      if (cfg.sortStrategy === 'max_price' && selected.length && new Set(selected.map(one => one.price.currencyId)).size !== 1)
        return { state: 'waiting-facts', reasonCode: 'FLOWER_RACK_PRICE_CURRENCY_NOT_COMPARABLE', deviceDueMs: Date.now() + 30000 };
      selected.sort((left, right) => cfg.sortStrategy === 'max_price' ? right.price.amount - left.price.amount || left.id - right.id
        : cfg.sortStrategy === 'min_stock' ? left.stock - right.stock || left.id - right.id : right.stock - left.stock || left.id - right.id);
      const ranked=selected.map(one=>({artId:one.id,stock:one.stock,price:one.price?
        {currencyId:one.price.currencyId,amount:one.price.amount,priceRef:one.price.priceRef}:null}));
      const selectionEvidence={version:'flower-rack/ranked-stocked-candidates/v1',sortStrategy:cfg.sortStrategy,
        bagSource:bag.source,complete:ranked.length<=64,total:ranked.length,ranked:ranked.length<=64?ranked:null,
        rankedFingerprint:fingerprint(ranked),scope:'current-stocked-candidates-before-per-candidate-budget-and-demand-check'};
      const empty = rows.filter(row => !positive(row.iid) && row.sellStartTime == null).map(row => row.rackId);
      if (!empty.length) checkpointBlockReason ||= 'FLOWER_RACK_NO_CURRENT_EMPTY_SLOT';
      else if (!selected.length) checkpointBlockReason ||= 'FLOWER_RACK_NO_SELECTED_CURRENT_STOCK';
      for (const rackId of empty) {
        const stand = Object.values(state.rules.stands).find(one => one.rackIds.includes(rackId));
        if (!stand) continue;
        const life = get('SELECT generation FROM backend_flower_rack_slot_lifecycles WHERE owner_ref=? AND subject_ref=? AND official_uid=? AND rack_id=?',
          input.context.ownerRef, input.context.subjectRef, state.state.value.uid, rackId);
        const generation = life?.generation || 0;
        const emptyTargetKey = `sell:uid:${state.state.value.uid}:rack:${rackId}:empty:g${generation}`;
        const emptySemanticKey = `${FLOWER_RACK_CONTRACT_REF}:${input.context.subjectRef}:${emptyTargetKey}`;
        const existing = get(`SELECT operation_id FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND feature_id='flower-rack'
          AND scope=? AND method=? AND semantic_key=? AND transport_state!='not_sent'
          ORDER BY prepared_at DESC,operation_id DESC LIMIT 1`, input.context.ownerRef, input.context.subjectRef,
          FLOWER_RACK_SCOPES.sell, FLOWER_RACK_METHODS.sell, emptySemanticKey);
        if (existing) {
          const oldSell = ledgerView.operation(existing.operation_id);
          const checkpoint = oldSell?.business_verdict === 'confirmed'
            ? advanceConsumedEmptyGeneration({ context: input.context, input, state, rackId, generation, emptySemanticKey,
              oldSellOperationId: existing.operation_id })
            : advanceAnsweredEmptyGeneration({ context: input.context, input, state, rackId, generation, emptySemanticKey,
              oldSellOperationId: existing.operation_id });
          if (!checkpoint.advanced) { checkpointBlockReason ||= checkpoint.reasonCode; continue; }
        }
        for (const candidate of selected) {
          const artId = candidate.id;
          const balance = resources.balance({ context: input.context, itemId: artId });
          if (balance?.base?.known !== true || !nonnegative(balance.base.value)) { checkpointBlockReason ||= 'FLOWER_RACK_SELECTED_BALANCE_UNKNOWN'; continue; }
          const quantity = Math.min(cfg.putCount, state.rules.maxSellNum, balance.base.value);
          if (!positive(quantity)) continue;
          const budget = resources.budget({ context: input.context, itemId: artId, quantity, keep: 0 });
          const related = readRelatedDemand({ context: input.context, itemId: artId, kind: 'finished-art' });
          if (related?.current !== true || !nonnegative(related.protectedQuantity)) { checkpointBlockReason ||= related?.reasonCode || 'FLOWER_RACK_RELATED_DEMAND_NOT_CURRENT'; continue; }
          const protectedBudget = resources.budget({ context: input.context, itemId: artId, quantity, keep: related.protectedQuantity });
          if (budget?.allowed !== true || protectedBudget?.allowed !== true) { checkpointBlockReason ||= protectedBudget?.reasonCode || budget?.reasonCode || 'FLOWER_RACK_SHARED_STOCK_NOT_AVAILABLE'; continue; }
          const proposal = makeProposal({ context: input.context, input, state, kind: 'sell', rack: { rackId }, artId, quantity, balance,
            priceProof: candidate.price, selectionEvidence });
          const admitted = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
          if (admitted.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis };
        }
      }
    }
    if (doUnlock && cfg.unlockEnabled === true) {
      const profile = readProfile({ context: input.context })?.profile, level = profile?.level;
      for (const stand of Object.values(state.rules.stands)) {
        if (stand.rackIds.some(id => Object.hasOwn(map, String(id)))) continue;
        if (!Array.isArray(stand.unlockCost) || stand.unlockCost[0] !== 11 || !Number.isSafeInteger(stand.unlockCost[1]) || stand.unlockCost[1] <= 0 ||
            !Number.isSafeInteger(stand.unlockLevel) || !Number.isSafeInteger(level) || level < stand.unlockLevel) continue;
        const budget = resources.currencyBudget({ context: input.context, currency: 'gold', quantity: stand.unlockCost[1],
          keep: cfg.unlockKeepGold });
        if (!budget.allowed) continue;
        const proposal = makeProposal({ context: input.context, input, state, kind: 'unlock', rack: { rackId: stand.standId } });
        const admitted = evaluateAdmission({ proposal, actor: input.context, factBasis: proposal.factBasis, boundary: 'before-prepare' });
        if (admitted.allowed) return { state: 'proposals', proposals: [proposal], factBasis: proposal.factBasis };
      }
    }
    return { state: 'waiting-facts', reasonCode: checkpointBlockReason || (cfg.unlockEnabled ? 'FLOWER_RACK_GOLD_BUDGET_NOT_AVAILABLE' : 'FLOWER_RACK_NO_CURRENT_ACTION'), deviceDueMs: Date.now() + 30000 };
  }
  async function verify({ proposal, response, connection } = {}) {
    const unknown = reasonCode => ({ verdict: 'unknown', reasonCode, verificationVersion: 'flower-rack/target-postread/v1',
      evidence: { targetRef: proposal?.targets?.[0]?.targetRef || null, extensionRef: proposal?.flowerRack?.extensionRef || null,
        reasonCode }, resourceResolutions: (proposal?.resources || []).map(one => ({ resourceKey: one.resourceKey, state: 'historical_footprint' })) });
    let bridge;
    try { bridge = await connection.readSnapshotAfterClose(); } catch (error) { return unknown(error?.code || 'FLOWER_RACK_POSTREAD_FAILED'); }
    const post = bridge?.newLoginObservation;
    if (bridge?.operationId !== proposal.operationId || bridge.oldPhysicalCloseReceipt?.closed !== true ||
        post?.method !== 'index.login' || post.source !== 'response' || post.transport !== 'answered' || post.envelopeOk !== true ||
        post.dsName !== 'G.ISyncData' || bridge.officialUid !== proposal.flowerRack.officialUid) return unknown('FLOWER_RACK_POSTREAD_INVALID');
    const after = facts.read(bridge.newContext), extension = extensionForContext(bridge.newContext), state = after?.value?.map?.[String(proposal.flowerRack.rackId)];
    const body = extension && Object.fromEntries(Object.entries(extension).filter(([key]) => key !== 'extensionRef'));
    if (after?.current !== true || after.source?.responseRef !== post.responseRef || !extension || extension.sourcePin !== proposal.flowerRack.extension.sourcePin ||
        extension.bundleRef !== proposal.flowerRack.bundleRef || extension.loginResponseRef !== post.responseRef || !body ||
        extension.extensionRef !== 'sha256:' + fingerprint(body)) return unknown('FLOWER_RACK_POSTREAD_FACTS_NOT_CURRENT');
    let effect = false, flow = null, profileFlow = null, before = null, afterValue = null;
    if (proposal.flowerRack.kind === 'sell') {
      flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId: proposal.flowerRack.artId,
        featureId: proposal.featureId, contractRef: proposal.contractRef, action: proposal.flowerRack });
      const newBalance = resources.balance({ context: bridge.newContext, itemId: proposal.flowerRack.artId })?.base;
      before = proposal.flowerRack.beforeItem; afterValue = newBalance?.value;
      effect = state?.iid === proposal.flowerRack.artId && state?.num === proposal.flowerRack.quantity &&
        flow?.method === proposal.method && flow?.bo?.state === 'known' && flow.bo.value === proposal.flowerRack.quantity &&
        newBalance?.known === true && nonnegative(before) && before - afterValue === flow.bo.value &&
        newBalance.source?.responseRef === post.responseRef;
    } else if (proposal.flowerRack.kind === 'cancel') {
      flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId: proposal.flowerRack.artId,
        featureId: proposal.featureId, contractRef: proposal.contractRef, action: proposal.flowerRack });
      const newBalance = resources.balance({ context: bridge.newContext, itemId: proposal.flowerRack.artId })?.base;
      before = proposal.flowerRack.beforeItem; afterValue = newBalance?.value;
      effect = state && !positive(state.iid) && flow?.method === proposal.method && flow?.bi?.state === 'known' &&
        positive(flow.bi.value) && flow.bi.value <= proposal.flowerRack.quantity && nonnegative(before) && newBalance?.known === true &&
        afterValue - before === flow.bi.value && newBalance.source?.responseRef === post.responseRef;
    } else if (proposal.flowerRack.kind === 'receive') {
      const newGold = readProfile({ context: bridge.newContext }).profile?.gold;
      // Rack proceeds are paid in gold (profile.gold), never inventory item 11.
      // Attribute the gain to this exact matched response and independently
      // observed login balance; a concurrent income must remain unknown.
      profileFlow = resources.matchedProfileFlow({ context: proposal, source: response, method: proposal.method, field: 'gold' });
      flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId: 11 });
      before = proposal.flowerRack.beforeGold; afterValue = newGold?.value;
      const gain = Number.isSafeInteger(afterValue) && nonnegative(before) ? afterValue - before : null;
      effect = state && !positive(state.iid) && nonnegative(before) && newGold?.state === 'known' &&
        positive(gain) && flow?.method === proposal.method && flow.responseRef === response.responseRef &&
        flow.connectionEpoch === response.connectionEpoch && flow.requestSequence === response.requestSequence && flow.wireKey === response.wireKey &&
        flow.bi?.state === 'known' && flow.bi.value === gain &&
        (flow.bd?.state === 'known' && flow.bd.value === afterValue ||
          flow.bdCoverage?.presence === 'missing' || flow.bdCoverage?.presence === 'present' && flow.bdCoverage.state === 'known' && !flow.bdCoverage.itemPresent) &&
        (!profileFlow || profileFlow.responseRef === response.responseRef && profileFlow.value === afterValue) &&
        newGold.source?.responseRef === post.responseRef;
    } else if (proposal.flowerRack.kind === 'unlock') {
      const stand = proposal.flowerRack.rackId, standRule = proposal.flowerRack.extension?.rules?.stands?.[stand], cost = standRule?.unlockCost;
      const newlyPresent = standRule?.rackIds.some(id => !Object.hasOwn(proposal.flowerRack.sourceMap || {}, String(id)) &&
        Object.hasOwn(after.value?.map || {}, String(id)));
      const gold = readProfile({ context: bridge.newContext })?.profile?.gold;
      flow = resources.matchedItemFlow({ context: proposal, source: response, method: proposal.method, itemId: 11 });
      profileFlow = resources.matchedProfileFlow({ context: proposal, source: response, method: proposal.method, field: 'gold' });
      before = proposal.flowerRack.beforeGold; afterValue = gold?.value;
      const debitBdValid = flow?.bdCoverage?.presence === 'missing' ||
        flow?.bdCoverage?.presence === 'present' && flow.bdCoverage.state === 'known' &&
          (!flow.bdCoverage.itemPresent || flow.bd?.state === 'known' && flow.bd.value === afterValue);
      const noContradictoryBiDebit = flow?.biCoverage?.presence === 'missing' ||
        flow?.biCoverage?.presence === 'present' && flow.biCoverage.state === 'known' &&
          (!flow.biCoverage.itemPresent || flow.bi?.state === 'known' && flow.bi.value === 0);
      const profileGoldValid = flow?.profileGoldCoverage?.presence === 'missing' ||
        flow?.profileGoldCoverage?.presence === 'present' && flow.profileGoldCoverage.state === 'known' &&
          flow.profileGold?.value === afterValue;
      effect = newlyPresent && cost?.[0] === 11 && cost[1] === proposal.flowerRack.quantity && gold?.state === 'known' &&
        nonnegative(before) && afterValue === before - cost[1] && flow?.bo?.state === 'known' && flow.bo.value === cost[1] &&
        flow.responseRef === response.responseRef && flow.requestSequence === response.requestSequence && flow.wireKey === response.wireKey &&
        noContradictoryBiDebit && debitBdValid && profileGoldValid &&
        (!profileFlow || profileFlow.value === afterValue) && gold.source?.responseRef === post.responseRef;
    }
    if (!effect) return unknown('FLOWER_RACK_EFFECT_NOT_PROVEN');
    return { verdict: 'confirmed', verificationVersion: 'flower-rack/target-postread/v1', postReadRef: post.responseRef,
      resourceResolutions: (proposal.resources || []).map(one => ({ resourceKey: one.resourceKey, state: 'released' })), evidence: { targetRef: proposal.targets[0].targetRef, extensionRef: proposal.flowerRack.extensionRef,
        kind: proposal.flowerRack.kind, rackId: proposal.flowerRack.rackId, artId: proposal.flowerRack.artId,
        quantity: proposal.flowerRack.quantity, beforeValue: before, afterValue, writeResponseRef: response.responseRef,
        postReadRef: post.responseRef, bridgeFingerprint: bridge.bridgeFingerprint, frameFingerprint: flow?.frameFingerprint || null,
        sourceRef: proposal.flowerRack.sourceRef, sourceFingerprint: proposal.flowerRack.sourceFingerprint,
        postValue: after.value, postSource: after.source, postExtension: extension,
        writeFlow: flow ? { method: flow.method, responseRef: flow.responseRef, observationRef: flow.observationRef,
          requestSequence: flow.requestSequence, connectionEpoch: flow.connectionEpoch, wireKey: flow.wireKey,
          bi: flow.bi, bo: flow.bo, bd: flow.bd, boCoverage: flow.boCoverage, bdCoverage: flow.bdCoverage,
          biCoverage: flow.biCoverage, profileGold: flow.profileGold, profileGoldCoverage: flow.profileGoldCoverage,
          frameFingerprint: flow.frameFingerprint } : null,
        beforeGoldSource: proposal.flowerRack.beforeGoldSource || null,
        postGoldSource: proposal.flowerRack.kind === 'receive' || proposal.flowerRack.kind === 'unlock'
          ? readProfile({ context: bridge.newContext })?.profile?.gold?.source || null : null,
        ...(proposal.flowerRack.kind === 'receive' ? { matchedGold: { bi11: flow?.bi?.state === 'known' ? flow.bi.value : null,
          bd11: flow?.bd?.state === 'known' ? flow.bd.value : null, bd11Presence: flow?.bd?.presence || null,
          responseGold: profileFlow?.value ?? null, responseFrameFingerprint: profileFlow?.frameFingerprint ?? null,
          responseObservationRef: profileFlow?.observationRef ?? null, itemFrameFingerprint: flow?.frameFingerprint || null,
          itemObservationRef: flow?.observationRef || null, responseRef: flow?.responseRef || null,
          requestSequence: flow?.requestSequence ?? null, wireKey: flow?.wireKey || null } } : {}) } };
  }
  function onSettled({ proposal, operation, verification, postReadBridge } = {}) {
    const rack = proposal.flowerRack, target = proposal.targets[0].targetRef;
    if (verification?.verdict === 'confirmed') transaction(() => {
      const priorClaim = get('SELECT operation_id,state FROM backend_flower_rack_claims WHERE owner_ref=? AND subject_ref=? AND target_ref=?',
        proposal.ownerRef, proposal.subjectRef, target);
      run(`INSERT INTO backend_flower_rack_claims VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner_ref,subject_ref,target_ref) DO UPDATE SET state=excluded.state,operation_id=excluded.operation_id,updated_at=excluded.updated_at`,
      proposal.ownerRef, proposal.subjectRef, target, proposal.operationId, 'confirmed', nowIso());
      if (['receive','cancel'].includes(rack.kind) && !(priorClaim?.operation_id === proposal.operationId && priorClaim.state === 'confirmed')) run(`INSERT INTO backend_flower_rack_slot_lifecycles VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner_ref,subject_ref,official_uid,rack_id) DO UPDATE SET generation=backend_flower_rack_slot_lifecycles.generation+1,updated_at=excluded.updated_at`,
        proposal.ownerRef, proposal.subjectRef, rack.officialUid, rack.rackId, 1, nowIso());
    });
    else if (verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent') transaction(() => run(`INSERT OR IGNORE INTO backend_flower_rack_claims
      VALUES(?,?,?,?,?,?)`, proposal.ownerRef, proposal.subjectRef, target, proposal.operationId, 'unknown-held', nowIso()));
    if (verification?.verdict === 'unknown' && operation?.transport_state !== 'not_sent' && ['receive','cancel'].includes(rack.kind) &&
        postReadBridge?.oldPhysicalCloseReceipt?.closed === true && postReadBridge.operationId === proposal.operationId &&
        postReadBridge.officialUid === rack.officialUid) {
      const previous = proposal.flowerRack.sourceMap?.[String(rack.rackId)], nextContext = postReadBridge.newContext;
      const next = nextContext && facts.read(nextContext), nextRow = next?.value?.map?.[String(rack.rackId)], newLogin = postReadBridge.newLoginObservation;
      const priorSaleMatches = previous?.rackId === rack.rackId && previous.iid === rack.artId && positive(previous.sellStartTime) &&
        previous.sellStartTime === (String(rack.targetKey).match(/sale:(\d+):(\d+)/)?.[2] ? Number(String(rack.targetKey).match(/sale:(\d+):(\d+)/)[2]) : null);
      if (priorSaleMatches && next?.current === true && next.value?.uid === rack.officialUid && next.source?.responseRef === newLogin?.responseRef &&
          next.source?.method === 'index.login' && next.source?.connectionEpoch === nextContext.connectionEpoch &&
          newLogin?.method === 'index.login' && newLogin?.source === 'response' && newLogin?.transport === 'answered' &&
          postReadBridge.oldPhysicalCloseReceipt.connectionEpoch === proposal.connectionEpoch && nextRow?.rackId === rack.rackId &&
          !positive(nextRow.iid) && !positive(nextRow.sellStartTime)) {
        const transition = { version: 'flower-rack/observed-slot-transition/v1', operationId: proposal.operationId, kind: rack.kind,
          officialUid: rack.officialUid, rackId: rack.rackId, oldResponseRef: proposal.flowerRack.sourceRef, oldSourceFingerprint: proposal.flowerRack.sourceFingerprint,
          oldSale: { iid: previous.iid, sellStartTime: previous.sellStartTime }, newResponseRef: newLogin.responseRef,
          newSourceFingerprint: next.fingerprint, newMember: nextRow, bridgeFingerprint: postReadBridge.bridgeFingerprint,
          leaseRef: postReadBridge.leaseRef, physicalClose: postReadBridge.oldPhysicalCloseReceipt,
          oldContext: stableContext(proposal), newContext: stableContext(nextContext) };
        const transitionRef = 'flower-rack-transition:' + fingerprint([proposal.ownerRef, proposal.subjectRef, proposal.operationId, transition]);
        const inserted = run(`INSERT OR IGNORE INTO backend_flower_rack_slot_transitions VALUES(?,?,?,?,?,?,?,?,?,?,?)`, transitionRef, proposal.ownerRef,
          proposal.subjectRef, rack.officialUid, rack.rackId, proposal.operationId, proposal.flowerRack.sourceRef, newLogin.responseRef,
          canonical(transition), fingerprint(transition), nowIso());
        if (Number(inserted.changes) === 1) run(`INSERT INTO backend_flower_rack_slot_lifecycles VALUES(?,?,?,?,?,?)
          ON CONFLICT(owner_ref,subject_ref,official_uid,rack_id) DO UPDATE SET generation=backend_flower_rack_slot_lifecycles.generation+1,updated_at=excluded.updated_at`,
          proposal.ownerRef, proposal.subjectRef, rack.officialUid, rack.rackId, 1, nowIso());
      }
    }
    appendOutbox({ ownerRef: proposal.ownerRef, subjectRef: proposal.subjectRef, eventType: 'FeatureSettlement',
      eventKey: 'flower-rack-settlement:' + proposal.operationId, payload: { operationId: operation?.operation_id || proposal.operationId,
        featureId: 'flower-rack', verdict: verification?.verdict || 'unknown', reasonCode: verification?.reasonCode || null,
        runEpoch: proposal.runEpoch, connectionEpoch: proposal.connectionEpoch, method: proposal.method } });
    return { visibility: 'current' };
  }
  const consumedDomainsFor = ({ config, method, proposal } = {}) =>
    actionDomains(proposal?.flowerRack?.kind || actionKindForMethod(method), config);
  const feature = Object.freeze({ featureId: 'flower-rack', consumedDomains: ['flower-rack','inventory','art-inputs','profile','clock','customer','customer-eligibility',
    'order-flower','order-flower-counter','order-flower-eligibility','order-flower-butler'],
    consumedDomainsFor,
    scopes: Object.values(FLOWER_RACK_SCOPES), methods: Object.values(FLOWER_RACK_METHODS), methodScopes: scopeFor,
    operationContracts, contractRef: FLOWER_RACK_CONTRACT_REF, resourceKinds: ['item','currency'], factDomains: ['flower-rack'], release: 'validation-only',
    implementationVersion: 'flower-rack/rack-map-facts-and-item-flow/v1',
    scheduleUnits: Object.freeze([{ scheduleKey: 'flower-rack:receive', wakeKey: 'flower-rack:receive', actionKind: 'receive',
      consumedDomainsFor: ({ config }) => actionDomains('receive', config), assess: input => assess({ ...input, actionKind: 'receive' }) },
      { scheduleKey: 'flower-rack:sell', wakeKey: 'flower-rack:sell', actionKind: 'sell',
        consumedDomainsFor: ({ config }) => actionDomains('sell', config), assess: input => assess({ ...input, actionKind: 'sell' }) },
      { scheduleKey: 'flower-rack:maintenance', wakeKey: 'flower-rack:maintenance', actionKind: 'cancel',
        consumedDomainsFor: ({ config }) => actionDomains('cancel', config), assess: input => assess({ ...input, actionKind: 'cancel' }) },
      { scheduleKey: 'flower-rack:unlock', wakeKey: 'flower-rack:unlock', actionKind: 'unlock',
        consumedDomainsFor: ({ config }) => actionDomains('unlock', config), assess: input => assess({ ...input, actionKind: 'unlock' }) }]),
    assess, qualify: evaluateAdmission, verify, readFactBasis, evaluateAdmission, onSettled, onCurrentVerified: () => {} });
  return Object.freeze({ feature, readFactBasis, evaluateAdmission, onSettled, assess });
}
