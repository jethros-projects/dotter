import test from 'node:test';
import assert from 'node:assert/strict';
import { DotPlugins } from '../src/plugins.mjs';
import { Transport } from '../src/transport.mjs';

const ACCOUNT = 'account-a';
const PLUGIN = 'plugin-a';
const CHECK = '/backend-api/accounts/check/v4-2023-04-27';
const SHARES = `/backend-api/ps/plugins/${PLUGIN}/shares`;
const jwt = subject => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;
const membership = structure => ({ accounts: { [ACCOUNT]: { can_access_with_session: true, account: { account_id: ACCOUNT, structure } } } });
function fixture({ data = membership('workspace'), afterCheck, checkStatus = 200, sharesStatus = 200, permissions = ['chatgpt.plugin_share.write'] } = {}) {
  let auth = { accountId: ACCOUNT, accessToken: jwt('subject-a') };
  const calls = [];
  const transport = new Transport({ authLoader: async () => auth, fetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: options.method, headers: new Headers(options.headers), query: new URL(url).search, body: options.body });
    if (route === CHECK) {
      if (afterCheck) auth = afterCheck(auth);
      return Response.json(data, { status: checkStatus });
    }
    assert.equal(route, SHARES, 'no unrelated plugin request');
    return Response.json({ can_refresh_from_source: false, current_user_permissions: permissions, principals: [] }, { status: sharesStatus });
  } });
  return { client: new DotPlugins({ transport }), calls };
}
const options = { pluginId: PLUGIN, expectedAccountId: ACCOUNT };

test('workspace share read first checks exact accessible account and retains native plugin headers', async () => {
  const f = fixture();
  await f.client.shares(options);
  assert.deepEqual(f.calls.map(x => [x.method, x.route]), [['GET', CHECK], ['GET', SHARES]]);
  assert.equal(f.calls[0].query, '');
  assert.equal(f.calls[0].headers.get('chatgpt-account-id'), ACCOUNT);
  assert.equal(f.calls[0].headers.get('oai-product-sku'), null);
  assert.equal(f.calls[1].headers.get('oai-product-sku'), 'CODEX');
  assert.equal(f.calls[1].headers.get('x-codex-surface'), 'plugin_management');
});

test('workspace sharing writes only after the same account preflight and permission read', async () => {
  const f = fixture();
  await f.client.setShares({ ...options, targets: [] });
  assert.deepEqual(f.calls.map(x => [x.method, x.route]), [['GET', CHECK], ['GET', SHARES], ['PUT', SHARES]]);
  assert.deepEqual(JSON.parse(f.calls[2].body), { targets: [], discoverability: 'PRIVATE' });
});

for (const method of ['shares', 'setShares']) test(`personal account blocks ${method} before the shares endpoint`, async () => {
  const f = fixture({ data: membership('personal') });
  await assert.rejects(f.client[method]({ ...options, targets: [] }), { code: 'WORKSPACE_REQUIRED' });
  assert.deepEqual(f.calls.map(x => x.route), [CHECK]);
});

for (const [label, data] of [
  ['missing accounts', {}],
  ['missing selected account', { accounts: { other: membership('workspace').accounts[ACCOUNT] } }],
  ['conflicting account id', { accounts: { [ACCOUNT]: { can_access_with_session: true, account: { account_id: 'other', structure: 'workspace' } } } }],
  ['missing account id', { accounts: { [ACCOUNT]: { can_access_with_session: true, account: { structure: 'workspace' } } } }],
  ['inaccessible membership', { accounts: { [ACCOUNT]: { ...membership('workspace').accounts[ACCOUNT], can_access_with_session: false } } }],
  ['missing access flag', { accounts: { [ACCOUNT]: { account: { account_id: ACCOUNT, structure: 'workspace' } } } }],
  ['deactivated account', { accounts: { [ACCOUNT]: { can_access_with_session: true, account: { account_id: ACCOUNT, structure: 'workspace', is_deactivated: true } } } }],
  ['malformed deactivation flag', { accounts: { [ACCOUNT]: { can_access_with_session: true, account: { account_id: ACCOUNT, structure: 'workspace', is_deactivated: 'false' } } } }],
  ['unknown structure', membership('unknown')],
  ['missing structure', membership(undefined)],
  ['null structure', membership(null)],
  ['malformed structure', membership(true)],
]) test(`${label} fails closed without guessing another account`, async () => {
  const f = fixture({ data });
  await assert.rejects(f.client.shares(options), { code: 'ACCOUNT_MEMBERSHIP_UNVERIFIED' });
  assert.deepEqual(f.calls.map(x => x.route), [CHECK]);
});

test('explicit false deactivation flag remains eligible', async () => {
  const data = membership('workspace');
  data.accounts[ACCOUNT].account.is_deactivated = false;
  const f = fixture({ data });
  await f.client.shares(options);
  assert.equal(f.calls.length, 2);
});

test('different signed-in account blocks before metadata fetch', async () => {
  const f = fixture();
  await assert.rejects(f.client.shares({ ...options, expectedAccountId: 'other' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('account change during metadata fetch blocks the shares read', async () => {
  const f = fixture({ afterCheck: auth => ({ ...auth, accountId: 'other' }) });
  await assert.rejects(f.client.shares(options), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('subject change in the same account during metadata fetch blocks the shares read', async () => {
  const f = fixture({ afterCheck: auth => ({ ...auth, accessToken: jwt('subject-b') }) });
  await assert.rejects(f.client.shares(options), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(f.calls.length, 1);
});

test('account metadata HTTP errors stop without retry or shares request', async () => {
  const f = fixture({ checkStatus: 403 });
  await assert.rejects(f.client.shares(options), { code: 'FORBIDDEN' });
  assert.equal(f.calls.length, 1);
});

test('downstream workspace denial remains a single HTTP error', async () => {
  const f = fixture({ sharesStatus: 400 });
  await assert.rejects(f.client.shares(options), { code: 'HTTP_ERROR' });
  assert.deepEqual(f.calls.map(x => x.route), [CHECK, SHARES]);
});

test('workspace eligibility does not grant missing share permission', async () => {
  const f = fixture({ permissions: [] });
  await assert.rejects(f.client.setShares({ ...options, targets: [] }), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(f.calls.map(x => x.method), ['GET', 'GET']);
});

test('invalid plugin identifiers and share targets still fail before metadata access', async () => {
  const f = fixture();
  await assert.rejects(f.client.shares({ ...options, pluginId: '../other' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.client.setShares({ ...options, targets: [{ principal_id: 'user-a', principal_type: 'user', role: 'owner' }] }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});
