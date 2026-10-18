import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ProjectConnections } from '../src/project-connections.mjs';
import { commands, createClient } from '../src/command-sets/project-connections.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct';
const projectId = 'g-p-abc';
const connectorType = 'google_drive';
const connectorId = 'connector_5f3c8c41a1e54ad7a76272c89e2554fa';
const scoped = { accountId, projectId, connectorType };
const linkId = 'link-project-1';
const authState = 'signed-state-with-private-entropy';
const authorizationUrl = `https://provider.example/oauth?client_id=example&state=${authState}`;
const callbackUrl = `https://chatgpt.com/connector_platform_oauth_redirect?code=SECRET_CALLBACK_CODE&state=${authState}`;
const connectorRoot = '/backend-api/aip/connectors';
const authentication = (subject = 'user-1', account = accountId) => ({ accountId: account, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
function membership() { return { accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } }; }
function project(overrides = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Example', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: 'user-1' }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, ...overrides }, files: [] };
}
function connector(overrides = {}) {
  return { id: connectorId, name: 'Google Drive', status: 'ENABLED', description: 'Project provider', supported_auth: [{ type: 'OAUTH' }], link_params_schema: { type: 'object', properties: {}, required: [] }, ...overrides };
}
function link(overrides = {}) {
  return { id: linkId, connector_id: connectorId, name: 'Project account', auth_type: 'OAUTH', auth_status: 'ACTIVE', connector_status: 'ENABLED', unavailable_reason: null, ...overrides };
}
function setup(...responses) {
  const calls = [];
  let auth = authentication(), members = membership(), projectValue = project(), connectorValue = connector();
  const transport = {
    authLoader: async () => auth,
    async request(method, route, options) {
      const call = { method, route, options }; calls.push(call);
      if (route === '/backend-api/accounts/check/v4-2023-04-27') return members;
      if (route === `/backend-api/gizmos/${projectId}`) return projectValue;
      if (method === 'GET' && /^\/backend-api\/aip\/connectors\/[^/]+$/.test(route)) return connectorValue;
      const response = responses.shift();
      if (typeof response === 'function') return response(call);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { api: new ProjectConnections({ transport }), transport, calls,
    setAuth: value => { auth = value; }, setMembership: value => { members = value; }, setProject: value => { projectValue = value; }, setConnector: value => { connectorValue = value; },
    get operations() { return calls.filter(call => !call.route.includes('/accounts/check/') && !call.route.startsWith('/backend-api/gizmos/')); },
    get mutations() { return calls.filter(call => call.method !== 'GET' && !call.route.endsWith('/links/list_accessible')); } };
}
const code = value => error => error.code === value;
const input = value => Readable.from([Buffer.from(value)]);
async function files(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dot-project-connections-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateFile: path.join(root, 'operation.json'), callbackFile: path.join(root, 'callback.txt') };
}

test('project connection manifest exposes only the eight scoped provider operations', () => {
  assert.throws(() => new ProjectConnections({}), TypeError);
  assert.ok(createClient({ transport: { request() {} } }) instanceof ProjectConnections);
  assert.deepEqual(Object.values(commands).map(value => value.method).sort(), ['connectionGet', 'connectionStatus', 'connectionTos', 'connectionStart', 'connectionReauthorize', 'connectionNoAuth', 'connectionComplete', 'connectionOperation'].sort());
  for (const descriptor of Object.values(commands)) {
    assert.ok(descriptor.required.includes('accountId'));
    assert.equal(descriptor.flags['--account'].target, 'accountId');
    assert.equal(typeof setup().api[descriptor.method], 'function');
  }
});

test('connection reads require an explicit account and supported project provider', async () => {
  const h = setup();
  for (const method of ['connectionGet', 'connectionStatus', 'connectionTos']) {
    await assert.rejects(h.api[method]({ projectId, connectorType }), code('INVALID_ARGUMENT'));
    await assert.rejects(h.api[method]({ ...scoped, connectorType: 'arbitrary-provider' }), code('INVALID_ARGUMENT'));
    await assert.rejects(h.api[method]({ ...scoped, projectId: 'g-not-a-project' }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('provider metadata uses project SKU and omits credential and opaque fields', async () => {
  const h = setup(); h.setConnector(connector({ access_token: 'SECRET_TOKEN', owner_profile: { email: 'private@example.test' }, branding: { privacy_policy: 'https://example.test/privacy', terms_of_service: 'https://example.test/terms' } }));
  const result = await h.api.connectionGet(scoped);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TOKEN|private@example/);
  const request = h.operations.find(call => call.route === `${connectorRoot}/${connectorId}`);
  assert.equal(request.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  assert.deepEqual(request.options.query, { include_actions: false });
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
});

test('provider status selects the exact link with project SKU and blocking refresh', async () => {
  const h = setup({ links: [link({ id: 'another-link' }), link()] });
  const result = await h.api.connectionStatus({ ...scoped, linkId });
  assert.equal(result.connected, true); assert.equal(result.link.id, linkId);
  const listing = h.operations.find(call => call.route.endsWith('/links/list_accessible'));
  assert.deepEqual(listing.options.body, { principals: [], link_refresh_strategy: 'BLOCKING' });
  assert.equal(listing.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
});

test('project connection reads cannot cross hidden or unrelated project resources', async () => {
  for (const changes of [{ hidden: true }, { id: 'g-p-other' }, { gizmo_type: 'gpt' }, { current_user_permission: { can_read: false } }]) {
    const h = setup(); h.setProject(project(changes));
    await assert.rejects(h.api.connectionGet(scoped));
    assert.equal(h.operations.length, 0);
  }
});

test('provider metadata mismatch cannot be used to authorize a different connector', async () => {
  const h = setup(); h.setConnector(connector({ id: 'unrelated-connector' }));
  await assert.rejects(h.api.connectionGet(scoped), code('INVALID_RESPONSE'));
});

test('connection reads revalidate the account identity for each operation', async () => {
  const h = setup();
  await h.api.connectionGet(scoped); await h.api.connectionGet(scoped);
  assert.equal(h.calls.filter(call => call.route.includes('/accounts/check/')).length, 2);
  const request = h.transport.request;
  h.transport.request = async (...args) => { const value = await request(...args); h.setAuth(authentication('other-user')); return value; };
  await assert.rejects(h.api.connectionGet(scoped), code('AUTH_IDENTITY_CHANGED'));
});

test('connection status never selects a different, hidden or implicit account link', async () => {
  for (const value of [link({ id: 'other-link' }), link({ connector_id: 'other-connector' }), link({ hidden: true }), link({ visibility: 'HIDDEN' })]) {
    const h = setup({ links: [value] });
    await assert.rejects(h.api.connectionStatus({ ...scoped, linkId }), code('CONNECTION_UNAVAILABLE'));
  }
  const h = setup();
  await assert.rejects(h.api.connectionStatus({ ...scoped, linkId: 'implicit_link::example' }), code('INVALID_ARGUMENT'));
  assert.equal(h.mutations.length, 0);
});

test('OAuth start checks project write permission before an authorization request', async t => {
  const { stateFile } = await files(t), h = setup();
  h.setProject(project({ current_user_permission: { can_read: true, can_write: false } }));
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(h.mutations.length, 0);
});

test('OAuth start rejects form-dependent setup instead of guessing input fields', async t => {
  const { stateFile } = await files(t), h = setup();
  h.setConnector(connector({ link_params_schema: { type: 'object', properties: { host: { type: 'string' } } } }));
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }), code('NATIVE_HANDOFF_REQUIRED'));
  assert.equal(h.mutations.length, 0);
});

test('OAuth start remains authorization-required and writes only a private binding journal', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  const result = await h.api.connectionStart({ ...scoped, stateFile, actionNames: ['read', 'read'], requestedScopes: ['files.read'] });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.authorizationUrl, authorizationUrl);
  assert.equal((await lstat(stateFile)).mode & 0o777, 0o600);
  const journal = await readFile(stateFile, 'utf8');
  assert.doesNotMatch(journal, /SECRET_CALLBACK_CODE|accessToken/);
  assert.equal(JSON.parse(journal).oauthStateSha256, createHash('sha256').update(authState).digest('hex'));
  const request = h.mutations.find(call => call.route.endsWith('/links/oauth'));
  assert.equal(request.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  assert.equal(request.options.headers['X-Codex-Surface'], 'connector_setup');
  assert.equal(request.options.body.connector_id, connectorId);
  assert.equal(request.options.body.callback_url, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.deepEqual(request.options.body.action_names, ['read']);
  assert.deepEqual(request.options.body.requested_scopes, ['files.read']);
  assert.equal(Object.hasOwn(request.options.body, 'project_id'), false);
  assert.match(request.options.body.post_auth_url, /product-sku=CODEX/);
  assert.equal(h.mutations.length, 1);
});

test('unknown OAuth initiation outcome never replays the authorization request', async t => {
  const { stateFile } = await files(t), h = setup(new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' }));
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }));
  assert.equal((await h.api.connectionStart({ ...scoped, stateFile })).status, 'outcome_unknown');
  assert.equal(h.mutations.filter(call => call.route.endsWith('/links/oauth')).length, 1);
});

test('an existing journal is not overwritten by another start', async t => {
  const { stateFile } = await files(t), contents = '{"private":"existing"}\n', h = setup();
  await writeFile(stateFile, contents, { mode: 0o600 });
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }));
  assert.equal(await readFile(stateFile, 'utf8'), contents);
  assert.equal(h.mutations.length, 0);
});

