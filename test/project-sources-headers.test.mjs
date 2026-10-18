import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSources, PROJECT_CONNECTOR_PROVIDERS } from '../src/project-sources.mjs';
import { Transport } from '../src/transport.mjs';
import { run } from '../src/cli.mjs';

// Native app-initial TFn (export Kur, imported Ee by add-sources-dialog)
// uses connector_setup for connector metadata; hIn (export Nur, imported Me)
// separately uses other for accessible links, both with CHATGPT_PROJECTS.
const accountId = 'fixture-account', subject = 'fixture-user', projectId = 'g-p-fixture';
const token = user => `header.${Buffer.from(JSON.stringify({ sub: user })).toString('base64url')}.signature`;
const membership = { accounts: { [accountId]: { account: { account_id: accountId, account_user_id: `${subject}__${accountId}`, structure: 'personal' }, can_access_with_session: true } } };
const project = { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Fixture' }, author: { user_id: subject }, share_recipient: 'private', sharing: { subjects: [] }, current_user_permission: { can_read: true }, memory_scope: 'global' }, files: [] };
function fixture({ failAt, changeSubjectAfterLinks = false } = {}) {
  const calls = []; let user = subject;
  const transport = new Transport({ authLoader: async () => ({ accountId, accessToken: token(user) }), fetchImpl: async (url, options) => {
    const parsed = new URL(url), headers = new Headers(options.headers);
    assert.equal(parsed.origin, 'https://chatgpt.com');
    calls.push({ method: options.method, path: parsed.pathname, query: [...parsed.searchParams], headers, body: options.body == null ? null : JSON.parse(options.body) });
    if (parsed.pathname === failAt) return new Response('<script src="/cdn-cgi/challenge-platform/"></script>', { status: 403, headers: { 'content-type': 'text/html' } });
    if (parsed.pathname === '/backend-api/accounts/check/v4-2023-04-27') return Response.json(membership);
    if (parsed.pathname === `/backend-api/gizmos/${projectId}`) return Response.json(project);
    if (parsed.pathname === '/backend-api/aip/connectors/links/list_accessible') {
      if (changeSubjectAfterLinks) user = 'changed-user';
      return Response.json({ links: [{ id: 'fixture-link', connector_id: PROJECT_CONNECTOR_PROVIDERS.google_drive, auth_status: 'ACTIVE', connector_status: 'ENABLED' }] });
    }
    const match = Object.values(PROJECT_CONNECTOR_PROVIDERS).find(id => parsed.pathname === `/backend-api/aip/connectors/${id}`);
    if (match) return Response.json({ id: match, status: 'ENABLED' });
    assert.fail('Unexpected synthetic request');
  } });
  return { transport, calls, client: new ProjectSources({ transport }) };
}
const selected = { accountId, projectId };
function verifyHeaders(calls, types) {
  const providers = calls.filter(call => call.path.startsWith('/backend-api/aip/connectors/'));
  assert.equal(providers.length, 1 + types.length);
  assert.equal(providers[0].method, 'POST');
  assert.equal(providers[0].path, '/backend-api/aip/connectors/links/list_accessible');
  assert.deepEqual(providers[0].body, { principals: [], link_refresh_strategy: 'BLOCKING' });
  assert.equal(providers[0].headers.get('x-codex-surface'), 'other');
  for (const [index, type] of types.entries()) {
    const call = providers[index + 1];
    assert.equal(call.method, 'GET');
    assert.equal(call.path, `/backend-api/aip/connectors/${PROJECT_CONNECTOR_PROVIDERS[type]}`);
    assert.equal(call.headers.get('x-codex-surface'), 'connector_setup');
    assert.deepEqual(call.query, [['include_actions', 'false']]); assert.equal(call.body, null);
  }
  for (const call of providers) {
    assert.equal(call.headers.get('oai-product-sku'), 'CHATGPT_PROJECTS');
    assert.equal(call.headers.get('chatgpt-account-id'), accountId);
    assert.equal(call.headers.get('authorization'), `Bearer ${token(subject)}`);
  }
}

test('one selected provider uses native distinct link and connector surfaces', async () => {
  const f = fixture(), result = await f.client.sourceProviders({ ...selected, connectorType: 'google_drive' });
  assert.equal(result.providers.length, 1); assert.equal(result.providers[0].connected, true);
  assert.equal(f.calls.length, 4); verifyHeaders(f.calls, ['google_drive']);
});

test('default provider discovery uses connector_setup for all three metadata reads', async () => {
  const f = fixture(), result = await f.client.sourceProviders(selected);
  assert.deepEqual(result.providers.map(item => item.connectorType), ['google_drive', 'slack', 'linear']);
  assert.equal(f.calls.length, 6); verifyHeaders(f.calls, ['google_drive', 'slack', 'linear']);
});

test('production CLI provider dispatch retains the native surfaces and selected account', async () => {
  const f = fixture(); let stdout = '';
  const result = await run(['account', 'projects', 'sources', 'providers', projectId, '--account', accountId, '--type', 'google_drive', '--json'], {
    createClient: async () => ({ transport: f.transport }), stdout: { write: value => { stdout += value; } }, stderr: { write: () => assert.fail('Unexpected diagnostic') },
  });
  assert.deepEqual(JSON.parse(stdout), result); verifyHeaders(f.calls, ['google_drive']);
});

test('edge rejection in account or project preflight never reaches provider discovery', async () => {
  for (const failAt of ['/backend-api/accounts/check/v4-2023-04-27', `/backend-api/gizmos/${projectId}`]) {
    const f = fixture({ failAt });
    await assert.rejects(f.client.sourceProviders(selected), { code: 'EDGE_CHALLENGE' });
    assert.equal(f.calls.some(call => call.path.startsWith('/backend-api/aip/')), false);
  }
});

test('connector metadata rejection retains the failure without trying another surface', async () => {
  const f = fixture({ failAt: `/backend-api/aip/connectors/${PROJECT_CONNECTOR_PROVIDERS.google_drive}` });
  await assert.rejects(f.client.sourceProviders({ ...selected, connectorType: 'google_drive' }), { code: 'EDGE_CHALLENGE' });
  assert.equal(f.calls.length, 4); verifyHeaders(f.calls, ['google_drive']);
});

test('a subject change after accessible links prevents the metadata GET', async () => {
  const f = fixture({ changeSubjectAfterLinks: true });
  await assert.rejects(f.client.sourceProviders(selected), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(call => call.method === 'GET' && call.path.startsWith('/backend-api/aip/connectors/')).length, 0);
});
