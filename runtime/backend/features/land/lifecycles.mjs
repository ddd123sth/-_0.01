import { canonical, clone, fingerprint, freeze, newId, parseStored } from '../../common.mjs';
import { knownCell } from './wire-facts.mjs';
import { LAND_HISTORY_DELETE_GUARD } from './history-retirement.mjs';

const val = cell => knownCell(cell) ? cell.value : null;
const relevant = one => ({ emptyRef: one.emptyRef, cropRef: one.cropRef, needWaterStageRef: one.needWaterStageRef,
  harvestStageRef: one.harvestStageRef, flowerId: one.flowerId, plantTime: one.plantTime, harvestCnt: one.harvestCnt,
  state: one.state, status: one.status, confidence: one.confidence, issues: one.issues });

export function createLandLifecycles({ store, projection } = {}) {
  if (!store || !projection) throw new TypeError('Land lifecycles require store and projection');
  const { run, get: getRow, transaction, nowIso } = store;
  run(`CREATE TABLE IF NOT EXISTS backend_land_lifecycle_heads(subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,
    owner_ref TEXT NOT NULL,model_json TEXT NOT NULL,PRIMARY KEY(subject_ref,land_id))`);
  run(`CREATE TABLE IF NOT EXISTS backend_land_lifecycle_events(event_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,
    subject_ref TEXT NOT NULL,land_id INTEGER NOT NULL,observation_ref TEXT NOT NULL,transition TEXT NOT NULL,
    before_json TEXT,after_json TEXT NOT NULL,recorded_at TEXT NOT NULL)`);
  run('CREATE INDEX IF NOT EXISTS backend_land_lifecycle_scope ON backend_land_lifecycle_events(subject_ref,land_id,recorded_at)');
  run(`CREATE TRIGGER IF NOT EXISTS backend_land_lifecycle_events_no_update BEFORE UPDATE ON backend_land_lifecycle_events
    BEGIN SELECT RAISE(ABORT,'land lifecycle evidence is append only'); END`);
  run(LAND_HISTORY_DELETE_GUARD);
  function get({ subjectRef, landId, ownerRef = null } = {}) {
    const row = getRow('SELECT owner_ref,model_json FROM backend_land_lifecycle_heads WHERE subject_ref=? AND land_id=?', subjectRef, landId);
    return row && (ownerRef === null || ownerRef === row.owner_ref) ? freeze(parseStored(row.model_json, 'land lifecycle')) : null;
  }
  function reconcile({ context, changedLandIds = null } = {}) {
    const view = projection.view(context);
    if (!view.current) return { accepted: false, reasonCode: 'LAND_CONTEXT_NOT_CURRENT', lifecycles: [] };
    const ids = changedLandIds === null ? Object.keys(view.lands).map(Number) : [...new Set(changedLandIds)];
    return transaction(() => {
      const results = [];
      for (const landId of ids) {
        const land = view.lands[landId];
        if (!land?.current) continue;
        const old = get({ subjectRef: context.subjectRef, landId, ownerRef: context.ownerRef });
        const collision = getRow('SELECT owner_ref FROM backend_land_lifecycle_heads WHERE subject_ref=? AND land_id=?', context.subjectRef, landId);
        if (collision && collision.owner_ref !== context.ownerRef) throw new Error('Land lifecycle owner conflict');
        const one = old ? clone(old) : { subjectRef: context.subjectRef, landId, emptyRef: null, cropRef: null,
          needWaterStageRef: null, harvestStageRef: null, flowerId: null, plantTime: null, harvestCnt: null, semanticVersion: 0 };
        one.context = clone(context);
        const flowerId = val(land.fields.flowerId), plantTime = val(land.fields.plantTime), harvestCnt = val(land.fields.harvestCnt), state = val(land.fields.state);
        let transition = 'observation';
        one.status = land.status; one.state = state; one.issues = [];
        if (land.status === 'empty') {
          if (!old || old.status !== 'empty' || !old.emptyRef) { one.emptyRef = 'land-empty:' + newId(); transition = 'trusted-empty'; }
          one.cropRef = null; one.needWaterStageRef = null; one.harvestStageRef = null;
          one.flowerId = null; one.plantTime = null; one.harvestCnt = null; one.confidence = 'proven-empty';
        } else if (land.status === 'occupied') {
          const changedFlower = old?.cropRef && old.flowerId !== null && old.flowerId !== flowerId;
          const changedPlantTime = old?.cropRef && old.plantTime !== null && plantTime !== null && old.plantTime !== plantTime;
          const decreasedCount = old?.cropRef && old.harvestCnt !== null && harvestCnt !== null && harvestCnt < old.harvestCnt;
          const fresh = !old?.cropRef || old.status === 'empty' || changedFlower || changedPlantTime || decreasedCount;
          if (fresh) {
            one.cropRef = 'land-crop:' + newId(); one.emptyRef = null;
            one.harvestStageRef = 'land-harvest-stage:' + newId(); one.needWaterStageRef = null;
            transition = 'observed-crop';
          } else if (harvestCnt !== null && old.harvestCnt !== null && harvestCnt > old.harvestCnt) {
            one.harvestStageRef = 'land-harvest-stage:' + newId(); one.needWaterStageRef = null;
            transition = 'observed-harvest-count-advance';
          }
          if (state === 1 && (!one.needWaterStageRef || old?.state !== 1 || fresh)) one.needWaterStageRef = 'land-water-stage:' + newId();
          if (state !== 1) one.needWaterStageRef = null;
          one.flowerId = flowerId;
          // A later supplied identity field enriches the same observed crop;
          // omission in a replacement row never fabricates a new plant time.
          one.plantTime = plantTime ?? (fresh ? null : old?.plantTime ?? null);
          one.harvestCnt = harvestCnt;
          one.confidence = plantTime !== null ? 'identified-crop' : 'observed-crop';
          if (plantTime === null) one.issues.push({ reasonCode: 'LAND_CROP_PLANT_TIME_NOT_SUPPLIED' });
          if (harvestCnt === null) one.issues.push({ reasonCode: 'LAND_CROP_HARVEST_COUNT_NOT_SUPPLIED' });
        } else {
          one.confidence = 'unknown';
          one.issues.push({ reasonCode: land.status === 'removed' ? 'LAND_NOT_CURRENTLY_PRESENT' : 'LAND_LIFECYCLE_UNREADABLE' });
        }
        const changed = !old || fingerprint(relevant(old)) !== fingerprint(relevant(one));
        one.semanticVersion = (old?.semanticVersion || 0) + Number(changed);
        one.lastObservationRef = land.source.observationRef; one.landSemanticVersion = land.semanticVersion;
        one.connectionEpoch = context.connectionEpoch;
        if (changed) run('INSERT INTO backend_land_lifecycle_events VALUES(?,?,?,?,?,?,?,?,?)', 'land-lifecycle:' + newId(), context.ownerRef,
          context.subjectRef, landId, land.source.observationRef, transition, old ? canonical(old) : null, canonical(one), nowIso());
        run(`INSERT INTO backend_land_lifecycle_heads VALUES(?,?,?,?) ON CONFLICT(subject_ref,land_id)
          DO UPDATE SET model_json=excluded.model_json`, context.subjectRef, landId, context.ownerRef, canonical(one));
        results.push(one);
      }
      return freeze({ accepted: true, lifecycles: results });
    });
  }
  function stageFor({ land, action } = {}) {
    const life = land?.subjectRef && Number.isSafeInteger(land.landId) ? get({ subjectRef: land.subjectRef, landId: land.landId }) : null;
    if (life && !land.fields && life.context) land = projection.view(life.context).lands[life.landId];
    const denied = reasonCode => ({ known: false, lifecycleRef: null, kind: action, reasonCode });
    if (!land?.current || !life || life.landSemanticVersion !== land.semanticVersion || life.confidence === 'unknown') return denied('LAND_LIFECYCLE_NOT_CURRENT');
    const ref = action === 'plant' && land.status === 'empty' ? life.emptyRef : action === 'water' && val(land.fields.state) === 1 ? life.needWaterStageRef :
      action === 'acceleration' && land.status === 'occupied' && val(land.fields.state) === 2 && life.cropRef && life.harvestStageRef
        ? 'land-acceleration-opportunity:' + fingerprint([life.harvestStageRef, life.harvestCnt]) :
      action === 'harvest' && land.status === 'occupied' ? life.harvestStageRef : null;
    return freeze(ref ? { known: true, lifecycleRef: ref, kind: action, reasonCode: null, cropRef: life.cropRef, emptyRef: life.emptyRef,
      needWaterStageRef: life.needWaterStageRef, harvestStageRef: life.harvestStageRef } : denied('LAND_ACTION_STAGE_UNAVAILABLE'));
  }
  function ripeness({ land, clock } = {}) {
    if (land?.subjectRef && !land.fields) {
      const life = get({ subjectRef: land.subjectRef, landId: land.landId });
      if (life?.context) land = projection.view(life.context).lands[life.landId];
    }
    const out = { known: false, mature: false, dueMs: null, reasonCode: null, clockRevision: clock?.revision ?? null, lowerNowMs: null };
    if (!land?.current || land.status !== 'occupied') return freeze({ ...out, reasonCode: 'LAND_NOT_CURRENT_OCCUPIED' });
    const state = val(land.fields.state), time = land.fields.nextTime, due = val(time);
    if (state === 1) return freeze({ ...out, known: true, reasonCode: 'LAND_NEEDS_WATER' });
    if (![2, 3].includes(state)) return freeze({ ...out, reasonCode: 'LAND_MATURITY_STATE_UNKNOWN' });
    if (due === null) {
      if (state === 3 && ['missing', 'null'].includes(time?.presence)) return freeze({ ...out, known: true, mature: true, reasonCode: 'LAND_EXPLICIT_MATURE_WITHOUT_TIME' });
      return freeze({ ...out, reasonCode: 'LAND_MATURITY_TIME_UNREADABLE' });
    }
    if (clock?.available !== true || !Number.isFinite(clock.nowMs) || !Number.isFinite(clock.uncertaintyMs) || clock.uncertaintyMs < 0
      || clock.connectionEpoch !== land.source.connectionEpoch) return freeze({ ...out, dueMs: due, reasonCode: 'LAND_OFFICIAL_CLOCK_UNAVAILABLE' });
    const lower = clock.nowMs - clock.uncertaintyMs;
    return freeze({ ...out, known: true, mature: lower >= due, dueMs: due, lowerNowMs: lower,
      reasonCode: lower >= due ? 'LAND_MATURE_AT_TRUSTED_CLOCK' : 'LAND_MATURITY_NOT_DUE' });
  }
  return Object.freeze({ get, reconcile, stageFor, ripeness });
}
