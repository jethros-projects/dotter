import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotConnectorAdmin, connectorPublicData } from '../src/connectors-admin.mjs';
import { commands, createClient } from '../src/command-sets/connectors-admin.mjs';
import { Transport } from '../src/transport.mjs';

const ROOT = '/backend-api/aip/connectors';
const connector = { id: 'connector-1', name: 'Example', connector_type: 'MCP', supported_auth: [{ type: 'OAUTH' }, { type: 'NONE' }, { type: 'API_KEY' }] };
function setup(handler = () => ({}), accountId = 'account-1') {
  const token = `h.${Buffer.from(JSON.stringify({ sub: 'subject-1', 'https://api.openai.com/auth': { user_id: 'user-1' } })).toString('base64url')}.s`;
  const calls = [], transport = { authLoader: async () => ({ accountId, accessToken: token }), request: async (method, route, options) => { const call = { method, route, ...options }; calls.push(call); return route === '/backend-api/accounts/check/v4-2023-04-27' ? { accounts: { [accountId]: { can_access_with_session: true, account: { account_id: accountId, structure: 'personal' } } } } : handler(call, calls.length); } };
  return { admin: new DotConnectorAdmin({ transport }), transport, calls };
}
const error = code => exception => exception.code === code;
test('admin manifest only references implemented methods', () => { for (const spec of Object.values(commands)) assert.equal(typeof DotConnectorAdmin.prototype[spec.method], 'function'); assert.ok(createClient({ transport: { request() {} } }) instanceof DotConnectorAdmin); });
test('full connector details retain schemas and redact credential values', async () => {
  const { admin, calls } = setup(() => ({ ...connector, client_secret: 'secret', link_params_schema: { properties: { password: { type: 'string' } } }, actions: [{ name: 'search' }] }));
  const result = await admin.get({ connectorId: connector.id });
  assert.equal(calls[0].query.include_actions, true); assert.equal(calls[0].expectedAccountId, 'account-1');
  assert.equal(result.client_secret, undefined); assert.equal(result.link_params_schema.properties.password.type, 'string'); assert.equal(result.actions.length, 1);
});
test('get rejects a connector ID mismatch', async () => { const { admin } = setup(() => ({ ...connector, id: 'other' })); await assert.rejects(admin.get({ connectorId: connector.id }), error('INVALID_RESPONSE')); });
for (const [method, suffix] of [['tos', 'tos'], ['mfaRequirement', 'mfa_requirement']]) test(`${method} uses verified read route`, async () => {
  const { admin, calls } = setup(() => ({ requirement: 'required' })); await admin[method]({ connectorId: connector.id }); assert.equal(calls[0].route, `${ROOT}/${connector.id}/${suffix}`); assert.equal(calls[0].method, 'GET');
});
for (const policy of ['always_ask', 'ask_before_writes', 'review_important_actions', 'full_access']) test(`privacy ${policy} validates exact link and pins account`, async () => {
  const { admin, calls } = setup(call => call.route.endsWith('list_accessible') ? { links: [{ id: 'link-1', connector_id: connector.id, owners: [{ type: 'USER', id: 'user-1' }] }] } : call.method === 'GET' ? connector : {});
  await admin.setPrivacy({ connectorId: connector.id, linkId: 'link-1', policy });
  assert.equal(calls.length, 4); assert.equal(calls[3].method, 'PATCH'); assert.deepEqual(calls[3].body, { apps_privacy_control: policy }); assert.ok(calls.every(call => call.expectedAccountId === 'account-1'));
});
test('privacy refuses wrong link and unsupported policy before mutation', async () => {
  const { admin, calls } = setup(call => call.method === 'GET' ? connector : { links: [{ id: 'link-1', connector_id: 'other' }] });
  await assert.rejects(admin.setPrivacy({ connectorId: connector.id, linkId: 'link-1', policy: 'full_access' }), error('CONNECTION_UNAVAILABLE')); assert.equal(calls.length, 3);
  await assert.rejects(admin.setPrivacy({ connectorId: connector.id, linkId: 'link-1', policy: 'yolo' }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 3);
});
test('OAuth companion and Slack options match native body', async () => {
  const slack = 'connector_3f8d1a79f27c4c7ba1a897ab13bf37dc';
  const { admin, calls } = setup(call => call.method === 'GET' ? { ...connector, id: slack } : { redirect_url: 'https://provider.test/authorize?state=abc' });
  const result = await admin.startOAuth({ connectorId: slack, requestedScopes: ['read'], actionNames: ['search'], companionConnectorIds: ['connector-2'], slackTeamId: 'T123' });
  assert.deepEqual(calls[1].body.requested_companion_connector_ids, ['connector-2']); assert.equal(calls[1].body.slack_team_id, 'T123'); assert.deepEqual(calls[1].body.requested_scopes, ['read']); assert.equal(result.status, 'authorization_required'); assert.equal(calls[1].body.siwc_login, undefined);
});
test('SIWC and wrong Slack connector refuse before network access', async () => {
  const { admin, calls } = setup(); await assert.rejects(admin.startOAuth({ connectorId: connector.id, siwcLogin: true }), error('NATIVE_IDENTITY_FLOW_REQUIRED'));
  await assert.rejects(admin.startOAuth({ connectorId: connector.id, slackTeamId: 'T1' }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0);
});
test('OAuth rejects token-bearing redirect', async () => { const { admin } = setup(call => call.method === 'GET' ? connector : { redirect_url: 'https://provider.test/?access_token=secret' }); await assert.rejects(admin.startOAuth({ connectorId: connector.id }), error('INVALID_RESPONSE')); });
test('unlink all requires exact confirmation and sends only connector ID', async () => {
  const { admin, calls } = setup(() => connector); await assert.rejects(admin.unlinkAll({ connectorId: connector.id, confirmConnectorId: 'wrong' }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0);
  await admin.unlinkAll({ connectorId: connector.id, confirmConnectorId: connector.id }); assert.equal(calls[1].method, 'DELETE'); assert.equal(calls[1].route, `${ROOT}/links`); assert.deepEqual(calls[1].body, { connector_id: connector.id });
});
test('MCP discovery and callback accept only exact target variants', async () => {
  const { admin, calls } = setup(() => ({ oauth_config: { type: 'OAUTH' } }));
  await admin.discoverOAuth({ target: { mcp_url: 'https://server.test/mcp' } }); await admin.oauthCallback({ target: { tunnel_id: `tunnel_${'a'.repeat(32)}` } }); await admin.tunnels(); await admin.oauthClients({ service: 'https://server.test' });
  assert.deepEqual(calls[0].body, { mcp_url: 'https://server.test/mcp' }); assert.deepEqual(calls[1].query, { tunnel_id: `tunnel_${'a'.repeat(32)}` }); assert.equal(calls[2].route, `${ROOT}/mcp/tunnels`); assert.equal(calls[3].route, `${ROOT}/oauth_clients`); assert.equal(calls[3].query.service, 'https://server.test');
  await assert.rejects(admin.discoverOAuth({ target: { mcp_url: 'https://a', tunnel_id: 'a'.repeat(32) } }), error('INVALID_ARGUMENT'));
});
test('MCP no-auth creation matches body', async () => {
  const { admin, calls } = setup(() => ({ connector }));
  const result = await admin.createMcp({ name: ' Example ', target: { mcp_url: 'https://server.test/mcp' }, authRequest: { supported_auth: [{ type: 'NONE' }] } });
  assert.equal(calls[0].route, `${ROOT}/mcp`); assert.deepEqual(calls[0].body, { name: 'Example', description: '', mcp_url: 'https://server.test/mcp', logo_url: null, auth_request: { supported_auth: [{ type: 'NONE' }] } }); assert.equal(result.status, 'created');
});
test('MCP secret file stays private and response credentials are redacted', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-admin-')); const file = join(folder, 'secret'); await writeFile(file, 'private-secret\n', { mode: 0o600 });
  try {
    const { admin, calls } = setup(() => ({ connector: { ...connector, client_secret: 'do-not-return' } }));
    const result = await admin.createMcp({ name: 'OAuth', target: { mcp_url: 'http://localhost:3000/mcp' }, authRequest: { supported_auth: [{ type: 'OAUTH', authorization_url: 'https://auth.test/authorize', token_url: 'https://auth.test/token' }], oauth_client_params: { client_id: 'client', token_endpoint_auth_method: 'client_secret_basic' } }, clientSecretFile: file });
    assert.equal(calls[0].body.auth_request.oauth_client_params.client_secret, 'private-secret'); assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('MCP rejects raw secrets and invalid authentication before requests', async () => {
  const { admin, calls } = setup(); const input = { name: 'X', target: { mcp_url: 'https://server.test' } };
  await assert.rejects(admin.createMcp({ ...input, authRequest: { supported_auth: [{ type: 'NONE' }], oauth_client_params: { client_id: 'id', client_secret: 'secret' } } }), error('INVALID_ARGUMENT'));
  await assert.rejects(admin.createMcp({ ...input, authRequest: { supported_auth: [{ type: 'OAUTH', authorization_url: 'file:///tmp/x', token_url: 'https://a' }] } }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0);
});
test('MCP logo and private secret reject symlinks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-admin-')); await writeFile(join(folder, 'file'), 'secret'); await symlink(join(folder, 'file'), join(folder, 'link'));
  try { const { admin, calls } = setup(); await assert.rejects(admin.createMcp({ name: 'X', target: { mcp_url: 'https://a.test' }, authRequest: { supported_auth: [{ type: 'NONE' }] }, logoFile: join(folder, 'link') }), error('PRIVATE_INPUT_UNREADABLE')); assert.equal(calls.length, 0); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
for (const [field, value] of [['name', 'Renamed'], ['description', 'Updated description']]) test(`MCP ${field} update verifies type and pins account`, async () => {
  const { admin, calls } = setup(() => connector); await admin.updateMcp({ connectorId: connector.id, field, value }); assert.equal(calls[1].method, 'PATCH'); assert.equal(calls[1].route, `${ROOT}/${connector.id}/${field}`); assert.deepEqual(calls[1].body, { [field]: value });
});
test('MCP mutation refuses ordinary connector', async () => { const { admin, calls } = setup(() => ({ ...connector, connector_type: 'SERVICE' })); await assert.rejects(admin.updateMcp({ connectorId: connector.id, field: 'name', value: 'Changed' }), error('INVALID_CONNECTOR_TYPE')); assert.equal(calls.length, 1); });
test('MCP refresh checks exact link and has no retries', async () => {
  const { admin, calls } = setup(call => { if (call.method === 'GET') return connector; if (call.route.endsWith('list_accessible')) return { links: [{ id: 'link-1', connector_id: connector.id }] }; throw new Error('network'); });
  await assert.rejects(admin.refreshActions({ connectorId: connector.id, linkId: 'link-1' })); assert.equal(calls.filter(call => call.route.endsWith('/refresh_actions')).length, 1);
});
test('retired MCP delete rejects before requests', async () => { const { admin, calls } = setup(() => connector); await assert.rejects(admin.deleteMcp({ connectorId: connector.id, confirmConnectorId: connector.id }), error('UNSUPPORTED')); assert.equal(calls.length, 0); });
test('account mismatch and missing account fail before requests', async () => { const { admin, calls } = setup(); await assert.rejects(admin.tunnels({ expectedAccountId: 'other' }), error('ACCOUNT_CHANGED')); assert.equal(calls.length, 0); const missing = setup(() => ({}), null); await assert.rejects(missing.admin.tunnels(), error('AUTH_ACCOUNT_REQUIRED')); });
test('service account links omit hidden links', async () => { const { admin, calls } = setup(() => ({ links: [{ id: 'a', visibility: 'HIDDEN' }, { id: 'b', visibility: 'PUBLIC' }] })); const result = await admin.serviceAccountLinks({ serviceAccountUserId: 'sa-1' }); assert.equal(result.links.length, 1); assert.deepEqual(calls[0].body, { service_account_account_user_id: 'sa-1' }); });
test('service-account noauth scopes the body without personal install fields', async () => { const { admin, calls } = setup(() => connector); await admin.serviceAccountNoAuth({ serviceAccountUserId: 'sa-1', connectorId: connector.id }); assert.equal(calls[1].route, `${ROOT}/service_accounts/links/noauth`); assert.equal(calls[1].body.service_account_account_user_id, 'sa-1'); assert.equal(calls[1].body.install_attempt_id, undefined); });
test('service-account OAuth uses service namespace', async () => { const { admin, calls } = setup(call => call.method === 'GET' ? connector : { redirect_url: 'https://auth.test/?state=x' }); await admin.serviceAccountOAuth({ serviceAccountUserId: 'sa-1', connectorId: connector.id, requestedScopes: ['read'] }); assert.equal(calls[1].route, `${ROOT}/service_accounts/links/oauth`); assert.equal(calls[1].body.service_account_account_user_id, 'sa-1'); });
test('service-account unlink checks connector membership', async () => { const { admin, calls } = setup(() => ({ links: [{ id: 'link-1', connector_id: connector.id }] })); await admin.serviceAccountUnlink({ serviceAccountUserId: 'sa-1', connectorId: connector.id, linkId: 'link-1', confirmLinkId: 'link-1' }); assert.equal(calls[1].route, `${ROOT}/service_accounts/links/link-1`); assert.equal(calls[1].method, 'DELETE'); });
test('redaction retains cursor values while removing nested secrets', () => { assert.deepEqual(connectorPublicData({ next_page_token: 'cursor', nested: { access_token: 'secret', foo: true } }), { next_page_token: 'cursor', nested: { foo: true } }); });
test('MCP tunnel accepts only native tunnel ID shapes', async () => { const { admin, calls } = setup(); await admin.discoverOAuth({ target: { tunnel_id: `tunnel_ab12_${'a'.repeat(32)}` } }); await assert.rejects(admin.discoverOAuth({ target: { tunnel_id: 'a'.repeat(32) } }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 1); });
test('service-account workspace connection mutation checks membership and team', async () => {
  const { admin, calls } = setup(() => ({ links: [{ id: 'link-1' }] }));
  await admin.setServiceAccountConnection({ serviceAccountUserId: 'service-1', teamId: 'team-1', linkId: 'link-1', enabled: true });
  assert.equal(calls[1].route, '/backend-api/ps/v2/service_accounts/service-1/workspace_connections/link-1'); assert.deepEqual(calls[1].body, { enabled: true }); assert.deepEqual(calls[1].query, { team_id: 'team-1' });
});
test('service-account read-only setting checks selected account link', async () => {
  const { admin, calls } = setup(() => ({ links: [{ id: 'link-1' }] }));
  await admin.setServiceAccountReadOnly({ serviceAccountUserId: 'service-1', linkId: 'link-1', readOnly: false });
  assert.equal(calls[1].route, '/backend-api/ps/v2/links/link-1'); assert.deepEqual(calls[1].body, { is_read_only: false });
});


test('MCP creation pins the real transport before the first write', async () => {
  let authReads = 0, writes = 0;
  const token = sub => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-1', accessToken: token(++authReads === 1 ? 'user-1' : 'user-2') }), fetchImpl: async () => {
    writes++; return new Response(JSON.stringify({ connector }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(new DotConnectorAdmin({ transport }).createMcp({ name: 'fixture', target: { mcp_url: 'https://example.com/mcp' }, authRequest: { supported_auth: [{ type: 'NONE' }] } }), error('AUTH_IDENTITY_CHANGED'));
  assert.equal(authReads, 2); assert.equal(writes, 0);
});

