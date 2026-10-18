import test from 'node:test';
import assert from 'node:assert/strict';
import { DotMail, mailProviders } from '../src/mail.mjs';
import { Transport } from '../src/transport.mjs';
const SID = '12345678-1234-1234-1234-123456789abc';
const AUTH = { accountId: 'account-1', accessToken: 'private' };
function fake(responses = []) {
  const calls = [];
  const transport = { authLoader: async () => AUTH, request: async (...args) => { calls.push(args); const value = responses.shift(); if (value instanceof Error) throw value; return value; } };
  return { calls, transport, mail: new DotMail({ transport }, { now: () => Date.parse('2026-10-18T12:00:00Z') }) };
}
const connector = provider => ({ id: mailProviders[provider].connectorId, actions: [{ name: 'send_email', is_enabled: true }] });
const link = provider => ({ id: 'link-1', connector_id: mailProviders[provider].connectorId, auth_status: 'ACTIVE', scopes: [mailProviders[provider].scope], owner_profile: { email: 'owner@example.com' } });
const SEND = { provider: 'gmail', linkId: 'link-1', to: ['user@example.com'], subject: 'Subject', body: 'Body', sendId: SID };

test('mail send verifies provider action and exact account link before one write', async () => {
  const { mail, calls } = fake([connector('gmail'), { links: [link('gmail')] }, { send_id: SID, unsend_expires_at: '2026-10-18T12:00:10Z' }]);
  const result = await mail.send(SEND);
  assert.equal(result.status, 'accepted'); assert.equal(result.sendId, SID);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['POST', '/backend-api/aip/connectors/email/send_email', { body: { send_id: SID, link_id: 'link-1', to: ['user@example.com'], cc: [], bcc: [], subject: 'Subject', body: 'Body' }, signal: undefined, idempotencyKey: SID, headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'writing_blocks' }, expectedAccountId: 'account-1' }]);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('Outlook reply uses verified native reply and source fields', async () => {
  const { mail, calls } = fake([connector('outlook'), { links: [link('outlook')] }, { send_id: SID }]);
  await mail.send({ ...SEND, provider: 'outlook', replyTo: { type: 'reply', provider: 'outlook', referenceMessageId: 'email-1' }, sourceId: 'source-1', sourceType: 'writing_block' });
  assert.equal(calls[2][2].body.email_action, 'reply'); assert.equal(calls[2][2].body.reference_message_id, 'email-1'); assert.equal(calls[2][2].body.source_id, 'source-1');
});

