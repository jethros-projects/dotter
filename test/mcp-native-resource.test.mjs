import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.mjs';
import { DotOperations } from '../src/operations.mjs';
import { readNativeResource } from '../src/mcp-native-call.mjs';

const context = { connectorId: 'connector-1', linkId: 'link-1' };
const accountId = 'account-1';
const uri = 'ui://provider/dynamic/session-123/widget.html?version=2';
const token = subject => `a.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.s`;
const code = value => error => error.code === value;
const link = (overrides = {}) => ({ id: context.linkId, connector_id: context.connectorId, auth_status: 'ACTIVE', connector_status: 'ENABLED', unavailable_reason: null, ...overrides });
function setup(behavior) {
  const calls = [], auth = { accountId, accessToken: token('user-1') };
  let links = [link()], firstReadResolve;
  const firstRead = new Promise(resolve => { firstReadResolve = resolve; });
  const transport = new Transport({ authLoader: async () => auth, fetchImpl: async (url, options) => {
    const route = new URL(url).pathname, body = JSON.parse(options.body);
    const call = { route, body, options }; calls.push(call);
    if (route === '/backend-api/ps/mcp') firstReadResolve();
    const custom = await behavior?.(call, calls);
    if (custom !== undefined) return custom;
    if (route === '/backend-api/aip/connectors/links/list_accessible') return Response.json({ links });
    if (route === '/backend-api/ps/mcp') return Response.json({ jsonrpc: '2.0', id: body.id, result: { contents: [{ uri: body.params.uri, mimeType: 'text/html', text: '<div>Dynamic widget</div>' }] } });
    if (route === '/backend-api/ecosystem/call_mcp') return Response.json({ contents: [{ uri: body.params.uri, text: 'Legacy result' }] });
    throw new Error('Unexpected test route');
  } });
  return { calls, auth, transport, firstRead, ops: new DotOperations({ transport }), setLinks: value => { links = value; },
    read: (options = {}) => readNativeResource(transport, { ...context, uri, expectedAccountId: accountId, ...options }) };
}
async function flushed() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }

test('dynamic UI resource reads need a verified exact link but no tool catalog', async () => {
  const h = setup(), result = await h.read();
  assert.equal(result.contents[0].uri, uri); assert.equal(result.contents[0].text, '<div>Dynamic widget</div>');
  assert.deepEqual(h.calls.map(call => call.route), ['/backend-api/aip/connectors/links/list_accessible', '/backend-api/ps/mcp']);
  assert.ok(h.calls.every(call => call.body.method !== 'tools/list'));
  const [discovery, read] = h.calls;
  assert.deepEqual(discovery.body, { principals: [], link_refresh_strategy: 'NONE' });
  assert.equal(discovery.options.headers['OAI-Product-Sku'], 'CODEX');
  assert.equal(discovery.options.headers['X-Codex-Surface'], 'other');
  assert.equal(read.options.headers['OAI-Product-Sku'], 'CODEX');
  assert.equal(new Headers(read.options.headers).get('chatgpt-account-id'), accountId);
  assert.equal(read.body.method, 'resources/read'); assert.equal(read.body.jsonrpc, '2.0'); assert.match(read.body.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(read.body.params, { uri, _meta: { connector_id: context.connectorId, link_id: context.linkId,
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } },
    'x-codex-turn-metadata': {} } });
  assert.equal(Object.hasOwn(read.body, 'requestState'), false);
});