test('journal symlinks cannot be used for OAuth state or operation reads', async t => {
  const { root, stateFile } = await files(t), target = path.join(root, 'actual.json'), h = setup();
  await writeFile(target, '{"private":"existing"}', { mode: 0o600 }); await symlink(target, stateFile);
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }));
  await assert.rejects(h.api.connectionOperation({ accountId, stateFile }));
  assert.equal(h.mutations.length, 0);
});

test('broadly readable operation journals cannot be resumed', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile }); await chmod(stateFile, 0o644);
  await assert.rejects(h.api.connectionOperation({ accountId, stateFile }));
  assert.equal(h.mutations.length, 1);
});

test('TOS reads project-scoped blurbs and policy links without accepting terms', async () => {
  const h = setup({ blurbs: [{ title: 'Provider terms', description: 'Review before continuing.', opaque: 'SECRET_VALUE' }] });
  h.setConnector(connector({ branding: { privacy_policy: 'https://example.test/privacy', terms_of_service: 'https://example.test/terms' } }));
  const result = await h.api.connectionTos(scoped);
  assert.deepEqual(result.blurbs, [{ title: 'Provider terms', description: 'Review before continuing.' }]);
  assert.equal(result.privacyPolicy, 'https://example.test/privacy'); assert.equal(result.termsOfService, 'https://example.test/terms');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_VALUE/);
  const request = h.operations.find(call => call.route.endsWith('/tos'));
  assert.equal(request.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  assert.equal(request.options.headers['X-Codex-Surface'], 'connector_setup');
  assert.equal(h.mutations.length, 0);
});

