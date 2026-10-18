import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DotConnectorAdmin, connectorPublicData } from '../src/connectors-admin.mjs';
import { Transport } from '../src/transport.mjs';
import { parseV4Args, prepareV4Options, runV4Command } from '../src/v4-commands.mjs';

const ROOT = '/backend-api/aip/connectors';
const connector = { id: 'connector-fixture', name: 'Fixture tool', connector_type: 'MCP', status: 'ENABLED',
  supported_auth: [{ type: 'API_KEY', header_scheme: { type: 'BEARER' } }],
  link_params_schema: { type: 'object', required: ['region'], properties: { region: { type: 'string' } } } };
const principal = 'user-fixture__account-fixture';
const key = 'synthetic-private-key-value';
const args = { serviceAccountUserId: principal, connectorId: connector.id, linkParams: { region: 'test-region' } };
const validPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const token = subject => `h.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.s`;

function setup(handler = call => call.method === 'GET' ? structuredClone(connector) : {}, extra = {}) {
  const calls = [];
  const transport = { authLoader: async () => ({ accountId: 'account-fixture', accessToken: token('person-fixture') }),
    request: async (method, route, options) => { const call = { method, route, ...options }; calls.push(call); return handler(call, calls.length); } };
  return { calls, transport, admin: new DotConnectorAdmin({ transport }, extra) };
}
async function fixture(t, bytes = `${key}\n`) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-service-account-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'key'); await writeFile(keyFile, bytes, { mode: 0o600 });
  return { directory, keyFile };
}
const code = expected => error => error?.code === expected && !JSON.stringify(error).includes(key);

test('service-account API-key setup sends the native request once after fresh connector validation', async t => {
  const file = await fixture(t), { admin, calls } = setup(() => structuredClone(connector));
  const result = await admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile, actionNames: ['search', 'search'], expectedAccountId: 'account-fixture' });
  assert.equal(calls.length, 2); assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].route, `${ROOT}/${connector.id}`);
  assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].route, `${ROOT}/service_accounts/links/api_key`);
  assert.deepEqual(calls[1].body, { connector_id: connector.id, name: connector.name, action_names: ['search'], key,
    link_params: { region: 'test-region' }, service_account_account_user_id: principal });
  assert.deepEqual(calls[1].headers, { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'connector_setup' });
  assert.ok(calls.every(call => call.expectedAccountId === 'account-fixture'));
  assert.deepEqual(result, { status: 'link_created', serviceAccountUserId: principal, connectorId: connector.id });
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('real CLI parsing and dispatch pass private stdin to the service-account operation', async () => {
  const { transport, calls } = setup();
  const parsed = parseV4Args('connector', ['service-account', 'api-key', principal, connector.id, '--key-file', '-', '--link-params', '{"region":"test-region"}', '--account', 'account-fixture']);
  assert.equal(parsed.keyFile, '-');
  const result = await runV4Command({ transport }, await prepareV4Options(parsed), { stdin: Readable.from([`${key}\n`]) });
  assert.equal(result.status, 'link_created'); assert.equal(calls[1].body.key, key); assert.equal(JSON.stringify(result).includes(key), false);
});

test('service-account key defaults to an empty action list and omits absent optional parameters', async t => {
  const file = await fixture(t), { admin, calls } = setup(() => ({ ...connector, link_params_schema: {} }));
  await admin.serviceAccountApiKey({ serviceAccountUserId: principal, connectorId: connector.id, keyFile: file.keyFile });
  assert.deepEqual(calls[1].body.action_names, []); assert.equal(Object.hasOwn(calls[1].body, 'link_params'), false);
  assert.equal(Object.hasOwn(calls[1].body, 'install_attempt_id'), false);
});

