import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apiUrl, Transport } from '../src/transport.mjs';

const ROUTE = '/backend-api/tbo';
const SDP = 'v=0\r\ns=control\r\n';
const jwt = (subject, suffix = '') => `e30.${Buffer.from(JSON.stringify({ sub: subject, nonce: suffix })).toString('base64url')}.test`;
const auth = (subject = 'user-1', accountId = 'account-1', suffix = '') => ({ accessToken: jwt(subject, suffix), accountId });
const fails = code => error => error.code === code;
function setup({ identities = [auth()], response } = {}) {
  const calls = []; let identity = 0;
  const transport = new Transport({ authLoader: async () => identities[Math.min(identity++, identities.length - 1)], fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (response) return response(url, options);
    return String(url).startsWith('https://realtime.chatgpt.com/') ? new Response(SDP) : new Response('{}');
  } });
  return { transport, calls };
}

test('query arrays preserve repeated keys, scalars, encoding, and order', () => {
  const url = apiUrl(ROUTE, { id: ['a/b', 'c&d'], enabled: true, offset: 2, missing: null, absent: undefined });
  assert.deepEqual(url.searchParams.getAll('id'), ['a/b', 'c&d']);
  assert.equal(url.search, '?id=a%2Fb&id=c%26d&enabled=true&offset=2');
});
for (const [label, value] of [['object', { id: 'x' }], ['NaN', NaN], ['Infinity', Infinity], ['null array element', [null]], ['object array element', [{}]], ['nested array', [['x']]]]) test(`query rejects ${label}`, () => {
  assert.throws(() => apiUrl(ROUTE, { q: value }), fails('INVALID_QUERY'));
});
test('session accepts refreshed tokens with the same account and JWT subject', async () => {
  const { transport, calls } = setup({ identities: [auth('user-1', 'account-1', 'old'), auth('user-1', 'account-1', 'new')] });
  await transport.request('GET', ROUTE); await transport.request('GET', ROUTE);
  assert.equal(calls.length, 2); assert.notEqual(calls[0].headers.Authorization, calls[1].headers.Authorization);
});
for (const next of [auth('user-2'), auth('user-1', 'account-2')]) test(`session pins identity across requests: ${next.accountId}`, async () => {
  const { transport, calls } = setup({ identities: [auth(), next] }); await transport.request('GET', ROUTE);
  await assert.rejects(transport.request('GET', ROUTE), fails('AUTH_IDENTITY_CHANGED')); assert.equal(calls.length, 1);
});
test('expected account rejects a request before credentials are sent', async () => {
  const { transport, calls } = setup(); await assert.rejects(transport.request('GET', ROUTE, { expectedAccountId: 'different' }), fails('ACCOUNT_CHANGED')); assert.equal(calls.length, 0);
});
test('realtime and ordinary requests share the same JWT identity pin', async () => {
  const { transport, calls } = setup({ identities: [auth(), auth('different')] });
  await transport.requestRealtimeSdp({ source: 'aeon', threadId: 'thread-1', aeonId: 'aeon-1', sdp: SDP, expectedAccountId: 'account-1' });
  await assert.rejects(transport.request('GET', ROUTE), fails('AUTH_IDENTITY_CHANGED')); assert.equal(calls.length, 1);
  const reverse = setup({ identities: [auth(), auth('different')] }); await reverse.transport.request('GET', ROUTE);
  await assert.rejects(reverse.transport.requestRealtimeSdp({ source: 'flora', conversationId: 'conversation-1', sdp: SDP, expectedAccountId: 'account-1' }), fails('AUTH_IDENTITY_CHANGED')); assert.equal(reverse.calls.length, 1);
});
test('realtime target negotiation uses only the fixed host and source-specific query', async () => {
  const { transport, calls } = setup();
  const result = await transport.requestRealtimeSdp({ source: 'aeon', threadId: 'thread~1', aeonId: 'aeon-1', sdp: SDP, expectedAccountId: 'account-1' });
  assert.equal(result.body, SDP); assert.equal(calls[0].url, 'https://realtime.chatgpt.com/v1/cua?source=aeon&thread_id=thread%7E1&aeon_id=aeon-1');
  assert.equal(calls[0].realtimeSdp, true); assert.equal(calls[0].redirect, 'manual'); assert.equal(calls[0].headers['Content-Type'], 'application/sdp');
  await transport.requestRealtimeSdp({ source: 'flora', conversationId: 'conversation-1', sdp: SDP, expectedAccountId: 'account-1' });
  assert.equal(calls[1].url, 'https://realtime.chatgpt.com/v1/cua?source=flora&cid=conversation-1');
});
test('invalid realtime target, SDP, or account never reaches fetch', async () => {
  const { transport, calls } = setup();
  for (const input of [{ source: 'other' }, { source: 'aeon', threadId: 'a?b', aeonId: 'a' }, { source: 'flora', conversationId: '../c' }, { source: 'flora', conversationId: 'c', sdp: 'not-sdp' }]) {
    await assert.rejects(transport.requestRealtimeSdp({ sdp: SDP, expectedAccountId: 'account-1', ...input }), fails('INVALID_ARGUMENT'));
  }
  await assert.rejects(transport.requestRealtimeSdp({ source: 'flora', conversationId: 'c', sdp: SDP }), fails('ACCOUNT_CHANGED')); assert.equal(calls.length, 0);
});
test('range and includeResponse preserve only relevant response headers', async () => {
  const { transport, calls } = setup({ response: () => new Response('abc', { status: 206, headers: {
    'content-type': 'application/octet-stream', 'content-range': 'bytes 2-4/10', 'accept-ranges': 'bytes', 'content-length': '3',
    location: '/backend-api/resource', 'openai-root-thread-id': 'thread-1', 'x-request-id': 'request-1', 'set-cookie': 'private', 'x-unrelated': 'not-exposed'
  } }) });
  const result = await transport.requestBytes('GET', ROUTE, { range: 'bytes=2-4', includeResponse: true });
  assert.equal(calls[0].headers.Range, 'bytes=2-4'); assert.deepEqual(result.body, Buffer.from('abc')); assert.equal(result.status, 206);
  for (const [name, value] of [['content-range', 'bytes 2-4/10'], ['location', '/backend-api/resource'], ['openai-root-thread-id', 'thread-1'], ['content-length', '3']]) assert.equal(result.headers.get(name), value);
  assert.equal(result.headers.get('set-cookie'), null); assert.equal(result.headers.get('x-unrelated'), null);
});
test('invalid ranges and ranges on writes fail before network', async () => {
  const { transport, calls } = setup();
  for (const range of ['bytes=0-', 'bytes=-1', 'bytes=4-2', 'bytes=0-104857600', 'bytes=0-1,2-3', 'bytes=0-9007199254740992']) await assert.rejects(transport.request('GET', ROUTE, { range }), fails('INVALID_RANGE'));
  await assert.rejects(transport.request('POST', ROUTE, { range: 'bytes=0-1' }), fails('INVALID_RANGE')); assert.equal(calls.length, 0);
});
test('new library and cloud-vault headers are allowed only on their observed routes', async () => {
  const { transport, calls } = setup();
  await transport.request('GET', '/backend-api/files/library/files/file-1', { headers: { 'x-oai-library-access-request-ids': 'request-1,request-2' } });
  await transport.request('GET', '/backend-api/files/library/files/file-1/content_redirect', { headers: { 'X-OpenAI-Attach-Auth': '1' } });
  await transport.request('GET', '/backend-api/flora/browser/auth', { headers: { 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2', 'X-OpenAI-Cloud-Vault-Check-Trigger': 'explicit_recheck' } });
  assert.equal(calls.length, 3);
  for (const [route, headers] of [
    [ROUTE, { 'x-oai-library-access-request-ids': 'r' }], [ROUTE, { 'X-OpenAI-Attach-Auth': '1' }],
    ['/backend-api/files/library/files/file-1', { 'X-OpenAI-Attach-Auth': '1' }],
    ['/backend-api/flora/browser/auth', { 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '3' }],
    [ROUTE, { 'X-OpenAI-Cloud-Vault-Check-Trigger': 'explicit_recheck' }],
    ['/backend-api/files/library/files/f', { 'x-oai-library-access-request-ids': 'r\r\nInjected: yes' }],
    [ROUTE, { Authorization: 'Bearer supplied' }], [ROUTE, { Cookie: 'secret' }], [ROUTE, { Range: 'bytes=0-1' }]
  ]) await assert.rejects(transport.request('GET', route, { headers }), fails('INVALID_HEADERS'));
  assert.equal(calls.length, 3);
});
test('new named telemetry surfaces allow only the observed values', async () => {
  const { transport, calls } = setup();
  for (const value of ['writing_blocks', 'plugin_management', 'skill_details', 'workspace_agents']) await transport.request('GET', ROUTE, { headers: { 'X-Codex-Surface': value } });
  await assert.rejects(transport.request('GET', ROUTE, { headers: { 'X-Codex-Surface': 'arbitrary' } }), fails('INVALID_HEADERS')); assert.equal(calls.length, 4);
});
test('TPP product SKU is limited to native widget POST routes and retains existing SKU behavior', async () => {
  const { transport, calls } = setup();
  const routes = ['/backend-api/ps/mcp', '/backend-api/ecosystem/call_mcp'];
  for (const route of routes) {
    await transport.request('POST', route, { headers: { 'OAI-Product-Sku': 'TPP' }, body: { method: 'tools/list' } });
    assert.equal(calls.at(-1).headers['OAI-Product-Sku'], 'TPP');
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    for (const route of routes) await assert.rejects(transport.request(method, route, { headers: { 'OAI-Product-Sku': 'TPP' } }), fails('INVALID_HEADERS'));
  }
  for (const route of [ROUTE, '/backend-api/ps/mcp/other', '/backend-api/ps/mcp/', '/backend-api/ecosystem/call_mcp/status']) {
    await assert.rejects(transport.request('POST', route, { headers: { 'OAI-Product-Sku': 'TPP' } }), fails('INVALID_HEADERS'));
  }
  for (const value of ['tpp', 'TPP\r\nInjected: yes', 'OTHER']) {
    await assert.rejects(transport.request('POST', routes[0], { headers: { 'OAI-Product-Sku': value } }), fails('INVALID_HEADERS'));
  }
  assert.equal(calls.length, 2);
  await transport.request('GET', ROUTE, { headers: { 'OAI-Product-Sku': 'CODEX' } });
  await transport.request('POST', routes[1], { headers: { 'OAI-Product-Sku': 'aeon' } });
  assert.deepEqual(calls.slice(-2).map(call => call.headers['OAI-Product-Sku']), ['CODEX', 'aeon']);
});
test('saved-entity native header is limited to the three exact POST routes and value', async () => {
  const { transport, calls } = setup();
  const base = '/backend-api/chat/frontend/v1/saved-entities';
  for (const route of [base, `${base}/status`, `${base}/remove`]) {
    await transport.request('POST', route, { headers: { 'x-openai-use-sheep': '1' } });
    assert.equal(calls.at(-1).headers['x-openai-use-sheep'], '1');
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
    for (const route of [base, `${base}/status`, `${base}/remove`]) {
      await assert.rejects(transport.request(method, route, { headers: { 'x-openai-use-sheep': '1' } }), fails('INVALID_HEADERS'));
    }
  }
  for (const route of [ROUTE, `${base}/other`, `${base}/status/`, '/backend-api/files/library/files/file-1']) {
    await assert.rejects(transport.request('POST', route, { headers: { 'x-openai-use-sheep': '1' } }), fails('INVALID_HEADERS'));
  }
  for (const headers of [{ 'x-openai-use-sheep': '0' }, { 'x-openai-use-sheep': 1 }, { 'x-openai-use-sheep': '1\r\nInjected: yes' }, { 'X-OpenAI-Use-Sheep': '1' }]) {
    await assert.rejects(transport.request('POST', base, { headers }), fails('INVALID_HEADERS'));
  }
  await assert.rejects(transport.uploadSigned('https://storage.blob.core.windows.net/f?sig=signed', {
    bytes: Buffer.from('file'), requiredHeaders: { 'x-openai-use-sheep': '1' }
  }), fails('INVALID_HEADERS'));
  assert.equal(calls.length, 3);
});
test('signed downloads stay anonymous and preserve byte ranges', async () => {
  const calls = [], transport = new Transport({ authLoader: async () => { throw new Error('must not load auth'); }, fetchImpl: async (url, options) => { calls.push(options); return new Response('ab', { status: 206, headers: { 'content-range': 'bytes 1-2/4' } }); } });
  const response = await transport.fetchSigned('https://files.oaiusercontent.com/file?sig=private', { range: 'bytes=1-2', includeResponse: true });
  assert.deepEqual(response.body, Buffer.from('ab')); assert.equal(response.headers.get('content-range'), 'bytes 1-2/4'); assert.equal(calls[0].headers.Range, 'bytes=1-2');
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].headers['ChatGPT-Account-Id'], undefined); assert.equal(calls[0].signedFile, true);
  for (const url of ['https://attacker.test/file', 'https://files.oaiusercontent.com.evil.test/f', 'http://files.oaiusercontent.com/f', 'https://user@files.oaiusercontent.com/f', 'https://files.oaiusercontent.com:444/f']) await assert.rejects(transport.fetchSigned(url), fails('UNSUPPORTED_FILE_HOST'));
  assert.equal(calls.length, 1);
});
test('signed uploads reject unsigned URLs and never access account credentials', async () => {
  const calls = [], transport = new Transport({ authLoader: async () => { throw new Error('must not load auth'); }, fetchImpl: async (url, options) => { calls.push(options); return new Response('', { status: 201 }); } });
  await transport.uploadSigned('https://storage.blob.core.windows.net/f?sig=signed', { bytes: Buffer.from('file'), contentType: 'application/zip' });
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].headers['ChatGPT-Account-Id'], undefined); assert.equal(calls[0].signedUpload, true); assert.equal(calls[0].redirect, 'manual');
  for (const url of ['https://files.oaiusercontent.com/f', 'https://attacker.test/f?sig=signed', 'http://storage.blob.core.windows.net/f?sig=signed', 'https://storage.blob.core.windows.net/f?sig=signed#fragment']) await assert.rejects(transport.uploadSigned(url, { bytes: Buffer.from('f') }), fails('UNSUPPORTED_FILE_HOST'));
  assert.equal(calls.length, 1);
});
test('regional OpenAI Azure uploads stay anonymous and reject near-match or empty-signature URLs', async () => {
  const calls = [], transport = new Transport({ authLoader: async () => { throw new Error('must not load auth'); }, fetchImpl: async (url, options) => { calls.push(options); return new Response('', { status: 201 }); } });
  await transport.uploadSigned('https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sv=version&sig=signed', { bytes: Buffer.from('file'), contentType: 'application/zip' });
  assert.equal(calls.length, 1); assert.equal(calls[0].signedUpload, true);
  assert.equal(calls[0].headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].headers.Cookie, undefined);
  for (const url of ['https://other.oaiusercontent.com/f?sig=x', 'https://sdmntprcentralus.oaiusercontent.com.evil.test/f?sig=x', 'https://sdmntprcentralus.oaiusercontent.com/f?sig=']) await assert.rejects(transport.uploadSigned(url, { bytes: Buffer.from('f') }), fails('UNSUPPORTED_FILE_HOST'));
  assert.equal(calls.length, 1);
});
test('regional OpenAI signed downloads preserve bytes without loading credentials', async () => {
  const calls = [], transport = new Transport({ authLoader: async () => { throw new Error('must not load auth'); }, fetchImpl: async (url, options) => { calls.push(options); return new Response('file'); } });
  assert.deepEqual(await transport.fetchSigned('https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sig=signed'), Buffer.from('file'));
  assert.equal(calls[0].signedFile, true); assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[0].headers.Cookie, undefined);
  for (const url of ['https://other.oaiusercontent.com/f?sig=x', 'https://sdmntprcentralus.oaiusercontent.com.evil.test/f?sig=x', 'https://sdmntprcentralus.oaiusercontent.com/f?sig=']) await assert.rejects(transport.fetchSigned(url), fails('UNSUPPORTED_FILE_HOST'));
  assert.equal(calls.length, 1);
});