test('malformed TOS data is rejected instead of passing opaque provider payloads', async () => {
  for (const response of [{ blurbs: {} }, { blurbs: [{ title: {}, description: 'Text' }] }, { blurbs: [{ title: 'Title', description: 'Text\u0000private' }] }]) {
    await assert.rejects(setup(response).api.connectionTos(scoped), code('INVALID_RESPONSE'));
  }
});

test('OAuth writes the starting journal phase before issuing its mutation', async t => {
  const { stateFile } = await files(t);
  const h = setup(async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.phase, 'starting'); assert.equal(state.operation, 'oauth');
    assert.equal(state.context.projectId, projectId); assert.equal(state.identity.accountId, accountId);
    return { redirect_url: authorizationUrl };
  });
  assert.equal((await h.api.connectionStart({ ...scoped, stateFile })).status, 'authorization_required');
});

test('resuming an authorization handoff does not issue a second authorization request', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  const first = await h.api.connectionStart({ ...scoped, stateFile });
  const second = await h.api.connectionStart({ ...scoped, stateFile });
  assert.equal(second.operationId, first.operationId); assert.equal(second.authorizationUrl, authorizationUrl);
  assert.equal(h.mutations.length, 1);
});

test('authorization without a unique OAuth state cannot enable callback submission', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: 'https://provider.example/oauth?client_id=example' });
  const result = await h.api.connectionStart({ ...scoped, stateFile });
  assert.equal(result.status, 'native_handoff_required'); assert.equal(result.canSubmitCallback, false);
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('OAUTH_SUBMISSION_UNAVAILABLE'));
  assert.equal(h.mutations.length, 1);
});