test('recipient and provider validation happens before authentication or HTTP', async () => {
  for (const change of [{ to: [] }, { provider: 'smtp' }, { to: ['user@example.com\nBcc:other@example.com'] }, { subject: 'a\nb' }, { sendId: 'bad' }, { replyTo: { type: 'reply', provider: 'outlook', referenceMessageId: 'm' } }, { body: null }]) {
    const { mail, calls } = fake(); await assert.rejects(mail.send({ ...SEND, ...change }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
  }
});

test('account switch refuses mail', async () => {
  const { mail, calls } = fake(); await assert.rejects(mail.send({ ...SEND, expectedAccountId: 'other' }), { code: 'ACCOUNT_CHANGED' }); assert.equal(calls.length, 0);
});

test('mail pins the preflight subject before any provider fetch or send', async () => {
  const auth = subject => ({ accountId: 'account-1', accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
  let authReads = 0, fetches = 0;
  const transport = new Transport({ authLoader: async () => auth(++authReads === 1 ? 'first-user' : 'second-user'),
    fetchImpl: async () => { fetches++; throw new Error('No network access is expected.'); } });
  const mail = new DotMail({ transport });
  await assert.rejects(mail.send(SEND), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(authReads, 2);
  assert.equal(fetches, 0);
});

test('disabled or missing send action refuses before mail mutation', async () => {
  for (const provider of [{ ...connector('gmail'), actions: [] }, { ...connector('gmail'), status: 'DISABLED_BY_ADMIN' }, { ...connector('gmail'), actions: [{ name: 'send_email', is_enabled: false }] }]) {
    const { mail, calls } = fake([provider]); await assert.rejects(mail.send(SEND), { code: 'MAIL_UNAVAILABLE' }); assert.equal(calls.length, 1);
  }
});

test('missing, hidden, wrong-provider, inactive and scope-deficient links refuse to send', async () => {
  for (const badLink of [undefined, { ...link('gmail'), visibility: 'HIDDEN' }, link('outlook'), { ...link('gmail'), auth_status: 'REAUTH_REQUIRED' }, { ...link('gmail'), scopes: [] }, { ...link('gmail'), unavailable_reason: 'policy' }]) {
    const { mail, calls } = fake([connector('gmail'), { links: badLink ? [badLink] : [] }]);
    await assert.rejects(mail.send(SEND), { code: 'MAIL_UNAVAILABLE' }); assert.equal(calls.length, 2);
  }
});

test('send errors preserve one attempt and unconfirmed receipt is not success', async () => {
  const { mail, calls } = fake([connector('gmail'), { links: [link('gmail')] }, new Error('network')]);
  await assert.rejects(mail.send(SEND)); assert.equal(calls.filter(call => call[1].endsWith('/send_email')).length, 1);
  const mismatch = fake([connector('gmail'), { links: [link('gmail')] }, { send_id: 'other' }]);
  await assert.rejects(mismatch.mail.send(SEND), { code: 'MAIL_UNCONFIRMED' }); assert.equal(mismatch.calls.length, 3);
});

test('mail status reconciles only the original send ID and suppresses error payloads', async () => {
  const { mail, calls } = fake([{ status: 'send_failed', error_message: 'token=private', raw: 'hidden' }]);
  assert.deepEqual(await mail.status({ sendId: SID }), { accountId: 'account-1', sendId: SID, status: 'send_failed' });
  assert.deepEqual(calls[0][2].body, { send_id: SID });
});

test('undo sends once inside the original deadline and labels the request accurately', async () => {
  const { mail, calls } = fake([{}]);
  const result = await mail.undo({ sendId: SID, unsendExpiresAt: '2026-10-18T12:00:10Z' });
  assert.equal(result.status, 'undo_requested'); assert.deepEqual(calls[0][2].body, { send_id: SID });
  for (const deadline of [undefined, 'bad', '2026-10-18T11:59:59Z']) {
    const denied = fake(); await assert.rejects(denied.mail.undo({ sendId: SID, unsendExpiresAt: deadline }), { code: 'UNDO_EXPIRED' }); assert.equal(denied.calls.length, 0);
  }
});

test('account list exposes safe identities and scope readiness only', async () => {
  const { mail } = fake([{ links: [{ ...link('gmail'), access_token: 'private', metadata: { hidden: true } }, { ...link('gmail'), id: 'hidden', visibility: 'HIDDEN' }] }]);
  const result = await mail.accounts(); assert.equal(result.accounts.length, 1); assert.equal(result.accounts[0].hasSendScope, true); assert.ok(!JSON.stringify(result).includes('private'));
});

test('contacts search verifies the selected contacts connector link', async () => {
  const contacts = { id: 'contacts-1', connector_id: 'connector_c0f748249d6a42aea4b00fd375570ded', auth_status: 'ACTIVE' };
  const { mail, calls } = fake([{ links: [contacts] }, { contacts: [{ name: 'Ada', email: 'ada@example.com', private: 'token' }] }]);
  assert.deepEqual((await mail.contacts({ linkId: 'contacts-1', query: 'Ada' })).contacts, [{ name: 'Ada', email: 'ada@example.com' }]);
  assert.deepEqual(calls[1][2].body, { limit: 10, link_id: 'contacts-1', query: 'Ada' });
  const denied = fake([{ links: [link('gmail')] }]); await assert.rejects(denied.mail.contacts({ linkId: 'link-1', query: 'Ada' }), { code: 'MAIL_UNAVAILABLE' }); assert.equal(denied.calls.length, 1);
});

test('abort between link preflight and send prevents mutation', async () => {
  const controller = new AbortController(); const f = fake([connector('gmail'), { links: [link('gmail')] }]); const original = f.transport.request;
  f.transport.request = async (...args) => { const result = await original(...args); if (args[1].endsWith('list_accessible')) controller.abort(); return result; };
  await assert.rejects(f.mail.send({ ...SEND, signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.calls.length, 2);
});
