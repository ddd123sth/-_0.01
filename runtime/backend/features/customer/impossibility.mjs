import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { customerContext, customerContextKey, knownCustomerCell, sameCustomerContext } from './wire-facts.mjs';
import { customerOrderFingerprint } from './identity.mjs';
import { artRecipeFingerprint } from '../art/rpc-contract.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { currentOfficialDataEvidence } from '../../official-data-evidence.mjs';

export const PHYSICAL_REJECT_VERSION = 'customer-physical-impossibility/v1';
export const CUSTOMER_BATCH_REJECT_VERSION = 'customer-physical-impossibility/customer-batch-v2';
export const NORMAL_MAKE_MINIMUM = freeze({ kind: 'normal-client-required-zero-stock',
  gameDecodedSha256: 'fc9970989021e4266301d2a167ae8e827ef71a124ad9d7f23cb922095a22aa69',
  range: { start: 1526512, end: 1527879, sha256: 'c8f87bcec7eb5e64d4c957ff3811a36c6ecb694ac9006238c363d2b0910b7ae7' },
  rule: 'G480/_tap_btn_make/zero-stock-early-return', minimumPerDistinctRequiredItem: 1,
  actualRecipeFeeProven: false, repeatedPositionFeeInferred: false });
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const scalar = one => knownCustomerCell(one) ? one.value : null;
const METHODS = new Set(NORMAL_SYNC_METHODS);
export const physicalSource = one => one ? { kind: one.kind ?? one.sourceKind ?? one.source ?? null, method: one.method ?? null,
  connectionEpoch: one.connectionEpoch ?? null, requestSequence: one.requestSequence ?? null, wireKey: one.wireKey ?? null, responseRef: one.responseRef ?? null } : null;
const sourceKnown = (one, context) => physicalSource(one)?.kind === 'response' && METHODS.has(one.method) && one.connectionEpoch === context.connectionEpoch &&
  positive(one.requestSequence) && reference(one.responseRef) && reference(one.wireKey) && /^ws\|\d+\|[1-9]\d*$/.test(one.wireKey) && Number(one.wireKey.split('|').at(-1)) === one.requestSequence;
const failure = reasonCode => freeze({ known: false, impossible: false, reasonCode, cause: null });
function validRecipe(recipe) {
  if (!positive(recipe?.artId) || !positive(recipe.vaseId) || !Array.isArray(recipe.flowersIds) || recipe.flowersIds.length !== 3 ||
      !recipe.flowersIds.every(positive) || !Array.isArray(recipe.unitInputMultiset)) return false;
  const counts = new Map(); for (const itemId of recipe.flowersIds) counts.set(itemId, (counts.get(itemId) || 0) + 1);
  return canonical(recipe.unitInputMultiset) === canonical([...counts].sort(([a], [b]) => a - b).map(([itemId, occurrences]) => ({ itemId, occurrences })));
}
function currentRecipeSource(source, version) {
  if (source?.gameVersion === '480.0.27' && version?.gameVersion === '480.0.27')
    return source.protocolVersion === '480.0.0' && source.gameDecodedSha256 === NORMAL_MAKE_MINIMUM.gameDecodedSha256;
  const proof = version?.sourceProofs?.['art.make'], received = source?.sourceProof;
  return !!currentOfficialDataEvidence(version, 'art.make') && source?.gameVersion === version.gameVersion && source.protocolVersion === version.protocolVersion
    && source.loginResponseRef === version.loginResponseRef && source.dataSnapshotId === version.dataSnapshotId
    && source.artTableSha256 === version.tableHashes.c_flowerArt && source.itemTableSha256 === version.tableHashes.c_item
    && source.flowerTableSha256 === version.tableHashes.c_flower && received?.supported === true
    && ['actionContractId','coreContractId','sourceVersion','protocolVersion','indexSha256','gameSha256','moSha256']
      .every(key => received[key] === proof[key]) && Array.isArray(received.matchedBlocks)
    && Array.isArray(proof.matchedBlocks) && canonical(received.matchedBlocks) === canonical(proof.matchedBlocks);
}
function observedCost(cost, recipe, version = null) {
  const gameVersion = version?.gameVersion ?? '480.0.27';
  if (gameVersion !== '480.0.27' && !currentOfficialDataEvidence(version, 'art.make')) return false;
  if (!validRecipe(recipe) || !cost?.known || !cost.complete || cost.kind !== 'observed-versioned-recipe-cost' || cost.gameVersion !== gameVersion || cost.protocolVersion !== '480.0.0' ||
      cost.artId !== recipe.artId || cost.recipeFingerprint !== artRecipeFingerprint(recipe) || cost.num !== 1 || !Array.isArray(cost.consumptions) ||
      !cost.consumptions.length || cost.consumptions.length > 3 || !cost.consumptions.every(one => positive(one.itemId) && positive(one.quantity)) ||
      new Set(cost.consumptions.map(one => one.itemId)).size !== cost.consumptions.length ||
      !recipe.unitInputMultiset.every(one => cost.consumptions.some(cost => cost.itemId === one.itemId && cost.quantity === one.occurrences)) ||
      cost.consumptions.length !== recipe.unitInputMultiset.length || !digest(cost.receiptFingerprint)) return false;
  const body = Object.fromEntries(Object.entries(cost).filter(([key]) => !['receiptRef', 'receiptFingerprint'].includes(key)));
  return fingerprint(body) === cost.receiptFingerprint && cost.receiptRef === 'art-observed-cost:' + cost.receiptFingerprint;
}