test('a matching callback is submitted once and requires a fresh exact active link', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl }, { link: link({ access_token: 'SECRET_TOKEN' }) }, { links: [link()] });
  await h.api.connectionStart({ ...scoped, stateFile });
  const result = await h.api.connectionComplete({ stateFile, accountId, redirectFile: '-', input: input(`${callbackUrl}\n`) });
  assert.equal(result.status, 'connected'); assert.equal(result.connected, true); assert.equal(result.linkId, linkId);
  assert.equal(result.canReplayMutation, false);
  const callback = h.mutations.find(call => call.route.endsWith('/oauth/callback'));
  assert.deepEqual(callback.options.body, { full_redirect_url: callbackUrl });
  assert.equal(callback.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_CALLBACK_CODE|SECRET_TOKEN|signed-state-with-private-entropy/);
  assert.doesNotMatch(await readFile(stateFile, 'utf8'), /SECRET_CALLBACK_CODE|SECRET_TOKEN/);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'verified');
});

test('callback state mismatch is rejected before any callback mutation', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionComplete({ stateFile, accountId, redirectFile: '-', input: input(callbackUrl.replace(authState, 'another-state')) }), code('OAUTH_STATE_MISMATCH'));
  assert.equal(h.mutations.length, 1);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'authorization_required');
});

test('callback checks refuse unrecognized origins, duplicate states, fragments and invalid UTF-8', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  for (const value of [
    `https://attacker.example/callback?code=SECRET&state=${authState}`,
    `${callbackUrl}&state=duplicate`, `${callbackUrl}#token=SECRET`,
    Buffer.from([0xff]),
  ]) {
    const stream = typeof value === 'string' ? input(value) : Readable.from([value]);
    await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: stream }), code('PRIVATE_INPUT_INVALID'));
  }
  assert.equal(h.mutations.length, 1);
});

test('provider cancellation records cancelled state without submitting the callback', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  const result = await h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(`https://chatgpt.com/connector_platform_oauth_redirect?state=${authState}&error=access_denied`) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.connected, false); assert.equal(h.mutations.length, 1);
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('OAUTH_SUBMISSION_UNAVAILABLE'));
});

test('another authenticated user cannot complete a pending connection', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile }); h.setAuth(authentication('user-2'));
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.mutations.length, 1);
});

test('another selected account cannot resume or inspect the connection journal', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionOperation({ accountId: 'other-account', stateFile }), code('ACCOUNT_CHANGED'));
  await assert.rejects(h.api.connectionComplete({ accountId: 'other-account', stateFile, redirectFile: '-', input: input(callbackUrl) }), code('ACCOUNT_CHANGED'));
  assert.equal(h.mutations.length, 1);
});

test('membership changes during the handoff cannot be confused with the original user', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  const changed = membership(); changed.accounts.acct.account.account_user_id = 'different-membership'; h.setMembership(changed);
  await assert.rejects(h.api.connectionOperation({ accountId, stateFile }), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.mutations.length, 1);
});

