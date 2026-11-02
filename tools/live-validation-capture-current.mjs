import fs from 'node:fs';
import path from 'node:path';
import { LiveValidationSession } from './live-validation-session.mjs';

const [evidenceDirArg, accountIdArg, uidArg, buildId] = process.argv.slice(2);
const evidenceDir = evidenceDirArg ? path.resolve(evidenceDirArg) : null;
const accountId = Number(accountIdArg), officialUid = Number(uidArg);
if (!evidenceDir || !Number.isSafeInteger(accountId) || !Number.isSafeInteger(officialUid) || !buildId)
  throw new Error('Usage: node tools/live-validation-capture-current.mjs <empty-evidence-dir> <account-id> <official-uid> <build-id>');

const session = new LiveValidationSession({ evidenceDir, adbPath: 'C:/leidian/LDPlayer14/adb.exe', serial: 'emulator-5554',
  packageName: 'online.ainiannian.wujinxia', accountId, officialUid, buildId });
const save = (name, value) => fs.writeFileSync(path.join(evidenceDir, name), JSON.stringify(value, null, 2) + '\n');
let source = null, error = null, cleanup = null;
try {
  const cohort = [];
  for (const id of [1, 3, 4]) {
    const account = await session.request('GET', `/api/local/accounts/${id}`);
    const config = await session.request('GET', `/api/local/accounts/${id}/config`);
    const uid = account.account?.uid;
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`COHORT_UID_UNVERIFIED:${id}`);
    if (account.account?.state !== 'stopped' || account.account?.running !== false || account.account?.desiredRunning !== false)
      throw new Error(`COHORT_NOT_STOPPED:${id}`);
    session.recordAccountBaseline({ id, uid, config: config.config });
    cohort.push({ id, uid, account, config });
  }
  save('fresh-cohort-baseline.json', { capturedUtc: new Date().toISOString(), accounts: cohort });
  const baseline = await session.readBaseline();
  const config = baseline.config?.config;
  const allOff = config?.flowerRack?.enabled === false && config?.art?.dailyMakeEnabled === false &&
    config?.art?.makeEnabled === false && config?.art?.firstAlbumClaim === false && config?.art?.firstShareClaim === false &&
    ['resident', 'satin', 'decorate', 'customer'].every(key => config?.orders?.[key]?.enabled === false) &&
    config?.plantEnabled === false && config?.waterEnabled === false && config?.harvestEnabled === false &&
    config?.waterwheelEnabled === false && config?.freeWaterEnabled === false && config?.accelerationMode === 'off';
  if (!allOff) throw new Error('CURRENT_SOURCE_CAPTURE_REQUIRES_ALL_OFF_FEATURES');
  await session.startOnce();
  source = await session.waitForConnected({ deadlineMs: 90000, pollMs: 2000, observationTimeoutMs: 15000, requiredDomain: 'land' });
  const f6c = await session.request('GET', `/api/local/accounts/${accountId}/writes/f6c0c43e-760d-4250-9e0a-ef18d0f033f4`);
  const daily = await session.request('GET', `/api/local/accounts/${accountId}/writes/49182a91-cee1-4cb4-a31c-59779d6e7534`);
  save('captured-source-summary.json', { capturedUtc: new Date().toISOString(), accountId, officialUid, buildId,
    ready: { available: source.observation.available, source: source.observation.source, session: source.observation.session,
      land: { available: source.observation.land?.available, current: source.observation.land?.current,
        source: source.observation.land?.source, reasonCode: source.observation.land?.reasonCode,
        rackMap: source.observation.land?.flowerRackMap || source.observation.land?.flowerRack?.map || null,
        bagKnown: source.observation.land?.bag?.complete === true },
      observedBytes: Buffer.byteLength(JSON.stringify(source.observation)) },
    f6c: { verdict: f6c.verdict, transport: f6c.transport, writeSlot: f6c.writeSlot,
      auditProjection: f6c.auditProjection, flowerRackAudit: f6c.flowerRackAudit },
    daily49182: { verdict: daily.verdict, auditProjection: daily.auditProjection, resourceCoverage: daily.resourceCoverage,
      domainAudit: daily.domainAudit } });
} catch (cause) {
  error = { at: new Date().toISOString(), message: cause?.message || String(cause), status: cause?.status || null,
    code: cause?.code || null, details: cause?.details || null };
  save('capture-error.json', error);
} finally {
  try { cleanup = await session.stopAndRestore(); }
  catch (cause) {
    cleanup = { cleanupComplete: false, error: cause?.message || String(cause), status: cause?.status || null };
    save('cleanup-error.json', { at: new Date().toISOString(), ...cleanup });
  }
  await session.close();
  const cleanupOk = cleanup?.stop === null ? cleanup?.stopped === true && cleanup?.restored === true :
    cleanup?.cleanupComplete === true && cleanup?.transportClosed === true && cleanup?.newWritesFenced === true &&
    cleanup?.writeDrainComplete === true && cleanup?.stopped === true && cleanup?.restored === true && cleanup?.finalVerified === true;
  save('capture-final.json', { endedUtc: new Date().toISOString(), success: source !== null && error === null && cleanupOk,
    sourceCaptured: source !== null, error, cleanup, events: session.events, errors: session.errors });
  if (!cleanupOk) error ||= { at: new Date().toISOString(), message: 'CLEANUP_PROOF_INCOMPLETE' };
}
console.log(JSON.stringify({ sourceCaptured: source !== null, readySource: source?.observation?.source || null,
  connectionEpoch: source?.observation?.session?.connectionEpoch || null, error, cleanup }, null, 2));
if (error || !(cleanup?.cleanupComplete === true && cleanup?.transportClosed === true && cleanup?.newWritesFenced === true &&
    cleanup?.writeDrainComplete === true && cleanup?.stopped === true && cleanup?.restored === true && cleanup?.finalVerified === true)) process.exitCode = 1;
