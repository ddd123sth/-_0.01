/**
 * Read-only ownership contract shared by current-need prepare and consume candidates.
 * It never changes the owner row; consume still performs its source transaction and CAS.
 */
export function currentNeedOwnerEligibility({ store, ledgerView, owner, operationId, decisionGeneration } = {}) {
  if (!owner) return Object.freeze({ prepareAllowed: true, operationOwned: false, previousOperationId: null, transferable: false });
  if (owner.operation_id === operationId && owner.decision_generation === decisionGeneration) {
    return Object.freeze({ prepareAllowed: true, operationOwned: true, previousOperationId: null, transferable: false });
  }
  const previousOperationId = owner.operation_id;
  const previous = previousOperationId ? ledgerView?.operation?.(previousOperationId) : null;
  const permit = previousOperationId ? store?.get?.('SELECT consumed,wire_key,request_sequence FROM backend_send_permits WHERE operation_id=?', previousOperationId) : null;
  const transferable = !!previous && previous.write_slot === 0 && previous.transport_state === 'not_sent' &&
    permit?.consumed === 0 && permit.wire_key === null && permit.request_sequence === null;
  return Object.freeze({ prepareAllowed: transferable, operationOwned: false, previousOperationId, transferable });
}