test('callback phase is durably marked before submission and unknown delivery cannot be replayed', async t => {
  const { stateFile } = await files(t);
  const h = setup({ redirect_url: authorizationUrl }, async () => {
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'completing');
    throw new DotError('NETWORK_ERROR', 'unknown delivery', { delivery: 'unknown' });
  });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('NETWORK_ERROR'));
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('OAUTH_SUBMISSION_UNAVAILABLE'));
  const status = await h.api.connectionOperation({ accountId, stateFile });
  assert.equal(status.status, 'outcome_unknown'); assert.equal(status.canReplayMutation, false);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('accepted callback can be reconciled after readback fails without resubmission', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl }, { link: link() }, new DotError('HTTP_ERROR', 'edge', { status: 403 }), { links: [link()] });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('HTTP_ERROR'));
  const state = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(state.phase, 'callback_received'); assert.equal(state.linkId, linkId);
  const result = await h.api.connectionOperation({ accountId, stateFile });
  assert.equal(result.status, 'connected'); assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('inactive callback link stays pending until a fresh active link is actually visible', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl }, { link: link() }, { links: [link({ auth_status: 'EXPIRED' })] }, { links: [link()] });
  await h.api.connectionStart({ ...scoped, stateFile });
  const first = await h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) });
  assert.equal(first.connected, false); assert.equal(first.status, 'verification_pending');
  assert.equal((await h.api.connectionOperation({ accountId, stateFile })).connected, true);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('a no-auth connection requires exact active-link readback and a durable receipt', async t => {
  const { stateFile } = await files(t), h = setup({ id: linkId }, { links: [link({ auth_type: 'NONE' })] });
  h.setConnector(connector({ supported_auth: [{ type: 'NONE' }] }));
  const result = await h.api.connectionNoAuth({ ...scoped, stateFile });
  assert.equal(result.connected, true); assert.equal(result.linkId, linkId);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'verified');
  const request = h.mutations.find(call => call.route.endsWith('/links/noauth'));
  assert.equal(request.options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  assert.equal(request.options.body.connector_id, connectorId); assert.deepEqual(request.options.body.action_names, []);
  assert.equal(h.mutations.length, 1);
});

test('no-auth receipt survives a readback edge error and reconciles without a second creation', async t => {
  const { stateFile } = await files(t), h = setup({ id: linkId }, new DotError('HTTP_ERROR', 'edge', { status: 403 }), { links: [link({ auth_type: 'NONE' })] });
  h.setConnector(connector({ supported_auth: [{ type: 'NONE' }] }));
  await assert.rejects(h.api.connectionNoAuth({ ...scoped, stateFile }), code('HTTP_ERROR'));
  const state = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(state.phase, 'link_created'); assert.equal(state.linkId, linkId);
  assert.equal((await h.api.connectionOperation({ accountId, stateFile })).connected, true);
  assert.equal(h.mutations.length, 1);
});

test('the closed project-provider wrapper does not offer unsupported no-auth', async t => {
  const { stateFile } = await files(t), h = setup();
  await assert.rejects(h.api.connectionNoAuth({ ...scoped, stateFile }), code('UNSUPPORTED_AUTH'));
  assert.equal(h.mutations.length, 0);
});

test('reauthorization retains the existing exact link and explicit scopes', async t => {
  const { stateFile } = await files(t), h = setup({ links: [link()] }, { redirect_url: authorizationUrl }, { link: link() }, { links: [link()] });
  const start = await h.api.connectionReauthorize({ ...scoped, linkId, stateFile, requestedScopes: ['files.read'] });
  assert.equal(start.status, 'authorization_required'); assert.equal(start.linkId, linkId);
  const request = h.mutations.find(call => call.route.endsWith('/oauth/reauth'));
  assert.equal(request.options.body.link_id, linkId); assert.deepEqual(request.options.body.requested_scopes, ['files.read']);
  assert.equal(Object.hasOwn(request.options.body, 'link_params'), false);
  const result = await h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) });
  assert.equal(result.connected, true); assert.equal(result.linkId, linkId);
});

test('reauthorization cannot accept a callback for a replacement link', async t => {
  const { stateFile } = await files(t), h = setup({ links: [link()] }, { redirect_url: authorizationUrl }, { link: link({ id: 'different-link' }) });
  await h.api.connectionReauthorize({ ...scoped, linkId, stateFile });
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('IDENTITY_MISMATCH'));
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).linkId, linkId);
});