// Execute the real helper in a subprocess, replacing only urllib's opener.
// Any attempted network call is captured locally and returns an in-memory body.
const pythonHarness = String.raw`
import base64, contextlib, io, json, runpy, sys, urllib.request
from email.message import Message
config = json.loads(sys.stdin.read())
calls = []
class Response:
    code = config.get('status', 206)
    headers = Message()
    for key, value in config.get('responseHeaders', {}).items(): headers[key] = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, maximum): return base64.b64decode(config.get('responseBody', 'YWJj'))[:maximum]
class Opener:
    def open(self, request, timeout):
        calls.append({'url': request.full_url, 'method': request.get_method(), 'headers': dict(request.header_items()), 'body': None if request.data is None else base64.b64encode(request.data).decode('ascii')})
        return Response()
urllib.request.build_opener = lambda *args: Opener()
sys.stdin = io.StringIO(json.dumps(config['request']))
out = io.StringIO()
with contextlib.redirect_stdout(out): runpy.run_path(sys.argv[1], run_name='__main__')
sys.stdout.write(json.dumps({'envelope': json.loads(out.getvalue()), 'calls': calls}))
`;
function python(request, options = {}) {
  const result = spawnSync('python3', ['-I', '-c', pythonHarness, fileURLToPath(new URL('../src/http.py', import.meta.url))], { input: JSON.stringify({ request, ...options }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined); return JSON.parse(result.stdout);
}
test('real Python helper preserves redirect, root-thread, and range headers without unrelated headers', () => {
  const result = python({ url: 'https://chatgpt.com/backend-api/file', method: 'GET', headers: { Authorization: 'Bearer fake' }, maxBytes: 100 }, { responseHeaders: {
    location: '/backend-api/next', 'openai-root-thread-id': 'thread-1', 'content-range': 'bytes 2-4/10', 'content-length': '3', 'accept-ranges': 'bytes', 'set-cookie': 'not-returned', 'x-unrelated': 'not-returned'
  } });
  assert.equal(result.calls.length, 1); assert.deepEqual(result.envelope.headers, { location: '/backend-api/next', 'openai-root-thread-id': 'thread-1', 'content-range': 'bytes 2-4/10', 'content-length': '3', 'accept-ranges': 'bytes' }); assert.equal(result.envelope.body, 'YWJj');
});
test('real Python helper allows anonymous signed PUT without forwarding credentials', () => {
  const request = { url: 'https://files.oaiusercontent.com/f?sig=signed', method: 'PUT', headers: { 'Content-Type': 'application/zip' }, bodyBase64: 'YWJj', signedUpload: true };
  const result = python(request); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].method, 'PUT'); assert.equal(result.calls[0].body, 'YWJj');
  for (const headers of [{ authorization: 'secret' }, { Cookie: 'secret' }, { 'CHATGPT-ACCOUNT-ID': 'a' }]) {
    const blocked = python({ ...request, headers }); assert.equal(blocked.calls.length, 0); assert.equal(blocked.envelope.error, 'NETWORK_ERROR');
  }
});
test('real Python helper validates the regional OpenAI Azure upload host and signature', () => {
  const request = { url: 'https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sig=signed', method: 'PUT', headers: { 'Content-Type': 'application/zip' }, bodyBase64: 'YWJj', signedUpload: true };
  assert.equal(python(request).calls.length, 1);
  for (const patch of [
    { headers: { Authorization: 'secret' } },
    { url: 'https://sdmntprcentralus.oaiusercontent.com.evil.test/f?sig=signed' },
    { url: 'https://sdmntprcentralus.oaiusercontent.com/f?sig=' },
    { method: 'POST' }
  ]) { const result = python({ ...request, ...patch }); assert.equal(result.calls.length, 0); assert.equal(result.envelope.error, 'NETWORK_ERROR'); }
});
test('real Python helper allows only anonymous signed regional downloads', () => {
  const request = { url: 'https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sig=signed', method: 'GET', headers: {}, signedFile: true };
  assert.equal(python(request).calls.length, 1);
  for (const patch of [{ headers: { Authorization: 'secret' } }, { method: 'DELETE' }, { url: 'https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sig=' }]) {
    const result = python({ ...request, ...patch }); assert.equal(result.calls.length, 0); assert.equal(result.envelope.error, 'NETWORK_ERROR');
  }
});
test('real Python helper rejects wrong signed hosts and methods before opening a URL', () => {
  for (const request of [
    { url: 'https://evil.test/f?sig=x', method: 'PUT', headers: {}, signedUpload: true },
    { url: 'https://files.oaiusercontent.com/f?sig=x', method: 'POST', headers: {}, signedUpload: true },
    { url: 'https://files.oaiusercontent.com/f', method: 'GET', headers: { Authorization: 'secret' }, signedFile: true },
    { url: 'https://files.oaiusercontent.com/f', method: 'DELETE', headers: {}, signedFile: true },
    { url: 'https://realtime.chatgpt.com/v1/other', method: 'POST', headers: { 'Content-Type': 'application/sdp' }, realtimeSdp: true }
  ]) { const result = python(request); assert.equal(result.calls.length, 0); assert.equal(result.envelope.error, 'NETWORK_ERROR'); }
});
test('real Python helper accepts only fixed source-specific realtime query contracts', () => {
  const request = { url: 'https://realtime.chatgpt.com/v1/cua?source=aeon&thread_id=t&aeon_id=a', method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: SDP, realtimeSdp: true };
  assert.equal(python(request).calls.length, 1);
  assert.equal(python({ ...request, url: 'https://realtime.chatgpt.com/v1/cua?source=flora&cid=c' }).calls.length, 1);
  for (const query of ['source=other&cid=c', 'source=aeon&thread_id=t', 'source=flora&cid=c&extra=x', 'source=flora&cid=c&cid=d', 'source=aeon&thread_id=t&aeon_id=..', '']) {
    const result = python({ ...request, url: `https://realtime.chatgpt.com/v1/cua?${query}` }); assert.equal(result.calls.length, 0, query); assert.equal(result.envelope.error, 'NETWORK_ERROR');
  }
});
