import test from 'node:test';
import assert from 'node:assert/strict';
import { DotBrowserAuth } from '../src/browser-auth.mjs';

const scope = { conversationId: 'conversation-fixture', challengeId: 'challenge-fixture' };
const allowed = ['http://localhost:8080', 'http://127.0.0.1:8000', 'http://example.test', 'https://example.test'];
const rejected = [
  'ftp://example.test', 'file:///private/example', 'javascript:alert(1)',
  'http://user:PRIVATE@example.test', 'https://user:PRIVATE@example.test',
  'http://example.test/sign-in', 'https://example.test/sign-in',
  'http://example.test/?token=PRIVATE', 'https://example.test/#PRIVATE',
];

function fixture(origins, prepared = false) {
  const items = origins.map(origin => ({ credential_id: 'credential-fixture', origin, account_label: 'Fixture', selection_id: 'PRIVATE-CAPABILITY', password: 'PRIVATE-PASSWORD' }));
  const response = prepared
    ? { manual_fill_recovery_supported: false, password_managers: [{ provider: 'openai_passwords', interaction: 'inline', items }] }
    : { available: true, save_enabled: true, reuse_enabled: true, items };
  return new DotBrowserAuth({ transport: {
    authLoader: async () => ({ accountId: 'account-fixture' }),
    request: async () => response,
  } });
}

for (const method of ['availability', 'candidates', 'prepare']) {
  test(`browser-auth ${method} preserves native HTTP and HTTPS origin metadata`, async () => {
    const result = await fixture(allowed, method === 'prepare')[method](scope);
    const items = method === 'prepare' ? result.passwordManagers[0].items : result.items;
    assert.deepEqual(items.map(item => item.origin), allowed);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CAPABILITY|PRIVATE-PASSWORD|selection_id/);
  });
  test(`browser-auth ${method} still strips non-web and non-origin metadata`, async () => {
    const result = await fixture(rejected, method === 'prepare')[method](scope);
    const items = method === 'prepare' ? result.passwordManagers[0].items : result.items;
    assert.deepEqual(items.map(item => item.origin), rejected.map(() => null));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  });
}
