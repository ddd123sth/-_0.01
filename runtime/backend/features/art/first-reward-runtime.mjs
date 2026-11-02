import { canonical, clone, fingerprint, freeze, newId } from '../../common.mjs';
import { ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { ART_FIRST_ALBUM_CONTRACT, ART_FIRST_SHARE_CONTRACT, ART_FIRST_ALBUM_POST_READ, ART_FIRST_SHARE_POST_READ,
  assertArtFirstAlbumProposal, assertArtFirstShareProposal, artFirstAlbumTargetVerification, artFirstShareTargetVerification } from './first-reward-contract.mjs';
import { createTechnicalHoldReviews } from './technical-hold-review.mjs';

const AXES = ['ownerRef','accountRef','subjectRef','ownerEpoch','runEpoch','connectionEpoch'];
const contextView = context => Object.fromEntries(AXES.map(key => [key, key === 'accountRef' ? String(context[key]) : context[key]]));
const sameContext = (a,b) => !!a && !!b && canonical(contextView(a)) === canonical(contextView(b));
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const sourceRef = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sync = value => { if (value?.then) { value.catch?.(() => {}); throw new TypeError('Art reward readers must be synchronous'); } return value; };

export function createArtFirstRewardRuntime({ store, artRuntime, resources, dynamicState, readConfiguration, extensionForContext,
  isCurrent, ledgerView, appendOutbox = () => {} } = {}) {
  for (const fn of [store?.run,store?.get,store?.transaction,store?.nowIso,artRuntime?.firstRewardInputs,artRuntime?.firstRewardBalances,resources?.matchedItemFlow,
    dynamicState?.snapshot,readConfiguration,extensionForContext,isCurrent,ledgerView?.currentAdmission,ledgerView?.operation,appendOutbox])
    if (typeof fn !== 'function') throw new TypeError('Art first reward requires bounded shared ports');
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_art_first_reward_claims(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,target_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
    state TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,feature_id,target_ref));
    CREATE TRIGGER IF NOT EXISTS backend_art_first_reward_claims_no_delete BEFORE DELETE ON backend_art_first_reward_claims
      BEGIN SELECT RAISE(ABORT,'first reward claim history is retained'); END;
    CREATE TABLE IF NOT EXISTS backend_art_technical_holds(
      owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,feature_id TEXT NOT NULL,implementation_version TEXT NOT NULL,
      reason_code TEXT NOT NULL,operation_id TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(owner_ref,subject_ref,feature_id,implementation_version));
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_holds_no_update BEFORE UPDATE ON backend_art_technical_holds
      BEGIN SELECT RAISE(ABORT,'art technical holds are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_art_technical_holds_no_delete BEFORE DELETE ON backend_art_technical_holds
      BEGIN SELECT RAISE(ABORT,'art technical holds are retained'); END;`);
  const technicalFailure = code => ['VERIFICATION_OPERATION_SCOPE_MISMATCH','VERIFICATION_OPERATION_CONTRACT_INVALID',
    'VERIFICATION_OPERATION_ORIGINAL_INVALID','DYNAMIC_COVERAGE_INVALID','WRITE_POST_READ_COVERAGE_UNPROVEN',
    'PROTOCOL_OBSERVATION_FAILED'].includes(code);
  const technicalHold = (context, featureId, implementationVersion) => store.get(`SELECT reason_code FROM backend_art_technical_holds
    WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND implementation_version=?`, context.ownerRef, context.subjectRef, featureId, implementationVersion);
  const holdReviews = createTechnicalHoldReviews({ store });
  const holdKeyFor = (context, featureId, implementationVersion) => ({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, featureId, implementationVersion });
  const reviewKey = (proposal, feature) => ({ ...holdKeyFor(proposal, proposal.featureId, feature.implementationVersion),
    ...contextView(proposal), operationId: proposal.operationId });
  function claimTechnicalReview({ proposal } = {}) {
    const feature = features[proposal?.featureId];
    if (!feature || !isCurrent(proposal)) return { accepted: false, reasonCode: 'ART_FIRST_REWARD_CONTEXT_NOT_CURRENT' };
    const key = reviewKey(proposal, feature), hold = holdReviews.state(key);
    if (!hold.held) return { accepted: true };
    const claimed = holdReviews.beginProbe(key);
    return { accepted: Boolean(claimed), reasonCode: claimed ? null : 'ART_FIRST_REWARD_TECHNICAL_HOLD:' + hold.reasonCode };
  }
  function finishTechnicalReview({ proposal } = {}) {
    const feature = features[proposal?.featureId];
    return feature ? holdReviews.finishProbe(reviewKey(proposal, feature)) : null;
  }
  const contracts = {
    'art.first-album': { contract: ART_FIRST_ALBUM_CONTRACT, postRead: ART_FIRST_ALBUM_POST_READ,
      assertion: assertArtFirstAlbumProposal, targetVerification: artFirstAlbumTargetVerification, configKey: 'firstAlbumClaim', action: 'album' },
    'art.first-share': { contract: ART_FIRST_SHARE_CONTRACT, postRead: ART_FIRST_SHARE_POST_READ,
      assertion: assertArtFirstShareProposal, targetVerification: artFirstShareTargetVerification, configKey: 'firstShareClaim', action: 'share' },
  };
  function domains(context, feature, proposal) {
    const snapshot = dynamicState.snapshot({ context: contextView(context), feature, config: readConfiguration(context)?.config || null, method: proposal?.method, proposal });
    return snapshot?.current === true && Array.isArray(snapshot.domains) ? snapshot.domains.map(domain => Object.fromEntries(
      ['domainId','current','semanticRevision','semanticFingerprint','sourceRef','sourceKind','method','requestSequence','observedAtMs','coverage','sourceProofs','dirty','reasonCode']
        .map(key => [key,domain[key]]))) : null;
  }
  function factBasis({ proposal, actor, feature } = {}) {
    if (!actor || !isCurrent(actor)) return { current: false, reasonCode: 'ART_FIRST_REWARD_CONTEXT_NOT_CURRENT' };
    const context = contextView(actor), inputs = sync(artRuntime.firstRewardInputs(context)), config = readConfiguration(context), d = domains(context,feature,proposal);
    const ext = extensionForContext(context);
    if (!inputs?.current || !d || !ext || proposal?.artFirstReward?.extensionRef !== ext.extensionRef ||
        proposal?.artFirstReward?.extension?.extensionRef !== ext.extensionRef) return { current:false,reasonCode:'ART_FIRST_REWARD_FACTS_NOT_CURRENT' };
    return freeze({ current:true,fingerprint:fingerprint({ context,inputs,featureId:feature.featureId,
      configEnabled:config?.config?.art?.[contracts[feature.featureId].configKey] === true,
      extensionRef:ext?.extensionRef || null,domains:d }) });
  }
  function isEligible(entry, featureId) {
    if (featureId === 'art.first-album') return entry.albumClaimed === false && entry.expKnown === true && nonnegative(entry.exp);
    const row = entry.shareRow;
    return entry.shareEligible === true && entry.shareRoute?.current === true && entry.shareRoute?.direct === true &&
      entry.shareClaimed === false && row?.id === 6 && Array.isArray(row.award) && row.award.length > 0 &&
      row.award.every(one => Array.isArray(one) && positive(one[0]) && positive(one[1])) &&
      positive(row.limit) && sourceRef(row.openId) && Array.isArray(entry.shareBalances) &&
      entry.shareBalances.length === row.award.length && entry.shareBalances.every((one, index) => one?.itemId === row.award[index][0] &&
        nonnegative(one.value) && sourceRef(one.basisRef) && one.source?.method === 'index.login' && one.source.responseRef === entry.loginResponseRef);
  }
  function targetInfo(featureId, entry, inputs) {
    if (featureId === 'art.first-album') {
      const siblings = inputs.albumReady === true && positive(entry.vaseId) && entry.vase?.known === true && entry.vase.owned === true
        ? inputs.albumClaimsByVase?.[String(entry.vaseId)] : null;
      if (!Array.isArray(siblings) || !siblings.length) return null;
      const claimSetFingerprint = fingerprint(siblings), targetRef = `art-first-album:${inputs.context.subjectRef}:${entry.vaseId}:${claimSetFingerprint}`;
      return { id: entry.vaseId, claimArtIds: siblings, claimSetFingerprint, targetRef, memberKey: `art-first-album:${entry.vaseId}` };
    }
    const targetRef = `art-first-share:${inputs.context.subjectRef}:${entry.artId}`;
    return { id: entry.artId, claimSetFingerprint: null, targetRef, memberKey: `art-first-share:${entry.artId}` };
  }
  function claimState(context, featureId, targetRef) {
    const claimed = store.get(`SELECT * FROM backend_art_first_reward_claims WHERE owner_ref=? AND subject_ref=? AND feature_id=? AND target_ref=?`,
      context.ownerRef,context.subjectRef,featureId,targetRef);
    if (!claimed) return null;
    const operation = ledgerView.operation(claimed.operation_id);
    // Not-sent / not-applicable records consumed neither the RPC nor the
    // target. Preserve their ledger rows, but let a later current proposal retry.
    if (operation?.transport_state === 'not_sent' && operation.business_verdict === 'not_applicable' && operation.write_slot !== 1) return null;
    return claimed;
  }
  function heldAlbumClaims(context, vaseId, excludeOperationId = null) {
    const admission = ledgerView.currentAdmission({ ownerRef: context.ownerRef, subjectRef: context.subjectRef, featureIds: ['art.first-album'] });
    if (!Array.isArray(admission?.unresolvedOperations)) return null;
    const held = [];
    for (const row of admission.unresolvedOperations) {
      if (row.operation_id === excludeOperationId) continue;
      const operation = ledgerView.operation(row.operation_id);
      if (operation?.feature_id !== 'art.first-album') continue;
      const stored = store.get(`SELECT kind,source,payload_json,payload_fingerprint,observed_at FROM backend_operation_evidence
        WHERE operation_id=? AND evidence_key='finite-domain-preparation:v1' AND kind='finite-domain-preparation' AND source='backend/write-gateway/v2'`, row.operation_id);
      let envelope = null;
      try { envelope = stored && JSON.parse(stored.payload_json); } catch { /* invalid evidence conservatively holds the vase */ }
      if (!stored || !envelope || ledgerJsonFingerprint({ kind: stored.kind, source: stored.source, payload: envelope, observedAt: stored.observed_at }) !== stored.payload_fingerprint) {
        held.push({ vaseId: null, artIds: null }); continue;
      }
      const preparation = envelope?.preparation;
      if (envelope.domain !== 'art-first-album' || preparation?.kind !== 'album' || !positive(preparation.vaseId) ||
          !Array.isArray(preparation.claimArtIds) || !preparation.claimArtIds.length || !preparation.claimArtIds.every(positive) ||
          preparation.claimSetFingerprint !== fingerprint(preparation.claimArtIds)) {
        held.push({ vaseId: null, artIds: null }); continue;
      }
      if (preparation.vaseId === vaseId) held.push({ vaseId, artIds: preparation.claimArtIds });
    }
    return held;
  }
  function readFactBasisFor(proposal, actor, feature) { return factBasis({ proposal, actor, feature }); }
  function evaluateAdmission({ proposal, actor, factBasis: supplied, ownReservation } = {}) {
    const feature = contracts[proposal?.featureId] && features[proposal.featureId];
    if (!feature || !actor || !isCurrent(actor) || !sameContext(actor,proposal)) return { historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_CONTEXT_NOT_CURRENT' };
    const hold=holdReviews.state(reviewKey(proposal,feature));
    if(hold.held && !hold.probeAllowed && !hold.ownedProbe)
      return{historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_TECHNICAL_HOLD:'+hold.reasonCode};
    const cfg=readConfiguration(contextView(actor)), action=proposal.artFirstReward, inputs=sync(artRuntime.firstRewardInputs(contextView(actor))), current=factBasis({proposal,actor,feature});
    const entry=inputs?.entries?.find(one=>one.artId===action?.artId && one.vaseId===action?.vaseId);
    const expected=entry && targetInfo(proposal.featureId,entry,inputs);
    if(cfg?.config?.art?.[contracts[proposal.featureId].configKey]!==true || !current.current || supplied?.fingerprint!==current.fingerprint ||
       !entry || !isEligible(entry,proposal.featureId) || expected?.targetRef!==proposal.targets?.[0]?.targetRef ||
       proposal.paramsFingerprint!==fingerprint(proposal.params))
      return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_TARGET_OR_FACTS_CHANGED'};
    const admission=ledgerView.currentAdmission({ownerRef:actor.ownerRef,subjectRef:actor.subjectRef,targetRefs:proposal.targets.map(one=>one.targetRef),resourceKeys:[],featureIds:[proposal.featureId]});
    if(!Array.isArray(admission?.unresolvedOperations)) return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_HISTORY_UNREADABLE'};
    for(const row of admission.unresolvedOperations) if(row.operation_id!==proposal.operationId) {
      const prior=ledgerView.operation(row.operation_id);
      if(prior?.targets?.some(one=>one.target_ref===expected.targetRef))
        return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_PRIOR_UNKNOWN_HELD'};
    }
    if (proposal.featureId === 'art.first-album') {
      const held = heldAlbumClaims(contextView(actor), action.vaseId, proposal.operationId);
      if (!held || held.some(one => one.vaseId === null || one.artIds.some(id => action.claimArtIds.includes(id))))
        return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_ALBUM_OVERLAPPING_UNKNOWN_SET_HELD'};
    }
    const claimed=claimState(actor,proposal.featureId,expected.targetRef);
    if(claimed && claimed.operation_id!==proposal.operationId) return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:false,reasonCode:'ART_FIRST_REWARD_CLAIM_CHANGED'};
    return {historicalConstraintsChecked:true,currentInFlightChecked:true,allowed:true,targetsCurrent:true,resourcesCurrent:true,reasonCode:null};
  }
  function makeProposal(input, feature, inputs, entry) {
    const info=targetInfo(feature.featureId,entry,inputs); if(!info) return null;
    const extension=extensionForContext(contextView(input.context));
    if(!extension?.extensionRef||extension.loginResponseRef!==inputs.loginResponseRef||
       extension.baseDataSnapshotId!==inputs.dataSnapshotId)return null;
    const prior=claimState(input.context,feature.featureId,info.targetRef); if(prior) return null;
    const operationId=newId(), action={ kind:contracts[feature.featureId].action, officialUid:inputs.officialUid, artId:entry.artId,
      vaseId:entry.vaseId, memberKey:info.memberKey,lifecycleRef:info.targetRef,targetRef:info.targetRef,
      ...(info.claimSetFingerprint?{claimSetFingerprint:info.claimSetFingerprint,claimArtIds:[...info.claimArtIds]}:{}), beforeExp:entry.exp ?? null,
      beforeShareRow:entry.shareRow || null, beforeShareBalances:entry.shareBalances || null, sourceRefs:entry.sourceRefs, loginResponseRef:inputs.loginResponseRef,
      extension:clone(extension),extensionRef:extension.extensionRef,
      ...(feature.featureId==='art.first-share'?{shareRoute:entry.shareRoute}:{}),
      versionEvidence:inputs.versionEvidence, dataSnapshotId:inputs.dataSnapshotId, recipeFingerprint:entry.recipeFingerprint };
    const params=feature.featureId==='art.first-album'?{flowerArtId:entry.vaseId}:{shareId:6,ext:{opType:2,id:entry.artId}};
    const target={targetKind:contracts[feature.featureId].contract.targetKind,targetRef:info.targetRef,memberKey:info.memberKey,
      lifecycleRef:info.targetRef,targetFingerprint:fingerprint({targetRef:info.targetRef,artId:entry.artId,vaseId:entry.vaseId,
        claimSet:info.claimSetFingerprint||null,claimArtIds:info.claimArtIds||null})};
    const proposal={...contextView(input.context),operationId,proposalId:newId(),featureId:feature.featureId,scope:contracts[feature.featureId].contract.scope,
      method:contracts[feature.featureId].contract.method,params,paramsFingerprint:fingerprint(params),contractRef:contracts[feature.featureId].contract.contractRef,
      semanticKey:info.targetRef,configRevision:input.config.savedRevision,featureCancelEpoch:input.config.featureCancelEpochs?.[feature.featureId],
      targets:[target],resources:[],resourceBindings:[],artFirstReward:action,traceId:fingerprint({featureId:feature.featureId,targetRef:info.targetRef,source:inputs.loginResponseRef})};
    contracts[feature.featureId].assertion(proposal);
    const basis=readFactBasisFor(proposal,input.context,feature); if(!basis.current)return null; proposal.factBasis=basis;
    return freeze(proposal);
  }
  async function verify({proposal,response,connection}={}) {
    const unknown=reasonCode=>({verdict:'unknown',reasonCode,verificationVersion:proposal?.featureId==='art.first-album'?'art-first-album/target-postread/v1':'art-first-share/target-postread/v1',
      evidence:{targetRef:proposal?.targets?.[0]?.targetRef||null,artId:proposal?.artFirstReward?.artId||null,vaseId:proposal?.artFirstReward?.vaseId||null},resourceResolutions:[]});
    let bridge;try{bridge=await connection.readSnapshotAfterClose();}catch(error){return unknown(error?.code||'ART_FIRST_REWARD_POSTREAD_FAILED');}
    const post=bridge?.newLoginObservation, action=proposal.artFirstReward;
    if(bridge?.operationId!==proposal.operationId||bridge.oldPhysicalCloseReceipt?.closed!==true||post?.method!=='index.login'||post.source!=='response'||
      post.transport!=='answered'||post.envelopeOk!==true||post.dsName!=='G.ISyncData'||bridge.officialUid!==action.officialUid) return unknown('ART_FIRST_REWARD_POSTREAD_INVALID');
    const inputs=sync(artRuntime.firstRewardInputs(contextView(bridge.newContext))), entry=inputs?.entries?.find(one=>one.artId===action.artId&&one.vaseId===action.vaseId);
    if(!inputs?.current||inputs.loginResponseRef!==post.responseRef||!entry) return unknown('ART_FIRST_REWARD_POSTLOGIN_FACTS_NOT_CURRENT');
    if(proposal.featureId==='art.first-album'){
      if(inputs.albumReady!==true || !Array.isArray(action.claimArtIds) || action.claimArtIds.some(artId =>
        !inputs.entries.find(one => one.artId===artId && one.vaseId===action.vaseId)?.albumClaimed))
        return unknown('ART_FIRST_ALBUM_VASE_HISTORY_NOT_UPDATED');
      const flow=resources.matchedItemFlow({context:proposal,source:response,method:proposal.method,itemId:6,
        featureId:proposal.featureId,contractRef:proposal.contractRef});
      const before=action.beforeExp, after=entry.exp;
      if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||!flow||flow.responseRef!==response.responseRef||flow.method!==response.method||
        flow.connectionEpoch!==response.connectionEpoch||flow.requestSequence!==response.requestSequence||flow.wireKey!==response.wireKey||
        flow.bi?.state!=='known'||!nonnegative(flow.bi.value)||after-before!==flow.bi.value||flow.bi.value<=0)
        return unknown('ART_FIRST_ALBUM_EXPERIENCE_GAIN_UNPROVEN');
      return {verdict:'confirmed',verificationVersion:'art-first-album/target-postread/v1',postReadRef:post.responseRef,resourceResolutions:[],
        evidence:{operationId:proposal.operationId,targetRef:proposal.targets[0].targetRef,artId:action.artId,vaseId:action.vaseId,
          beforeExp:before,afterExp:after,experienceGain:flow.bi.value,writeResponseRef:response.responseRef,newLoginResponseRef:post.responseRef,
          bridgeFingerprint:bridge.bridgeFingerprint,leaseRef:bridge.leaseRef,sourceRefs:action.sourceRefs}};
    }
    if(entry.shareClaimed!==true) return unknown('ART_FIRST_SHARE_HISTORY_NOT_UPDATED');
    const awards=action.beforeShareRow?.award;
    if(!Array.isArray(awards)||!awards.length||!awards.every(one=>Array.isArray(one)&&positive(one[0])&&positive(one[1])))
      return unknown('ART_FIRST_SHARE_AWARD_SOURCE_UNPROVEN');
    const flows={};
    for(const [itemId,quantity] of awards){
      const flow=resources.matchedItemFlow({context:proposal,source:response,method:proposal.method,itemId,
        featureId:proposal.featureId,contractRef:proposal.contractRef});
      const before=action.beforeShareBalances?.find(one=>one.itemId===itemId);
      const after=artRuntime.firstRewardBalances(contextView(bridge.newContext),[itemId])?.balances?.[0] || null;
      const profileFlow=after?.resourceKind==='profile' ? resources.matchedProfileFlow({context:proposal,source:response,method:proposal.method,
        field:after.field,featureId:proposal.featureId,contractRef:proposal.contractRef}) : null;
      if(!flow||flow.responseRef!==response.responseRef||flow.method!==response.method||flow.connectionEpoch!==response.connectionEpoch||
        flow.requestSequence!==response.requestSequence||flow.wireKey!==response.wireKey||flow.bi?.state!=='known'||flow.bi.value!==quantity||
        !before||after?.itemId!==itemId||!nonnegative(after.value)||after.source?.method!=='index.login'||after.source.responseRef!==post.responseRef||
        after.source.connectionEpoch!==post.connectionEpoch||after.source.requestSequence!==post.requestSequence||after.value-before.value!==quantity||
        after.resourceKind==='profile' && profileFlow && (profileFlow.responseRef!==response.responseRef||profileFlow.value!==after.value) ||
        after.resourceKind==='bag' && flow.bd?.presence==='present'&&(flow.bd.state!=='known'||flow.bd.value!==after.value))
        return unknown('ART_FIRST_SHARE_REWARD_FLOW_UNPROVEN');
      flows[itemId]={quantity,before:{value:before.value,basisRef:before.basisRef,source:before.source,resourceKind:before.resourceKind,field:before.field||null},
        after:{value:after.value,basisRef:after.basisRef,source:after.source,resourceKind:after.resourceKind,field:after.field||null},
        frameFingerprint:flow.frameFingerprint,responseRef:flow.responseRef,requestSequence:flow.requestSequence,wireKey:flow.wireKey,
        profileFlow:profileFlow||null,bd:flow.bd||null};
    }
    return {verdict:'confirmed',verificationVersion:'art-first-share/target-postread/v1',postReadRef:post.responseRef,resourceResolutions:[],
      evidence:{operationId:proposal.operationId,targetRef:proposal.targets[0].targetRef,artId:action.artId,shareId:6,award:awards,flows,
        writeResponseRef:response.responseRef,newLoginResponseRef:post.responseRef,bridgeFingerprint:bridge.bridgeFingerprint,leaseRef:bridge.leaseRef,
        sourceRefs:action.sourceRefs}};
  }
  function onSettled({proposal,verification}={}){
    const operation = ledgerView.operation(proposal.operationId);
    const feature=features[proposal.featureId], reasonCode=verification?.reasonCode||null;
    const notSent = operation?.transport_state === 'not_sent' && operation.business_verdict === 'not_applicable' && operation.write_slot !== 1;
    finishTechnicalReview({ proposal });
    if (notSent) return;
    const state=verification?.verdict==='confirmed'?'confirmed': 'unknown-held';
    if (verification?.verdict !== 'confirmed' && technicalFailure(reasonCode)) store.run(`INSERT OR IGNORE INTO backend_art_technical_holds
      (owner_ref,subject_ref,feature_id,implementation_version,reason_code,operation_id,created_at) VALUES(?,?,?,?,?,?,?)`,
      proposal.ownerRef,proposal.subjectRef,proposal.featureId,feature?.implementationVersion||'unknown',reasonCode,proposal.operationId,store.nowIso());
    store.transaction(()=>store.run(`INSERT INTO backend_art_first_reward_claims(owner_ref,subject_ref,feature_id,target_ref,operation_id,state,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,feature_id,target_ref) DO UPDATE SET
      operation_id=excluded.operation_id,state=excluded.state,updated_at=excluded.updated_at`, proposal.ownerRef,proposal.subjectRef,
      proposal.featureId,proposal.targets[0].targetRef,proposal.operationId,state,store.nowIso()));
    appendOutbox({ownerRef:proposal.ownerRef,subjectRef:proposal.subjectRef,eventType:'FeatureSettlement',eventKey:'art-first-reward:'+proposal.operationId,
      payload:{operationId:proposal.operationId,featureId:proposal.featureId,verdict:verification?.verdict||'unknown',reasonCode:verification?.reasonCode||null,
        connectionEpoch:proposal.connectionEpoch,method:proposal.method}});
  }
  const features=Object.fromEntries(Object.entries(contracts).map(([featureId,entry])=>{
    const assess=input=>{
      if(input.config?.config?.art?.[entry.configKey]!==true)return{state:'disabled',reasonCode:'ART_FIRST_REWARD_DISABLED'};
      if(!isCurrent(input.context))return{state:'waiting-facts',reasonCode:'ART_FIRST_REWARD_CONTEXT_NOT_CURRENT',deviceDueMs:Date.now()+15000};
      const context=contextView(input.context), source=sync(artRuntime.firstRewardInputs(context));
      if(!source?.current)return{state:'waiting-facts',reasonCode:source?.reasonCode||'ART_FIRST_REWARD_FACTS_NOT_CURRENT',deviceDueMs:Date.now()+15000};
      const hold=holdReviews.state(holdKeyFor(context,featureId,definition.implementationVersion));
      if(hold.held && !hold.probeAllowed)return{state:'waiting-facts',reasonCode:'ART_FIRST_REWARD_TECHNICAL_HOLD:'+hold.reasonCode,deviceDueMs:hold.nextProbeAtMs||Date.now()+30000};
      for(const candidate of source.entries){if(!isEligible(candidate,featureId))continue;
        const proposal=makeProposal(input,definition,source,candidate);if(!proposal)continue;
        const admission=evaluateAdmission({proposal,actor:input.context,factBasis:proposal.factBasis,boundary:'before-prepare'});
        if(admission.allowed)return{state:'proposals',proposals:[proposal],factBasis:proposal.factBasis};}
      return{state:'waiting-facts',reasonCode:featureId==='art.first-share'?'ART_FIRST_SHARE_DIRECT_ROUTE_OR_ELIGIBILITY_UNPROVEN':'ART_FIRST_ALBUM_NO_UNCLAIMED_VASE_REWARD',deviceDueMs:Date.now()+30000};
    };
    const definition=Object.freeze({featureId,label:featureId==='art.first-album'?'花艺图鉴奖励':'花艺首次分享奖励',phase:'G4',scopes:[entry.contract.scope],
      methods:[entry.contract.method],methodScopes:{[entry.contract.method]:entry.contract.scope},operationContracts:{[entry.contract.method]:Object.freeze({...entry.contract,postRead:entry.postRead,
        validateTargetVerification:entry.targetVerification})},contractRef:entry.contract.contractRef,resourceKinds:[],factDomains:featureId==='art.first-album'?['art-album']:['art-share','customer-eligibility'],
      consumedDomains:featureId==='art.first-album'?['art-album','inventory','profile','clock']:['art-share','inventory','profile','clock','customer-eligibility'],release:'validation-only',
      implementationVersion:featureId+'/source-bound-request-only/v2',scheduleUnits:[{scheduleKey:featureId+':claim',wakeKey:featureId+':claim',assess}],assess,
      qualify:evaluateAdmission,verify,readFactBasis:input=>factBasis({...input,feature:definition}),evaluateAdmission,onSettled,onCurrentVerified:()=>{},
      claimTechnicalReview,finishTechnicalReview});
    return [featureId,definition];
  }));
  return Object.freeze({features:Object.freeze(features),feature:id=>features[id]||null});
}
