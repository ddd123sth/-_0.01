import { canonical, clone, fingerprint, freeze, plainObject, problem } from '../../common.mjs';

export const LAND_IMPLEMENTATION_VERSION = 'land-single/v1';
export const LAND_CONTRACT_REF = 'official-apk-1.2.5+land-runtime/single-v1';
export const LAND_METHODS = freeze({ plant: 'usrLand.plant', water: 'usrLand.water', harvest: 'usrLand.harvest' });
export const positiveId = value => Number.isSafeInteger(value) && value > 0;
export const valueOf = cell => cell?.presence === 'present' && cell.state === 'known' ? cell.value : undefined;
export const field = (entity, name) => valueOf(entity?.fields?.[name]);
export const contextKey = context => canonical([context.ownerRef, context.accountRef, context.subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch]);
export const sameContext = (a, b) => Boolean(a && b && ['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].every(key => a[key] === b[key]));
export const configValue = receipt => receipt?.config ?? receipt;
export const landEntries = view => Object.values(view?.lands || {}).sort((a, b) => a.landId - b.landId);
export const landFieldStates = land => Object.fromEntries(['flowerId', 'state', 'harvestCnt', 'plantTime', 'nextTime'].map(name =>
  [name, { presence: land?.fields?.[name]?.presence ?? 'missing', state: land?.fields?.[name]?.state ?? 'unobserved' }]));
export const legacyItemReservationKey = (constraint, proof = null) => {
  const previous = proof?.available === true ? proof.previousExecution : null;
  const installation = typeof previous?.sourceInstallId === 'string' && typeof previous?.sourceSignerFingerprint === 'string' ?
    { installId: previous.sourceInstallId, signerFingerprint: previous.sourceSignerFingerprint } : { unprovenTransferId: constraint.transfer_id };
  return 'legacy-item:' + fingerprint([installation, constraint.source_origin_key, constraint.raw_ref]);
};
export const safeSource = source => source ? { responseRef: source.responseRef ?? null, observationRef: source.observationRef ?? null, wireKey: source.wireKey ?? null,
  connectionEpoch: source.connectionEpoch ?? null, requestSequence: source.requestSequence ?? null,
  method: source.method ?? null, sourceKind: ['response', 'late', 'push'].includes(source.sourceKind ?? source.kind ?? source.source)
    ? source.sourceKind ?? source.kind ?? source.source : null } : null;

export function captureLandArgs({ method, input, capability = null }) {
  const featureId = Object.keys(LAND_METHODS).find(id => LAND_METHODS[id] === method);
  if (!featureId || !plainObject(input)) throw problem('LAND_RPC_NOT_ADMITTED', '本阶段仅允许三种单地方法', 400);
  const keys = featureId === 'plant' ? ['flowerId', 'landId'] : ['landId'];
  if (canonical(Object.keys(input).sort()) !== canonical(keys) || !positiveId(input.landId) ||
      featureId === 'plant' && !positiveId(input.flowerId)) throw problem('LAND_RPC_ARGUMENT_INVALID', '土地参数必须与已登记单地合同完全一致', 400);
  if (capability && (capability.methods && !capability.methods.includes(method) || capability.allowed === false)) {
    throw problem('LAND_RPC_CAPABILITY_UNAVAILABLE', '本方法尚未取得限定验收能力');
  }
  const params = clone(input);
  return freeze({ params, paramsFingerprint: fingerprint(params), targetIds: [params.landId], featureId, method });
}

export function assertSingleProposal(proposal) {
  const captured = captureLandArgs({ method: proposal.method, input: proposal.params });
  const target = proposal.targets?.[0];
  if (!Array.isArray(proposal.targets) || proposal.targets.length !== 1 || target.targetKind !== 'land' ||
      target.targetRef !== `land:${proposal.subjectRef}:${captured.params.landId}` || !target.memberKey || !target.lifecycleRef ||
      captured.paramsFingerprint !== proposal.paramsFingerprint || proposal.scope !== captured.featureId || proposal.featureId !== captured.featureId) {
    throw problem('LAND_PROPOSAL_BINDING_INVALID', '单地提案目标、方法或参数绑定不一致');
  }
  return captured;
}

export function proposalContext(proposal) {
  return Object.freeze(Object.fromEntries(['ownerRef', 'accountRef', 'subjectRef', 'ownerEpoch', 'runEpoch', 'connectionEpoch'].map(key => [key, proposal[key]])));
}
