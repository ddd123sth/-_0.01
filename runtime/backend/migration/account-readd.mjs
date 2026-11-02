import { fingerprint, parseStored, problem } from '../common.mjs';
import { CONFIG_FIELDS } from '../config/fields.mjs';

// An explicit debug maintenance workflow around the NORMAL remove/add ports.
// The Keystore key and plaintext credentials never leave this process. The
// bounded recovery row contains the existing encrypted envelopes only; no
// automatic login or account START is performed on startup or after STOP.
export function createAccountReaddRecovery({ store, cipher, accounts, config, authorize }) {
  const { get, run, transaction } = store;
  transaction(() => store.db.exec(`CREATE TABLE IF NOT EXISTS backend_account_readd_recovery(
    owner_ref TEXT NOT NULL,old_account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,official_uid INTEGER NOT NULL,server_id INTEGER NOT NULL,
    username_cipher TEXT NOT NULL,credential_cipher TEXT NOT NULL,remark TEXT NOT NULL,payload_fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,old_account_ref));
    CREATE TRIGGER IF NOT EXISTS backend_account_readd_recovery_immutable BEFORE UPDATE ON backend_account_readd_recovery
      BEGIN SELECT RAISE(ABORT,'account readd recovery is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_account_readd_recovery_delete_guard BEFORE DELETE ON backend_account_readd_recovery
      WHEN NOT EXISTS(SELECT 1 FROM backend_accounts a WHERE a.owner_ref=OLD.owner_ref AND a.subject_ref=OLD.subject_ref
        AND CAST(a.account_id AS TEXT)!=OLD.old_account_ref AND a.removed_at IS NULL AND a.server_id=OLD.server_id
        AND a.username_cipher IS NOT NULL AND a.credential_cipher IS NOT NULL AND length(a.verification_ref)>0
        AND CASE WHEN json_valid(a.profile_json) THEN json_extract(a.profile_json,'$.uid')=OLD.official_uid ELSE 0 END)
      BEGIN SELECT RAISE(ABORT,'verified replacement account required before encrypted recovery exit'); END;`));
  const payload = row => Object.fromEntries(['owner_ref','old_account_ref','subject_ref','official_uid','server_id',
    'username_cipher','credential_cipher','remark'].map(key => [key,row[key]]));
  function check(input) {
    if (process.env.GARDEN_DEBUG_TOOLS !== '1') throw problem('DEBUG_TOOLS_DISABLED', '接口不存在', 404);
    authorize({ ownerRef: input.ownerRef });
    if (!/^[1-9]\d*$/.test(String(input.accountRef)) || !Number.isSafeInteger(input.expectedUid) || input.expectedUid <= 0
        || !Number.isSafeInteger(input.expectedServerId) || input.expectedServerId <= 0)
      throw problem('ACCOUNT_READD_IDENTITY_REQUIRED','重新添加验证需要原账号的真实主体',400);
    const old = accounts.row(input.ownerRef,String(input.accountRef),{includeRemoved:true}), profile = parseStored(old.profile_json,'重新添加原主体');
    if (profile.uid !== input.expectedUid || old.server_id !== input.expectedServerId)
      throw problem('ACCOUNT_READD_IDENTITY_CHANGED','原账号主体已变化，未执行删除或重新添加',409);
    return { old,profile };
  }
  function replacement(old, uid) {
    const row = get(`SELECT * FROM backend_accounts WHERE owner_ref=? AND subject_ref=? AND account_id!=? AND removed_at IS NULL`,old.owner_ref,old.subject_ref,old.account_id);
    if (!row) return null;
    const profile = parseStored(row.profile_json,'重新添加正常验证主体');
    if (profile.uid !== uid || row.server_id !== old.server_id || !row.username_cipher || !row.credential_cipher || !row.verification_ref)
      throw problem('ACCOUNT_READD_REPLACEMENT_IDENTITY_UNPROVEN','新条目身份尚未完成正常核对，原恢复记录保留',409);
    return row;
  }
  function complete(old, row) {
    transaction(()=>run('DELETE FROM backend_account_readd_recovery WHERE owner_ref=? AND old_account_ref=?',old.owner_ref,String(old.account_id)));
    return { phase:'complete',oldAccountRef:String(old.account_id),newAccountRef:String(row.account_id),subjectRef:row.subject_ref,
      officialUid:parseStored(row.profile_json,'重新添加主体').uid,serverId:row.server_id,normalVerificationRef:row.verification_ref,
      started:false,encryptedRecoveryCleared:true };
  }
  function prepare(input) {
    const {old,profile}=check(input), existing=replacement(old,profile.uid);
    if (existing) return complete(old,existing);
    return transaction(()=>{
      const prior=get('SELECT * FROM backend_account_readd_recovery WHERE owner_ref=? AND old_account_ref=?',old.owner_ref,String(old.account_id));
      if (!prior) {
        if (old.removed_at || !old.username_cipher?.startsWith('enc:v1:') || !old.credential_cipher?.startsWith('enc:v1:'))
          throw problem('ACCOUNT_READD_ENCRYPTED_ORIGINAL_REQUIRED','没有可保全的本机加密凭据，未执行删除',409);
        const settings=config.read({ownerRef:old.owner_ref,accountRef:String(old.account_id)}).config;
        if (CONFIG_FIELDS.filter(f=>f.type==='boolean').some(f=>f.dtoPath.split('.').reduce((o,k)=>o?.[k],settings)!==false))
          throw problem('ACCOUNT_READD_ALL_FEATURES_DISABLED_REQUIRED','重新添加验证前必须关闭本号全部业务意愿',409);
        const row={owner_ref:old.owner_ref,old_account_ref:String(old.account_id),subject_ref:old.subject_ref,official_uid:profile.uid,
          server_id:old.server_id,username_cipher:old.username_cipher,credential_cipher:old.credential_cipher,remark:profile.remark||''};
        run('INSERT INTO backend_account_readd_recovery VALUES(?,?,?,?,?,?,?,?,?,?)',...Object.values(payload(row)),fingerprint(payload(row)),store.nowIso());
        accounts.remove({ownerRef:old.owner_ref,accountRef:String(old.account_id)});
      } else if (fingerprint(payload(prior))!==prior.payload_fingerprint)
        throw problem('ACCOUNT_READD_RECOVERY_INTEGRITY','加密恢复记录不完整，原件保留',409);
      return {phase:'removed-recovery-ready',oldAccountRef:String(old.account_id),subjectRef:old.subject_ref,officialUid:profile.uid,
        serverId:old.server_id,encryptedRecoveryDurable:true,normalAddRequired:true,started:false};
    });
  }
  async function resume(input) {
    const {old,profile}=check(input), existing=replacement(old,profile.uid);
    if (existing) return complete(old,existing);
    const row=get('SELECT * FROM backend_account_readd_recovery WHERE owner_ref=? AND old_account_ref=?',old.owner_ref,String(old.account_id));
    if (!old.removed_at || !row || row.subject_ref!==old.subject_ref || row.official_uid!==profile.uid || row.server_id!==old.server_id
        || fingerprint(payload(row))!==row.payload_fingerprint)
      throw problem('ACCOUNT_READD_RECOVERY_REQUIRED','重新添加需要原停止账号的完整加密恢复记录',409);
    let username='',password='';
    try {
      username=cipher.decrypt(row.username_cipher);password=cipher.decrypt(row.credential_cipher);
      const added=await accounts.add({ownerRef:old.owner_ref,username,password,serverId:row.server_id,remark:row.remark});
      if (added.subjectRef!==old.subject_ref) throw problem('ACCOUNT_READD_ALIAS_BINDING_REQUIRED','新登录标识需核实与原主体承接，尚未启动业务',409);
      const verified=replacement(old,profile.uid);
      if (!verified) throw problem('ACCOUNT_READD_NORMAL_VERIFICATION_REQUIRED','正常验证未完成，原恢复记录保留',409);
      return complete(old,verified);
    } finally {username='';password='';}
  }
  return Object.freeze({prepare,resume});
}
