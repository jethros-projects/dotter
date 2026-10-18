import test from 'node:test';
import assert from 'node:assert/strict';
import { DotConnectorAdmin } from '../src/connectors-admin.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { run } from '../src/cli.mjs';

const accountId = 'account-a', connectorId = 'connector-a', linkId = 'link-a', userId = 'user-a';
const token = claims => `h.${Buffer.from(JSON.stringify({ sub: 'stable-subject', 'https://api.openai.com/auth': claims })).toString('base64url')}.s`;
const ownToken = token({ user_id: userId });
const membership = () => ({ accounts: { [accountId]: { can_access_with_session: true, account: { account_id: accountId, structure: 'personal' } } } });
const connector = () => ({ id: connectorId, name: 'Fixture', supported_auth: [{ type: 'OAUTH' }], labels: {} });
const link = () => ({ id: linkId, connector_id: connectorId, auth_status: 'ACTIVE', owners: [{ type: 'USER', id: userId }], apps_privacy_control: null });
const options = { connectorId, linkId, policy: 'always_ask', expectedAccountId: accountId };
function fixture({ account = membership(), app = connector(), selected = link(), accessToken = ownToken, handler } = {}) {
  const state = { accessToken, accountId }, calls = [];
  const transport = {
    authLoader: async () => ({ accountId: state.accountId, accessToken: state.accessToken }),
    request: async (method, path, request) => {
      calls.push({ method, path, ...request });
      if (handler) return handler({ method, path, request, state });
      if (path === '/backend-api/accounts/check/v4-2023-04-27') return account;
      if (path === `/backend-api/aip/connectors/${connectorId}`) return app;
      if (path.endsWith('/links/list_accessible')) return { links: [selected] };
      return {};
    },
  };
  return { admin: new DotConnectorAdmin({ transport }), transport, calls, state };
}

test('privacy uses exact selected personal membership, owner, connector and link before PATCH', async () => {
  const f = fixture();
  assert.deepEqual(await f.admin.setPrivacy(options), { status: 'updated', connectorId, linkId, policy: 'always_ask' });
  assert.deepEqual(f.calls.map(({ method }) => method), ['GET', 'GET', 'POST', 'PATCH']);
  assert.ok(f.calls.every(call => call.expectedAccountId === accountId));
  assert.equal(f.calls[0].path, '/backend-api/accounts/check/v4-2023-04-27');
  assert.deepEqual(f.calls[3].body, { apps_privacy_control: 'always_ask' });
  assert.equal(f.calls[3].path, `/backend-api/aip/connectors/links/${linkId}`);
});

test('privacy supports native fallback chatgpt_user_id', async () => {
  const f = fixture({ accessToken: token({ chatgpt_user_id: userId }) });
  assert.equal((await f.admin.setPrivacy(options)).status, 'updated');
});

