import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical } from '../runtime/backend/common.mjs';
import { answerGateDiagnostics } from '../runtime/backend/features/order-flower/verification.mjs';

test('failed matched-answer diagnostics are safe for durable canonical evidence', () => {
  const proposal = { operationId: 'operation:test', method: 'orderFlower.finishOrder', connectionEpoch: 9 };
  const anchor = { gameVersion: '480.0.27', protocolVersion: '480.0.0', loginResponseRef: 'login:test' };
  const diagnostics = answerGateDiagnostics(proposal, { source: 'response', transport: 'answered', method: proposal.method,
    connectionEpoch: 9, requestSequence: 2, wireKey: 'ws|9|2', responseRef: 'response:test', envelopeOk: false,
    dsName: 'G.ISyncData', rejected: false, messagePresent: false }, {}, anchor);
  assert.equal(diagnostics.outcomeState, 'failed');
  assert.equal(diagnostics.reasonCode, 'ORDER_FLOWER_GATE_ENVELOPEOK');
  assert.equal(diagnostics.versionEvidence.gameVersionPresent, false);
  assert.equal(diagnostics.versionEvidence.gameVersionEqual, false);
  assert.equal(diagnostics.gates.find(gate => gate.name === 'version.gameVersion').passed, false);
  assert.doesNotThrow(() => canonical(diagnostics));
  assert.equal(JSON.stringify(diagnostics).includes('token'), false);
});
