import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySessionFailure } from '../runtime/backend/session/failure-policy.mjs';

test('source-bound SDK credential failures request credentials, while unknown and V5 codes stay recoverable', () => {
  const credential = classifySessionFailure({ code: 'REAL_ACCOUNT_CREDENTIAL_REJECTED', phase: '渠道会话兑换',
    sourceNamespace: 'sdk-login', loginKind: 'credential', loginCode: 2011 });
  assert.equal(credential.action, 'needs-credentials');
  assert.equal(credential.retryable, false);
  const unknownSdk = classifySessionFailure({ code: 'REAL_SDK_LOGIN_FAILED', sourceNamespace: 'sdk-login', loginCode: 14999 });
  const unrelatedV5Number = classifySessionFailure({ code: 'REAL_ACCOUNT_LOGIN_FAILED', sourceNamespace: 'v5-account', remoteCode: 2011 });
  assert.equal(unknownSdk.retryable, true);
  assert.equal(unrelatedV5Number.retryable, true);
  assert.equal(unrelatedV5Number.action, 'retry');
});

test('SDK top-session and throttle codes preserve timed automatic recovery', () => {
  const topSession = classifySessionFailure({ code: 'REAL_SDK_LOGIN_FAILED', sourceNamespace: 'sdk-login', loginCode: 2001 });
  const throttle = classifySessionFailure({ code: 'REAL_SDK_LOGIN_FAILED', sourceNamespace: 'sdk-login', loginCode: 902051 });
  assert.equal(topSession.action, 'single-session');
  assert.equal(topSession.retryable, true);
  assert.equal(topSession.retryAfterMs, 15000);
  assert.equal(throttle.action, 'wait-time');
  assert.equal(throttle.retryAfterMs, 180000);
});

test('explicit account and owner conflicts remain protected', () => {
  const disabled = classifySessionFailure({ sourceNamespace: 'sdk-login', loginCode: 902053 });
  const owner = classifySessionFailure({ code: 'SUBJECT_BINDING_CONFLICT' });
  assert.equal(disabled.action, 'account-disabled');
  assert.equal(disabled.retryable, false);
  assert.equal(owner.action, 'ownership-conflict');
  assert.equal(owner.retryable, false);
});
