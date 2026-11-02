// Account-scoped execution boundary: every stop/recovery records the exact
// phase it proved, so "requested", "closed", "drained" and "ready again" are
// never collapsed into one boolean. Records are append-only; the head row is
// only a pointer for status display.
import { fingerprint, problem } from '../common.mjs';

const ORDER = Object.freeze(['fenced', 'closing', 'execution-ended-proven', 'state-rebased', 'ready', 'stopped']);

export function createExecutionStateLedger({ store, now = () => Date.now() }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS backend_account_execution_states(
    owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,reason_code TEXT,evidence_ref TEXT,receipt_ref TEXT NOT NULL,recorded_at TEXT NOT NULL,
    PRIMARY KEY(owner_ref,account_ref));
    CREATE TABLE IF NOT EXISTS backend_account_execution_transitions(
    transition_ref TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,account_ref TEXT NOT NULL,subject_ref TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,run_epoch INTEGER NOT NULL,connection_epoch INTEGER NOT NULL,
    from_state TEXT,to_state TEXT NOT NULL,reason_code TEXT,evidence_ref TEXT,recorded_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS backend_account_execution_transitions_no_update BEFORE UPDATE ON backend_account_execution_transitions
      BEGIN SELECT RAISE(ABORT,'execution transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS backend_account_execution_transitions_no_delete BEFORE DELETE ON backend_account_execution_transitions
      BEGIN SELECT RAISE(ABORT,'execution transitions are retained'); END;`);
  const rank = state => ORDER.indexOf(state);
  function current({ ownerRef, accountRef }) {
    return store.get('SELECT * FROM backend_account_execution_states WHERE owner_ref=? AND account_ref=?', ownerRef, String(accountRef)) || null;
  }
  function transition({ context, to, reasonCode = null, evidenceRef = null }) {
    if (!ORDER.includes(to)) throw problem('EXECUTION_STATE_UNKNOWN', '未知的账号执行阶段');
    const ownerRef = context?.ownerRef, accountRef = String(context?.accountRef ?? '');
    const subjectRef = context?.subjectRef;
    if (typeof ownerRef !== 'string' || !ownerRef || !/^[1-9]\d*$/.test(accountRef) || typeof subjectRef !== 'string' || !subjectRef ||
        !Number.isSafeInteger(context.ownerEpoch) || !Number.isSafeInteger(context.runEpoch) || !Number.isSafeInteger(context.connectionEpoch))
      throw problem('EXECUTION_STATE_CONTEXT_INVALID', '账号执行阶段缺少精确代际');
    return store.transaction(() => {
      const head = current({ ownerRef, accountRef });
      const sameEpoch = head && head.subject_ref === subjectRef && head.owner_epoch === context.ownerEpoch &&
        head.run_epoch === context.runEpoch && head.connection_epoch === context.connectionEpoch;
      const fromState = sameEpoch ? head.state : null;
      if (sameEpoch && fromState === to) return { ...head, duplicate: true };
      // A new run/connection epoch restarts at 'fenced' or later, never backwards
      // within the same epoch. A stop is terminal until the next epoch begins.
      if (sameEpoch && (fromState === 'stopped' || rank(to) <= rank(fromState)))
        throw problem('EXECUTION_STATE_NOT_MONOTONIC', '账号执行阶段不能倒退或越过停止');
      const receipt = fingerprint([ownerRef, accountRef, subjectRef, context.ownerEpoch, context.runEpoch,
        context.connectionEpoch, fromState, to, reasonCode, evidenceRef]);
      const transitionRef = 'execution-transition:' + receipt;
      store.run(`INSERT OR IGNORE INTO backend_account_execution_transitions
        (transition_ref,owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,from_state,to_state,reason_code,evidence_ref,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, transitionRef, ownerRef, accountRef, subjectRef, context.ownerEpoch, context.runEpoch,
      context.connectionEpoch, fromState, to, reasonCode, evidenceRef, store.nowIso());
      store.run(`INSERT INTO backend_account_execution_states
        (owner_ref,account_ref,subject_ref,owner_epoch,run_epoch,connection_epoch,state,reason_code,evidence_ref,receipt_ref,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_ref,account_ref) DO UPDATE SET
        subject_ref=excluded.subject_ref,owner_epoch=excluded.owner_epoch,run_epoch=excluded.run_epoch,connection_epoch=excluded.connection_epoch,
        state=excluded.state,reason_code=excluded.reason_code,evidence_ref=excluded.evidence_ref,receipt_ref=excluded.receipt_ref,recorded_at=excluded.recorded_at`,
      ownerRef, accountRef, subjectRef, context.ownerEpoch, context.runEpoch, context.connectionEpoch, to, reasonCode,
      evidenceRef, transitionRef, store.nowIso());
      return { state: to, previousState: fromState, receiptRef: transitionRef, recordedAtMs: now() };
    });
  }
  return Object.freeze({ current, transition, states: ORDER });
}