import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authPath, authStatus, loadAuth } from '../src/auth.mjs';
import { apiUrl, classifyResponse, Transport } from '../src/transport.mjs';

const ACCESS = 'synthetic-access-secret';
const REFRESH = 'synthetic-refresh-secret';
const authLoader = async () => ({ accessToken: ACCESS, accountId: 'test-account' });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

async function fixture(t, value) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dot-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return file;
}

test('auth path honors explicit file and CODEX_HOME without reading env secrets', () => {
  assert.equal(authPath({ env: { CODEX_HOME: '/workspace/codex' }, home: '/home/test' }), '/workspace/codex/auth.json');
  assert.equal(authPath({ authFile: '/workspace/login.json' }), '/workspace/login.json');
});

test('auth uses only the access token; status never exposes any token', async t => {
  const authFile = await fixture(t, { auth_mode: 'chatgpt', tokens: { access_token: ACCESS, refresh_token: REFRESH, id_token: 'synthetic-id-secret', account_id: 'test-account' } });
  const auth = await loadAuth({ authFile });
  assert.equal(auth.accessToken, ACCESS);
  assert.equal(auth.refreshToken, undefined);
  assert.equal(auth.idToken, undefined);
  const status = await authStatus({ authFile });
  assert.equal(status.status, 'ready');
  assert.equal(status.hasAccountSelector, true);
  assert.equal(status.accountId, 'test-account');
  assert(!JSON.stringify(status).includes('secret'));
});

test('invalid and API-key login errors do not echo file contents', async t => {
  const malformed = await fixture(t, '{"exposed": "' + ACCESS);
  const status = await authStatus({ authFile: malformed });
  assert.equal(status.error.code, 'AUTH_INVALID');
  assert(!JSON.stringify(status).includes(ACCESS));
  const api = await fixture(t, { auth_mode: 'api', OPENAI_API_KEY: ACCESS });
  await assert.rejects(loadAuth({ authFile: api }), { code: 'AUTH_MODE' });
});

test('expired OAuth token asks for Codex login instead of refreshing it itself', async t => {
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url');
  const authFile = await fixture(t, { tokens: { access_token: `header.${payload}.sig` } });
  await assert.rejects(loadAuth({ authFile }), { code: 'AUTH_EXPIRED' });
});

test('credential header injection is rejected', async t => {
  const authFile = await fixture(t, { tokens: { access_token: 'safe\r\nmalicious: value' } });
  await assert.rejects(loadAuth({ authFile }), { code: 'AUTH_INVALID' });
});

test('API URLs are pinned to the first-party origin and reject traversal', () => {
  assert.equal(apiUrl('/backend-api/tbo', { cursor: 'a&b?c' }).href, 'https://chatgpt.com/backend-api/tbo?cursor=a%26b%3Fc');
  for (const route of ['https://evil.example/', '//evil.example/a', '/backend-api/../evil', '/backend-api/%2e%2e/a', '/backend-api/a?x=1', '/backend-api/\\evil']) {
    assert.throws(() => apiUrl(route), { code: 'INVALID_ROUTE' });
  }
});

test('transport sets account/auth headers and refuses to follow redirects', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://chatgpt.com');
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], 'test-account');
    assert.equal(options.headers['User-Agent'], `dotter/${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`);
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
  } });
  await assert.rejects(transport.request('GET', '/backend-api/tbo'), error => {
    assert.equal(error.code, 'REDIRECT_BLOCKED');
    assert(!JSON.stringify(error.toJSON()).includes(ACCESS));
    return true;
  });
  assert.equal(calls, 1);
});

