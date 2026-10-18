import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.mjs';
import { DotOperations } from '../src/operations.mjs';
import { normalizeNativeTools, nativeToolBinding } from '../src/mcp-catalog.mjs';
import { callNativeTool, hasNativeWidgetTemplate } from '../src/mcp-native-call.mjs';
import { DotError } from '../src/errors.mjs';

const context = { connectorId: 'connector-1', linkId: 'link-1' };
const accountId = 'account-1';
const token = `a.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.s`;
function nativeDescriptor() {
  return { name: 'vercel.open_deployments', description: 'Open deployment view',
    inputSchema: { type: 'object', properties: { link_id: { type: 'string' }, projectId: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['link_id', 'projectId'], additionalProperties: false },
    _meta: { connector_id: context.connectorId, link_id: context.linkId, resource_name: 'vercel.open_deployments', link_accounts: [{ link_id: 'link-1' }, { link_id: 'link-2' }],
      ui: { resourceUri: 'ui://vercel/app-v1' }, _codex_apps: { resource_uri: '/connector-1/link-1/open_deployments', requires_explicit_link_id: true, contains_mcp_source: true } } };
}
function descriptor(mutate) {
  const value = nativeDescriptor(); mutate?.(value);
  return normalizeNativeTools({ tools: [value] }, context).tools[0];
}
function setup(behavior) {
  const calls = [], auth = { accountId, accessToken: token };
  let firstRequestResolve;
  const firstRequest = new Promise(resolve => { firstRequestResolve = resolve; });
  const transport = new Transport({ authLoader: async () => auth, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url: String(url), options, body }); firstRequestResolve();
    if (behavior) return behavior(body, options, calls);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Ready' }], isError: false } });
  } });
  const invoke = (options = {}) => callNativeTool(transport, { descriptor: descriptor(), ...context, arguments: { projectId: 'project-1' }, expectedAccountId: accountId, ...options });
  return { transport, calls, auth, firstRequest, invoke, ops: new DotOperations({ transport }) };
}
async function flushed() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
const code = value => error => error.code === value;

test('native UI-template discovery accepts either advertised field', () => {
  assert.equal(hasNativeWidgetTemplate(nativeDescriptor()), true);
  assert.equal(hasNativeWidgetTemplate({ _meta: { 'openai/outputTemplate': 'ui://provider/app' } }), true);
  assert.equal(hasNativeWidgetTemplate({ _meta: { ui: { resourceUri: ' ' } } }), false);
  assert.equal(hasNativeWidgetTemplate({}), false);
});

test('native tool call retains qualified name, exact routing metadata and protocol capabilities', async () => {
  const h = setup(); const result = await h.invoke();
  assert.equal(result.isError, false); assert.equal(result.content[0].text, 'Ready'); assert.equal(h.calls.length, 1);
  const { url, body, options } = h.calls[0];
  assert.equal(new URL(url).pathname, '/backend-api/ps/mcp');
  assert.equal(body.jsonrpc, '2.0'); assert.equal(body.method, 'tools/call');
  assert.match(body.id, /^[a-f0-9-]{36}$/); assert.equal(body.params.name, 'vercel.open_deployments');
  assert.deepEqual(body.params.arguments, { projectId: 'project-1', link_id: 'link-1' });
  assert.deepEqual(body.params._meta._codex_apps, nativeDescriptor()._meta._codex_apps);
  assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.deepEqual(body.params._meta['io.modelcontextprotocol/clientCapabilities'], { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } });
  assert.equal(options.headers['OAI-Product-Sku'], 'CODEX');
  assert.equal(new Headers(options.headers).get('chatgpt-account-id'), accountId);
  assert.equal(Object.hasOwn(body, 'requestState'), false); assert.equal(Object.hasOwn(body, 'inputResponses'), false);
  assert.deepEqual(body.params._meta['x-codex-turn-metadata'], { source: 'mcp_app' });
  assert.doesNotMatch(JSON.stringify(body), /thread_id|conversation_id|message_id/);
});