test('journal product scope, provider and account identity cannot be edited into another flow', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  const baseline = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const change of [
    value => { value.productSku = 'CODEX'; },
    value => { value.context.connectorId = 'different-connector'; },
    value => { value.context.connectorType = 'other-provider'; },
    value => { value.oauthStateSha256 = 'invalid'; },
  ]) {
    const value = structuredClone(baseline); change(value); await writeFile(stateFile, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(h.api.connectionOperation({ accountId, stateFile }), code('INVALID_STATE'));
  }
  assert.equal(h.mutations.length, 1);
});

test('private callback files reject symlinks and readable-by-others permissions', async t => {
  const { root, stateFile, callbackFile } = await files(t), target = path.join(root, 'actual-callback.txt'), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  await writeFile(target, callbackUrl, { mode: 0o600 }); await symlink(target, callbackFile);
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: callbackFile }), code('INVALID_STATE'));
  await rm(callbackFile); await writeFile(callbackFile, callbackUrl, { mode: 0o644 });
  // Exercise unsafe permissions even when the test runner uses a private umask.
  await chmod(callbackFile, 0o644); assert.equal((await lstat(callbackFile)).mode & 0o777, 0o644);
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: callbackFile }), code('INVALID_STATE'));
  assert.equal(h.mutations.length, 1);
});

test('missing operation journals produce a typed error without contacting the service', async t => {
  const { stateFile } = await files(t), h = setup();
  await assert.rejects(h.api.connectionOperation({ accountId, stateFile }), code('INVALID_STATE'));
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('INVALID_STATE'));
  assert.equal(h.calls.length, 0);
});

test('permission changes after metadata preflight block OAuth before its mutation', async t => {
  const { stateFile } = await files(t), h = setup(), request = h.transport.request;
  let changed = false;
  h.transport.request = async (...args) => {
    const result = await request(...args);
    if (!changed && args[1] === `${connectorRoot}/${connectorId}`) {
      changed = true; h.setProject(project({ current_user_permission: { can_read: true, can_write: false } }));
    }
    return result;
  };
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(h.mutations.length, 0);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'prepared');
});

test('a callback cannot be submitted after project write permission is revoked', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile });
  h.setProject(project({ current_user_permission: { can_read: true, can_write: false } }));
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(h.mutations.length, 1);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'authorization_required');
});

test('identity change after callback submission is explicitly an unknown outcome and cannot be replayed', async t => {
  const { stateFile } = await files(t);
  const h = setup({ redirect_url: authorizationUrl }, () => { h.setAuth(authentication('different-user')); return { link: link() }; });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), error => error.code === 'AUTH_IDENTITY_CHANGED' && error.details.delivery === 'unknown');
  h.setAuth(authentication());
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('OAUTH_SUBMISSION_UNAVAILABLE'));
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('a second process cannot submit a callback while the first holds the operation lock', async t => {
  const { stateFile } = await files(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const h = setup({ redirect_url: authorizationUrl }, async () => { enter(); return pending; }, { links: [link()] });
  await h.api.connectionStart({ ...scoped, stateFile });
  const first = h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) });
  await entered;
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), code('STATE_BUSY'));
  release({ link: link() });
  assert.equal((await first).connected, true);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('the journal pins requested scope and provider choices across a resumed authorization', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl });
  await h.api.connectionStart({ ...scoped, stateFile, requestedScopes: ['files.read'] });
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile, requestedScopes: ['files.write'] }), code('INVALID_STATE'));
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile, connectorType: 'slack', requestedScopes: ['files.read'] }), code('INVALID_STATE'));
  assert.equal(h.mutations.length, 1);
});

test('workspace policy denial blocks project-provider setup even with native project write permission', async t => {
  const { stateFile } = await files(t), h = setup({ permissions: [] });
  const value = membership(); value.accounts.acct.account.structure = 'workspace'; value.accounts.acct.account.account_user_id = 'user-1'; h.setMembership(value);
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(h.mutations.length, 0);
});

