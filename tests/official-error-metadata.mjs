// Pure code-table and text-metadata checks. No account, response, game world,
// database or network request is created here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../vendor/garden-engine/server/src/game/login-error-codes.js', import.meta.url), 'utf8');
const login = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('the imported official login table retains all 57 codes and non-retryable IP policies', () => {
  assert.equal(Object.keys(login.LOGIN_ERROR_CODES).length, 57);
  assert.deepEqual(Object.entries(login.LOGIN_ERROR_CODES).filter(([, entry]) => entry.kind === 'risk_ip').map(([code]) => Number(code)),
    [103, 104, 2016, 2027, 902049, 902050, 902051]);
  for (const [code, entry] of Object.entries(login.LOGIN_ERROR_CODES)) {
    if (!['risk_ip', 'blocked'].includes(entry.kind)) continue;
    const policy = login.describeLoginError(Number(code));
    assert.equal(policy.retryable, false);
    assert.equal(policy.stopAccount, true);
  }
});

test('error text keeps the explanation while masking credential values in place', () => {
  const text = '文本净化检查：密码=短口令；token="private-value"；保留这句说明。';
  const fields = login.officialErrorNoteFields(text);
  assert.equal(fields.officialErrorNote, '文本净化检查：密码=[已隐藏]；token=[已隐藏]；保留这句说明。');
  assert.equal(fields.officialErrorRedacted, true);
  assert.equal(fields.officialErrorTruncated, false);
  assert.equal(login.sanitizeOfficialErrorNote(fields.officialErrorNote), fields.officialErrorNote);
  assert.equal(login.sanitizeOfficialErrorNote('Authorization: Bearer private-value；仍保留说明'), 'Authorization: [已隐藏] [已隐藏]；仍保留说明');
});

test('long error notes have a separate 1600 character budget from short remote annotations', () => {
  const text = '这是文本净化检查。'.repeat(250);
  const fields = login.officialErrorNoteFields(text);
  assert.equal(fields.officialErrorNote.length, 1600);
  assert.equal(fields.officialErrorTruncated, true);
  assert.equal(fields.officialErrorRedacted, false);
  assert.equal(login.sanitizeRemoteNote(text).length, 40);
  assert.equal(login.sanitizeRemoteNote('token=private-value；保留说明'), '〈已掩码〉');
});

test('the existing diagnostic transport preserves official error text and redaction flags idempotently', () => {
  const fields = login.officialErrorNoteFields('净化检查：uuid=private-value；可读说明');
  const first = login.loginDiagnosticFields(fields);
  assert.deepEqual(first, fields);
  assert.deepEqual(login.loginDiagnosticFields(first), first);
  assert.equal(login.officialErrorNoteFields('  '), undefined);
});