for (const [name, update, expected] of [
  ['wrong connector', { id: 'different-connector' }, 'INVALID_RESPONSE'],
  ['disabled connector', { status: 'DISABLED_BY_ADMIN' }, 'CONNECTION_UNAVAILABLE'],
  ['unavailable API-key auth', { supported_auth: [{ type: 'NONE' }] }, 'UNSUPPORTED_AUTH'],
]) test(`service-account setup refuses ${name} before writing`, async t => {
  const file = await fixture(t), { admin, calls } = setup(() => ({ ...connector, ...update }));
  await assert.rejects(admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile }), code(expected));
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
});

test('service-account key setup requires current link parameters and never retries uncertain writes', async t => {
  const file = await fixture(t), missing = setup();
  await assert.rejects(missing.admin.serviceAccountApiKey({ serviceAccountUserId: principal, connectorId: connector.id, keyFile: file.keyFile }), code('INVALID_ARGUMENT'));
  assert.equal(missing.calls.length, 1);
  const failure = new Error('synthetic transport failure'), h = setup(call => { if (call.method === 'GET') return connector; throw failure; });
  await assert.rejects(h.admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile }), error => error === failure);
  assert.equal(h.calls.length, 2);
});

test('service-account setup rejects a composite principal from another account before any request', async t => {
  const file = await fixture(t), { admin, calls } = setup();
  await assert.rejects(admin.serviceAccountApiKey({ ...args, serviceAccountUserId: 'user-fixture__other-account', keyFile: file.keyFile }), code('ACCOUNT_CHANGED'));
  assert.equal(calls.length, 0);
});

test('every service-account operation rejects a cross-account composite before network access', async () => {
  const h = setup(), common = { serviceAccountUserId: 'user-fixture__other-account', connectorId: connector.id, teamId: 'team-fixture', linkId: 'link-fixture' };
  for (const [method, extra] of [
    ['serviceAccountLinks', {}], ['serviceAccountOAuth', {}], ['serviceAccountNoAuth', {}],
    ['serviceAccountUnlink', { confirmLinkId: common.linkId }], ['serviceAccountConnections', {}],
    ['setServiceAccountConnection', { enabled: true }], ['setServiceAccountReadOnly', { readOnly: true }],
  ]) await assert.rejects(h.admin[method]({ ...common, ...extra }), code('ACCOUNT_CHANGED'));
  assert.equal(h.calls.length, 0);
});