test('authorization input validation happens before any journal or API write', async t => {
  const { stateFile } = await files(t), h = setup();
  for (const options of [{ actionNames: 'all' }, { actionNames: [''] }, { requestedScopes: ['scope\nsecret'] }, { requestedScopes: new Array(101).fill('scope') }]) {
    await assert.rejects(h.api.connectionStart({ ...scoped, stateFile, ...options }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
  await assert.rejects(lstat(stateFile), { code: 'ENOENT' });
});

test('a failed authorization receipt write creates a private recoverable journal without replay', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl }, { link: link() }, { links: [link()] });
  const save = h.api._save.bind(h.api);
  h.api._save = async (file, value) => { if (value.phase === 'authorization_required') throw new DotError('WRITE_FAILED', 'injected disk failure'); return save(file, value); };
  let recoveryFile;
  await assert.rejects(h.api.connectionStart({ ...scoped, stateFile }), error => {
    assert.equal(error.code, 'CONNECTION_RECEIPT_NOT_SAVED'); assert.equal(error.details.delivery, 'received');
    assert.equal(error.details.canReplayMutation, false); recoveryFile = error.details.recoveryStateFile;
    assert.doesNotMatch(JSON.stringify(error), /signed-state-with-private-entropy|SECRET_CALLBACK_CODE/);
    return typeof recoveryFile === 'string';
  });
  assert.equal((await lstat(recoveryFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(recoveryFile, 'utf8')).phase, 'authorization_required');
  h.api._save = save;
  assert.equal((await h.api.connectionStart({ ...scoped, stateFile })).status, 'outcome_unknown');
  const result = await h.api.connectionComplete({ accountId, stateFile: recoveryFile, redirectFile: '-', input: input(callbackUrl) });
  assert.equal(result.connected, true);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/links/oauth')).length, 1);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('a failed callback receipt write preserves its exact link in a recovery journal', async t => {
  const { stateFile } = await files(t), h = setup({ redirect_url: authorizationUrl }, { link: link() }, { links: [link()] });
  await h.api.connectionStart({ ...scoped, stateFile });
  const save = h.api._save.bind(h.api);
  h.api._save = async (file, value) => { if (value.phase === 'callback_received') throw new DotError('WRITE_FAILED', 'injected disk failure'); return save(file, value); };
  let recoveryFile;
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) }), error => {
    assert.equal(error.code, 'CONNECTION_RECEIPT_NOT_SAVED'); assert.equal(error.details.linkId, linkId);
    assert.equal(error.details.delivery, 'received'); recoveryFile = error.details.recoveryStateFile;
    return typeof recoveryFile === 'string';
  });
  const recovered = JSON.parse(await readFile(recoveryFile, 'utf8'));
  assert.equal(recovered.phase, 'callback_received'); assert.equal(recovered.linkId, linkId);
  assert.equal(Object.hasOwn(recovered, 'authorizationUrl'), false);
  assert.doesNotMatch(JSON.stringify(recovered), /SECRET_CALLBACK_CODE/);
  h.api._save = save;
  assert.equal((await h.api.connectionOperation({ accountId, stateFile: recoveryFile })).connected, true);
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('cancellation immediately after callback delivery is classified as unknown without replay', async t => {
  const { stateFile } = await files(t), controller = new AbortController();
  const h = setup({ redirect_url: authorizationUrl }, () => { controller.abort(); return { link: link() }; });
  await h.api.connectionStart({ ...scoped, stateFile });
  await assert.rejects(h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl), signal: controller.signal }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown' && error.details.canReplayMutation === false);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'completing');
  assert.equal(h.mutations.filter(call => call.route.endsWith('/oauth/callback')).length, 1);
});