test('403 diagnostics distinguish a confirmed challenge from an uncertain HTML refusal', () => {
  const html = new Headers({ 'content-type': 'text/html', 'cf-ray': 'abc123-LHR' });
  assert.equal(classifyResponse(403, html, '<h1>Forbidden</h1>').code, 'FORBIDDEN_HTML');
  assert.equal(classifyResponse(403, new Headers({ 'cf-mitigated': 'challenge' }), '').code, 'EDGE_CHALLENGE');
  assert.equal(classifyResponse(403, html, '<script src="/cdn-cgi/challenge-platform/x"></script>').code, 'EDGE_CHALLENGE');
  assert.equal(classifyResponse(401, new Headers(), '').code, 'AUTH_REJECTED');
  assert.equal(classifyResponse(403, new Headers({ 'content-type': 'application/json' }), '{"error":{}}').code, 'FORBIDDEN');
});

test('structured onboarding error codes are retained without exposing arbitrary server fields', () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of [
    { error: { code: 'cloud_aeon_recovery_required' } },
    { error_code: 'cloud_aeon_recovery_required' },
    { extra: { error_code: 'cloud_aeon_recovery_required' } },
    { detail: { error: { code: 'cloud_aeon_recovery_required' } } },
    { error: { error: { error_code: 'cloud_aeon_recovery_required' } } },
    { detail: { code: 'cloud_aeon_recovery_required' } },
    { code: 'cloud_aeon_recovery_required' },
    { detail: 'cloud_aeon_recovery_required' }
  ]) {
    const error = classifyResponse(409, headers, JSON.stringify({ ...value, message: ACCESS }));
    assert.equal(error.details.apiCode, 'cloud_aeon_recovery_required');
    assert.equal(error.details.apiErrorFamily, 'cloud_aeon');
    assert.equal(JSON.stringify(error.toJSON()).includes(ACCESS), false);
  }
  const unknown = classifyResponse(403, headers, JSON.stringify({ error: { code: 'cloud_aeon_' + ACCESS } }));
  assert.equal(unknown.details.apiCode, undefined);
  assert.equal(unknown.details.apiErrorFamily, 'cloud_aeon');
  assert.equal(JSON.stringify(unknown.toJSON()).includes(ACCESS), false);
  assert.equal(classifyResponse(403, headers, JSON.stringify({ code: ACCESS })).details.apiCode, undefined);
});

test('only the explicit latest backing-run read accepts an observed JSON null response', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return json(null); } });
  const route = '/backend-api/automation/routine-id/latest_backing_run';
  await assert.rejects(transport.request('GET', route), { code: 'INVALID_RESPONSE' });
  assert.equal(await transport.request('GET', route, { allowNull: true }), null);
  const response = await transport.request('GET', route, { allowNull: true, includeResponse: true });
  assert.equal(response.status, 200); assert.equal(response.body, null);
  for (const [method, path, options] of [
    ['GET', '/backend-api/tbo', { allowNull: true }],
    ['POST', route, { allowNull: true }],
    ['GET', route, { allowNull: 'true' }],
    ['GET', route, { allowNull: true, responseType: 'text' }]
  ]) await assert.rejects(transport.request(method, path, options), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 3);
});

test('server error text and injected diagnostic headers are never echoed', async () => {
  const transport = new Transport({ authLoader, fetchImpl: async () => json({ error: { message: ACCESS + REFRESH } }, 403, { 'x-request-id': ACCESS + '\tbad' }) });
  await assert.rejects(transport.request('GET', '/backend-api/tbo'), error => {
    assert(!JSON.stringify(error.toJSON()).includes(ACCESS));
    assert(!JSON.stringify(error.toJSON()).includes(REFRESH));
    return true;
  });
});

test('POST network failures are single-attempt and retain reconciliation key', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; throw new Error(ACCESS); } });
  await assert.rejects(transport.request('POST', '/backend-api/messaging/rooms/test/messages', { body: { content: { text: 'test' } }, idempotencyKey: 'key' }), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.details.delivery, 'unknown');
    assert.equal(error.details.idempotencyKey, 'key');
    assert(!error.message.includes(ACCESS));
    return true;
  });
  assert.equal(calls, 1);
});