test('privacy prefers user_id over chatgpt_user_id', async () => {
  const f = fixture({ accessToken: token({ user_id: userId, chatgpt_user_id: 'other' }) });
  assert.equal((await f.admin.setPrivacy(options)).status, 'updated');
  const g = fixture({ accessToken: token({ user_id: 'other', chatgpt_user_id: userId }) });
  await assert.rejects(g.admin.setPrivacy(options), { code: 'PERMISSION_REQUIRED' });
  assert.equal(g.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('privacy accepts one matching owner among other owners and does not require MCP or NONE auth', async () => {
  const selected = link(); selected.owners.unshift({ type: 'GROUP', id: 'group-a' }, { type: 'USER', id: 'other-user' });
  selected.auth_status = 'INACTIVE';
  const app = { ...connector(), connector_type: 'SERVICE', status: 'ENABLED' };
  const f = fixture({ selected, app });
  assert.equal((await f.admin.setPrivacy(options)).status, 'updated');
});

test('privacy preserves literal native label semantics', async () => {
  for (const label of [undefined, 'true', false]) {
    const app = connector(); if (label !== undefined) app.labels.apps_privacy_control_available = label;
    assert.equal((await fixture({ app }).admin.setPrivacy(options)).status, 'updated');
  }
});

test('privacy skips equal policy only after eligibility validation', async () => {
  const selected = { ...link(), apps_privacy_control: 'always_ask' }, f = fixture({ selected });
  assert.deepEqual(await f.admin.setPrivacy(options), { status: 'unchanged', connectorId, linkId, policy: 'always_ask' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
  const app = connector(); app.labels.apps_privacy_control_available = 'false';
  const g = fixture({ app, selected });
  await assert.rejects(g.admin.setPrivacy(options), { code: 'PRIVACY_UNAVAILABLE' });
});

for (const [name, account, code] of [
  ['workspace', { accounts: { [accountId]: { can_access_with_session: true, account: { account_id: accountId, structure: 'workspace' } } } }, 'UNSUPPORTED_SCOPE'],
  ['wrong account', { accounts: { [accountId]: { can_access_with_session: true, account: { account_id: 'other', structure: 'personal' } } } }, 'ACCOUNT_MEMBERSHIP_UNVERIFIED'],
  ['inactive session', { accounts: { [accountId]: { can_access_with_session: false, account: { account_id: accountId, structure: 'personal' } } } }, 'ACCOUNT_MEMBERSHIP_UNVERIFIED'],
  ['missing selected account', { accounts: {} }, 'ACCOUNT_MEMBERSHIP_UNVERIFIED'],
]) test(`privacy rejects ${name} membership before connector/link reads`, async () => {
  const f = fixture({ account });
  await assert.rejects(f.admin.setPrivacy(options), { code });
  assert.equal(f.calls.length, 1);
});

for (const [name, owners] of [['missing', undefined], ['null', null], ['scalar', 'user-a'], ['empty', []], ['other user', [{ type: 'USER', id: 'other' }]], ['wrong type', [{ type: 'GROUP', id: userId }]]]) {
  test(`privacy rejects ${name} owners without PATCH`, async () => {
    const f = fixture({ selected: { ...link(), owners } });
    await assert.rejects(f.admin.setPrivacy(options), { code: 'PERMISSION_REQUIRED' });
    assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
  });
}

test('privacy rejects reauthorization-required links and disabled connector control', async () => {
  for (const f of [fixture({ selected: { ...link(), auth_status: 'REAUTH_REQUIRED' } }), fixture({ app: { ...connector(), labels: { apps_privacy_control_available: 'false' } } })]) {
    await assert.rejects(f.admin.setPrivacy(options), { code: 'PRIVACY_UNAVAILABLE' });
    assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
  }
});

for (const [name, accessToken] of [['only subject', token({})], ['account-user only', token({ chatgpt_account_user_id: userId })], ['empty user', token({ user_id: '' })], ['malformed token', 'invalid']]) {
  test(`privacy rejects ${name} identity before network access`, async () => {
    const f = fixture({ accessToken });
    await assert.rejects(f.admin.setPrivacy(options), { code: 'AUTH_IDENTITY_REQUIRED' });
    assert.equal(f.calls.length, 0);
  });
}

test('native user drift after link read is blocked even with unchanged token subject/account', async () => {
  const f = fixture({ handler: ({ path, state }) => {
    if (path === '/backend-api/accounts/check/v4-2023-04-27') return membership();
    if (path.endsWith('/links/list_accessible')) { state.accessToken = token({ user_id: 'other' }); return { links: [link()] }; }
    return connector();
  } });
  await assert.rejects(f.admin.setPrivacy(options), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
});

test('account drift after link read is blocked before PATCH', async () => {
  const f = fixture({ handler: ({ path, state }) => {
    if (path === '/backend-api/accounts/check/v4-2023-04-27') return membership();
    if (path.endsWith('/links/list_accessible')) { state.accountId = 'other'; return { links: [link()] }; }
    return connector();
  } });
  await assert.rejects(f.admin.setPrivacy(options), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
});

test('native user is fenced at the real transport final auth read', async () => {
  let afterLinks = false, afterReads = 0, patches = 0;
  const transport = new Transport({
    authLoader: async () => ({ accountId, accessToken: afterLinks && ++afterReads >= 3 ? token({ user_id: 'other' }) : ownToken }),
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname;
      if (request.method === 'PATCH') patches++;
      const data = path === '/backend-api/accounts/check/v4-2023-04-27' ? membership()
        : path.endsWith('/links/list_accessible') ? (afterLinks = true, { links: [link()] }) : connector();
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(new DotConnectorAdmin({ transport }).setPrivacy(options), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(patches, 0);
});

test('privacy guard remains operation-local and does not mutate the shared transport', async () => {
  const f = fixture(), original = f.transport.authLoader;
  await f.admin.setPrivacy(options);
  assert.equal(f.transport.authLoader, original);
  assert.equal(f.admin.assertCurrent, undefined);
});

test('a privacy write error is rethrown once without retry', async () => {
  const failure = new DotError('HTTP_ERROR', 'Rejected', { status: 500 });
  const f = fixture({ handler: ({ method, path }) => {
    if (method === 'PATCH') throw failure;
    return path === '/backend-api/accounts/check/v4-2023-04-27' ? membership() : path.endsWith('/links/list_accessible') ? { links: [link()] } : connector();
  } });
  await assert.rejects(f.admin.setPrivacy(options), error => error === failure);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('identity drift after an acknowledged PATCH remains an unknown outcome', async () => {
  const f = fixture({ handler: ({ method, path, state }) => {
    if (method === 'PATCH') { state.accessToken = token({ user_id: 'other' }); return {}; }
    return path === '/backend-api/accounts/check/v4-2023-04-27' ? membership() : path.endsWith('/links/list_accessible') ? { links: [link()] } : connector();
  } });
  await assert.rejects(f.admin.setPrivacy(options), error => error.code === 'AUTH_IDENTITY_CHANGED' && error.details.delivery === 'unknown');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('actual CLI reports an unchanged policy without PATCH', async () => {
  const f = fixture({ selected: { ...link(), apps_privacy_control: 'always_ask' } });
  let stdout = '';
  const result = await run(['connector', 'admin', 'privacy', connectorId, linkId, 'always_ask', '--account', accountId, '--json'], {
    createClient: async () => new FullDotClient({ transport: f.transport }),
    stdout: { write: value => { stdout += value; } },
    stderr: { write: () => { throw new Error('Unexpected stderr'); } },
  });
  assert.deepEqual(result, { status: 'unchanged', connectorId, linkId, policy: 'always_ask' });
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
});