test('reauthorization and no-auth reject creation-only or OAuth-only parameter combinations', async t => {
  const { stateFile } = await files(t), h = setup();
  await assert.rejects(h.api.connectionReauthorize({ ...scoped, stateFile, linkId, actionNames: ['read'] }), code('INVALID_ARGUMENT'));
  await assert.rejects(h.api.connectionNoAuth({ ...scoped, stateFile, requestedScopes: ['read'] }), code('INVALID_ARGUMENT'));
  await assert.rejects(h.api.connectionNoAuth({ ...scoped, stateFile, actionNames: ['read'] }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('repeating a verified setup freshly checks the link instead of returning stale connected status', async t => {
  for (const mode of ['noauth', 'oauth', 'reauthorize']) {
    const { stateFile } = await files(t);
    const expired = { links: [link({ auth_status: 'REAUTH_REQUIRED', auth_type: mode === 'noauth' ? 'NONE' : 'OAUTH' })] };
    const responses = mode === 'noauth'
      ? [{ id: linkId }, { links: [link({ auth_type: 'NONE' })] }, expired]
      : [...(mode === 'reauthorize' ? [{ links: [link()] }] : []), { redirect_url: authorizationUrl }, { link: link() }, { links: [link()] }, expired];
    const h = setup(...responses);
    if (mode === 'noauth') h.setConnector(connector({ supported_auth: [{ type: 'NONE' }] }));
    const method = mode === 'noauth' ? 'connectionNoAuth' : mode === 'oauth' ? 'connectionStart' : 'connectionReauthorize';
    const options = { ...scoped, stateFile, ...(mode === 'reauthorize' ? { linkId } : {}) };
    const initial = await h.api[method](options);
    const verified = mode === 'noauth' ? initial : await h.api.connectionComplete({ accountId, stateFile, redirectFile: '-', input: input(callbackUrl) });
    assert.equal(verified.connected, true);
    const repeated = await h.api[method](options);
    assert.equal(repeated.connected, false); assert.equal(repeated.status, 'verification_pending');
    assert.equal(repeated.linkId, linkId);
    const route = mode === 'noauth' ? '/links/noauth' : mode === 'oauth' ? '/links/oauth' : '/links/oauth/reauth';
    assert.equal(h.mutations.filter(call => call.route.endsWith(route)).length, 1);
  }
});

test('default-link status returns the newer exact accessible-link auth state', async () => {
  const h = setup({ link: link() }, { links: [link({ auth_status: 'REAUTH_REQUIRED' })] });
  const result = await h.api.connectionStatus(scoped);
  assert.equal(result.connected, false); assert.equal(result.link.id, linkId);
  assert.equal(result.link.auth_status, 'REAUTH_REQUIRED');
  assert.equal(h.operations.filter(call => call.route.endsWith('/links/list_accessible')).length, 1);
  assert.equal(h.mutations.length, 0);
});

test('reauthorization reuses stored form configuration without requiring creation fields again', async t => {
  const { stateFile } = await files(t), h = setup({ links: [link()] }, { redirect_url: authorizationUrl });
  h.setConnector(connector({ link_params_schema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] } }));
  const result = await h.api.connectionReauthorize({ ...scoped, stateFile, linkId });
  assert.equal(result.status, 'authorization_required'); assert.equal(result.linkId, linkId);
  const request = h.mutations.find(call => call.route.endsWith('/oauth/reauth'));
  assert.equal(request.options.body.link_id, linkId);
  assert.equal(Object.hasOwn(request.options.body, 'link_params'), false);
  assert.equal(h.mutations.length, 1);
});

test('creation stops if a properties-only form appears at the final fresh metadata check', async t => {
  for (const mode of ['oauth', 'noauth']) {
    const { stateFile } = await files(t), h = setup(), request = h.transport.request;
    const authType = mode === 'oauth' ? 'OAUTH' : 'NONE';
    h.setConnector(connector({ supported_auth: [{ type: authType }] }));
    let metadataReads = 0;
    h.transport.request = async (...args) => {
      const result = await request(...args);
      if (args[0] === 'GET' && args[1] === `${connectorRoot}/${connectorId}` && ++metadataReads === 4) {
        return connector({ supported_auth: [{ type: authType }], link_params_schema: { type: 'object', properties: { host: { type: 'string' } }, required: [] } });
      }
      return result;
    };
    const method = mode === 'oauth' ? 'connectionStart' : 'connectionNoAuth';
    await assert.rejects(h.api[method]({ ...scoped, stateFile }), code('NATIVE_HANDOFF_REQUIRED'));
    assert.equal(h.mutations.length, 0);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'prepared');
  }
});
