import crypto from 'node:crypto';
import { createMigrationReceiver } from './receiver.mjs';
import { canonical, parseStored, problem } from '../common.mjs';

// Production migration composition extracted from bootstrap so integration
// fixtures exercise the same source-fence and import-indexing path.
export function createMigrationComposition({ store, cipher, targetInfo, accounts, software,
  authorizeOwnerMapping, assertOwnerCurrent, legacy, legacyLogging, legacyHistory, log }) {
  if (!store || !cipher || !targetInfo || !accounts || !software || typeof authorizeOwnerMapping !== 'function' ||
      typeof assertOwnerCurrent !== 'function' || !legacy || !legacyLogging || !legacyHistory || typeof log !== 'function') {
    throw new TypeError('Migration composition requires production bootstrap dependencies');
  }
  return createMigrationReceiver({ store, cipher, targetInfo, authorizeOwnerMapping, assertOwnerCurrent,
    verifyAndAdd: async input => {
      if (input.existingVerified) {
        const prior = input.existingVerified, row = accounts.row(input.ownerRef, prior.accountRef);
        const source = parseStored(row.source_json, '原迁移来源');
        const original = store.get("SELECT source_owner_ref,target_account_ref,target_subject_ref FROM backend_migration_imports WHERE session_id=? AND transfer_id=? AND state='imported'",
          prior.originalSessionId, prior.originalTransferId);
        const subjectRef = crypto.createHash('sha256').update('official\0' + input.username.trim().normalize('NFKC').toLowerCase()).digest('hex');
        if (!original || row.owner_ref !== prior.ownerRef || prior.ownerRef !== input.ownerRef || row.subject_ref !== prior.subjectRef ||
            subjectRef !== row.subject_ref || row.server_id !== prior.serverId || input.serverId !== row.server_id ||
            row.verification_ref !== prior.verificationRef || row.migration_key !== prior.originalTransferId ||
            source.migrationKey !== prior.originalTransferId || source.sourceOwnerRef !== prior.sourceOwnerRef ||
            original.source_owner_ref !== prior.sourceOwnerRef || String(original.target_account_ref) !== String(row.account_id) ||
            original.target_subject_ref !== row.subject_ref || !row.credential_cipher) {
          throw problem('MIGRATION_SUPPLEMENT_IDENTITY_CHANGED', '补充原证据的主体、归属或原核对收据不一致');
        }
        software.authorize({ ownerRef: input.ownerRef });
        return { ownerRef: input.ownerRef, accountRef: String(row.account_id), subjectRef: row.subject_ref,
          credentialStored: true, verificationRef: row.verification_ref };
      }
      const proofs = input.stopProofs;
      if (!Array.isArray(proofs) || proofs.length !== 2 || proofs.some(proof =>
        proof.sourceFenceCommitted !== true || proof.currentInFlight !== false || proof.stopped !== true)) {
        throw problem('MIGRATION_SOURCE_FENCE_REQUIRED', '来源尚无完整持久迁移栅栏证明');
      }
      store.transaction(() => {
        for (const alias of input.aliases) store.run('INSERT OR IGNORE INTO backend_executor_isolation VALUES(?,?,?,?,?)', alias.subjectRef,
          'signed-migration:' + input.migrationKey + ':' + alias.subjectRef, 'source:' + input.sourceInfo.instanceRef,
          canonical(proofs[1]), store.nowIso());
      });
      const result = await accounts.add({ ...input, remark: input.sourceAccount.remark || '', legacyDocument: input.sourceAccount.script_config,
        source: { kind: 'signed-device-handoff', migrationKey: input.migrationKey, sourceOwnerRef: input.ownershipEvidence.sourceOwnerRef,
          sourceInstanceRef: input.sourceInfo.instanceRef, mappingRef: input.ownershipEvidence.mappingRef },
        aliases: input.aliases.map(alias => ({ aliasRef: alias.subjectRef, basis: alias.basis, identityVersion: alias.identityVersion,
          evidence: { sourceRef: alias.sourceRef, migrationKey: input.migrationKey } })) });
      return { ownerRef: input.ownerRef, accountRef: result.accountRef, subjectRef: result.subjectRef, credentialStored: true,
        verificationRef: result.evidenceRef };
    },
    onImported: input => {
      legacyLogging.onImported(input);
      legacyHistory.onImported(input);
      if (input.kind === 'device-log-metadata') {
        log(input.ownerRef, input.accountRef, '已保全源安装日志队列与上传策略快照；旧云回执仍属原证据，未自动重传。', 'info',
          { transferId: input.transferId, kind: input.kind });
        return;
      }
      const indexed = legacy.indexImport(input);
      log(input.ownerRef, input.accountRef, input.existingVerified ? '已补充原主体历史证据，沿用原官服身份核对收据；本次未重新登录游戏。' :
        '原账号资料与历史证据已保全，已通过正常官服身份核对；本次没有自动启动业务。', 'info',
        { transferId: input.transferId, verificationRef: input.verificationRef, legacy: indexed });
    } });
}