// The report is a current synchronous port, never a stored planner outcome.
// Budget/keep/other reservations are intentionally not read as physical stock.
export function assessCustomerImpossibility({ context: supplied, view, order, life, decision, config, report } = {}) {
  const batchParent = report?.customerBatch?.entries?.find(one => one.npcId === order?.npcId && one.lifecycleRef === life?.lifecycleRef &&
    one.artId === scalar(order?.fields?.artId) && one.decisionRef === decision?.decisionRef &&
    one.contentFingerprint === life?.contentFingerprint);
  if (report?.customerBatch?.version === 'art-customer-batch-inputs/v2' && report.customerBatch.current === true && batchParent)
    return assessCustomerBatchImpossibility({ context: supplied, view, order, life, decision, config, report });
  const context = customerContext(supplied), dto = config?.config, art = dto?.art, customer = dto?.orders?.customer,
    plan = report?.planning, uid = scalar(view?.identity?.uid), artId = scalar(order?.fields?.artId), need = scalar(order?.fields?.num);
  if (!context || view?.current !== true || !sameCustomerContext(context, view.context) || !view.identity?.verified || !positive(uid) ||
      customer?.enabled !== true || customer.autoReject !== true || art?.makeEnabled !== true ||
      !nonnegative(config.featureCancelEpochs?.['order.customer']) || !nonnegative(config.featureCancelEpochs?.['art.make'])) return failure('CUSTOMER_PHYSICAL_REJECT_INTENT_OR_IDENTITY_UNKNOWN');
  if (decision?.verdict !== 'accepted' || decision.accepted !== true || decision.identityKnown !== true || !sameCustomerContext(context, decision.context) ||
      !life?.current || !life.identityKnown || !sameCustomerContext(context, life.context) || decision.lifecycleRef !== life.lifecycleRef ||
      decision.order?.contentFingerprint !== life.contentFingerprint || order?.current !== true || !order.readable || customerOrderFingerprint(order) !== life.contentFingerprint ||
      !positive(artId) || !positive(need)) return failure('CUSTOMER_PHYSICAL_REJECT_ACCEPTED_PARENT_REQUIRED');
  if (!plan?.current || !sameCustomerContext(context, plan.context) || plan.officialUid !== uid || plan.policy?.makeEnabled !== true ||
      plan.policy.artCancelEpoch !== config.featureCancelEpochs['art.make'] || plan.policy.customerCancelEpoch !== config.featureCancelEpochs['order.customer'] ||
      plan.customer?.known !== true || plan.customer.enabled !== true) return failure('CUSTOMER_PHYSICAL_REJECT_ART_REPORT_NOT_CURRENT');
  const entry = plan.customer.entries?.find(one => one.parent?.lifecycleRef === life.lifecycleRef && one.artId === artId && one.parent.npcId === order.npcId),
    recipe = entry?.recipe, recipeSource = entry?.recipeSource;
  if (!entry?.recipeKnown || !validRecipe(recipe) || recipe.artId !== artId ||
      !currentRecipeSource(recipeSource, view.versionBinding) ||
      entry.parent.contentFingerprint !== life.contentFingerprint || entry.parent.need !== need || entry.parent.decisionRef !== decision.decisionRef) return failure('CUSTOMER_PHYSICAL_REJECT_RECIPE_OR_PARENT_UNKNOWN');
  const raw = itemId => {
    const balance = report.rawItems?.[itemId];
    return balance?.itemId === itemId && sameCustomerContext(context, balance.context) && balance.base?.known === true &&
      nonnegative(balance.base.value) && reference(balance.basisRef) && sourceKnown(balance.base.source, context) ? balance : null;
  };
  const product = raw(artId);
  if (!product) return failure('CUSTOMER_PHYSICAL_REJECT_RAW_PRODUCT_UNKNOWN');
  const netShortage = Math.max(0, need - product.base.value);
  if (!netShortage) return failure('CUSTOMER_PHYSICAL_REJECT_FINISHED_STOCK_PHYSICALLY_SUFFICIENT');
  const vases = view.artEligibilityInputs?.vases, map = vases?.map, domain = vases?.domain;
  const validSource = source => sourceKnown(source, context) && source.contextKey === customerContextKey(context) &&
    source.version?.gameVersion === view.versionBinding?.gameVersion && (source.version?.gameVersion === '480.0.27' || currentOfficialDataEvidence(source.version, 'art.make')) &&
    source.version.protocolVersion === '480.0.0' && source.version.source === 'normal-package-hop-and-matched-world-login/v1' && source.version.loginResponseRef === view.identity.source?.responseRef;
  const mapKnown = knownCustomerCell(domain) && domain.current === true && validSource(domain.source) && knownCustomerCell(map) && map.current === true &&
    validSource(map.source) && map.sourceProvidedMapComplete === true && map.decodedComplete === true && map.complete === true && map.truncated === false &&
    Array.isArray(map.entries) && map.total === map.entries.length && map.entries.every(row => row.current === true && row.readable === true &&
      row.uidMatchesCurrentLogin === true && row.vaseIdMatchesKey === true && scalar(row.fields?.uid) === uid && scalar(row.fields?.vaseId) === row.vaseId);
  if (!mapKnown) return failure('CUSTOMER_PHYSICAL_REJECT_COMPLETE_VASE_OWNERSHIP_UNKNOWN');
  const vase = map.entries.find(row => row.vaseId === recipe.vaseId), materials = recipe.unitInputMultiset.map(one => ({ ...one, balance: raw(one.itemId) }));
  const cost = report.costContracts?.[artId], costKnown = observedCost(cost, recipe, view.versionBinding);
  let reasonCode = null, constraint = null;
  if (!vase) { reasonCode = 'CUSTOMER_REQUIRED_VASE_PROVEN_NOT_OWNED'; constraint = 'complete-current-vase-map-absence'; }
  else {
    if (materials.some(one => !one.balance)) return failure('CUSTOMER_PHYSICAL_REJECT_RAW_INPUTS_UNKNOWN');
    const minimumKnown = plainObject(recipeSource.ranges?.ordinaryMake) && canonical(recipeSource.ranges.ordinaryMake) === canonical(NORMAL_MAKE_MINIMUM.range)
      || recipeSource.sourceProof?.matchedBlocks?.some(block => block.name === 'ordinaryMake' && block.byteLength === 1367 && block.sha256 === NORMAL_MAKE_MINIMUM.range.sha256);
    if (minimumKnown && materials.some(one => one.balance.base.value === 0)) {
      reasonCode = 'CUSTOMER_REQUIRED_FLOWER_PROVEN_ZERO'; constraint = NORMAL_MAKE_MINIMUM.kind;
    } else if (costKnown && materials.some(one => !positive(one.occurrences * netShortage) || one.balance.base.value < one.occurrences * netShortage)) {
      if (materials.some(one => !positive(one.occurrences * netShortage))) return failure('CUSTOMER_PHYSICAL_REJECT_REQUIRED_QUANTITY_OVERFLOW');
      reasonCode = 'CUSTOMER_OBSERVED_COST_INPUT_TOTAL_INSUFFICIENT'; constraint = 'observed-versioned-cost-net-shortage';
    } else return failure(!costKnown ? 'CUSTOMER_PHYSICAL_REJECT_NO_PROVEN_INPUT_SHORTAGE_COST_UNKNOWN' : 'CUSTOMER_PHYSICAL_REJECT_RAW_INPUT_TOTAL_SUFFICIENT');
  }
  const basis = { context, officialUid: uid, gameVersion: view.versionBinding.gameVersion, protocolVersion: '480.0.0',
    parent: { npcId: order.npcId, lifecycleRef: life.lifecycleRef, contentFingerprint: life.contentFingerprint, artId, need, decisionRef: decision.decisionRef },
    policy: { customerEnabled: true, autoReject: true, makeEnabled: true, customerCancelEpoch: config.featureCancelEpochs['order.customer'], artCancelEpoch: config.featureCancelEpochs['art.make'] },
    product: { itemId: artId, rawQuantity: product.base.value, netShortage },
    recipe: { artId, vaseId: recipe.vaseId, flowersIds: [...recipe.flowersIds], unitInputMultiset: clone(recipe.unitInputMultiset), recipeFingerprint: artRecipeFingerprint(recipe) },
    vase: { known: true, owned: !!vase, complete: true, observedOwnedIdsFingerprint: fingerprint(map.entries.map(row => row.vaseId).sort((a, b) => a - b)) },
    materials: constraint === 'complete-current-vase-map-absence' ? [] : materials.map(one => ({ itemId: one.itemId, rawQuantity: one.balance.base.value,
      requiredMinimum: constraint === NORMAL_MAKE_MINIMUM.kind ? 1 : one.occurrences * netShortage })), constraint,
    costReceiptRef: constraint === 'observed-versioned-cost-net-shortage' ? cost.receiptRef : null,
    costReceiptFingerprint: constraint === 'observed-versioned-cost-net-shortage' ? cost.receiptFingerprint : null };
  const evidence = { basis, sources: { product: { basisRef: product.basisRef, source: physicalSource(product.base.source) },
    vase: { source: physicalSource(map.source), domainSource: physicalSource(domain.source), sourceProvidedMapComplete: true, decodedComplete: true, total: map.total },
    materials: constraint === 'complete-current-vase-map-absence' ? [] : materials.map(one => ({ itemId: one.itemId, basisRef: one.balance.basisRef, source: physicalSource(one.balance.base.source) })) },
    minimumRequirementSource: constraint === NORMAL_MAKE_MINIMUM.kind ? NORMAL_MAKE_MINIMUM : null,
    costContract: constraint === 'observed-versioned-cost-net-shortage' ? clone(cost) : null };
  return freeze({ known: true, impossible: true, reasonCode, cause: { version: PHYSICAL_REJECT_VERSION, kind: 'physical-impossibility', reasonCode,
    reportFingerprint: fingerprint(basis), evidence } });
}