test('native alternate advertised link selection injects the selected synthetic argument', async () => {
  const h = setup(); await h.invoke({ linkId: 'link-2' });
  assert.equal(h.calls[0].body.params.arguments.link_id, 'link-2');
  assert.equal(h.calls[0].body.params._meta._codex_apps.resource_uri, '/connector-1/link-1/open_deployments');
});

test('a genuine provider link argument is preserved when no synthetic selector is declared', async () => {
  const tool = descriptor(value => { value._meta._codex_apps.requires_explicit_link_id = false; });
  const h = setup(); await h.invoke({ descriptor: tool, linkId: 'link-1', arguments: { projectId: 'project-1', link_id: 'provider-resource-1' } });
  assert.equal(h.calls[0].body.params.arguments.link_id, 'provider-resource-1');
  assert.equal(h.calls[0].body.params._meta._codex_apps.requires_explicit_link_id, false);
});

test('nonsynthetic native tools reject alternate account links before sending', async () => {
  const raw = nativeDescriptor(); raw._meta._codex_apps.requires_explicit_link_id = false;
  const h = setup();
  for (const selectedAtCatalog of ['link-1', 'link-2']) {
    const tool = normalizeNativeTools({ tools: [raw] }, { connectorId: 'connector-1', linkId: selectedAtCatalog }).tools[0];
    await assert.rejects(h.invoke({ descriptor: tool, linkId: 'link-2', arguments: { projectId: 'project-1', link_id: 'provider-resource-1' } }), code('CONNECTION_UNAVAILABLE'));
    if (selectedAtCatalog === 'link-2') await assert.rejects(h.invoke({ descriptor: tool, linkId: undefined, arguments: { projectId: 'project-1', link_id: 'provider-resource-1' } }), code('CONNECTION_UNAVAILABLE'));
  }
  assert.equal(h.calls.length, 0);
});

test('a conflicting synthetic account argument cannot send a request', async () => {
  const h = setup();
  await assert.rejects(h.invoke({ arguments: { projectId: 'project-1', link_id: 'link-2' } }), code('INVALID_ARGUMENT'));
  await assert.rejects(h.invoke({ linkId: 'unadvertised' }), code('CONNECTION_UNAVAILABLE'));
  assert.equal(h.calls.length, 0);
});