test('POST HTTP failures are never retried', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return json({}, status); } });
    await assert.rejects(transport.request('POST', '/backend-api/messaging/rooms/test/messages', { body: {}, idempotencyKey: 'same-key' }), error => {
      assert.equal(error.details.delivery, 'unknown');
      assert.equal(error.details.idempotencyKey, 'same-key');
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('successful non-JSON response gives a safe delivery-unknown error for POST', async () => {
  const transport = new Transport({ authLoader, fetchImpl: async () => new Response('<html>' + ACCESS + '</html>') });
  await assert.rejects(transport.request('POST', '/backend-api/messaging/rooms/test/messages', { body: {}, idempotencyKey: 'key' }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.details.delivery, 'unknown');
    assert(!JSON.stringify(error.toJSON()).includes(ACCESS));
    return true;
  });
});

test('transport cancellation does not turn a user interrupt into a network retry', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('Aborted', 'AbortError'));
  const transport = new Transport({ authLoader, fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); } });
  await assert.rejects(transport.request('GET', '/backend-api/tbo', { signal: controller.signal }), { name: 'AbortError' });
});

test('multipart uploads contain bytes, use a bounded file part, and make one request', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async (_url, options) => {
    calls++;
    assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert(Buffer.isBuffer(options.body));
    assert(options.body.includes(Buffer.from([0, 1, 255])));
    assert(options.body.toString().includes('name="file"; filename="note.txt"'));
    return json({ id: 'file_test' });
  } });
  assert.equal((await transport.requestMultipart('POST', '/backend-api/messaging/rooms/test/files', { file: { name: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from([0, 1, 255]) } })).id, 'file_test');
  assert.equal(calls, 1);
});

test('binary reads preserve bytes and anonymous signed downloads never load auth', async () => {
  const bytes = Buffer.from([0, 255, 254, 1]);
  const transport = new Transport({ authLoader: async () => { throw new Error('must not read auth'); }, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['ChatGPT-Account-Id'], undefined);
    assert.equal(options.signedFile, true);
    assert.equal(options.redirect, 'manual');
    return new Response(bytes);
  } });
  assert.deepEqual(await transport.fetchSigned('https://files.oaiusercontent.com/test?signature=not-a-secret'), bytes);
  await assert.rejects(transport.fetchSigned('https://evil.example/test'), { code: 'UNSUPPORTED_FILE_HOST' });
});

test('explicit DELETE/PATCH mutations are single-attempt and accept empty acknowledgments', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return new Response(null, { status: 204 }); } });
  assert.deepEqual(await transport.request('DELETE', '/backend-api/test'), { completed: true });
  assert.deepEqual(await transport.request('PATCH', '/backend-api/test', { body: { value: true } }), { completed: true });
  assert.equal(calls, 2);
});

test('connector inventory permits only fixed product headers without allowing auth overrides', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.headers['OAI-Product-Sku'], 'CODEX');
    assert.equal(options.headers['X-Codex-Surface'], 'other');
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
    return json({ links: [] });
  } });
  await transport.request('POST', '/backend-api/aip/connectors/links/list_accessible', {
    headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, body: { principals: [], link_refresh_strategy: 'NONE' }
  });
  for (const headers of [{ Authorization: 'bad' }, { Host: 'evil.example' }, { 'OAI-Product-Sku': 'other' }, null, []]) {
    await assert.rejects(transport.request('GET', '/backend-api/tbo', { headers }), { code: 'INVALID_HEADERS' });
  }
  assert.equal(calls, 1);
});