test('service-account setup pins both account and login subject across read and write', async t => {
  const file = await fixture(t);
  for (const switchKind of ['account', 'subject']) {
    let reads = 0; const sent = [];
    const transport = new Transport({ authLoader: async () => ({ accountId: switchKind === 'account' && ++reads > 2 ? 'other-account' : 'account-fixture',
      accessToken: token(switchKind === 'subject' && ++reads > 2 ? 'other-person' : 'person-fixture') }), fetchImpl: async (url, options) => {
      sent.push(options.method); return new Response(JSON.stringify(connector), { headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(new DotConnectorAdmin({ transport }).serviceAccountApiKey({ ...args, keyFile: file.keyFile }), error => ['ACCOUNT_CHANGED', 'AUTH_IDENTITY_CHANGED'].includes(error?.code));
    assert.deepEqual(sent, ['GET']);
  }
});

test('service-account preflight guard is checked again immediately before the mutation', async t => {
  const file = await fixture(t); let current = true;
  const { admin, calls } = setup(() => { current = false; return connector; }, { assertCurrent: () => { if (!current) throw new Error('selected principal changed'); } });
  await assert.rejects(admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile }), /selected principal changed/);
  assert.equal(calls.length, 1);
});

for (const [name, bytes] of [['empty', ''], ['oversize', 'x'.repeat(65537)], ['invalid UTF8', Buffer.from([0xff])], ['embedded newline', `${key}\nnext`], ['embedded carriage return', `${key}\rnext`], ['NUL', `${key}\0next`]]) {
  test(`service-account setup rejects ${name} credential input without a request`, async t => {
    const file = await fixture(t, bytes), { admin, calls } = setup();
    await assert.rejects(admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile }), code('INVALID_ARGUMENT'));
    assert.equal(calls.length, 0);
  });
}

test('service-account private files reject directories, symlinks, and missing paths without a request', async t => {
  const file = await fixture(t), link = join(file.directory, 'link'); await symlink(file.keyFile, link);
  for (const keyFile of [file.directory, link, join(file.directory, 'missing')]) {
    const h = setup(); await assert.rejects(h.admin.serviceAccountApiKey({ ...args, keyFile }), error => ['INVALID_ARGUMENT', 'PRIVATE_INPUT_UNREADABLE'].includes(error?.code));
    assert.equal(h.calls.length, 0);
  }
});

test('credential FIFO is rejected promptly without waiting for a writer', { timeout: 5000 }, async t => {
  const file = await fixture(t); await rm(file.keyFile); await promisify(execFile)('mkfifo', [file.keyFile]);
  const { admin, calls } = setup();
  await assert.rejects(admin.serviceAccountApiKey({ ...args, keyFile: file.keyFile }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

for (const reason of [null, false, 0, '', new Error('synthetic cancellation')]) test(`credential stdin cancellation preserves a ${typeof reason} reason`, async () => {
  const input = new PassThrough(), controller = new AbortController(), h = setup();
  const pending = h.admin.serviceAccountApiKey({ ...args, keyFile: '-', input, signal: controller.signal });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  controller.abort(reason);
  assert.deepEqual(await outcome, { error: reason }); assert.equal(h.calls.length, 0); assert.equal(input.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('interactive and oversized credential stdin are rejected before a request', async () => {
  const interactive = new PassThrough(); interactive.isTTY = true;
  for (const input of [interactive, Readable.from(['x'.repeat(65537)])]) {
    const h = setup(); await assert.rejects(h.admin.serviceAccountApiKey({ ...args, keyFile: '-', input }), code('INVALID_ARGUMENT')); assert.equal(h.calls.length, 0);
  }
});

test('stdin errors are sanitized and do not expose credential text', async () => {
  const input = new PassThrough(), controller = new AbortController(), h = setup();
  const pending = h.admin.serviceAccountApiKey({ ...args, keyFile: '-', input, signal: controller.signal });
  queueMicrotask(() => input.destroy(new Error(key)));
  await assert.rejects(pending, code('PRIVATE_INPUT_UNREADABLE')); assert.equal(h.calls.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('OAuth client-secret stdin remains private and cancellation keeps the original reason', async () => {
  const authRequest = { supported_auth: [{ type: 'OAUTH', authorization_url: 'https://auth.example.test/start', token_url: 'https://auth.example.test/token' }],
    oauth_client_params: { client_id: 'fixture-client', token_endpoint_auth_method: 'client_secret_basic' } };
  const h = setup(() => ({ connector: { ...connector, client_secret: key } }));
  const result = await h.admin.createMcp({ name: 'Fixture', target: { mcp_url: 'https://example.test/mcp' }, authRequest,
    clientSecretFile: '-', input: Readable.from([`${key}\n`]) });
  assert.equal(h.calls[0].body.auth_request.oauth_client_params.client_secret, key);
  assert.equal(JSON.stringify(result).includes(key), false);
  const controller = new AbortController(), input = new PassThrough(), cancelled = setup();
  const outcome = cancelled.admin.createMcp({ name: 'Fixture', target: { mcp_url: 'https://example.test/mcp' }, authRequest,
    clientSecretFile: '-', input, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  controller.abort(false); assert.deepEqual(await outcome, { error: false }); assert.equal(cancelled.calls.length, 0);
});

test('MCP creation sends a real PNG as an exact data URL and only the expected fields', async t => {
  const file = await fixture(t, validPNG), { admin, calls } = setup(() => ({ connector }));
  const result = await admin.createMcp({ name: ' Fixture ', target: { mcp_url: 'https://example.test/mcp' }, authRequest: { supported_auth: [{ type: 'NONE' }] }, logoFile: file.keyFile });
  assert.equal(calls.length, 1); assert.equal(calls[0].body.logo_url, `data:image/png;base64,${validPNG.toString('base64')}`); assert.equal(result.status, 'created');
});

test('MCP logo update reads the current connector before sending the exact image', async t => {
  const file = await fixture(t, validPNG), { admin, calls } = setup(() => connector);
  await admin.updateMcp({ connectorId: connector.id, field: 'logo', logoFile: file.keyFile });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PATCH']); assert.deepEqual(calls[1].body, { logo_url: `data:image/png;base64,${validPNG.toString('base64')}` });
});

for (const [name, bytes] of [['signature only', validPNG.subarray(0, 8)], ['truncated image', validPNG.subarray(0, -4)], ['not PNG', Buffer.from('not an image')], ['oversized image', Buffer.concat([validPNG, Buffer.alloc(10241)])]]) {
  test(`MCP rejects ${name} before reading the account or sending a request`, async t => {
    const file = await fixture(t, bytes), { admin, calls, transport } = setup(); let authReads = 0; transport.authLoader = async () => { authReads++; return { accountId: 'account-fixture' }; };
    await assert.rejects(admin.createMcp({ name: 'Fixture', target: { mcp_url: 'https://example.test/mcp' }, authRequest: { supported_auth: [{ type: 'NONE' }] }, logoFile: file.keyFile }), code('INVALID_ARGUMENT'));
    assert.equal(authReads, 0); assert.equal(calls.length, 0);
  });
}

test('MCP rejects non-ASCII PNG chunk names without masking high bits', async t => {
  const bytes = Buffer.from(validPNG); for (let index = 12; index < 16; index++) bytes[index] |= 0x80;
  const file = await fixture(t, bytes), h = setup();
  await assert.rejects(h.admin.createMcp({ name: 'Fixture', target: { mcp_url: 'https://example.test/mcp' }, authRequest: { supported_auth: [{ type: 'NONE' }] }, logoFile: file.keyFile }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('connector projection removes nested credentials and URL userinfo while preserving schema names', () => {
  const result = connectorPublicData({ private_key: key, apiKey: key, nested: { key, access_token: key },
    endpoint: `https://user:${key}@example.test/path`,
    properties: { client_secret: key, password: { type: 'string', default: key, description: 'Password' }, ordinary: { type: 'string' } } });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.deepEqual(result.properties.password, { type: 'string', description: 'Password' }); assert.deepEqual(result.properties.ordinary, { type: 'string' });
});

test('connector credential schemas preserve descriptions, requirements and types without credential defaults', () => {
  const schema = { type: 'object', required: ['api_key', 'region'], properties: {
    api_key: { title: 'Provider API key', description: 'Use a personal key', writeOnly: true, type: 'string', default: key, examples: [key],
      anyOf: [{ type: 'string', const: key }, { type: 'null' }] },
    region: { type: 'string', enum: ['us', 'eu'], default: 'us' },
  } };
  const result = connectorPublicData({ link_params_schema: schema });
  assert.deepEqual(result.link_params_schema.required, schema.required);
  assert.deepEqual(result.link_params_schema.properties.api_key, { title: 'Provider API key', description: 'Use a personal key', writeOnly: true,
    type: 'string', anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(result.link_params_schema.properties.region, schema.properties.region);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('hidden and malformed service-account links cannot authorize read/write or unlink mutations', async () => {
  for (const link of [null, { id: 'link-fixture', connector_id: connector.id, visibility: 'hidden' }, { id: 'link-fixture', connector_id: connector.id, is_hidden: true }]) {
    const h = setup(() => ({ links: [link] }));
    await assert.rejects(h.admin.serviceAccountUnlink({ ...args, linkId: 'link-fixture', confirmLinkId: 'link-fixture' }), error => ['INVALID_RESPONSE', 'CONNECTION_UNAVAILABLE'].includes(error?.code));
    assert.equal(h.calls.length, 1);
  }
});