test('only bound native descriptors for the selected connector can invoke a tool', async () => {
  const h = setup();
  for (const value of [nativeDescriptor(), structuredClone(descriptor()), { name: 'open_deployments', inputSchema: {} }]) {
    await assert.rejects(h.invoke({ descriptor: value }), code('INVALID_ARGUMENT'));
  }
  await assert.rejects(h.invoke({ connectorId: 'another-connector' }), code('INVALID_ARGUMENT'));
  const renamed = descriptor(); renamed.name = 'other-action';
  await assert.rejects(h.invoke({ descriptor: renamed }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('schema validation rejects types, required fields and extra fields before network', async () => {
  const h = setup();
  for (const value of [{}, { projectId: 123 }, { projectId: '' }, { projectId: 'project-1', count: 11 }, { projectId: 'project-1', extra: true }]) {
    await assert.rejects(h.invoke({ arguments: value }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('argument validation preserves caller input without inserting a synthetic link in place', async () => {
  const h = setup(), args = { projectId: 'project-1', count: 2 };
  await h.invoke({ arguments: args });
  assert.deepEqual(args, { projectId: 'project-1', count: 2 });
  assert.equal(h.calls[0].body.params.arguments.count, 2);
});

test('non-JSON arguments and remote schemas cannot send a request', async () => {
  const h = setup();
  const cyclic = { projectId: 'project-1' }; cyclic.self = cyclic;
  for (const value of [cyclic, [], { projectId: 'project-1', count: NaN }, Object.assign(Object.create({ private: true }), { projectId: 'project-1' })]) {
    await assert.rejects(h.invoke({ arguments: value }), code('INVALID_ARGUMENT'));
  }
  const tool = descriptor(value => { value.inputSchema = { $ref: 'https://schema.example/private.json', properties: { link_id: { type: 'string' } } }; });
  await assert.rejects(h.invoke({ descriptor: tool }), code('UNSUPPORTED_ACTION'));
  assert.equal(h.calls.length, 0);
});

test('TPP native calls pass real transport product-header validation', async () => {
  const h = setup(); await h.invoke({ productSku: 'TPP' });
  assert.equal(h.calls[0].options.headers['OAI-Product-Sku'], 'TPP');
  await assert.rejects(h.invoke({ productSku: 'CHATGPT_PROJECTS' }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 1);
});

test('native JSON-RPC envelopes require the exact request ID and one result or error', async () => {
  for (const make of [
    body => ({ jsonrpc: '1.0', id: body.id, result: {} }),
    body => ({ jsonrpc: '2.0', id: 'another-request', result: {} }),
    body => ({ jsonrpc: '2.0', id: body.id, result: {}, error: { code: -1, message: 'bad' } }),
    body => ({ jsonrpc: '2.0', id: body.id }),
    body => ({ jsonrpc: '2.0', id: body.id, result: null }),
    body => ({ jsonrpc: '2.0', id: body.id, result: [] }),
  ]) {
    const h = setup(body => Response.json(make(body)));
    await assert.rejects(h.invoke(), code('INVALID_RESPONSE')); assert.equal(h.calls.length, 1);
  }
});

test('native JSON-RPC errors expose only the bounded error code and are not retried', async () => {
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'SECRET_PROVIDER_ERROR', data: { requestState: 'PRIVATE_STATE' } } }));
  await assert.rejects(h.invoke(), error => error.code === 'MCP_ERROR' && error.details.jsonRpcCode === -32602 && !/SECRET_PROVIDER_ERROR|PRIVATE_STATE/.test(JSON.stringify(error)));
  assert.equal(h.calls.length, 1);
  for (const value of [{ code: 'bad', message: 'error' }, { code: 1.5, message: 'error' }, { code: 1 }]) {
    const invalid = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, error: value }));
    await assert.rejects(invalid.invoke(), code('INVALID_RESPONSE')); assert.equal(invalid.calls.length, 1);
  }
});

test('actual native input requests return a safe pending result without guessing an answer', async () => {
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: { private: { message: 'PRIVATE_QUESTION', requestedSchema: {} } }, content: [{ type: 'text', text: 'NOT_DONE' }] } }));
  const result = await h.invoke();
  assert.equal(result.resultType, 'input_required'); assert.equal(result.requiresNativeContinuation, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STATE|PRIVATE_QUESTION|NOT_DONE|inputRequests/);
  assert.equal(h.calls.length, 1);
});

test('malformed input requests and pending states are rejected without continuation', async () => {
  for (const result of [
    { resultType: 'input_required', inputRequests: {} },
    { resultType: 'input_required', requestState: '', inputRequests: {} },
    { resultType: 'input_required', requestState: 'x'.repeat(65537), inputRequests: {} },
    { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: [] },
    { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: JSON.parse('{"__proto__":{}}') },
  ]) {
    const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result }));
    await assert.rejects(h.invoke(), error => error.code === 'INVALID_RESPONSE' && !JSON.stringify(error).includes('PRIVATE_STATE'));
    assert.equal(h.calls.length, 1);
  }
});

test('network and edge failures never retry or fallback to the legacy route', async () => {
  for (const behavior of [
    () => { throw new Error('connection reset'); },
    () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
  ]) {
    const h = setup(behavior);
    await assert.rejects(h.invoke()); assert.equal(h.calls.length, 1);
    assert.equal(new URL(h.calls[0].url).pathname, '/backend-api/ps/mcp');
  }
});