test('native resources reject missing identities and malformed UI URIs before any request', async () => {
  const h = setup();
  for (const options of [
    { connectorId: undefined }, { linkId: undefined }, { connectorId: '../other' }, { linkId: '.' },
    { uri: 'https://provider.example/widget.html' }, { uri: 'ui:/provider/widget.html' }, { uri: 'ui://' },
    { uri: 'ui://user:password@provider/widget.html' }, { uri: 'ui://provider/bad%path' },
    { uri: 'ui://provider/line\nbreak' }, { uri: `ui://provider/${'x'.repeat(8192)}` },
  ]) await assert.rejects(h.read(options), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('native resource link checks reject hidden, disabled, expired and unavailable exact links', async () => {
  for (const current of [
    link({ id: 'other-link' }), link({ connector_id: 'other-connector' }),
    link({ visibility: 'HIDDEN' }), link({ visibility: 'hidden' }), link({ hidden: true }), link({ is_hidden: true }),
    link({ auth_status: 'EXPIRED' }), link({ connector_status: 'DISABLED' }), link({ connector_status: 'DISABLED_BY_ADMIN' }),
    link({ unavailable_reason: 'needs_reconnect' }),
  ]) {
    const h = setup(); h.setLinks([current]);
    await assert.rejects(h.read(), code('CONNECTION_UNAVAILABLE'));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].route, '/backend-api/aip/connectors/links/list_accessible');
  }
});

test('resource discovery rejects duplicate exact links and malformed link collections', async () => {
  const duplicate = setup(); duplicate.setLinks([link(), link()]);
  await assert.rejects(duplicate.read(), code('INVALID_RESPONSE')); assert.equal(duplicate.calls.length, 1);
  const malformed = setup(call => call.route.endsWith('/links/list_accessible') ? Response.json({ links: {} }) : undefined);
  await assert.rejects(malformed.read(), code('INVALID_RESPONSE')); assert.equal(malformed.calls.length, 1);
});

test('native resource contents must match the exact requested dynamic URI', async () => {
  for (const result of [{ contents: {} }, { contents: [null] }, { contents: [{ uri: 'ui://provider/other', text: 'PRIVATE_OTHER_RESOURCE' }] }, {}]) {
    const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result }) : undefined);
    await assert.rejects(h.read(), error => error.code === 'INVALID_RESPONSE' && !JSON.stringify(error).includes('PRIVATE_OTHER_RESOURCE'));
    assert.equal(h.calls.length, 2);
  }
});

test('native resource contents require one typed text or canonical base64 blob payload', async () => {
  for (const content of [
    { uri }, { uri, text: null }, { uri, text: 1 }, { uri, blob: null }, { uri, blob: {} },
    { uri, text: 'text', blob: 'YQ==' }, { uri, text: '', mimeType: null }, { uri, blob: '', mimeType: 123 },
    { uri, blob: 'not-base64!' }, { uri, blob: 'YQ' }, { uri, blob: 'YR==' }, { uri, blob: 'YQ==\n' },
  ]) {
    const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: { contents: [content] } }) : undefined);
    await assert.rejects(h.read(), code('INVALID_RESPONSE'));
    assert.equal(h.calls.length, 2);
  }
});

test('empty text and blob payloads remain valid and preserve resource metadata', async () => {
  for (const content of [
    { uri, text: '', mimeType: 'text/html', _meta: { ui: { prefersBorder: true } }, custom: ['preserve', 1] },
    { uri, blob: '', mimeType: 'application/octet-stream', _meta: { source: 'empty-fixture' } },
    { uri, blob: 'YQ==', mimeType: 'application/octet-stream', description: 'One byte' },
  ]) {
    const result = { contents: [content], _meta: { providerVersion: 'fixture' } };
    const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result }) : undefined);
    assert.deepEqual(await h.read(), result);
  }
});

test('native resources validate JSON-RPC identity and return sanitized protocol errors', async () => {
  const wrong = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: 'other-request', result: { contents: [] } }) : undefined);
  await assert.rejects(wrong.read(), code('INVALID_RESPONSE'));
  const error = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, error: { code: -32603, message: 'PRIVATE_PROVIDER_ERROR', data: { credential: 'PRIVATE_TOKEN' } } }) : undefined);
  await assert.rejects(error.read(), value => value.code === 'MCP_ERROR' && value.details.jsonRpcCode === -32603 && !/PRIVATE_PROVIDER_ERROR|PRIVATE_TOKEN/.test(JSON.stringify(value)));
  assert.equal(error.calls.length, 2);
});

test('interactive resource input stays pending without exposing opaque continuation data', async () => {
  const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: {
    resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: { private: { message: 'PRIVATE_QUESTION' } }, contents: [{ uri, text: 'NOT_READY' }],
  } }) : undefined);
  const result = await h.read();
  assert.equal(result.resultType, 'input_required'); assert.equal(result.requiresNativeContinuation, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STATE|PRIVATE_QUESTION|NOT_READY|inputRequests/);
  assert.equal(h.calls.length, 2);
});

