import { canonical, clone, fingerprint, freeze, parseStored, problem } from '../../common.mjs';
import { hashLedgerBytes, ledgerJsonFingerprint } from '../../persistence/json-contract.mjs';
import { configValue, field, landEntries, safeSource, sameContext, valueOf } from './rpc-contract.mjs';
import { proveLandStageSeparation } from './admission.mjs';
import { resolveAcceptedLandObservationEvidence } from './compatibility-evidence.mjs';
import { createLandGroupHistory } from './group-history.mjs';

const liveMember = member => member.currentBinding?.state !== 'historical' && !['cancelled', 'finished'].includes(member.state);
const pendingMember = member => ['planned', 'pending', 'unknown', 'conflict'].includes(member.state) || typeof member.currentUnknownOperationId === 'string';

export function createLandGroups({ store, projection, lifecycles, appendOutbox, ledgerView = null, isolationEvidence = null, clock = null,
  isCurrent = () => false }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_land_group_heads(
    owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,group_ref TEXT NOT NULL,document_json TEXT NOT NULL,
    revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_ref,subject_ref,group_ref));
    CREATE TABLE IF NOT EXISTS backend_land_group_receipts(
    receipt_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,group_ref TEXT NOT NULL,
    kind TEXT NOT NULL,payload_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_land_group_receipts_immutable BEFORE UPDATE ON backend_land_group_receipts
      BEGIN SELECT RAISE(ABORT,'land group receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_land_group_receipts_append_only BEFORE DELETE ON backend_land_group_receipts
      BEGIN SELECT RAISE(ABORT,'land group receipts are append only'); END;`);
  const history = createLandGroupHistory({ store, ledgerView });
  const rows = context => store.all('SELECT * FROM backend_land_group_heads WHERE owner_ref=? AND subject_ref=? ORDER BY group_ref', context.ownerRef, context.subjectRef);
  const documents = context => rows(context).map(row => ({ ...parseStored(row.document_json, '土地组'), revision: row.revision }));
  function receipt(context, groupRef, kind, payload) {
    const ref = fingerprint([context.ownerRef, context.subjectRef, groupRef, kind, payload]);
    store.run('INSERT OR IGNORE INTO backend_land_group_receipts VALUES(?,?,?,?,?,?,?)', ref, context.ownerRef, context.subjectRef,
      groupRef, kind, canonical(payload), store.nowIso());
    return ref;
  }
  function save(context, group, kind) {
    const document = clone(group); delete document.revision;
    const old = store.get('SELECT * FROM backend_land_group_heads WHERE owner_ref=? AND subject_ref=? AND group_ref=?', context.ownerRef, context.subjectRef, group.groupRef);
    if (old?.document_json === canonical(document)) return false;
    const revision = (old?.revision || 0) + 1;
    store.run(`INSERT INTO backend_land_group_heads VALUES(?,?,?,?,?,?) ON CONFLICT(owner_ref,subject_ref,group_ref)
      DO UPDATE SET document_json=excluded.document_json,revision=excluded.revision,updated_at=excluded.updated_at`,
    context.ownerRef, context.subjectRef, group.groupRef, canonical(document), revision, store.nowIso());
    receipt(context, group.groupRef, kind, { revision, documentFingerprint: fingerprint(document), document });
    return true;
  }
  function view(context) {
    const groups = documents(context);
    return freeze({ groups, layoutBasis: 'stable-land-id-order', flowerOccupancy(flowerId) {
      return new Set(groups.flatMap(group => group.flowerId === flowerId && group.state !== 'closed' && group.currentBinding?.state !== 'historical'
        ? group.members.filter(liveMember).map(member => member.landId) : [])).size;
    } });
  }
  function reconcile({ context, configReceipt, currentView = null }) {
    const reusable = currentView?.current === true && currentView.identity?.verified === true && currentView.context &&
      sameContext(context, currentView.context) && isCurrent(context);
    const config = configValue(configReceipt), current = reusable ? currentView : projection.view(context);
    if (!current.current || current.identity?.verified !== true) return view(context);
    return store.transaction(() => {
      const groups = documents(context), owned = new Set();
      const accepted = new Map(), adoptions = new Map(), closedAdoptionWrites = new Map();
      const activeSlot = store.get('SELECT operation_id FROM backend_operations WHERE owner_ref=? AND subject_ref=? AND write_slot=1 LIMIT 1',
        context.ownerRef, context.subjectRef);
      const acceptedSource = source => {
        if (source?.kind !== 'response' || source.connectionEpoch !== context.connectionEpoch ||
            !Number.isSafeInteger(source.requestSequence) || source.requestSequence < 1 || !source.observationRef || !source.responseRef) return null;
        const key = canonical(source);
        if (!accepted.has(key)) accepted.set(key, resolveAcceptedLandObservationEvidence({ store, context,
          observationRef: source.observationRef, source }));
        return accepted.get(key);
      };
      function settledAdoptionWrites(group) {
        if (closedAdoptionWrites.has(group.groupRef)) return closedAdoptionWrites.get(group.groupRef);
        const members = [...group.members, ...(group.round?.members ?? [])];
        let result = null;
        if (!members.some(item => item.currentUnknownOperationId || item.state === 'unknown')) {
          result = [];
          for (const operationId of new Set(members.map(item => item.operationId).filter(Boolean))) {
            const operation = store.get('SELECT * FROM backend_operations WHERE operation_id=?', operationId);
            let original;
            try { original = operation && parseStored(operation.original_json, '土地接收组历史操作'); } catch { /* keep the old binding */ }
            const roundMember = group.round?.members.find(item => item.operationId === operationId);
            const groupMember = roundMember && group.members.find(item => item.memberKey === roundMember.memberKey && item.landId === roundMember.landId);
            const basis = original?.factBasis, target = original?.targets?.[0];
            if (!operation || operation.owner_ref !== context.ownerRef || operation.account_ref !== context.accountRef ||
                operation.subject_ref !== context.subjectRef || operation.transport_state !== 'answered' ||
                operation.business_verdict !== 'confirmed' || operation.write_slot !== 0 ||
                !original || hashLedgerBytes(operation.original_json) !== operation.original_fingerprint ||
                ledgerJsonFingerprint(original) !== operation.original_fingerprint || original.operationId !== operationId ||
                !['ownerRef', 'accountRef', 'subjectRef', 'runEpoch', 'connectionEpoch'].every((key, index) =>
                  original[key] === operation[['owner_ref', 'account_ref', 'subject_ref', 'run_epoch', 'connection_epoch'][index]]) ||
                operation.feature_id !== 'harvest' || operation.scope !== 'harvest' || operation.method !== 'usrLand.harvest' ||
                original.featureId !== operation.feature_id || original.scope !== operation.scope || original.method !== operation.method ||
                original.paramsFingerprint !== operation.params_fingerprint ||
                !roundMember || roundMember.state !== 'confirmed' || !groupMember || groupMember.cropRef !== roundMember.cropRef ||
                members.some(item => item.operationId === operationId && (item.landId !== roundMember.landId || item.memberKey !== roundMember.memberKey)) ||
                basis?.version !== 'land-single-basis/v1' || basis.groupRef !== group.groupRef || basis.roundRef !== group.round.roundRef ||
                basis.groupMemberKey !== roundMember.memberKey || basis.target?.landId !== roundMember.landId ||
                basis.target.cropRef !== roundMember.cropRef || basis.target.lifecycleRef !== roundMember.stageRef || basis.target.flowerId !== group.flowerId ||
                !Array.isArray(original.targets) || original.targets.length !== 1 || target?.targetKind !== 'land' || target.targetRef !== `land:${context.subjectRef}:${roundMember.landId}` ||
                target.lifecycleRef !== roundMember.stageRef) { result = null; break; }
            result.push({ operationId, originalFingerprint: operation.original_fingerprint, transport: operation.transport_state,
              verdict: operation.business_verdict, writeSlot: operation.write_slot, landId: roundMember.landId,
              memberKey: roundMember.memberKey, cropRef: roundMember.cropRef, stageRef: roundMember.stageRef });
          }
        }
        closedAdoptionWrites.set(group.groupRef, result);
        return result;
      }
      function supersededAdoption(group, member, land, life) {
        const settledWrites = activeSlot || group.adoption !== true ? null : settledAdoptionWrites(group);
        if (!settledWrites ||
            !land?.current || land.status !== 'occupied' || !sameContext(context, life?.context) ||
            life.landId !== member.landId || life.status !== 'occupied' || !life.cropRef || life.cropRef === member.cropRef ||
            life.landSemanticVersion !== land.semanticVersion || life.confidence === 'unknown' ||
            !Number.isSafeInteger(group.flowerId) || group.flowerId < 1 || !Number.isSafeInteger(field(land, 'flowerId')) ||
            field(land, 'flowerId') < 1 || field(land, 'flowerId') === group.flowerId || life.flowerId !== field(land, 'flowerId')) return null;
        if (!adoptions.has(group.groupRef)) {
          const row = store.get(`SELECT receipt_ref,payload_json FROM backend_land_group_receipts
            WHERE owner_ref=? AND subject_ref=? AND group_ref=? AND kind='adopted'`, context.ownerRef, context.subjectRef, group.groupRef);
          let payload = null;
          try { payload = row && parseStored(row.payload_json, '土地原始接收组证据'); } catch { /* no proof, no retirement */ }
          adoptions.set(group.groupRef, row && payload && row.receipt_ref === fingerprint([context.ownerRef, context.subjectRef,
            group.groupRef, 'adopted', payload]) && payload.documentFingerprint === fingerprint(payload.document) ? { row, payload } : null);
        }
        const adopted = adoptions.get(group.groupRef), original = adopted?.payload.document;
        const oldMember = original?.members?.find(item => item.memberKey === member.memberKey && item.landId === member.landId);
        if (original?.adoption !== true || original.flowerId !== group.flowerId || oldMember?.cropRef !== member.cropRef ||
            !oldMember?.cropRef || oldMember.operationId || oldMember.currentUnknownOperationId) return null;
        const identity = acceptedSource(current.identity.source), evidence = acceptedSource(land.source);
        const sourceMember = evidence?.frame.landChanges?.value?.[String(member.landId)] ?? evidence?.frame.landBase?.value?.[String(member.landId)];
        if (!identity || !Number.isSafeInteger(valueOf(current.identity.uid)) || valueOf(current.identity.uid) < 1 ||
            valueOf(identity.frame.profile.uid) !== valueOf(current.identity.uid) || !evidence ||
            sourceMember?.valid !== true || sourceMember.removed || field(sourceMember, 'flowerId') !== life.flowerId ||
            ![1, 2, 3].includes(field(sourceMember, 'state')) ||
            canonical(land.fields.flowerId.source) !== canonical(land.source) ||
            canonical(land.fields.state.source) !== canonical(land.source)) return null;
        return { version: 'land-adoption-current-binding-separation/' + (settledWrites.length ? 'v2' : 'v1'), originalAdoptionReceiptRef: adopted.row.receipt_ref,
          originalAdoptionFingerprint: adopted.payload.documentFingerprint, originalGroupRevision: group.revision,
          originalRoundFingerprint: fingerprint(group.round ?? null), originalRoundDenominator: group.round?.members.length ?? null,
          previous: { flowerId: group.flowerId, cropRef: member.cropRef, memberKey: member.memberKey, operationId: null },
          current: { context: clone(context), landId: member.landId, flowerId: life.flowerId, cropRef: life.cropRef,
            harvestStageRef: life.harvestStageRef, landSemanticVersion: land.semanticVersion, source: clone(land.source),
            identityObservationRef: identity.frame.observationRef, identityFrameFingerprint: identity.frameFingerprint,
            observationRef: evidence.frame.observationRef, frameFingerprint: evidence.frameFingerprint,
            payloadFingerprint: evidence.payloadFingerprint }, noActiveWriteSlot: true, originalOutcomeUnchanged: true,
          ...(settledWrites.length ? { originalSettledWrites: settledWrites } : {}) };
      }
      for (const group of groups) {
        if (group.currentBinding?.state === 'historical') continue;
        const uncertainRound = group.members.some(member => liveMember(member) && pendingMember(member)) ||
          group.round?.members.some(member => member.state === 'unknown');
        for (const member of group.members) {
          if (!liveMember(member)) continue;
          const land = current.lands[String(member.landId)], life = lifecycles.get({ subjectRef: context.subjectRef, landId: member.landId });
          const operation = member.operationId && ledgerView?.operation?.(member.operationId);
          if (member.state === 'planned' && !operation) { member.state = 'cancelled'; member.reasonCode = 'LAND_PLAN_NOT_PREPARED'; continue; }
          if (operation?.transport_state === 'not_sent') { member.state = 'cancelled'; member.reasonCode = 'LAND_PLAN_PROVED_UNSENT'; continue; }
          if (operation && ['unverified', 'unknown'].includes(operation.business_verdict)) member.state = 'unknown';
          const adoptedSeparation = supersededAdoption(group, member, land, life);
          if (adoptedSeparation) {
            const receiptRef = receipt(context, group.groupRef, 'current-adoption-binding-historical', adoptedSeparation);
            member.currentBinding = { state: 'historical', receiptRef, operationId: null,
              currentStageRef: life.harvestStageRef, reasonCode: 'LAND_ADOPTED_CROP_REPLACED_BY_ACCEPTED_CURRENT_CROP' };
            continue;
          }
          if (uncertainRound && isolationEvidence?.read && land?.current) {
            const roundMember = group.round?.members.find(item => item.landId === member.landId && item.operationId);
            const operationId = member.currentUnknownOperationId || roundMember?.operationId || member.operationId;
            if (operationId) {
              const proof = isolationEvidence.read({ context, operationId });
              let separation = proveLandStageSeparation({ context, land, life, proof });
              if (!separation.allowed) separation = proveCurrentActionNeed({ context, land, life, proof,
                action: member.currentUnknownFeature || operation?.feature_id || roundMember?.featureId || null,
                clock: typeof clock === 'function' ? clock(context.subjectRef) : null });
              if (separation.allowed) {
                // Original verdicts, round members and the frozen denominator
                // remain intact. Only this historical binding stops occupying
                // the current land; a new current adoption has its own receipt.
                const bindingReceiptRef = receipt(context, group.groupRef, 'current-binding-historical', {
                  memberKey: member.memberKey, landId: member.landId, operationId,
                  originalMemberState: member.state, originalRoundRef: group.round?.roundRef ?? null,
                  originalRoundDenominator: group.round?.members.length ?? null, evidence: separation.evidence });
                member.currentBinding = { state: 'historical', receiptRef: bindingReceiptRef, operationId,
                  currentStageRef: life?.harvestStageRef ?? life?.emptyRef ?? null, reasonCode: separation.reasonCode };
                continue;
              }
            }
          }
          if (!pendingMember(member) && land?.current && land.status === 'empty') {
            member.state = 'finished'; member.reasonCode = 'LAND_CURRENT_EMPTY_CONFIRMED';
          } else if (!pendingMember(member) && land?.current && land.status === 'occupied' && life?.cropRef !== member.cropRef) {
            member.state = 'conflict'; member.reasonCode = 'LAND_GROUP_CROP_CHANGED';
          }
          if (member.state === 'confirmed' && field(land, 'state') === 1 && member.needWaterStageRef !== life?.needWaterStageRef) {
            member.needWaterStageRef = life?.needWaterStageRef ?? null;
            member.needWaterObservedAt = store.nowIso();
          }
          if (member.state === 'confirmed' && land?.current && life?.cropRef === member.cropRef) {
            if ([1, 2].includes(field(land, 'state'))) member.seenGrowthForCrop = { cropRef: life.cropRef,
              harvestStageRef: life.harvestStageRef, source: safeSource(land.source) };
            const due = field(land, 'nextTime'), planted = field(land, 'plantTime');
            if (Number.isSafeInteger(due) && due > 0 && (!Number.isSafeInteger(planted) || due >= planted)) {
              member.trustedMaturityDue = { cropRef: life.cropRef, harvestStageRef: life.harvestStageRef, dueMs: due,
                source: safeSource(land.source) };
            }
          }
          if (liveMember(member)) owned.add(member.landId);
        }
        if (group.members.some(member => member.currentBinding?.state === 'historical') && group.currentBinding?.state !== 'historical') {
          const receiptRef = receipt(context, group.groupRef, 'current-group-binding-historical', {
            originalRoundRef: group.round?.roundRef ?? null, originalRoundDenominator: group.round?.members.length ?? null,
            historicalMembers: group.members.filter(member => member.currentBinding?.state === 'historical').map(member => ({
              memberKey: member.memberKey, landId: member.landId, receiptRef: member.currentBinding.receiptRef })),
            remainingCurrentLandIds: group.members.filter(liveMember).map(member => member.landId).sort((a, b) => a - b),
            originalOutcomesUnchanged: true, currentOwnershipDerivedFromNewFacts: true });
          group.currentBinding = { state: 'historical', receiptRef, reasonCode: 'LAND_ORIGINAL_GROUP_CURRENT_BINDING_RETIRED' };
          // The frozen source group/round remains immutable audit context. Its
          // remaining real crops are adopted below into a separate current
          // group so one historical member cannot strand its siblings.
          for (const member of group.members) owned.delete(member.landId);
        }
        if (group.members.every(member => !liveMember(member))) {
          if (group.currentBinding?.state !== 'historical') { group.state = 'closed'; group.round = null; }
        }
        else if (group.state !== 'closed') group.pendingConfigRevision = config.groupSize !== group.capacity ? configReceipt.savedRevision : null;
        save(context, group, 'reconciled');
      }
      // Adopt only real current crops. A missing planting time creates a
      // separate source-bound adoption, never a made-up shared sowing batch.
      const buckets = new Map();
      for (const land of landEntries(current)) {
        if (owned.has(land.landId) || land.current !== true || land.status !== 'occupied') continue;
        const life = lifecycles.get({ subjectRef: context.subjectRef, landId: land.landId });
        if (!life?.cropRef || !Number.isSafeInteger(life.flowerId) || life.flowerId <= 0) continue;
        const key = canonical([life.flowerId, life.plantTime ?? life.cropRef]);
        const bucket = buckets.get(key) || []; bucket.push({ land, life }); buckets.set(key, bucket);
      }
      for (const bucket of buckets.values()) for (let start = 0; start < bucket.length; start += config.groupSize) {
        const chunk = bucket.slice(start, start + config.groupSize);
        const priorBindings = chunk.flatMap(({ land }) => groups.flatMap(group => [
          ...group.members.filter(member => member.landId === land.landId && member.currentBinding?.state === 'historical').map(member =>
            ({ groupRef: group.groupRef, memberKey: member.memberKey, receiptRef: member.currentBinding.receiptRef })),
          ...(group.currentBinding?.state === 'historical' && typeof group.currentBinding.receiptRef === 'string' && group.currentBinding.receiptRef
            ? [{ groupRef: group.groupRef, memberKey: 'group:' + land.landId, receiptRef: group.currentBinding.receiptRef }]
            : group.currentBinding?.state === 'historical' && group.currentBinding.reasonCode === 'LAND_ORIGINAL_GROUP_PRESERVED_CURRENT_BINDING_RETIRED'
              ? [{ groupRef: group.groupRef, memberKey: 'group:' + land.landId, receiptRef: null,
                legacyMarker: { kind: 'group-binding-receipt-missing', reasonCode: group.currentBinding.reasonCode,
                  markerRef: fingerprint([group.groupRef, 'group:' + land.landId, group.currentBinding]) } }]
              : [])]));
        const groupRef = 'adopt:' + fingerprint([chunk.map(item => item.life.cropRef), priorBindings]);
        if (groups.some(group => group.groupRef === groupRef)) continue;
        save(context, { groupRef, flowerId: chunk[0].life.flowerId, capacity: config.groupSize, configRevision: configReceipt.savedRevision,
          pendingConfigRevision: null, state: 'active', layoutBasis: 'stable-land-id-order', adoption: true, priorBindings,
          members: chunk.map(({ land, life }) => ({ memberKey: 'crop:' + life.cropRef, landId: land.landId, cropRef: life.cropRef,
            emptyRef: null, operationId: null, state: 'confirmed', reasonCode: 'LAND_EXISTING_CROP_ADOPTED' })), round: null }, 'adopted');
      }
      return view(context);
    });
  }
  function allocateEmpty({ context, flowerId, capacity, configReceipt, operationId, proposalId, predictedYield = null, excludeLandIds = [] }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) return null;
    const current = projection.view(context), config = configValue(configReceipt), groups = documents(context);
    const occupied = new Set(groups.flatMap(group => group.state === 'closed' || group.currentBinding?.state === 'historical' ? [] :
      group.members.filter(liveMember).map(member => member.landId)));
    const land = landEntries(current).find(item => item.current === true && item.status === 'empty' && !occupied.has(item.landId) && !excludeLandIds.includes(item.landId) &&
      lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: item.landId }, action: 'plant' }).known === true);
    if (!land) return null;
    const stage = lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: land.landId }, action: 'plant' });
    return store.transaction(() => {
      let group = groups.find(item => item.state === 'active' && item.currentBinding?.state !== 'historical' && item.flowerId === flowerId && !item.round &&
        item.capacity === config.groupSize && item.members.filter(liveMember).length < item.capacity && !item.pendingConfigRevision);
      if (!group) group = { groupRef: 'sow:' + fingerprint([context.ownerRef, context.subjectRef, stage.lifecycleRef, flowerId]), flowerId,
        capacity: config.groupSize, configRevision: configReceipt.savedRevision, pendingConfigRevision: null,
        state: 'active', adoption: false, layoutBasis: 'stable-land-id-order', members: [], round: null };
      const member = { memberKey: 'plant:' + fingerprint([land.landId, stage.lifecycleRef, flowerId]), landId: land.landId,
        emptyRef: stage.lifecycleRef, cropRef: null, operationId, proposalId, state: 'planned', reasonCode: null, predictedYield };
      group.members = group.members.filter(old => old.memberKey !== member.memberKey || old.state !== 'cancelled');
      group.members.push(member); save(context, group, 'planned');
      return freeze({ groupRef: group.groupRef, member: clone(member), land: clone(land), stage: clone(stage) });
    });
  }
  function cancelPlan({ context, operationId, reasonCode }) {
    return store.transaction(() => {
      const operation = ledgerView?.operation?.(operationId);
      if (operation && operation.transport_state !== 'not_sent') throw problem('LAND_PLAN_POSSIBLY_SENT', '可能已发送的原组成员不能撤出分母');
      for (const group of documents(context)) {
        const member = group.members.find(item => item.operationId === operationId && item.state === 'planned');
        if (!member) continue;
        member.state = 'cancelled'; member.reasonCode = reasonCode;
        if (group.members.every(item => !liveMember(item))) group.state = 'closed';
        save(context, group, 'unsent-plan-cancelled');
      }
    });
  }
  function freezeHarvestRound({ context, groupRef, clock }) {
    return store.transaction(() => {
      const group = documents(context).find(item => item.groupRef === groupRef);
      if (!group || group.state === 'closed' || group.currentBinding?.state === 'historical') return { known: true, ready: false, reasonCode: 'LAND_GROUP_CLOSED' };
      if (group.round && group.round.members.some(member => member.state === 'pending' &&
          group.members.some(original => original.memberKey === member.memberKey && liveMember(original)))) return freeze({ known: true, ready: true, group });
      if (group.round && group.round.members.some(member => member.state !== 'confirmed')) return freeze({ known: false, ready: false,
        reasonCode: 'LAND_HARVEST_ROUND_UNRESOLVED', group });
      if (group.members.some(member => member.currentBinding?.state === 'historical')) return freeze({ known: false, ready: false,
        reasonCode: 'LAND_ORIGINAL_GROUP_CURRENT_BINDING_SPLIT', group });
      if (group.members.filter(liveMember).some(pendingMember)) return freeze({ known: false, ready: false, reasonCode: 'LAND_GROUP_PENDING_MEMBER', group });
      const members = group.members.filter(liveMember), current = projection.view(context), roundMembers = [];
      let dueMs = null;
      for (const member of members) {
        const land = current.lands[String(member.landId)], life = lifecycles.get({ subjectRef: context.subjectRef, landId: member.landId });
        if (!land?.current || life?.cropRef !== member.cropRef) return freeze({ known: false, ready: false, reasonCode: 'LAND_GROUP_MEMBER_NOT_CURRENT', group });
        if ((member.operationId || member.maturityGuardRequired) && field(land, 'state') === 3 &&
            !Number.isSafeInteger(field(land, 'nextTime'))) {
          const growth = member.seenGrowthForCrop, due = member.trustedMaturityDue;
          const growthProven = growth?.cropRef === life.cropRef && growth.harvestStageRef === life.harvestStageRef &&
            (growth.source.connectionEpoch < land.source.connectionEpoch || growth.source.connectionEpoch === land.source.connectionEpoch &&
              growth.source.requestSequence < land.source.requestSequence);
          const dueProven = due?.cropRef === life.cropRef && due.harvestStageRef === life.harvestStageRef &&
            clock?.available === true && clock.connectionEpoch === land.source.connectionEpoch &&
            Number.isFinite(clock.nowMs) && Number.isFinite(clock.uncertaintyMs) && clock.uncertaintyMs >= 0 &&
            clock.nowMs - clock.uncertaintyMs >= due.dueMs;
          if (!growthProven && !dueProven) return freeze({ known: false, ready: false,
            dueMs: due?.cropRef === life.cropRef && due.harvestStageRef === life.harvestStageRef ? due.dueMs : null,
            reasonCode: 'LAND_NEW_CROP_MATURE_ECHO_IDENTITY_UNPROVEN', group });
        }
        const maturity = lifecycles.ripeness({ land, clock });
        if (!maturity.known) return freeze({ known: false, ready: false, reasonCode: maturity.reasonCode, group });
        if (!maturity.mature) dueMs = Number.isSafeInteger(maturity.dueMs) ? Math.max(dueMs ?? 0, maturity.dueMs) : dueMs;
        const stage = lifecycles.stageFor({ land: { subjectRef: context.subjectRef, landId: member.landId }, action: 'harvest' });
        if (!stage.known && maturity.mature) return freeze({ known: false, ready: false, reasonCode: stage.reasonCode, group });
        roundMembers.push({ memberKey: member.memberKey, landId: member.landId, cropRef: member.cropRef,
          stageRef: stage.lifecycleRef ?? null, state: 'pending' });
      }
      if (!members.length) return freeze({ known: true, ready: false, reasonCode: 'LAND_GROUP_EMPTY', group });
      if (members.some(member => !lifecycles.ripeness({ land: current.lands[String(member.landId)], clock }).mature)) {
        return freeze({ known: dueMs !== null, ready: false, dueMs, reasonCode: 'LAND_GROUP_NOT_ALL_MATURE', group });
      }
      group.round = { roundRef: 'round:' + fingerprint([groupRef, roundMembers.map(member => [member.landId, member.cropRef, member.stageRef])]),
        members: roundMembers, state: 'active' };
      save(context, group, 'harvest-round-frozen');
      return freeze({ known: true, ready: true, group });
    });
  }
  function applyTargetSettlement({ context, proposal, member, settlementRef, postRead, effect = null }) {
    const group = documents(context).find(item => item.groupRef === proposal.land?.groupRef);
    if (!group) throw problem('LAND_SETTLEMENT_GROUP_MISSING', '原土地操作缺少冻结组身份', 500);
    const original = group.members.find(item => item.memberKey === proposal.land.groupMemberKey && item.landId === proposal.params.landId);
    if (!original) throw problem('LAND_SETTLEMENT_MEMBER_MISSING', '原组成员不能由新目标替代', 500);
    receipt(context, group.groupRef, 'target-settled', { operationId: proposal.operationId, settlementRef: settlementRef ?? null,
      featureId: proposal.featureId, verdict: member.verdict, reasonCode: member.reasonCode ?? null, postReadRef: postRead?.responseRef ?? null });
    if (member.verdict === 'unknown') { original.currentUnknownOperationId = proposal.operationId; original.currentUnknownFeature = proposal.featureId; }
    if (proposal.featureId === 'plant') {
      if (original.operationId !== proposal.operationId) return;
      original.state = member.verdict === 'confirmed' ? 'confirmed' : member.verdict === 'rejected' ? 'cancelled' : 'unknown';
      original.reasonCode = member.reasonCode ?? null;
      if (member.verdict === 'confirmed') { original.cropRef = effect?.cropRef ?? null; original.maturityGuardRequired = true;
        if (!original.cropRef) original.state = 'conflict'; }
    } else if (proposal.featureId === 'harvest') {
      if (group.round?.roundRef !== proposal.land.roundRef) return;
      const roundMember = group.round.members.find(item => item.landId === proposal.params.landId && item.stageRef === proposal.targets[0].lifecycleRef);
      if (!roundMember || roundMember.state !== 'pending') return;
      roundMember.state = member.verdict; roundMember.operationId = proposal.operationId;
      if (member.verdict === 'confirmed') original.maturityGuardRequired = true;
      if (member.verdict === 'confirmed' && effect?.empty === true) original.state = 'finished';
      if (group.round.members.every(item => item.state === 'confirmed')) group.round.state = 'completed';
    }
    save(context, group, 'settlement-applied');
  }
  function reconcileHandoffs(input) { return reconcile(input); }
  function announce(context, proposal) { appendOutbox?.({ ownerRef: context.ownerRef, subjectRef: context.subjectRef,
    eventType: 'FactsChanged', eventKey: 'land-group-current:' + proposal.operationId, payload: { domain: 'land-groups', featureId: proposal.featureId, groupRef: proposal.land.groupRef,
      operationId: proposal.operationId, connectionEpoch: context.connectionEpoch } }); }
  return Object.freeze({ reconcile, view, allocateEmpty, cancelPlan, freezeHarvestRound, applyTargetSettlement, reconcileHandoffs, announce, retireReceipts: history.retire });
}

export function proveCurrentActionNeed({ context, land, life, proof, action, clock }) {
  const fail = reasonCode => ({ allowed: false, reasonCode });
  const originalAction = proof?.original?.featureId ?? proof?.original?.feature_id ?? proof?.original?.scope;
  if (proof?.available !== true || proof.original?.ownerRef !== context.ownerRef || proof.original?.subjectRef !== context.subjectRef ||
      proof.currentCheckpoint?.ownerRef !== context.ownerRef || proof.currentCheckpoint?.subjectRef !== context.subjectRef ||
      proof.currentCheckpoint?.connectionEpoch !== context.connectionEpoch || !land?.current || !life || life.landId !== land.landId ||
      life.context?.subjectRef !== context.subjectRef || !['plant', 'water', 'harvest'].includes(action) || originalAction !== action) {
    return fail('LAND_CURRENT_NEED_CLOSURE_OR_TARGET_UNPROVEN');
  }
  const source = land.source, previous = proof.previousExecution;
  const closed = previous?.kind === 'matched-operation-response' ? previous.operationRequestEnded === true && previous.requestTerminated === true :
    previous?.closed === true && previous.executionClosed === true;
  if (!closed) return fail('LAND_CURRENT_NEED_CLOSURE_OR_TARGET_UNPROVEN');
  if (source?.kind !== 'response' || source.connectionEpoch !== context.connectionEpoch || !source.responseRef ||
      !Number.isSafeInteger(source.requestSequence) || (previous.kind === 'matched-operation-response' ?
        source.requestSequence <= previous.requestSequence : context.connectionEpoch <= proof.original.connectionEpoch)) {
    return fail('LAND_CURRENT_NEED_INDEPENDENT_TARGET_READ_REQUIRED');
  }
  const metadata = proof.original.lifecycleTargetMetadata, before = metadata?.targets?.find(target => target.landId === land.landId) ||
    (metadata?.targetBasis?.landId === land.landId ? metadata.targetBasis : null);
  if (!before) return fail('LAND_CURRENT_NEED_ORIGINAL_TARGET_REQUIRED');
  const state = field(land, 'state');
  let necessary = false, reasonCode = null;
  if (action === 'plant') {
    necessary = before.status === 'empty' && land.status === 'empty' && (state === 0 || land.explicitEmptyObject === true);
    reasonCode = 'LAND_CURRENT_EMPTY_STILL_NEEDS_PLANT';
  } else {
    const sameCrop = before.cropRef && life.cropRef === before.cropRef || before.flowerId > 0 && field(land, 'flowerId') === before.flowerId &&
      before.plantTime > 0 && field(land, 'plantTime') === before.plantTime;
    if (action === 'water') {
      necessary = sameCrop && land.status === 'occupied' && state === 1;
      reasonCode = 'LAND_CURRENT_CROP_STILL_NEEDS_WATER';
    } else {
      necessary = sameCrop && land.status === 'occupied' && [2, 3].includes(state) &&
        (state === 3 && ['missing', 'null'].includes(land.fields?.nextTime?.presence) ||
          Number.isSafeInteger(field(land, 'nextTime')) && clock?.available === true && Number.isFinite(clock.nowMs) &&
          Number.isFinite(clock.uncertaintyMs) && clock.uncertaintyMs >= 0 && clock.connectionEpoch === context.connectionEpoch &&
          clock.nowMs - clock.uncertaintyMs >= field(land, 'nextTime'));
      reasonCode = 'LAND_CURRENT_CROP_STILL_NEEDS_HARVEST';
    }
  }
  if (!necessary) return fail('LAND_CURRENT_ACTION_NO_LONGER_NEEDED');
  return { allowed: true, reasonCode, evidence: { version: 'land-current-action-need/v1', action, currentTarget: {
    landId: land.landId, lifecycleRef: action === 'plant' ? life.emptyRef : action === 'water' ? life.needWaterStageRef : life.harvestStageRef,
    cropRef: life.cropRef ?? null, flowerId: field(land, 'flowerId') ?? null, state: state ?? null,
    source: { responseRef: source.responseRef, connectionEpoch: source.connectionEpoch, requestSequence: source.requestSequence } },
    originalOutcomeUnchanged: true, currentNeedOnly: true } };
}