test('native calls preserve the ordinary 10 MiB transport response bound', async () => {
  const h = setup(() => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); } })));
  await assert.rejects(h.invoke(), code('RESPONSE_TOO_LARGE')); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.maxBytes, 10 * 1024 * 1024);
});

test('an aborted or invalidated identity cannot begin a native tool call', async () => {
  const h = setup(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.invoke({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(h.invoke({ assertCurrent: () => { throw new DotError('AUTH_IDENTITY_CHANGED', 'identity changed'); } }), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.calls.length, 0);
});

test('generic UI-producing tools use the native route after catalog verification', async () => {
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [nativeDescriptor()] } : { content: [{ type: 'text', text: 'Native UI ready' }], isError: false } }));
  const result = await h.ops.toolCall({ ...context, name: 'open_deployments', arguments: { projectId: 'project-1' }, threadId: 'thread-1', conversationId: 'conversation-1', messageId: 'message-1' });
  assert.equal(result.content[0].text, 'Native UI ready'); assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => new URL(call.url).pathname === '/backend-api/ps/mcp'));
  assert.equal(h.calls[1].body.params.name, 'vercel.open_deployments');
  assert.doesNotMatch(JSON.stringify(h.calls[1].body), /thread-1|conversation-1|message-1|thread_id|conversation_id|message_id/);
});

test('published routing identity and selector flags cannot be changed after normalization', async () => {
  const h = setup();
  for (const mutate of [
    value => { value._meta._codex_apps.resource_uri = '/connector-1/link-2/open_deployments'; },
    value => { value._meta._codex_apps.requires_explicit_link_id = false; },
    value => { delete value._meta._codex_apps.contains_mcp_source; },
    value => { value._meta.resource_name = 'vercel.other'; },
    value => { value._meta._codex_apps = Object.assign(Object.create({ private: true }), value._meta._codex_apps); },
  ]) {
    const value = descriptor(); mutate(value);
    await assert.rejects(h.invoke({ descriptor: value }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('unknown routing metadata is not forwarded and private native bindings remain frozen', async () => {
  const value = descriptor(tool => { tool._meta._codex_apps.untrusted = { access_token: 'PRIVATE_ROUTING' }; });
  const binding = nativeToolBinding(value);
  assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.linkIds)); assert.ok(Object.isFrozen(binding.routingMetadata));
  assert.throws(() => binding.linkIds.push('other-link'), TypeError);
  const h = setup(); await h.invoke({ descriptor: value });
  assert.doesNotMatch(JSON.stringify(h.calls[0].body), /PRIVATE_ROUTING|untrusted/);
});

test('completed results discard continuation capabilities without losing tool content', async () => {
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Done' }], isError: false,
    requestState: 'PRIVATE_STATE', inputRequests: { secret: {} }, inputResponses: { secret: 'PRIVATE_REPLY' } } }));
  const result = await h.invoke();
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Done' }], isError: false });
});

test('stable pending state is continued with the same arguments until completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let round = 0;
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: round++ < 2
    ? { resultType: 'input_required', requestState: 'PRIVATE_STABLE_STATE', inputRequests: {} }
    : { content: [{ type: 'text', text: 'Done' }], isError: false } }));
  const pending = h.invoke(); await h.firstRequest; await flushed();
  assert.equal(h.calls.length, 1); t.mock.timers.tick(1000); await flushed();
  assert.equal(h.calls.length, 2); t.mock.timers.tick(1000);
  const result = await pending; assert.equal(result.content[0].text, 'Done'); assert.equal(h.calls.length, 3);
  const [initial, second, third] = h.calls.map(call => call.body);
  assert.notEqual(initial.id, second.id); assert.notEqual(second.id, third.id);
  assert.deepEqual(second.params, initial.params); assert.deepEqual(third.params, initial.params);
  assert.equal(second.requestState, 'PRIVATE_STABLE_STATE'); assert.equal(third.requestState, second.requestState);
  assert.deepEqual(second.inputResponses, {}); assert.deepEqual(third.inputResponses, {});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STABLE_STATE/);
});

