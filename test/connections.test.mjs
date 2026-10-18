import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DotConnections } from '../src/connections.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';

const connector = { id: 'connector_1', name: 'Example', description: 'Example app', status: 'ENABLED', supported_auth: [{ type: 'OAUTH' }, { type: 'API_KEY' }, { type: 'NONE' }] };
const link = { id: 'link_1', connector_id: 'connector_1', name: 'Account', auth_type: 'OAUTH', auth_status: 'ACTIVE' };
const code = expected => error => error.code === expected;
function setup(...responses) {
  const calls = [];
  const connections = new DotConnections({ transport: { async request(...args) {
    calls.push(args);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  } } });
  return { connections, calls };
}
function input(text) { return Readable.from([Buffer.from(text)]); }

test('connector health is a bounded projection with no credential fields', async () => {
  const { connections, calls } = setup({ ...connector, credentials: { key: 'secret' }, link_params_schema: { required: ['host'] } },
    { link: { ...link, token: 'secret', configuration: { password: 'secret' } } });
  const result = await connections.status({ connectorId: connector.id });
  assert.equal(result.connected, true);
  assert.deepEqual(result.connector.supportedAuth, ['OAUTH', 'API_KEY', 'NONE']);
  assert.deepEqual(result.connector.requiredLinkParams, ['host']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(calls[0][1], '/backend-api/aip/connectors/connector_1');
  assert.equal(calls[1][1], '/backend-api/aip/connectors/connector_1/link');
});

test('an absent link and disabled connector are not reported connected', async () => {
  const first = setup(connector, { link: null });
  assert.equal((await first.connections.status({ connectorId: connector.id })).connected, false);
  const second = setup({ ...connector, status: 'DISABLED_BY_ADMIN' }, { link });
  assert.equal((await second.connections.status({ connectorId: connector.id })).connected, false);
});

test('specific account health checks the exact connector and link', async () => {
  const { connections, calls } = setup(connector, { links: [link, { ...link, id: 'link_2' }] });
  const result = await connections.status({ connectorId: connector.id, linkId: 'link_2' });
  assert.equal(result.link.id, 'link_2');
  assert.deepEqual(calls[1][2].body, { principals: [], link_refresh_strategy: 'NONE' });
});

test('OAuth starts with the browser callback and remains pending', async () => {
  const { connections, calls } = setup(connector, { redirect_url: 'https://provider.example/oauth?client_id=example&state=opaque' });
  const result = await connections.startOAuth({ connectorId: connector.id, actionNames: ['read', 'read'], requestedScopes: ['files.read'] });
  assert.equal(result.status, 'authorization_required');
  assert.equal(result.authorizationUrl, 'https://provider.example/oauth?client_id=example&state=opaque');
  assert.equal(calls.length, 2);
  const body = calls[1][2].body;
  assert.equal(body.connector_id, connector.id);
  assert.equal(body.callback_url, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.deepEqual(body.action_names, ['read']);
  assert.deepEqual(body.requested_scopes, ['files.read']);
  assert.match(body.install_attempt_id, /^[0-9a-f-]{36}$/);
  assert.equal(new URL(body.post_auth_url).origin, 'https://chatgpt.com');
  assert.equal(calls[1][2].headers['X-Codex-Surface'], 'connector_setup');
});

test('OAuth refuses unsafe authorization URLs without following them', async () => {
  for (const redirect_url of ['http://provider.example/auth', 'https://user:pass@provider.example/auth', 'javascript:alert(1)', 'https://provider.example/auth?access_token=secret', 'https://provider.example/auth#access_token=secret']) {
    const { connections, calls } = setup(connector, { redirect_url });
    await assert.rejects(connections.startOAuth({ connectorId: connector.id }), code('INVALID_RESPONSE'));
    assert.equal(calls.length, 2);
  }
});

test('unsupported, disabled, and missing connection parameters stop before writes', async () => {
  for (const [metadata, expected] of [
    [{ ...connector, status: 'DISABLED_BY_ADMIN' }, 'CONNECTION_UNAVAILABLE'],
    [{ ...connector, supported_auth: [{ type: 'NONE' }] }, 'UNSUPPORTED_AUTH'],
    [{ ...connector, link_params_schema: { required: ['host'] } }, 'INVALID_ARGUMENT']
  ]) {
    const { connections, calls } = setup(metadata);
    await assert.rejects(connections.startOAuth({ connectorId: connector.id }), code(expected));
    assert.equal(calls.length, 1);
  }
});

test('reauthorization targets an accessible explicit OAuth link', async () => {
  const { connections, calls } = setup(connector, { links: [link] }, { redirect_url: 'https://provider.example/oauth?state=opaque' });
  const result = await connections.reauthorize({ connectorId: connector.id, linkId: link.id, requestedScopes: ['read'] });
  assert.equal(result.status, 'authorization_required');
  assert.equal(calls[2][1], '/backend-api/aip/connectors/links/oauth/reauth');
  assert.deepEqual(calls[2][2].body, { callback_url: 'https://chatgpt.com/connector_platform_oauth_redirect', link_id: link.id,
    post_auth_url: calls[2][2].body.post_auth_url, requested_scopes: ['read'] });
});

test('reauthorization reuses existing configuration when creation requires link parameters', async () => {
  const metadata = { ...connector, link_params_schema: { type: 'object', required: ['hostname'] } };
  const { connections, calls } = setup(metadata, { links: [link] }, { redirect_url: 'https://provider.example/oauth?state=opaque' });
  const result = await connections.reauthorize({ connectorId: connector.id, linkId: link.id });
  assert.equal(result.status, 'authorization_required');
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1], '/backend-api/aip/connectors/links/oauth/reauth');
  assert.equal(Object.hasOwn(calls[2][2].body, 'link_params'), false);
});