function assessCustomerBatchImpossibility({ context: supplied, view, order, life, decision, config, report } = {}) {
  const context = customerContext(supplied), customer = config?.config?.orders?.customer, art = config?.config?.art,
    uid = scalar(view?.identity?.uid), artId = scalar(order?.fields?.artId), need = scalar(order?.fields?.num), batch = report.customerBatch;
  const failure = reasonCode => freeze({ known: false, impossible: false, reasonCode, cause: null });
  if (!context || view?.current !== true || !sameCustomerContext(context, view.context) || view.identity?.verified !== true || !positive(uid) ||
      customer?.enabled !== true || customer.autoReject !== true || art?.makeEnabled !== true ||
      !nonnegative(config.featureCancelEpochs?.['order.customer']) || !nonnegative(config.featureCancelEpochs?.['art.make']) ||
      batch.current !== true || !sameCustomerContext(context, batch.context)) return failure('CUSTOMER_BATCH_PHYSICAL_REJECT_INTENT_OR_IDENTITY_UNKNOWN');
  if (decision?.verdict !== 'accepted' || decision.accepted !== true || decision.identityKnown !== true || !sameCustomerContext(context, decision.context) ||
      !life?.current || !life.identityKnown || !sameCustomerContext(context, life.context) || decision.lifecycleRef !== life.lifecycleRef ||
      decision.order?.contentFingerprint !== life.contentFingerprint || order?.current !== true || !order.readable ||
      customerOrderFingerprint(order) !== life.contentFingerprint || !positive(artId) || !positive(need))
    return failure('CUSTOMER_BATCH_PHYSICAL_REJECT_ACCEPTED_PARENT_REQUIRED');
  const entry = batch.entries?.find(one => one.npcId === order.npcId && one.lifecycleRef === life.lifecycleRef && one.artId === artId &&
    one.decisionRef === decision.decisionRef && one.contentFingerprint === life.contentFingerprint);
  if (!entry || !positive(entry.netShortage) || entry.netShortage > need || entry.need !== need || entry.finishedStock < 0 ||
      !validRecipe(entry.recipe) || entry.recipe.artId !== artId || !Array.isArray(entry.inputRows) || !entry.inputRows.length ||
      entry.recipeSource?.loginResponseRef !== view.identity.source?.responseRef || !currentRecipeSource(entry.recipeSource, view.versionBinding)
      || !Array.isArray(entry.shortage) || !entry.shortage.length)
    return failure('CUSTOMER_BATCH_PHYSICAL_REJECT_RECIPE_OR_SHORTAGE_UNKNOWN');
  const shortageById = new Map(entry.shortage.map(one => [one.itemId, one]));
  const materials = entry.inputRows.map(one => ({ itemId: one.itemId, occurrences: one.occurrences, need: one.physicalRequired,
    available: one.available, shortfall: Math.max(0, one.physicalRequired - one.available), basisRef: one.basisRef, source: one.source }));
  if (materials.some(one => !positive(one.itemId) || !positive(one.occurrences) || one.need !== one.occurrences * entry.netShortage ||
        !nonnegative(one.available) || !nonnegative(one.shortfall) || !reference(one.basisRef) || !sourceKnown(one.source, context) ||
        (one.shortfall > 0) !== shortageById.has(one.itemId) || shortageById.has(one.itemId) &&
        (shortageById.get(one.itemId).need !== one.need || shortageById.get(one.itemId).available !== one.available ||
          shortageById.get(one.itemId).shortfall !== one.shortfall)) || !materials.some(one => one.shortfall > 0) ||
      materials.length !== entry.recipe.unitInputMultiset.length ||
      materials.some(one => entry.recipe.unitInputMultiset.find(input => input.itemId === one.itemId)?.occurrences !== one.occurrences))
    return failure('CUSTOMER_BATCH_PHYSICAL_REJECT_RAW_INPUT_SHORTAGE_UNKNOWN');
  const basis = { context, officialUid: uid, parent: { npcId: order.npcId, lifecycleRef: life.lifecycleRef,
      contentFingerprint: life.contentFingerprint, decisionRef: decision.decisionRef, artId, need },
    policy: { customerEnabled: true, autoReject: true, makeEnabled: true,
      customerCancelEpoch: config.featureCancelEpochs['order.customer'], artCancelEpoch: config.featureCancelEpochs['art.make'] },
    product: { rawQuantity: entry.finishedStock, requiredOutput: need, netShortage: entry.netShortage },
    recipe: { ...clone(entry.recipe), recipeFingerprint: artRecipeFingerprint(entry.recipe) },
    materials: materials.map(({ itemId, occurrences, need: required, available, shortfall }) => ({ itemId, occurrences, required, available, shortfall })) };
  const sources = { product: { basisRef: entry.productBasisRef || null, source: physicalSource(entry.productSource) },
    order: { responseRef: entry.sourceRef },
    materials: materials.map(one => ({ itemId: one.itemId, basisRef: one.basisRef, source: physicalSource(one.source) })),
    recipeSource: clone(entry.recipeSource) };
  return freeze({ known: true, impossible: true, reasonCode: 'CUSTOMER_BATCH_REQUIRED_INPUTS_PHYSICALLY_SHORT', cause: {
    version: CUSTOMER_BATCH_REJECT_VERSION, kind: 'customer-batch-physical-shortage', reasonCode: 'CUSTOMER_BATCH_REQUIRED_INPUTS_PHYSICALLY_SHORT',
    reportFingerprint: fingerprint(basis), evidence: { basis, sources } } });
}