test('native resource continuation repeats only the acknowledged state and rechecks the exact link', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let round = 0;
  const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: round++ === 0
    ? { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} }
    : { contents: [{ uri, text: 'Ready' }] } }) : undefined);
  const pending = h.read(); await h.firstRead; await flushed(); t.mock.timers.tick(1000);
  const result = await pending; assert.equal(result.contents[0].text, 'Ready');
  assert.deepEqual(h.calls.map(call => call.route), ['/backend-api/aip/connectors/links/list_accessible', '/backend-api/ps/mcp', '/backend-api/aip/connectors/links/list_accessible', '/backend-api/ps/mcp']);
  const first = h.calls[1].body, second = h.calls[3].body;
  assert.notEqual(first.id, second.id); assert.deepEqual(first.params, second.params);
  assert.equal(second.requestState, 'PRIVATE_STATE'); assert.deepEqual(second.inputResponses, {});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STATE/);
});

test('revoked resource access during continuation stops before a second resource read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } }) : undefined);
  const pending = assert.rejects(h.read(), code('CONNECTION_UNAVAILABLE'));
  await h.firstRead; await flushed(); h.setLinks([link({ auth_status: 'EXPIRED' })]); t.mock.timers.tick(1000); await pending;
  assert.equal(h.calls.filter(call => call.route === '/backend-api/ps/mcp').length, 1);
  assert.equal(h.calls.filter(call => call.route.endsWith('/links/list_accessible')).length, 2);
});

test('native resource cancellation stops pending reads without another request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const h = setup(call => call.route === '/backend-api/ps/mcp' ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } }) : undefined);
  const pending = assert.rejects(h.read({ signal: controller.signal }), { name: 'AbortError' });
  await h.firstRead; await flushed(); controller.abort(); await pending;
  t.mock.timers.tick(1000); await flushed(); assert.equal(h.calls.length, 2);
});

test('identity changes after resource response cannot return its contents', async () => {
  let h;
  h = setup(call => {
    if (call.route !== '/backend-api/ps/mcp') return;
    h.auth.accessToken = token('other-user');
    return Response.json({ jsonrpc: '2.0', id: call.body.id, result: { contents: [{ uri, text: 'PRIVATE_OTHER_USER_CONTENT' }] } });
  });
  await assert.rejects(h.read(), error => error.code === 'AUTH_IDENTITY_CHANGED' && !JSON.stringify(error).includes('PRIVATE_OTHER_USER_CONTENT'));
  assert.equal(h.calls.length, 2);
});

test('native resource transport failures never retry or use the legacy route', async () => {
  for (const failure of [() => { throw new Error('connection reset'); }, () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } })]) {
    const h = setup(call => call.route === '/backend-api/ps/mcp' ? failure() : undefined);
    await assert.rejects(h.read()); assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.route !== '/backend-api/ecosystem/call_mcp'));
  }
});

test('dynamic native resource reads preserve the ordinary 10 MiB response bound', async () => {
  const h = setup(call => call.route === '/backend-api/ps/mcp' ? new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close();
  } })) : undefined);
  await assert.rejects(h.read(), code('RESPONSE_TOO_LARGE'));
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].options.maxBytes, 10 * 1024 * 1024);
});

test('generic UI resource reads use native routing without carrying supplied chat context', async () => {
  const h = setup();
  const result = await h.ops.resourceRead({ appUri: 'connectors://connector-1', linkId: context.linkId, uri,
    threadId: 'thread-1', conversationId: 'conversation-1', messageId: 'message-1' });
  assert.equal(result.contents[0].uri, uri); assert.equal(h.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(h.calls[1].body), /thread-1|conversation-1|message-1|thread_id|conversation_id|message_id/);
  assert.ok(h.calls.every(call => call.body.method !== 'tools/list'));
});

test('generic non-UI resources retain existing legacy behavior', async () => {
  const h = setup(), legacyUri = 'resource://provider/report';
  const result = await h.ops.resourceRead({ ...context, uri: legacyUri, threadId: 'thread-1' });
  assert.equal(result.contents[0].uri, legacyUri);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].route, '/backend-api/ecosystem/call_mcp');
  assert.equal(h.calls[0].body.thread_id, 'thread-1');
});