test('project connector SKU passes through real transport only on audited catalog routes', async () => {
  const calls = [];
  const transport = new Transport({ authLoader, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers['OAI-Product-Sku'], 'CHATGPT_PROJECTS');
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
    return json({ links: [] });
  } });
  const headers = { 'OAI-Product-Sku': 'CHATGPT_PROJECTS', 'X-Codex-Surface': 'other' };
  await transport.request('POST', '/backend-api/aip/connectors/links/list_accessible', { headers, body: { principals: [], link_refresh_strategy: 'BLOCKING' } });
  await transport.request('GET', '/backend-api/aip/connectors/google_drive', { headers });
  await transport.request('GET', '/backend-api/aip/connectors/google_drive/link', { headers });
  await transport.request('GET', '/backend-api/aip/connectors/google_drive/tos', { headers });
  for (const leaf of ['oauth', 'oauth/reauth', 'oauth/callback', 'noauth', 'api_key']) {
    await transport.request('POST', `/backend-api/aip/connectors/links/${leaf}`, { headers, body: {} });
  }
  for (const [method, path] of [['GET', '/backend-api/tbo'], ['POST', '/backend-api/ps/mcp'], ['POST', '/backend-api/aip/connectors/google_drive'], ['GET', '/backend-api/aip/connectors/google_drive/oauth']]) {
    await assert.rejects(transport.request(method, path, { headers }), { code: 'INVALID_HEADERS' });
  }
  assert.equal(calls.length, 9);
});

test('native project upload header is limited to matching gizmo reservation and processing bodies', async () => {
  const calls = [];
  const transport = new Transport({ authLoader, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers['chatgpt-project-id'], 'g-p-test');
    assert.equal(JSON.parse(options.body).gizmo_id, 'g-p-test');
    return json({ completed: true });
  } });
  const headers = { 'chatgpt-project-id': 'g-p-test' };
  const body = { gizmo_id: 'g-p-test', use_case: 'gizmo' };
  await transport.request('POST', '/backend-api/files', { headers, body });
  await transport.request('POST', '/backend-api/files/process_upload_stream', { headers, body: { ...body, file_id: 'file-test', entry_surface: 'project_sources' } });
  for (const [method, path, invalidBody] of [
    ['GET', '/backend-api/files', body], ['POST', '/backend-api/projects/g-p-test/files', body],
    ['POST', '/backend-api/files', { ...body, gizmo_id: 'g-p-other' }],
    ['POST', '/backend-api/files', { ...body, use_case: 'my_files' }],
  ]) await assert.rejects(transport.request(method, path, { headers, body: invalidBody }), { code: 'INVALID_HEADERS' });
  assert.equal(calls.length, 2);
});

test('raw voice response preserves SDP and only approved response headers', async () => {
  const transport = new Transport({ authLoader, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Accept, 'text/plain');
    return new Response('v=0\r\ns=answer\r\n', { status: 201, headers: {
      location: '/backend-api/tbo/dot_1/voice/calls/rtc_test', 'openai-root-thread-id': 'thread_1',
      'set-cookie': 'private-cookie', 'x-private-token': ACCESS
    } });
  } });
  const result = await transport.request('POST', '/backend-api/tbo/dot_1/voice/calls', {
    body: { sdp: 'v=0\r\ns=offer\r\n' }, responseType: 'text', includeResponse: true
  });
  assert.equal(result.status, 201);
  assert.equal(result.body, 'v=0\r\ns=answer\r\n');
  assert.equal(result.headers.get('openai-root-thread-id'), 'thread_1');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-private-token'), null);
});

test('account pinning refuses changed authentication before requests, while verified headers pass', async () => {
  let calls = 0;
  const key = '11111111-1111-4111-8111-111111111111';
  const transport = new Transport({ authLoader, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.headers['Idempotency-Key'], key);
    assert.equal(options.headers['X-Codex-Surface'], 'connector_setup');
    return json({ completed: true });
  } });
  await assert.rejects(transport.request('GET', '/backend-api/tbo', { expectedAccountId: 'another-account' }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(calls, 0);
  await transport.request('POST', '/backend-api/tbo/dot/meeting-sessions', {
    headers: { 'Idempotency-Key': key, 'X-Codex-Surface': 'connector_setup' }, expectedAccountId: 'test-account'
  });
  assert.equal(calls, 1);
});