test('reauthorization and unlink reject other connectors, hidden and implicit links', async () => {
  for (const badLink of [{ ...link, connector_id: 'other' }, { ...link, visibility: 'HIDDEN' }]) {
    const { connections, calls } = setup({ links: [badLink] });
    await assert.rejects(connections.unlink({ connectorId: connector.id, linkId: link.id }), code('CONNECTION_UNAVAILABLE'));
    assert.equal(calls.length, 1);
  }
  const { connections, calls } = setup();
  await assert.rejects(connections.unlink({ connectorId: connector.id, linkId: 'implicit_link::example' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('unlink affects only the selected accessible account connection', async () => {
  const { connections, calls } = setup({ links: [link] }, { completed: true });
  assert.deepEqual(await connections.unlink({ connectorId: connector.id, linkId: link.id }), { status: 'unlinked', connectorId: connector.id, linkId: link.id });
  assert.equal(calls[1][0], 'DELETE');
  assert.equal(calls[1][1], '/backend-api/aip/connectors/links/link_1');
  assert.equal(calls[1][2].headers['X-Codex-Surface'], 'settings');
});

test('OAuth callback is read privately and only projected account fields are returned', async () => {
  const secretUrl = 'https://chatgpt.com/connector_platform_oauth_redirect?code=SECRET_CODE&state=SIGNED_STATE';
  const { connections, calls } = setup({ link: { ...link, access_token: 'SECRET_TOKEN' } });
  const result = await connections.completeOAuth({ connectorId: connector.id, redirectFile: '-', input: input(`${secretUrl}\n`) });
  assert.equal(result.status, 'callback_accepted');
  assert.deepEqual(calls[0][2].body, { full_redirect_url: secretUrl });
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

function setupSku(productSku, ...responses) {
  const calls = [];
  const transport = { async request(...args) { calls.push(args); const value = responses.shift(); if (value instanceof Error) throw value; return value; } };
  return { connections: new DotConnections({ transport }, { productSku }), calls, transport };
}

test('project connection scope is closed and preserves native canonical aliases', async () => {
  assert.throws(() => setupSku('TPP'), code('INVALID_ARGUMENT'));
  const actual = { ...connector, id: 'asdk_app_1' };
  const h = setupSku('CHATGPT_PROJECTS', actual, { redirect_url: 'https://provider.example/oauth?state=opaque' });
  await h.connections.startOAuth({ connectorId: 'connector_1' });
  assert.equal(h.calls[1][2].body.connector_id, 'asdk_app_1');
  assert.equal(new URL(h.calls[1][2].body.post_auth_url).hash.includes('product-sku=CODEX'), true);
  assert.ok(h.calls.every(call => call[2].headers['OAI-Product-Sku'] === 'CHATGPT_PROJECTS'));
  const mismatch = setupSku('CHATGPT_PROJECTS', { ...connector, id: 'asdk_app_other' });
  await assert.rejects(mismatch.connections.get({ connectorId: 'connector_1' }), code('INVALID_RESPONSE'));
});

test('project link status keeps exact link selection and blocking refresh with alias support', async () => {
  const h = setupSku('CHATGPT_PROJECTS', { ...connector, id: 'asdk_app_1' }, { links: [{ ...link, connector_id: 'asdk_app_1' }, { ...link, id: 'link_other' }] });
  const result = await h.connections.status({ connectorId: 'connector_1', linkId: 'link_1' });
  assert.equal(result.connected, true); assert.equal(result.link.id, 'link_1');
  assert.equal(h.calls[1][2].body.link_refresh_strategy, 'BLOCKING');
  assert.ok(h.calls.every(call => call[2].headers['OAI-Product-Sku'] === 'CHATGPT_PROJECTS'));
});

test('active auth alone is not a usable connection when hidden, implicit or admin-disabled', async () => {
  for (const value of [{ ...link, visibility: 'HIDDEN' }, { ...link, hidden: true }, { ...link, id: 'implicit_link::x' }, { ...link, connector_status: 'DISABLED_BY_ADMIN' }, { ...link, unavailable_reason: 'expired' }, { ...link, unavailable_reason: { code: 'unavailable', private: true } }]) {
    const h = setup(connector, { link: value });
    assert.equal((await h.connections.status({ connectorId: connector.id })).connected, false);
  }
});

test('even an active callback receipt still requires independent connection verification', async () => {
  for (const fields of [{}, { visibility: 'HIDDEN' }, { unavailable_reason: 'not_ready' }]) {
    const h = setupSku('CHATGPT_PROJECTS', { link: { ...link, ...fields } });
    const result = await h.connections.completeOAuth({ connectorId: connector.id, redirectFile: '-', input: input('https://chatgpt.com/connector_platform_oauth_redirect?code=private&state=opaque') });
    assert.equal(result.status, 'callback_accepted'); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][2].headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
  }
});

test('all project authentication mutations retain selected SKU and canonical server connector IDs', async () => {
  const actual = { ...connector, id: 'asdk_app_1' };
  const noauth = setupSku('CHATGPT_PROJECTS', actual, { id: 'new-link' });
  await noauth.connections.linkNoAuth({ connectorId: connector.id });
  assert.equal(noauth.calls[1][2].body.connector_id, actual.id);
  const reauth = setupSku('CHATGPT_PROJECTS', actual, { links: [{ ...link, connector_id: actual.id }] }, { redirect_url: 'https://provider.example/auth?state=opaque' });
  await reauth.connections.reauthorize({ connectorId: connector.id, linkId: link.id });
  assert.ok([...noauth.calls, ...reauth.calls].every(call => call[2].headers['OAI-Product-Sku'] === 'CHATGPT_PROJECTS'));
});

test('project connection guard prevents identity drift before a write and marks post-write uncertainty', async () => {
  let checks = 0, calls = 0;
  const first = new DotConnections({ transport: { async request() { calls++; return connector; } } }, {
    productSku: 'CHATGPT_PROJECTS', assertCurrent: async () => { if (++checks === 4) throw new DotError('ACCOUNT_CHANGED', 'changed'); }
  });
  await assert.rejects(first.linkNoAuth({ connectorId: connector.id }), code('ACCOUNT_CHANGED'));
  assert.equal(calls, 1);
  checks = 0; calls = 0;
  const second = new DotConnections({ transport: { async request() { calls++; return calls === 1 ? connector : { id: 'new-link' }; } } }, {
    productSku: 'CHATGPT_PROJECTS', assertCurrent: async () => { if (++checks === 5) throw new DotError('ACCOUNT_CHANGED', 'changed'); }
  });
  await assert.rejects(second.linkNoAuth({ connectorId: connector.id }), error => error.code === 'ACCOUNT_CHANGED' && error.details.delivery === 'unknown');
  assert.equal(calls, 2);
});

test('project scope cannot be used to disguise an account-wide unlink', async () => {
  const h = setupSku('CHATGPT_PROJECTS');
  await assert.rejects(h.connections.unlink({ connectorId: connector.id, linkId: link.id }), code('UNSUPPORTED_SCOPE'));
  assert.equal(h.calls.length, 0);
});

test('callback rejects unrecognized redirects, duplicate state, and provider cancellation', async () => {
  for (const [url, expected] of [
    ['https://attacker.example/?code=secret&state=s', 'INVALID_ARGUMENT'],
    ['https://chatgpt.com/connector_platform_oauth_redirect?state=a&state=b', 'INVALID_ARGUMENT'],
    ['https://chatgpt.com/connector_platform_oauth_redirect?state=a&error=access_denied', 'OAUTH_CANCELLED'],
    ['https://chatgpt.com/connector_platform_oauth_redirect?code=secret', 'INVALID_ARGUMENT']
  ]) {
    const { connections, calls } = setup();
    await assert.rejects(connections.completeOAuth({ connectorId: connector.id, redirectFile: '-', input: input(url) }), code(expected));
    assert.equal(calls.length, 0);
  }
});

test('callback response must identify the requested connector', async () => {
  const { connections } = setup({ link: { ...link, connector_id: 'other' } });
  await assert.rejects(connections.completeOAuth({ connectorId: connector.id, redirectFile: '-', input: input('codex://connector/oauth_callback?code=secret&state=s') }), code('INVALID_RESPONSE'));
});

test('API keys come from explicit private input and never appear in results', async () => {
  const { connections, calls } = setup(connector, { id: 'new_link', token: 'SECRET_KEY' });
  const result = await connections.linkApiKey({ connectorId: connector.id, keyFile: '-', input: input('SECRET_KEY\n'), actionNames: ['read'] });
  assert.equal(calls[1][2].body.key, 'SECRET_KEY');
  assert.equal(calls[1][1], '/backend-api/aip/connectors/links/api_key');
  assert.deepEqual(result, { status: 'link_created', connectorId: connector.id, linkId: 'new_link' });
  assert.ok(!JSON.stringify(result).includes('SECRET_KEY'));
});

test('key files must be bounded regular UTF-8 files; symbolic links are refused', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dot-connection-'));
  try {
    const keyFile = path.join(directory, 'key');
    await writeFile(keyFile, 'PRIVATE_KEY\n', { mode: 0o600 });
    await symlink(keyFile, path.join(directory, 'symlink'));
    const valid = setup(connector, { id: 'new_link' });
    await valid.connections.linkApiKey({ connectorId: connector.id, keyFile });
    assert.equal(valid.calls[1][2].body.key, 'PRIVATE_KEY');
    const bad = setup();
    await assert.rejects(bad.connections.linkApiKey({ connectorId: connector.id, keyFile: path.join(directory, 'symlink') }), code('PRIVATE_INPUT_UNREADABLE'));
    await assert.rejects(bad.connections.linkApiKey({ connectorId: connector.id, keyFile: directory }), code('INVALID_ARGUMENT'));
    await writeFile(keyFile, Buffer.from([0xff]));
    await assert.rejects(bad.connections.linkApiKey({ connectorId: connector.id, keyFile }), code('INVALID_ARGUMENT'));
    assert.equal(bad.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private input is never accepted from an echoing terminal or as a direct key argument', async () => {
  const terminal = input('secret'); terminal.isTTY = true;
  const { connections, calls } = setup();
  await assert.rejects(connections.linkApiKey({ connectorId: connector.id, keyFile: '-', input: terminal }), code('INVALID_ARGUMENT'));
  await assert.rejects(connections.linkApiKey({ connectorId: connector.id, key: 'secret' }), code('INVALID_ARGUMENT'));
  await assert.rejects(connections.linkApiKey({ connectorId: connector.id, keyFile: '-', input: input('x'.repeat(65537)) }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('no-auth linking verifies advertised support and uses exact contract', async () => {
  const { connections, calls } = setup(connector, { id: 'new_link', secret: 'never return' });
  assert.deepEqual(await connections.linkNoAuth({ connectorId: connector.id }), { status: 'link_created', connectorId: connector.id, linkId: 'new_link' });
  assert.equal(calls[1][1], '/backend-api/aip/connectors/links/noauth');
  assert.deepEqual(calls[1][2].body.action_names, []);
  assert.equal(calls[1][2].body.connector_id, connector.id);
});

test('writes are not retried on transport errors', async () => {
  const failure = new DotError('NETWORK_ERROR', 'The API request failed.', { delivery: 'unknown' });
  const { connections, calls } = setup(connector, failure);
  await assert.rejects(connections.linkNoAuth({ connectorId: connector.id }), error => error === failure);
  assert.equal(calls.length, 2);
});

test('invalid IDs and malformed server metadata cannot reach mutations', async () => {
  const invalid = setup();
  await assert.rejects(invalid.connections.startOAuth({ connectorId: '../x' }), code('INVALID_ARGUMENT'));
  assert.equal(invalid.calls.length, 0);
  const mismatched = setup({ ...connector, id: 'another' });
  await assert.rejects(mismatched.connections.startOAuth({ connectorId: connector.id }), code('INVALID_RESPONSE'));
  assert.equal(mismatched.calls.length, 1);
  assert.throws(() => new DotConnections({}), TypeError);
});

test('an auth account change after preflight prevents a connector mutation', async () => {
  let authReads = 0, fetches = 0;
  const transport = new Transport({
    authLoader: async () => ({ accessToken: 'test-token', accountId: ++authReads <= 2 ? 'account_a' : 'account_b' }),
    fetchImpl: async () => { fetches++; return new Response(JSON.stringify(connector), { headers: { 'Content-Type': 'application/json' } }); }
  });
  const connections = new DotConnections({ transport });
  await assert.rejects(connections.linkNoAuth({ connectorId: connector.id }), code('ACCOUNT_CHANGED'));
  assert.equal(fetches, 1);
});

test('explicit expected accounts and absent account selectors fail before requests', async () => {
  for (const [accountId, expectedAccountId, expectedCode] of [
    ['account_a', 'account_b', 'ACCOUNT_CHANGED'], [null, undefined, 'AUTH_ACCOUNT_REQUIRED']
  ]) {
    let requests = 0;
    const connections = new DotConnections({ transport: { authLoader: async () => ({ accountId }), request: async () => { requests++; } } });
    await assert.rejects(connections.startOAuth({ connectorId: connector.id, expectedAccountId }), code(expectedCode));
    assert.equal(requests, 0);
  }
});

test('iCloud app-specific passwords cannot use the generic API-key route', async () => {
  const connectorId = 'connector_6a99cb6846448190875813bf1e8e5504';
  const { connections, calls } = setup({ ...connector, id: connectorId });
  await assert.rejects(connections.linkApiKey({ connectorId, keyFile: '-', input: input('private-key') }), code('UNSUPPORTED_AUTH'));
  assert.equal(calls.length, 1);
});