export function assertCustomerPhysicalRejectCause({ cause, customer, proposal }) {
  const basis = cause?.evidence?.basis, context = customerContext(proposal), source = cause?.evidence?.sources;
  if (cause?.version === CUSTOMER_BATCH_REJECT_VERSION) {
    const valid = cause.kind === 'customer-batch-physical-shortage' && cause.reasonCode === 'CUSTOMER_BATCH_REQUIRED_INPUTS_PHYSICALLY_SHORT' &&
      digest(cause.reportFingerprint) && plainObject(basis) && fingerprint(basis) === cause.reportFingerprint && sameCustomerContext(context, basis.context) &&
      basis.officialUid === customer.officialUid && basis.parent?.npcId === customer.npcId && basis.parent.lifecycleRef === customer.lifecycleRef &&
      basis.parent.contentFingerprint === customer.contentFingerprint && basis.parent.decisionRef === customer.acceptedDecisionRef &&
      basis.parent.artId === customer.artId && basis.parent.need === customer.need && basis.policy?.customerEnabled === true &&
      basis.policy.autoReject === true && basis.policy.makeEnabled === true && basis.policy.customerCancelEpoch === proposal.featureCancelEpoch &&
      nonnegative(basis.policy.artCancelEpoch) && nonnegative(basis.product?.rawQuantity) && positive(basis.product?.requiredOutput) &&
      positive(basis.product?.netShortage) && basis.product.requiredOutput === customer.need &&
      basis.product.netShortage === Math.max(0, customer.need - basis.product.rawQuantity) && validRecipe(basis.recipe) &&
      basis.recipe.artId === customer.artId && basis.recipe.recipeFingerprint === artRecipeFingerprint(basis.recipe) &&
      Array.isArray(basis.materials) && basis.materials.length === basis.recipe.unitInputMultiset.length &&
      Array.isArray(source?.materials) && source.materials.length === basis.materials.length &&
      source.order?.responseRef === customer.beforeOrder?.sourceRef &&
      currentRecipeSource(source.recipeSource, customer.versionEvidence) && reference(source.product?.basisRef) && sourceKnown(source.product?.source, context) &&
      customer.beforeItems?.some(one => one.itemId === customer.artId && one.quantity === basis.product.rawQuantity) &&
      basis.materials.every(one => positive(one.itemId) && positive(one.occurrences) && one.required === one.occurrences * basis.product.netShortage &&
        nonnegative(one.available) && one.shortfall === Math.max(0, one.required - one.available) && nonnegative(one.shortfall) &&
        basis.recipe.unitInputMultiset.some(input => input.itemId === one.itemId && input.occurrences === one.occurrences) &&
        source.materials.some(proof => proof.itemId === one.itemId && reference(proof.basisRef) && sourceKnown(proof.source, context))) &&
      basis.materials.some(one => one.shortfall > 0);
    if (!valid) throw problem('CUSTOMER_BATCH_PHYSICAL_REJECT_CAUSE_INVALID', '批量配花缺料拒因必须绑定当前订单、配方和原始库存');
    return cause;
  }
  const common = cause?.version === PHYSICAL_REJECT_VERSION && cause.kind === 'physical-impossibility' && digest(cause.reportFingerprint) &&
    plainObject(basis) && fingerprint(basis) === cause.reportFingerprint && sameCustomerContext(context, basis.context) &&
    basis.officialUid === customer.officialUid && basis.gameVersion === customer.versionEvidence?.gameVersion && basis.protocolVersion === '480.0.0' &&
    (basis.gameVersion === '480.0.27' || currentOfficialDataEvidence(customer.versionEvidence, 'art.make')) &&
    basis.parent?.npcId === customer.npcId && basis.parent.artId === customer.artId && basis.parent.need === customer.need &&
    basis.parent.lifecycleRef === customer.lifecycleRef && basis.parent.contentFingerprint === customer.contentFingerprint &&
    basis.parent.decisionRef === customer.acceptedDecisionRef && basis.policy?.customerEnabled === true && basis.policy.autoReject === true &&
    basis.policy.makeEnabled === true && basis.policy.customerCancelEpoch === proposal.featureCancelEpoch && nonnegative(basis.policy.artCancelEpoch) &&
    nonnegative(basis.product?.rawQuantity) && positive(basis.product.netShortage) && basis.product.netShortage === customer.need - basis.product.rawQuantity &&
    basis.product.itemId === customer.artId && Array.isArray(customer.beforeItems) && customer.beforeItems.some(one => one.itemId === customer.artId && one.quantity === basis.product.rawQuantity) &&
    validRecipe(basis.recipe) && basis.recipe.artId === customer.artId &&
    basis.recipe.recipeFingerprint === artRecipeFingerprint(basis.recipe) && basis.vase?.known === true && basis.vase.complete === true &&
    digest(basis.vase.observedOwnedIdsFingerprint) && source?.vase?.sourceProvidedMapComplete === true && source.vase.decodedComplete === true &&
    nonnegative(source.vase.total) && sourceKnown(source.vase.source, context) && sourceKnown(source.vase.domainSource, context) &&
    reference(source.product?.basisRef) && sourceKnown(source.product.source, context) && Array.isArray(basis.materials) && Array.isArray(source.materials);
  let proven = false;
  if (common && basis.constraint === 'complete-current-vase-map-absence') proven = cause.reasonCode === 'CUSTOMER_REQUIRED_VASE_PROVEN_NOT_OWNED' &&
    basis.vase.owned === false && basis.materials.length === 0 && source.materials.length === 0 && cause.evidence.costContract === null;
  if (common && ['normal-client-required-zero-stock', 'observed-versioned-cost-net-shortage'].includes(basis.constraint)) {
    proven = basis.vase.owned === true && basis.materials.length === basis.recipe.unitInputMultiset.length && basis.materials.length > 0 && basis.materials.length <= 3 && source.materials.length === basis.materials.length &&
      new Set(basis.materials.map(one => one.itemId)).size === basis.materials.length && basis.materials.every(one => positive(one.itemId) && nonnegative(one.rawQuantity) && positive(one.requiredMinimum) &&
        basis.recipe.flowersIds.includes(one.itemId) && source.materials.some(item => item.itemId === one.itemId && reference(item.basisRef) && sourceKnown(item.source, context)));
    if (basis.constraint === NORMAL_MAKE_MINIMUM.kind) proven &&= cause.reasonCode === 'CUSTOMER_REQUIRED_FLOWER_PROVEN_ZERO' &&
      canonical(cause.evidence.minimumRequirementSource) === canonical(NORMAL_MAKE_MINIMUM) && basis.materials.every(one => one.requiredMinimum === 1) &&
      basis.materials.some(one => one.rawQuantity === 0) && cause.evidence.costContract === null;
    else proven &&= cause.reasonCode === 'CUSTOMER_OBSERVED_COST_INPUT_TOTAL_INSUFFICIENT' && observedCost(cause.evidence.costContract, basis.recipe, customer.versionEvidence) &&
      basis.costReceiptRef === cause.evidence.costContract.receiptRef && basis.costReceiptFingerprint === cause.evidence.costContract.receiptFingerprint &&
      basis.materials.some(one => one.rawQuantity < one.requiredMinimum) && basis.materials.every(one => one.requiredMinimum ===
        basis.recipe.unitInputMultiset.find(input => input.itemId === one.itemId)?.occurrences * basis.product.netShortage);
  }
  if (!common || !proven) throw problem('CUSTOMER_PHYSICAL_REJECT_CAUSE_INVALID', '物理拒因必须绑定当前原始不足或完整花瓶缺席，不能由未知或预留推造');
  return cause;
}
