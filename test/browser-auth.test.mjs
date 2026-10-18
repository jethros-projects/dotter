import test from 'node:test';
import assert from 'node:assert/strict';
import { DotBrowserAuth, browserAuthCapabilities } from '../src/browser-auth.mjs';
import { Transport } from '../src/transport.mjs';
const candidate = { credential_id: 'credential-1', origin: 'https://example.com', account_label: 'Work', created_at: '2026-10-18', selection_id: 'DO-NOT-EXPOSE', expires_at: '2026-10-19', password: 'SECRET' };
const availability = { available: true, save_enabled: true, reuse_enabled: true, manual_save_supported: true, manual_fill_recovery_supported: false, manual_save_fields: { password: 'password-field' }, items: [candidate], next_cursor: 'cursor=' };
function fixture(result = availability) {
  const calls = []; let accountId = 'account-1';
  const client = new DotBrowserAuth({ transport: { authLoader: async () => ({ accountId }), request: async (...args) => { calls.push(args); return typeof result === 'function' ? result(...args) : result; } } });
  return { client, calls, setAccount(value) { accountId = value; } };
}
const scope = { conversationId: 'thread-1', challengeId: 'challenge-1' };
test('browser-auth availability uses exact scoped contract, headers, and account pin', async () => {
  const { client, calls } = fixture(); const result = await client.availability(scope);
  assert.equal(result.items[0].accountLabel, 'Work'); assert.equal(result.manualSaveSupported, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|DO-NOT-EXPOSE|password-field/);
  assert.deepEqual(calls[0], ['GET', '/backend-api/flora/browser/credential-availability', { query: { conversation_id: 'thread-1', challenge_id: 'challenge-1' }, headers: { 'X-OpenAI-Cloud-Vault-Check-Trigger': 'explicit_recheck', 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2' }, expectedAccountId: 'account-1', signal: undefined }]);
});
test('browser-auth candidate paging preserves opaque cursor and strips selection capability', async () => {
  const { client, calls } = fixture(); const result = await client.candidates({ ...scope, cursor: 'opaque+/=' });
  assert.equal(calls[0][0], 'POST'); assert.deepEqual(calls[0][2].body, { conversation_id: 'thread-1', challenge_id: 'challenge-1', cursor: 'opaque+/=' });
  assert.equal(result.nextCursor, 'cursor='); assert.equal(result.items[0].credentialId, 'credential-1'); assert.equal(result.items[0].origin, 'https://example.com');
});
test('browser-auth candidate timestamps preserve native numeric epoch seconds', async () => {
  const { client } = fixture({ ...availability, items: [{ ...candidate, created_at: 1792281600.25, expires_at: 1792368000 }] });
  const result = await client.availability(scope);
  assert.equal(result.items[0].createdAt, 1792281600.25); assert.equal(result.items[0].expiresAt, 1792368000);
  const invalid = fixture({ ...availability, items: [{ ...candidate, created_at: Infinity, expires_at: 'not-a-date' }] });
  assert.equal((await invalid.client.availability(scope)).items[0].createdAt, null);
  assert.equal((await invalid.client.availability(scope)).items[0].expiresAt, null);
});
test('browser-auth prepares metadata without external enrollment URLs or saved secrets', async () => {
  const { client, calls } = fixture({ manual_fill_recovery_supported: true, operation_id: 'operation-1', operation: { operation_id: 'operation-1', fill_status: 'submitted', save_status: 'saved' }, password_managers: [
    { provider: 'openai_passwords', interaction: 'inline', save_enabled: true, items: [candidate], next_cursor: null, manual_save_fields: { password: 'password-field' } },
    { provider: 'onepassword', interaction: 'external', state: 'connected', enrollment_url: 'https://example.com/?token=SECRET' }, { provider: 'unverified', key: 'SECRET' },
  ] });
  const result = await client.prepare(scope); assert.equal(result.passwordManagers.length, 2); assert.equal(result.operation.fillStatus, 'submitted');
  assert.equal(calls[0][1], '/backend-api/flora/browser/auth/prepare'); assert.doesNotMatch(JSON.stringify(result), /SECRET|enrollment_url|selection_id|password-field/);
});
test('browser-auth reconcile preserves exact observed status and does not retry', async () => {
  for (const fillStatus of ['submitted', 'declined', 'cancelled', 'unavailable', 'expired', 'origin_changed', 'page_changed', 'locator_invalid', 'submission_failed', 'unknown']) {
    const { client, calls } = fixture({ operation_id: 'operation-1', fill_status: fillStatus, save_status: 'not_requested', token: 'SECRET' });
    assert.deepEqual(await client.reconcile({ ...scope, operationId: 'operation-1' }), { operationId: 'operation-1', fillStatus, saveStatus: 'not_requested' });
    assert.equal(calls.length, 1); assert.match(calls[0][1], /\/operation-1\/reconcile$/); assert.deepEqual(calls[0][2].body, { conversation_id: 'thread-1', challenge_id: 'challenge-1' });
  }
});
test('browser-auth rejects cross-operation results and account changes', async () => {
  const { client, calls } = fixture({ operation_id: 'wrong', fill_status: 'submitted', save_status: 'saved' });
  await assert.rejects(client.reconcile({ ...scope, operationId: 'operation-1' }), { code: 'BROWSER_AUTH_IDENTITY_MISMATCH' });
  await assert.rejects(client.prepare({ ...scope, expectedAccountId: 'wrong' }), { code: 'ACCOUNT_CHANGED' }); assert.equal(calls.length, 1);
});
test('browser-auth checks the JWT subject as well as shared workspace account', async () => {
  let subject = 'user-1'; const calls = [];
  const transport = { assertIdentity: Transport.prototype.assertIdentity, authLoader: async () => ({ accountId: 'shared', accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` }), request: async (...args) => { calls.push(args); return availability; } };
  const client = new DotBrowserAuth({ transport }); await client.availability(scope); subject = 'user-2';
  await assert.rejects(client.availability(scope), { code: 'AUTH_IDENTITY_CHANGED' }); assert.equal(calls.length, 1);
});
test('browser-auth rejects invalid scopes and trigger without HTTP calls', async () => {
  const { client, calls } = fixture();
  for (const invalid of [{ conversationId: '../other' }, { challengeId: '' }, { trigger: 'unverified' }]) await assert.rejects(client.availability({ ...scope, ...invalid }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.candidates({ ...scope, cursor: '\n' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.reconcile({ ...scope, operationId: 'bad/path' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('browser-auth rejects unexpected response envelopes and hostile origins', async () => {
  for (const result of [null, [], {}, { ...availability, items: null }]) await assert.rejects(fixture(result).client.availability(scope), { code: 'INVALID_RESPONSE' });
  const { client } = fixture({ ...availability, items: [{ ...candidate, origin: 'https://user:SECRET@example.com' }] });
  assert.equal((await client.candidates(scope)).items[0].origin, null);
});
test('browser-auth distinguishes explicit credential workflows from native proofs', () => {
  const capabilities = browserAuthCapabilities(); assert.ok(capabilities.browserAuth.includes('reconcile existing operation'));
  assert.ok(capabilities.browserAuthNativeWorkflows.includes('durable operation claim'));
  assert.match(capabilities.browserAuthUnsupported.join(' '), /first-party human completion/);
});
