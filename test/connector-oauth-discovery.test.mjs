import test from 'node:test';
import assert from 'node:assert/strict';
import { DotConnectorAdmin } from '../src/connectors-admin.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { run } from '../src/cli.mjs';

const target = { mcp_url: 'https://example.test/mcp' };
const token = `h.${Buffer.from(JSON.stringify({ sub: 'user-a' })).toString('base64url')}.s`;
function fixture(handler) {
  const calls = [];
  const transport = {
    authLoader: async () => ({ accountId: 'account-a' }),
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      return handler();
    },
  };
  return { admin: new DotConnectorAdmin({ transport }), calls };
}

test('OAuth discovery normalizes only an ordinary HTTP 404 after one exact request', async () => {
  const { admin, calls } = fixture(() => { throw new DotError('HTTP_ERROR', 'No OAuth configuration', { status: 404 }); });
  assert.deepEqual(await admin.discoverOAuth({ target, expectedAccountId: 'account-a' }), { oauth_config: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/backend-api/aip/connectors/mcp/oauth_config');
  assert.deepEqual(calls[0].options.body, target);
  assert.equal(calls[0].options.expectedAccountId, 'account-a');
});

test('OAuth discovery retains successful configuration and credential redaction', async () => {
  const { admin, calls } = fixture(() => ({ oauth_config: { authorization_url: 'https://example.test/authorize', client_secret: 'hidden' } }));
  assert.deepEqual(await admin.discoverOAuth({ target }), { oauth_config: { authorization_url: 'https://example.test/authorize' } });
  assert.equal(calls.length, 1);
});

test('OAuth discovery retains a successful explicit null configuration', async () => {
  const { admin } = fixture(() => ({ oauth_config: null }));
  assert.deepEqual(await admin.discoverOAuth({ target }), { oauth_config: null });
});

for (const [name, failure] of [
  ['HTTP 400', new DotError('HTTP_ERROR', 'Bad target', { status: 400 })],
  ['HTTP 401', new DotError('HTTP_ERROR', 'Unauthorized', { status: 401 })],
  ['HTTP 403', new DotError('HTTP_ERROR', 'Forbidden', { status: 403 })],
  ['HTTP 500', new DotError('HTTP_ERROR', 'Server error', { status: 500 })],
  ['string status', new DotError('HTTP_ERROR', 'Nonstandard status', { status: '404' })],
  ['missing status', new DotError('HTTP_ERROR', 'No status')],
  ['edge challenge', new DotError('EDGE_CHALLENGE', 'Challenge', { status: 404 })],
  ['auth identity error', new DotError('AUTH_IDENTITY_CHANGED', 'Changed', { status: 404 })],
  ['invalid response', new DotError('INVALID_RESPONSE', 'Malformed', { status: 404 })],
  ['plain status-bearing error', Object.assign(new Error('Unrelated'), { status: 404 })],
  ['plain code-bearing error', Object.assign(new Error('Unrelated'), { code: 'HTTP_ERROR', details: { status: 404 } })],
]) test(`OAuth discovery preserves ${name} without retry`, async () => {
  const { admin, calls } = fixture(() => { throw failure; });
  await assert.rejects(admin.discoverOAuth({ target }), error => error === failure);
  assert.equal(calls.length, 1);
});

test('discovery target and account errors still fail before the request', async () => {
  const { admin, calls } = fixture(() => ({}));
  await assert.rejects(admin.discoverOAuth({ target: { ...target, tunnel_id: 'extra' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(admin.discoverOAuth({ target, expectedAccountId: 'other-account' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(calls.length, 0);
});

test('ordinary callback 404 remains an error on its separate route', async () => {
  const failure = new DotError('HTTP_ERROR', 'Callback unavailable', { status: 404 });
  const { admin, calls } = fixture(() => { throw failure; });
  await assert.rejects(admin.oauthCallback({ target }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/backend-api/aip/connectors/oauth/callback_id');
  assert.equal(calls[0].method, 'GET');
});

test('actual CLI reports null OAuth configuration from ordinary JSON 404', async () => {
  let requests = 0, stdout = '';
  const response = JSON.stringify({ detail: 'MCP server https://example.test/mcp does not implement OAuth' });
  const transport = new Transport({
    authLoader: async () => ({ accountId: 'account-a', accessToken: token }),
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(String(url), 'https://chatgpt.com/backend-api/aip/connectors/mcp/oauth_config');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), target);
      assert.equal(new Headers(options.headers).get('chatgpt-account-id'), 'account-a');
      return new Response(response, { status: 404, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(response)) } });
    },
  });
  const result = await run(['connector', 'admin', 'oauth-config', '--target', JSON.stringify(target), '--account', 'account-a', '--json'], {
    createClient: async () => new FullDotClient({ transport }),
    stdout: { write: text => { stdout += text; } },
    stderr: { write: () => { throw new Error('Unexpected stderr'); } },
  });
  assert.deepEqual(result, { oauth_config: null });
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal(requests, 1);
});

for (const [name, status, headers, body, expected] of [
  ['edge 403', 403, { 'cf-mitigated': 'challenge' }, '{}', 'EDGE_CHALLENGE'],
  ['edge 404', 404, { 'cf-mitigated': 'challenge' }, '{}', 'EDGE_CHALLENGE'],
  ['invalid JSON', 200, { 'content-type': 'application/json' }, '{', 'INVALID_RESPONSE'],
]) test(`real transport ${name} is not normalized`, async () => {
  let requests = 0;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-a', accessToken: token }), fetchImpl: async () => {
    requests++;
    return new Response(body, { status, headers });
  } });
  await assert.rejects(new DotConnectorAdmin({ transport }).discoverOAuth({ target }), { code: expected });
  assert.equal(requests, 1);
});
