import { verifyOfficialSourceVersionFrame } from '../../official-server-version-contract.mjs';
import { clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';
import { createOfficialLandCatalog } from '../land/catalog.mjs';
import { createOfficialCustomerCatalog } from '../customer/catalog.mjs';
import { createOfficialArtCatalog } from './catalog.mjs';
import { NORMAL_SYNC_METHODS } from '../../facts/normal-sync-contract.mjs';
import { officialActionContractId, OFFICIAL_CORE_CONTRACT_ID } from '../../official-version-profile.mjs';

export const ART_MAKE_CONTRACT = Object.freeze({ contractId: 'art-make/single-v1', featureId: 'art.make',
  scope: 'flower-art-make', method: 'flowerArt.makeFlowerArt', targetKind: 'flower-art-unit' });
const ART_TABLE_SHA256 = '636220908e677377ee4902a38a7ab6adb66540f86902199e99141eaff3de66da';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const BASIS_METHODS = new Set(NORMAL_SYNC_METHODS);
const exactKeys = (value, expected) => plainObject(value) && fingerprint(Object.keys(value).sort()) === fingerprint([...expected].sort());
let catalog;
function currentCatalog() {
  if (!catalog) {
    const landCatalog = createOfficialLandCatalog(), customerCatalog = createOfficialCustomerCatalog({ landCatalog });
    catalog = createOfficialArtCatalog({ customerCatalog, landCatalog });
  }
  return catalog;
}

// The ordinary current controller takes these three fields, not an art id or
// a guessed currency price: G480 [443841,443947), DS [161704,161792).
export function captureArtMakeArgs(input) {
  if (!exactKeys(input, ['vaseId', 'flowersIds', 'num']) || !positive(input.vaseId) || input.num !== 1 ||
    !Array.isArray(input.flowersIds) || input.flowersIds.length !== 3 || Object.keys(input.flowersIds).length !== 3 ||
    !input.flowersIds.every(positive)) throw problem('ART_MAKE_ARGUMENT_CONTRACT_INVALID', '必要花艺首批仅允许真实花瓶、有序三配花与单次一件', 400);
  const params = clone(input);
  return freeze({ params, paramsFingerprint: fingerprint(params) });
}
export const artRecipeFingerprint = art => fingerprint({ artId: art.artId, vaseId: art.vaseId, flowersIds: art.flowersIds,
  num: 1, gameVersion: '480.0.27', artTableSha256: ART_TABLE_SHA256 });
export const artTargetFingerprint = art => fingerprint({ parentLifecycleRef: art.parentLifecycleRef, demandRef: art.demandRef,
  unitRef: art.unitRef, recipeFingerprint: art.recipeFingerprint });

export function assertArtMakeProposal(proposal) {
  const captured = captureArtMakeArgs(proposal?.params), definition = ART_MAKE_CONTRACT, art = proposal.art;
  if (Object.entries(definition).filter(([key]) => key !== 'contractId' && key !== 'targetKind').some(([key, value]) => proposal[key] !== value) ||
    !reference(proposal.subjectRef) || captured.paramsFingerprint !== proposal.paramsFingerprint || !plainObject(art) ||
    !positive(art.artId) || art.vaseId !== captured.params.vaseId || art.num !== 1 ||
    fingerprint(art.flowersIds) !== fingerprint(captured.params.flowersIds) || !reference(art.demandRef) || !reference(art.unitRef) ||
    !/^customer-life:[a-f0-9]{64}$/.test(art.parentLifecycleRef) || !positive(art.officialUid) ||
    art.versionEvidence?.protocolVersion !== '480.0.0' ||
    !reference(art.versionEvidence.loginResponseRef)) throw problem('ART_MAKE_PROPOSAL_CONTRACT_INVALID', '花艺制作须绑定已接受父单、持久单件需求和本次正常主体版本', 400);
  const dynamicSource = art.catalogSource?.dataSnapshotId;
  const proof = art.versionEvidence?.sourceProofs?.['art.make'];
  const dynamicRecipeValid = typeof dynamicSource === 'string' && art.catalogSource?.dataSnapshotId === art.versionEvidence?.dataSnapshotId &&
    art.catalogSource?.gameVersion === art.versionEvidence?.gameVersion && art.catalogSource?.protocolVersion === art.versionEvidence?.protocolVersion &&
    art.catalogSource?.loginResponseRef === art.versionEvidence?.loginResponseRef && art.catalogSource?.contractId === OFFICIAL_CORE_CONTRACT_ID &&
    art.catalogSource?.sourceProof?.supported === true && art.catalogSource.sourceProof.actionContractId === officialActionContractId('art.make') &&
    art.catalogSource.sourceProof.coreContractId === OFFICIAL_CORE_CONTRACT_ID && art.catalogSource.sourceProof.sourceVersion === art.versionEvidence.gameVersion &&
    art.catalogSource.sourceProof.protocolVersion === art.versionEvidence.protocolVersion && proof?.supported === true &&
    proof.actionContractId === art.catalogSource.sourceProof.actionContractId &&
    /^[a-f0-9]{64}$/.test(art.catalogSource.artTableSha256 || '') && /^[a-f0-9]{64}$/.test(art.catalogSource.itemTableSha256 || '') &&
    /^[a-f0-9]{64}$/.test(art.catalogSource.flowerTableSha256 || '') && art.recipeSourceProof?.dataSnapshotId === dynamicSource &&
    art.recipeSourceProof?.loginResponseRef === art.versionEvidence.loginResponseRef && art.recipeSourceProof?.tableSha256 === art.catalogSource.artTableSha256 &&
    art.recipeSourceProof?.row?.id === art.artId && art.recipeSourceProof.row.vase === art.vaseId &&
    fingerprint(art.recipeSourceProof.row.flowers) === fingerprint(art.flowersIds) &&
    art.recipeSourceProof.fingerprint === fingerprint(art.recipeSourceProof.row);
  const legacyRecipeValid = art.versionEvidence.gameVersion === '480.0.27' && !dynamicSource && (() => {
    const recipe = currentCatalog().recipe(art.artId);
    return recipe.known && recipe.vaseId === art.vaseId && fingerprint(recipe.flowersIds) === fingerprint(art.flowersIds);
  })();
  if (!(dynamicRecipeValid || legacyRecipeValid) || art.recipeFingerprint !== artRecipeFingerprint(art))
    throw problem('ART_MAKE_RECIPE_BINDING_INVALID', '花艺配方必须绑定当前数据快照和已核源码合同', 400);
  // Derive multiplicity from the exact current row just validated above. A
  // current snapshot must never fall back to the bundled legacy recipe table.
  const counts = new Map();
  for (const itemId of captured.params.flowersIds) counts.set(itemId, (counts.get(itemId) || 0) + 1);
  const recipe = dynamicRecipeValid ? freeze({ known: true, artId: art.artId, vaseId: art.vaseId,
    flowersIds: [...captured.params.flowersIds], rowProof: clone(art.recipeSourceProof), source: clone(art.catalogSource),
    unitInputMultiset: [...counts].sort(([a], [b]) => a - b).map(([itemId, occurrences]) => ({ itemId, occurrences })) })
    : currentCatalog().recipe(art.artId);
  const target = proposal.targets?.[0];
  if (!Array.isArray(proposal.targets) || proposal.targets.length !== 1 ||
    !exactKeys(target, ['memberKey', 'targetKind', 'targetRef', 'lifecycleRef', 'targetFingerprint']) ||
    target.memberKey !== 'art:' + art.unitRef || target.targetKind !== definition.targetKind ||
    target.targetRef !== 'flower-art:' + proposal.subjectRef + ':' + art.artId || target.lifecycleRef !== art.unitRef ||
    target.targetFingerprint !== artTargetFingerprint(art) || proposal.semanticKey !== 'art-make:' + art.unitRef) {
    throw problem('ART_MAKE_TARGET_BINDING_INVALID', '花艺单件原目标、配方与父需求身份绑定不一致', 400);
  }
  const need = art.currentNeed;
  if (need !== undefined && (!plainObject(need) || need.necessary !== true || need.featureId !== definition.featureId || need.targetRef !== target.targetRef ||
    !reference(need.businessNeedRef) || !digest(need.decisionGeneration) || !digest(need.semanticFingerprint) ||
    need.needRef !== 'current-need:' + fingerprint([need.featureId, need.targetRef, need.businessNeedRef]) ||
    !reference(need.claimRef) || !Array.isArray(need.basisRefs) || !need.basisRefs.includes(art.versionEvidence.loginResponseRef) ||
    !Array.isArray(art.beforeItems) || art.beforeItems.some(one => !need.basisRefs.includes(one.basisRef)))) {
    throw problem('ART_CURRENT_NEED_PROOF_INVALID', '花艺候选必须绑定完整当前读和确定的单次需求代际', 400);
  }
  const expected = recipe.unitInputMultiset.map(one => ({ itemId: one.itemId, quantity: one.occurrences }));
  if (!Array.isArray(proposal.resources) || proposal.resources.length !== expected.length ||
    !Array.isArray(proposal.resourceBindings) || proposal.resourceBindings.length !== expected.length ||
    new Set(proposal.resources.map(one => one.resourceKey)).size !== expected.length ||
    new Set(proposal.resourceBindings.map(one => one.resourceKey)).size !== expected.length ||
    !expected.every(one => {
      const resource = proposal.resources.find(entry => entry.resourceKind === 'item' && entry.resourceRef === 'item:' + one.itemId);
      const binding = resource && proposal.resourceBindings.find(entry => entry.resourceKey === resource.resourceKey);
      return resource && resource.quantity === one.quantity && reference(resource.resourceKey) && reference(resource.basisRef) &&
        reference(resource.accountingRef) && binding?.memberKey === target.memberKey && binding.quantity === one.quantity;
    })) throw problem('ART_MAKE_RESOURCE_BINDING_INVALID', '每份配花多重集须精确绑定原单件资源预约', 400);
  const source = one => (one?.kind ?? one?.sourceKind ?? one?.source) === 'response' && BASIS_METHODS.has(one.method) &&
    one.connectionEpoch === proposal.connectionEpoch && positive(one.requestSequence) && reference(one.responseRef) && reference(one.wireKey);
  const ids = [...expected.map(one => one.itemId), art.artId], items = art.beforeItems, profile = art.beforeProfile, vase = art.beforeVase;
  if (!Array.isArray(items) || items.length !== ids.length || new Set(items.map(one => one.itemId)).size !== ids.length ||
    !items.every(one => ids.includes(one.itemId) && nonnegative(one.quantity) && reference(one.basisRef) && source(one.source)) ||
    !expected.every(one => {
      const initial = items.find(entry => entry.itemId === one.itemId);
      return initial?.quantity >= one.quantity && proposal.resources.some(resource => resource.resourceRef === 'item:' + one.itemId && resource.basisRef === initial.basisRef);
    }) || !plainObject(profile) || !nonnegative(profile.gold) || !nonnegative(profile.yb) || !source(profile.source) ||
    profile.goldSource !== undefined && !source(profile.goldSource) || profile.ybSource !== undefined && !source(profile.ybSource) ||
    !plainObject(vase) || vase.uid !== art.officialUid || vase.vaseId !== art.vaseId || !positive(vase.uTime) || !positive(vase.cTime) || !source(vase.source)) {
    throw problem('ART_MAKE_ORIGINAL_FACTS_REQUIRED', '成本取证前必须保全实际配花、成品、金币元宝与本人花瓶来源', 400);
  }
  if (art.currentNeed?.necessary === true && (!source(profile.goldSource) || !source(profile.ybSource))) {
    throw problem('ART_MAKE_CURRENCY_SOURCES_REQUIRED', '当前花艺提案必须分别绑定金币和元宝来源');
  }
  const observation = art.costObservation, known = art.costContract;
  const link = art.productionUnit?.compatibilityLink, currentSource = art.catalogSource, rowProof = art.recipeSourceProof;
  const currentSourceAuthorized = currentSource?.dataSnapshotId
    ? link?.dataSnapshotId === currentSource.dataSnapshotId && link?.currentLoginResponseRef === currentSource.loginResponseRef &&
      link?.sourceProofFingerprint === fingerprint(currentSource.sourceProof) && link?.rowProofFingerprint === rowProof?.fingerprint &&
      rowProof?.sourceVersion === currentSource.gameVersion && rowProof?.protocolVersion === currentSource.protocolVersion &&
      rowProof?.dataSnapshotId === currentSource.dataSnapshotId && rowProof?.loginResponseRef === currentSource.loginResponseRef
    : link?.dataSnapshotId == null && link?.currentLoginResponseRef == null && link?.sourceProofFingerprint == null &&
      link?.rowProofFingerprint == null && currentSource?.gameVersion === art.versionEvidence.gameVersion;
  const compatibilityAuthorized = !observation && typeof art.productionUnit?.authorizationRef === 'string' && art.productionUnit.authorizationRef.length > 0 &&
    plainObject(link) && link.historicalCostGameVersion === known?.gameVersion && link.historicalCostProtocolVersion === known?.protocolVersion &&
    link.costReceiptRef === known?.receiptRef && link.costReceiptFingerprint === known?.receiptFingerprint &&
    link.sourceVersion === art.versionEvidence.gameVersion && link.protocolVersion === art.versionEvidence.protocolVersion && currentSourceAuthorized &&
    link.historicalQuotaRef && link.historicalOperationId &&
    link.historicalOperationFingerprint && link.historicalSettlementFingerprint && link.historicalBridgeFingerprint;
  const observing = plainObject(observation) && observation.kind === 'validation-single-cost-observation' && observation.unitRef === art.unitRef &&
    reference(observation.quotaRef) && observation.gameVersion === art.versionEvidence.gameVersion && observation.protocolVersion === '480.0.0' &&
    observation.recipeFingerprint === art.recipeFingerprint;
  const observed = !observation && known?.known === true && known.complete === true && known.kind === 'observed-versioned-recipe-cost' &&
    reference(known.receiptRef) && digest(known.receiptFingerprint) &&
    known.protocolVersion === '480.0.0' && compatibilityAuthorized &&
    known.recipeFingerprint === art.recipeFingerprint && fingerprint(known.consumptions) === fingerprint(expected) &&
    known.additionalCurrencyCostKnown === true && known.gold === 0 && known.yb === 0 && known.vaseConsumed === false;
  if (!observing && !observed) throw problem('ART_MAKE_COST_CONTRACT_UNPROVEN', '费用未知仅可进入持久单配方限额的首次成本取证，不得当作免费自动制作');
  // This validates the finite packet. The root's synchronous admission still
  // proves the quota CAS/parent deficit or the immutable observed-cost receipt.
  return freeze({ ...captured, recipe, expectedConsumptions: expected,
    costMode: observing ? 'validation-single-cost-observation' : 'observed-versioned-recipe-cost' });
}

export function artAfterCloseLoginProof({ proposal, response, bridge } = {}) {
  assertArtMakeProposal(proposal);
  const axes = ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'];
  const originalContext = Object.fromEntries(axes.map(key => [key, proposal[key]]));
  const same = (a, b, keys) => !!a && !!b && keys.every(key => a[key] === b[key]);
  const after = { connectionEpoch: response?.connectionEpoch, requestSequence: response?.requestSequence,
    wireKey: response?.wireKey, responseRef: response?.responseRef };
  const current = bridge?.newContext, closed = bridge?.oldPhysicalCloseReceipt, observed = bridge?.newLoginObservation;
  const expected = proposal.art.versionEvidence, version = observed?.versionEvidence, oldLogin = bridge?.oldLoginSource;
  if (proposal.operationDescriptor?.postRead?.kind !== 'after-close-login' || proposal.operationDescriptor.postRead.method !== 'index.login' ||
    !reference(bridge?.leaseRef) || bridge.operationId !== proposal.operationId || !digest(bridge.bridgeFingerprint) ||
    !same(bridge.originalContext, originalContext, axes) || !same(bridge.after, after, Object.keys(after)) ||
    !same(current, originalContext, axes.filter(key => key !== 'connectionEpoch')) || !positive(current?.connectionEpoch) ||
    current.connectionEpoch <= originalContext.connectionEpoch || response?.transport !== 'answered' || response?.method !== ART_MAKE_CONTRACT.method ||
    after.connectionEpoch !== originalContext.connectionEpoch || !positive(after.requestSequence) || !reference(after.wireKey) || !reference(after.responseRef) ||
    closed?.closed !== true || closed.connectionEpoch !== originalContext.connectionEpoch || !reference(closed.closureEvidenceRef) ||
    observed?.source !== 'response' || observed.transport !== 'answered' || observed.method !== 'index.login' ||
    observed.connectionEpoch !== current.connectionEpoch || !positive(observed.requestSequence) || !reference(observed.wireKey) || !reference(observed.responseRef) ||
    observed.envelopeOk !== true || observed.dsName !== 'G.ISyncData' || observed.rejected === true ||
    !positive(bridge.officialUid) || bridge.officialUid !== proposal.art.officialUid || observed.value?.['7']?.['0']?.['0'] !== bridge.officialUid ||
    oldLogin?.method !== 'index.login' || oldLogin.connectionEpoch !== originalContext.connectionEpoch || oldLogin.officialUid !== bridge.officialUid ||
    oldLogin.responseRef !== expected.loginResponseRef || oldLogin.versionEvidence?.gameVersion !== expected.gameVersion ||
    !verifyOfficialSourceVersionFrame(oldLogin, expected, originalContext, proposal.art.officialUid) || version?.gameVersion !== expected.gameVersion ||
    version?.protocolVersion !== expected.protocolVersion || version?.loginResponseRef !== observed.responseRef ||
    !verifyOfficialSourceVersionFrame(observed, version, current, proposal.art.officialUid)) {
    throw problem('ART_AFTER_CLOSE_LOGIN_BRIDGE_INVALID', '原制作与真实关闭后的同主体登录证据不匹配');
  }
  return freeze({ version: 'art-after-close-login/v1', leaseRef: bridge.leaseRef, operationId: proposal.operationId,
    originalContext, newContext: Object.fromEntries(axes.map(key => [key, current[key]])), after, bridgeFingerprint: bridge.bridgeFingerprint,
    oldPhysicalCloseReceipt: { closed: true, connectionEpoch: closed.connectionEpoch, closureEvidenceRef: closed.closureEvidenceRef },
    newLogin: { responseRef: observed.responseRef, method: 'index.login', connectionEpoch: observed.connectionEpoch,
      requestSequence: observed.requestSequence, wireKey: observed.wireKey, gameVersion: version.gameVersion,
      protocolVersion: version.protocolVersion, loginResponseRef: version.loginResponseRef }, officialUid: bridge.officialUid });
}