test('native tool continuations stop at 32 responses without restarting the original call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } }));
  const pending = assert.rejects(h.invoke(), code('CONTINUATION_LIMIT')); await h.firstRequest; await flushed();
  for (let i = 0; i < 31; i++) { t.mock.timers.tick(1000); await flushed(); }
  await pending; assert.equal(h.calls.length, 32);
  assert.equal(h.calls.filter(call => !Object.hasOwn(call.body, 'requestState')).length, 1);
});

test('aborting pending native input polling sends no further call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } }));
  const pending = assert.rejects(h.invoke({ signal: controller.signal }), { name: 'AbortError' });
  await h.firstRequest; await flushed(); controller.abort(); await pending;
  t.mock.timers.tick(1000); await flushed(); assert.equal(h.calls.length, 1);
});

test('identity is revalidated before each native continuation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let invalidated = false;
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } }));
  const pending = assert.rejects(h.invoke({ assertCurrent: () => { if (invalidated) throw new DotError('AUTH_IDENTITY_CHANGED', 'identity changed'); } }), code('AUTH_IDENTITY_CHANGED'));
  await h.firstRequest; await flushed(); invalidated = true; t.mock.timers.tick(1000); await pending;
  assert.equal(h.calls.length, 1);
});

test('network failure during acknowledged continuation never replays the initial call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let round = 0;
  const h = setup(body => {
    if (round++) throw new Error('continuation connection reset');
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'PRIVATE_STATE', inputRequests: {} } });
  });
  const pending = assert.rejects(h.invoke(), code('NETWORK_ERROR'));
  await h.firstRequest; await flushed(); t.mock.timers.tick(1000); await pending;
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].body.requestState, 'PRIVATE_STATE');
});

test('generic native UI errors never fall back to the legacy ecosystem route', async () => {
  const h = setup(body => {
    if (body.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [nativeDescriptor()] } });
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'PRIVATE_PROVIDER_ERROR' } });
  });
  await assert.rejects(h.ops.toolCall({ ...context, name: 'open_deployments', arguments: { projectId: 'project-1' } }), code('MCP_ERROR'));
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(call => new URL(call.url).pathname === '/backend-api/ps/mcp'));
});

test('generic native UI dispatch resolves a connector supplied only as appUri', async () => {
  const h = setup(body => Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list'
    ? { tools: [nativeDescriptor()] } : { content: [{ type: 'text', text: 'Done' }], isError: false } }));
  const result = await h.ops.toolCall({ appUri: 'connectors://connector-1', linkId: 'link-1', name: 'open_deployments', arguments: { projectId: 'project-1' } });
  assert.equal(result.isError, false); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.params.name, 'vercel.open_deployments');
});

test('generic native UI dispatch pins identity before discovery even for a custom transport', async () => {
  const calls = [], auth = { accountId, accessToken: token };
  const transport = { authLoader: async () => auth, async request(method, route, options) {
    calls.push({ method, route, options });
    auth.accessToken = `a.${Buffer.from(JSON.stringify({ sub: 'different-user' })).toString('base64url')}.s`;
    return { jsonrpc: '2.0', id: options.body.id, result: { tools: [nativeDescriptor()] } };
  } };
  const ops = new DotOperations({ transport });
  await assert.rejects(ops.toolCall({ ...context, name: 'open_deployments', arguments: { projectId: 'project-1' } }), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.body.method, 'tools/list');
});

test('a native result cannot be returned under a different authenticated user', async () => {
  let h;
  h = setup(body => {
    h.auth.accessToken = `a.${Buffer.from(JSON.stringify({ sub: 'different-user' })).toString('base64url')}.s`;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'PRIVATE_NEW_USER_CONTENT' }] } });
  });
  await assert.rejects(h.invoke(), error => error.code === 'AUTH_IDENTITY_CHANGED' && !JSON.stringify(error).includes('PRIVATE_NEW_USER_CONTENT'));
  assert.equal(h.calls.length, 1);
});
