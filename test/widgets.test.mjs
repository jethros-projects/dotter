import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DotWidgets } from '../src/widgets.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';
import { commands, createClient } from '../src/command-sets/widgets.mjs';
const token = sub => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
const ARG = { threadId: 'thread-1', messageId: 'message-1', attachmentId: 'attachment-1' };
function fixtureMessage(changes = {}) {
  return { id: 'message-1', created_at: '2026-10-18T10:00:00Z', raw_messages: [], attachments: [{ type: 'widget', product_sku: 'aeon', attachment_id: 'attachment-1', original_message_id: 'original-1', messages: [
    { id: 'original-1', author: { role: 'assistant' }, metadata: { chatgpt_sdk: { html_asset_pointer: 'ui://widget/app.html', resolved_pineapple_uri: 'connectors://connector-1', attribution_id: 'connector-1', link_id: 'link-1', widget_session_id: 'session-1', action_name: 'render', tool_title: 'Example' } } },
    { id: 'tool-1', author: { role: 'tool' }, content: { content_type: 'text', parts: [JSON.stringify({ content: [{ type: 'text', text: 'visible' }], _meta: { hidden: 'do not display' } })] } }
  ] }], ...changes };
}
function fake() {
  const f = { calls: [], auth: { accountId: 'account-1', accessToken: token('user-1') }, items: [fixtureMessage()],
    links: [{ id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' }],
    results: { 'tools/list': { tools: [{ name: 'render', _meta: { _codex_apps: { resource_uri: '/connector-1/link-1/render' } }, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }, 'resources/list': { resources: [{ uri: 'ui://widget/data' }] }, 'resources/templates/list': { resourceTemplates: [{ uriTemplate: 'ui://widget/{id}' }] }, 'prompts/list': { prompts: [{ name: 'explain' }] }, 'resources/read': { contents: [{ uri: 'ui://widget/data', text: 'hello' }] }, 'tools/call': { content: [{ type: 'text', text: 'done' }], structuredContent: { okay: true }, _meta: { secret: 'invisible' } } } };
  f.transport = { authLoader: async () => ({ ...f.auth }), request: async (method, route, options) => {
    f.calls.push({ method, route, options });
    if (f.before) await f.before(method, route, options);
    if (route === '/backend-api/tbo/by-thread/thread-1') return { messaging_room_id: f.profileRoom ?? 'room-1' };
    if (route === '/backend-api/messaging/rooms/room-1/messages') return f.history ? f.history(options.query) : { items: structuredClone(f.items) };
    if (route === '/backend-api/aip/connectors/links/list_accessible') return { links: f.links };
    if (route === '/backend-api/ecosystem/call_mcp') { const result = f.results[options.body.method]; if (result instanceof Error) throw result; return structuredClone(result); }
    if (route === '/backend-api/ps/mcp') {
      if (f.psResponse) return f.psResponse(options.body);
      const result = f.results[options.body.method]; if (result instanceof Error) throw result;
      return { jsonrpc: '2.0', id: options.body.id, result: structuredClone(result) };
    }
    throw Error(`Unexpected ${route}`);
  } };
  f.widgets = new DotWidgets({ transport: f.transport });
  f.inspect = () => f.widgets.inspect(ARG);
  f.bound = async () => ({ ...ARG, requestFingerprint: (await f.inspect()).requestFingerprint });
  return f;
}
const mcpCalls = f => f.calls.filter(call => call.route === '/backend-api/ecosystem/call_mcp');
const psCalls = f => f.calls.filter(call => call.route === '/backend-api/ps/mcp');
function native(sku = 'CODEX') { const f = fake(); f.items[0].attachments[0].product_sku = sku; return f; }
async function flushed() { await new Promise(setImmediate); }

test('widget inspection exposes exact context and fingerprint without raw tool messages', async () => {
  const f = fake(), result = await f.inspect();
  assert.equal(result.accountId, 'account-1'); assert.equal(result.roomId, 'room-1'); assert.equal(result.requestFingerprint.length, 64);
  assert.equal(result.widgetMessageId, 'tool-1'); assert.equal(result.linkId, 'link-1'); assert.equal(result.methods.length, 6);
  assert.doesNotMatch(JSON.stringify(result), /do not display|raw_messages|toolInput|visible/);
});
test('list excludes malformed native widgets', async () => {
  const f = fake(); f.items.push(fixtureMessage({ id: 'message-2', attachments: [{ type: 'widget', product_sku: 'CODEX' }] }));
  const result = await f.widgets.list({ threadId: 'thread-1' }); assert.equal(result.widgets.length, 1);
});
test('list accepts opaque pagination before cursor', async () => {
  const f = fake(); await f.widgets.list({ threadId: 'thread-1', before: 'prior_cursor' }); assert.equal(f.calls[1].options.query.before, 'prior_cursor');
});
test('does not expose hidden, deleted or private-channel messages', async () => {
  for (const changes of [{ deleted_at: 'now' }, { channel: 'analysis' }, { recipient: 'private' }, { metadata: { is_hidden: true } }]) {
    const f = fake(); f.items = [fixtureMessage(changes)]; assert.equal((await f.widgets.list({ threadId: 'thread-1' })).widgets.length, 0);
    await assert.rejects(f.inspect(), { code: 'WIDGET_UNAVAILABLE' });
  }
});
test('does not expose hidden inner tool messages', async () => {
  const f = fake(); f.items[0].attachments[0].messages[1].metadata = { is_hidden: true };
  assert.equal((await f.widgets.list({ threadId: 'thread-1' })).widgets.length, 0);
});
test('rejects a different room even when caller knows its ID', async () => {
  const f = fake(); await assert.rejects(f.widgets.inspect({ ...ARG, roomId: 'other-room' }), { code: 'WIDGET_UNAVAILABLE' }); assert.equal(f.calls.length, 1);
});
test('requires explicit selected thread and current account selector', async () => {
  const f = fake(); await assert.rejects(f.widgets.inspect({ ...ARG, threadId: undefined }), { code: 'INVALID_ARGUMENT' });
  f.auth.accountId = undefined; await assert.rejects(f.inspect(), { code: 'ACCOUNT_CHANGED' });
});
test('rejects account and same-account subject changes', async () => {
  for (const mutate of [f => { f.auth.accountId = 'account-2'; }, f => { f.auth.accessToken = token('user-2'); }]) {
    const f = fake(); f.before = (method, route) => { if (route.includes('/messages')) mutate(f); };
    await assert.rejects(f.inspect(), { code: 'ACCOUNT_CHANGED' });
  }
});
test('rejects closed widgets', async () => {
  const f = fake(); f.items[0].attachments[0].messages[1].metadata = { chatgpt_sdk: { is_widget_closed: true } };
  await assert.rejects(f.inspect(), { code: 'STALE_ACTION' });
});
test('rejects replaced widget in a newer message', async () => {
  const f = fake(); const newer = fixtureMessage({ id: 'message-2', created_at: '2026-10-18T11:00:00Z' });
  f.items.push(newer); await assert.rejects(f.inspect(), { code: 'STALE_ACTION' });
});
test('requires exact widget message for attachments with multiple tool cards', async () => {
  const f = fake(); const second = structuredClone(f.items[0].attachments[0].messages[1]); second.id = 'tool-2'; second.metadata = { chatgpt_sdk: { widget_session_id: 'other-session' } };
  f.items[0].attachments[0].messages.push(second);
  await assert.rejects(f.inspect(), { code: 'WIDGET_UNAVAILABLE' });
  assert.equal((await f.widgets.inspect({ ...ARG, widgetMessageId: 'tool-2' })).widgetMessageId, 'tool-2');
});
test('rejects changes while reading the newest page', async () => {
  const f = fake(); let count = 0; f.history = () => ({ items: count++ === 0 ? f.items : [] });
  await assert.rejects(f.inspect(), { code: 'STALE_ACTION' });
});
test('searches older pages and rejects repeated cursors', async () => {
  const f = fake(); f.history = q => q.before ? { items: f.items } : { items: [], prev_cursor: 'old' };
  assert.equal((await f.inspect()).messageId, 'message-1');
  f.history = () => ({ items: [], prev_cursor: 'loop' }); await assert.rejects(f.inspect(), { code: 'CURSOR_LOOP' });
});
test('rejects internal, cross-origin and implicit-link widgets', async () => {
  for (const change of [{ resolved_pineapple_uri: 'internal://connector-auth' }, { resolved_pineapple_uri: 'https://evil.example/' }, { link_id: 'implicit_link::one' }, { link_id: 'synthetic_link::one' }]) {
    const f = fake(); Object.assign(f.items[0].attachments[0].messages[0].metadata.chatgpt_sdk, change);
    assert.equal((await f.widgets.list({ threadId: 'thread-1' })).widgets.length, 0);
  }
});
for (const [method, remote, field] of [['resources', 'resources/list', 'resources'], ['resourceTemplates', 'resources/templates/list', 'resourceTemplates'], ['prompts', 'prompts/list', 'prompts']]) test(`${method} uses native aeon MCP route and no arbitrary metadata`, async () => {
  const f = fake(), args = await f.bound(); f.results[remote][field][0]._meta = { ...f.results[remote][field][0]._meta, secret: 'hidden' };
  const value = await f.widgets[method]({ ...args, cursor: 'next' });
  assert.ok(Array.isArray(value[field])); assert.equal(value[field][0]._meta, undefined);
  const request = mcpCalls(f).at(-1); assert.equal(request.options.expectedAccountId, 'account-1'); assert.deepEqual(request.options.headers, { 'OAI-Product-Sku': 'aeon' });
  assert.deepEqual(request.options.body, { app_uri: 'connectors://connector-1', conversation_id: null, thread_id: 'thread-1', launcher_host: 'chatgpt', message_id: 'original-1', method: remote, params: { cursor: 'next' } });
});
test('does not dispatch a catalog for a changed fingerprint', async () => {
  const f = fake(), args = await f.bound(); f.items[0].attachments[0].messages[1].content.parts[0] = 'changed';
  await assert.rejects(f.widgets.tools(args), { code: 'STALE_ACTION' }); assert.equal(mcpCalls(f).length, 0);
});
test('does not dispatch a catalog for inactive, hidden or wrong connection', async () => {
  for (const change of [{ id: 'wrong' }, { connector_id: 'wrong' }, { auth_status: 'EXPIRED' }, { visibility: 'HIDDEN' }, { connector_status: 'DISABLED_BY_ADMIN' }]) {
    const f = fake(), args = await f.bound(); Object.assign(f.links[0], change);
    await assert.rejects(f.widgets.tools(args), { code: 'CONNECTION_UNAVAILABLE' }); assert.equal(mcpCalls(f).length, 0);
  }
});
test('call validates current declared schema and sends exact connection metadata', async () => {
  const f = fake(), args = await f.bound();
  const value = await f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } });
  const request = mcpCalls(f).at(-1); assert.equal(request.options.body.method, 'tools/call');
  assert.deepEqual(request.options.body.params, { name: 'render', arguments: { text: 'hello' }, _meta: { 'openai/action_name': 'render', 'openai/connector_id': 'connector-1', 'openai/link_id': 'link-1' } });
  assert.deepEqual(value.content, [{ type: 'text', text: 'done' }]); assert.equal(value._meta, undefined); assert.deepEqual(value.structuredContent, { okay: true });
});
test('call requires exact confirmation and a listed tool', async () => {
  const f = fake(), args = await f.bound();
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', arguments: {} }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(f.widgets.call({ ...args, toolName: 'send_everything', confirmTool: 'send_everything', arguments: {} }), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(mcpCalls(f).filter(c => c.options.body.method === 'tools/call').length, 0);
});
test('invalid arguments never invoke the tool', async () => {
  const f = fake(), args = await f.bound();
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 3 } }), { code: 'INVALID_ARGUMENT' });
  assert.equal(mcpCalls(f).filter(c => c.options.body.method === 'tools/call').length, 0);
});
test('requires connection-matching fully qualified tool names', async () => {
  const f = fake(), args = await f.bound();
  await assert.rejects(f.widgets.call({ ...args, toolName: '/connector-2/link-1/render', confirmTool: '/connector-2/link-1/render', arguments: {} }), { code: 'INVALID_ARGUMENT' });
  f.results['tools/list'].tools[0].name = '/connector-1/link-1/render';
  await f.widgets.call({ ...args, toolName: '/connector-1/link-1/render', confirmTool: '/connector-1/link-1/render', arguments: { text: 'hello' } });
  assert.equal(mcpCalls(f).at(-1).options.body.params.name, 'render');
});
test('freshly rechecks card after schema validation before executing', async () => {
  const f = fake(), args = await f.bound(); f.before = (method, route, options) => { if (options?.body?.method === 'tools/list') f.items[0].attachments[0].messages[1].content.parts[0] = 'replaced'; };
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'STALE_ACTION' });
  assert.equal(mcpCalls(f).filter(c => c.options.body.method === 'tools/call').length, 0);
});
test('tool failures are never automatically retried', async () => {
  const f = fake(), args = await f.bound(); f.results['tools/call'] = new DotError('NETWORK_ERROR', 'Uncertain delivery', { delivery: 'unknown' });
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'NETWORK_ERROR' });
  assert.equal(mcpCalls(f).filter(c => c.options.body.method === 'tools/call').length, 1);
});
test('native input-required result does not expose private continuation state or pretend success', async () => {
  const f = fake(), args = await f.bound(); f.results['tools/call'] = { resultType: 'input_required', requestState: 'private-capability', inputRequests: { secret: {} }, _meta: { secret: 'hidden' } };
  const result = await f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } });
  assert.equal(result.status, 'input_required'); assert.equal(result.requiresNativeContinuation, true);
  assert.doesNotMatch(JSON.stringify(result), /private-capability|inputRequests|"secret"/);
});
test('resource reads exact listed URI through bound connector and strips hidden metadata', async () => {
  const f = fake(), args = await f.bound();
  const value = await f.widgets.readResource({ ...args, uri: 'ui://widget/data' }); assert.equal(value.contents[0].text, 'hello');
  const request = mcpCalls(f).at(-1); assert.deepEqual(request.options.body.params, { uri: 'ui://widget/data', _meta: { 'openai/action_name': 'render', 'openai/connector_id': 'connector-1', 'openai/link_id': 'link-1' } });
});
test('unlisted and credential-bearing resources never dispatch a read', async () => {
  const f = fake(), args = await f.bound();
  await assert.rejects(f.widgets.readResource({ ...args, uri: 'https://other.example/resource' }), { code: 'RESOURCE_UNAVAILABLE' });
  await assert.rejects(f.widgets.readResource({ ...args, uri: 'https://example.com/r?token=secret' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(mcpCalls(f).filter(c => c.options.body.method === 'resources/read').length, 0);
});
test('wrong resource response URI fails closed', async () => {
  const f = fake(), args = await f.bound(); f.results['resources/read'].contents[0].uri = 'ui://elsewhere';
  await assert.rejects(f.widgets.readResource({ ...args, uri: 'ui://widget/data' }), { code: 'INVALID_RESPONSE' });
});
test('binary resources require private file output and preserve bytes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dot-widget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fake(), args = await f.bound(); f.results['resources/read'] = { contents: [{ uri: 'ui://widget/data', mimeType: 'application/octet-stream', blob: 'AAEC' }] };
  await assert.rejects(f.widgets.readResource({ ...args, uri: 'ui://widget/data' }), { code: 'BINARY_OUTPUT_REQUIRED' });
  const output = path.join(directory, 'resource.bin'); const value = await f.widgets.readResource({ ...args, uri: 'ui://widget/data', output });
  assert.equal(value.bytes, 3); assert.deepEqual(await readFile(output), Buffer.from([0, 1, 2])); assert.equal((await stat(output)).mode & 0o077, 0);
  const link = path.join(directory, 'symlink.bin'); await symlink(output, link);
  await assert.rejects(f.widgets.readResource({ ...args, uri: 'ui://widget/data', output: link, overwrite: true }), { code: 'INVALID_OUTPUT' });
});
test('legacy internal widget factory remains while CLI registration is empty', async () => {
  const f = fake(); assert.equal(createClient({ transport: f.transport }) instanceof DotWidgets, true);
  assert.deepEqual(commands, {}); assert.ok(!Object.values(commands).some(command => command.method === 'request'));
});

test('full room pages without cursors expose a raw-message boundary',async()=>{
  const f=fake();f.items=Array.from({length:20},(_,i)=>({id:`item-${i}`,created_at:`2026-10-18T10:${String(i).padStart(2,'0')}:00Z`,metadata:{is_hidden:true}}));
  const result=await f.widgets.list({threadId:'thread-1'});assert.equal(result.widgets.length,0);assert.equal(result.prevCursor,'item-0');
});
test('inspection finds an older widget behind a full page without cursor fields',async()=>{
  const f=fake(),newer=Array.from({length:20},(_,i)=>({id:`new-${i}`,created_at:`2026-10-18T11:${String(i).padStart(2,'0')}:00Z`,content:{attachments:[]}}));
  f.history=q=>q.before==='new-0'?{items:f.items}:{items:newer};
  const result=await f.inspect();assert.equal(result.widgetMessageId,'tool-1');assert.ok(f.calls.some(c=>c.options.query?.before==='new-0'));
});
test('widget paging preserves a server cursor and does not invent a short-page cursor',async()=>{
  const f=fake();f.history=()=>({items:Array.from({length:20},(_,i)=>({id:`item-${i}`})),prev_cursor:'server-cursor'});
  assert.equal((await f.widgets.list({threadId:'thread-1'})).prevCursor,'server-cursor');
  f.history=()=>({items:[{id:'short'}]});assert.equal((await f.widgets.list({threadId:'thread-1'})).prevCursor,null);
});

test('projects only known widget products and includes the product in the fingerprint', async () => {
  const f = fake(), fingerprints = new Set();
  for (const sku of ['aeon', 'CODEX', 'TPP']) {
    f.items[0].attachments[0].product_sku = sku;
    const result = await f.inspect(); assert.equal(result.productSku, sku); fingerprints.add(result.requestFingerprint);
  }
  assert.equal(fingerprints.size, 3);
  for (const sku of ['unknown', 'CODEX\r\nX-Header: value', undefined]) {
    f.items[0].attachments[0].product_sku = sku;
    assert.equal((await f.widgets.list({ threadId: 'thread-1' })).widgets.length, 0);
  }
});
for (const sku of ['CODEX', 'TPP']) for (const [method, rpcMethod, field] of [['tools', 'tools/list', 'tools'], ['resourceTemplates', 'resources/templates/list', 'resourceTemplates']]) test(`${sku} ${method} uses the exact native JSON-RPC envelope`, async () => {
  const f = native(sku), args = await f.bound();
  await f.widgets[method]({ ...args, cursor: 'next', endpoint: 'https://evil.example/', requestState: 'injected' });
  assert.equal(mcpCalls(f).length, 0);
  const call = psCalls(f).at(-1), body = call.options.body;
  assert.deepEqual(call.options.headers, { 'OAI-Product-Sku': sku }); assert.equal(call.options.expectedAccountId, 'account-1');
  assert.equal(body.jsonrpc, '2.0'); assert.match(body.id, /^[0-9a-f-]{36}$/); assert.equal(body.method, rpcMethod);
  assert.deepEqual(body.params, { cursor: 'next', _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } },
    'x-codex-turn-metadata': { ...(method === 'tools' ? { mcp_request_meta: { selected_connector_ids: ['connector-1'] } } : {}), thread_id: 'thread-1' }
  } });
  assert.equal(Object.hasOwn(body, 'requestState'), false);
  assert.equal(Object.hasOwn(body, 'inputResponses'), false);
});
for (const sku of ['CODEX', 'TPP']) for (const method of ['resources', 'prompts']) test(`${sku} ${method} retains the native ecosystem route`, async () => {
  const f = native(sku), args = await f.bound(); await f.widgets[method](args);
  assert.equal(psCalls(f).length, 0); assert.deepEqual(mcpCalls(f).at(-1).options.headers, { 'OAI-Product-Sku': sku });
});
test('CODEX tool calls bind resource metadata, exact arguments and the selected thread', async () => {
  const f = native(), args = await f.bound();
  f.results['tools/call'].structuredContent = null;
  const value = await f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' }, requestState: 'untrusted', inputResponses: { prompt: { action: 'accept' } } });
  const call = psCalls(f).at(-1), params = call.options.body.params;
  assert.equal(params.name, 'render'); assert.deepEqual(params.arguments, { text: 'hello' });
  assert.deepEqual(params._meta._codex_apps, { resource_uri: '/connector-1/link-1/render' });
  assert.equal(params._meta['openai/connector_id'], 'connector-1'); assert.equal(params._meta['openai/link_id'], 'link-1');
  assert.deepEqual(params._meta['x-codex-turn-metadata'], { source: 'mcp_app', thread_id: 'thread-1' });
  assert.equal(Object.hasOwn(call.options.body, 'requestState'), false);
  assert.equal(value.structuredContent, null); assert.equal(value._meta, undefined);
});
test('CODEX explicit-link descriptors inject only the selected active link', async () => {
  const f = native(), args = await f.bound();
  const descriptor = f.results['tools/list'].tools[0];
  descriptor.inputSchema.properties.link_id = { type: 'string' }; descriptor.inputSchema.required.push('link_id');
  descriptor._meta = { _codex_apps: { resource_uri: '/connector-1/link-1/render', requires_explicit_link_id: true, private: 'not forwarded' } };
  await f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } });
  assert.deepEqual(psCalls(f).at(-1).options.body.params.arguments, { text: 'hello', link_id: 'link-1' });
  assert.deepEqual(psCalls(f).at(-1).options.body.params._meta._codex_apps, { resource_uri: '/connector-1/link-1/render', requires_explicit_link_id: true });
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello', link_id: 'other-link' } }), { code: 'INVALID_ARGUMENT' });
});
test('native descriptor cannot redirect a widget invocation to another connection', async () => {
  const f = native(), args = await f.bound();
  f.results['tools/list'].tools[0]._meta = { _codex_apps: { resource_uri: '/connector-2/link-1/render' } };
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'INVALID_RESPONSE' });
  assert.equal(psCalls(f).filter(call => call.options.body.method === 'tools/call').length, 0);
});
test('TPP resource reads use exact native link metadata without a source action', async () => {
  const f = native('TPP'), args = await f.bound();
  delete f.items[0].attachments[0].messages[0].metadata.chatgpt_sdk.action_name;
  const bound = await f.bound(), result = await f.widgets.readResource({ ...bound, uri: 'ui://widget/data' });
  assert.equal(result.contents[0].text, 'hello');
  const params = psCalls(f).at(-1).options.body.params;
  assert.equal(params.uri, 'ui://widget/data');
  assert.equal(params._meta.connector_id, 'connector-1'); assert.equal(params._meta.link_id, 'link-1');
  assert.equal(Object.hasOwn(params._meta, 'openai/action_name'), false);
});
test('native JSON-RPC mismatches and malformed envelopes fail closed', async () => {
  for (const response of [body => ({ jsonrpc: '2.0', id: 'wrong', result: { tools: [] } }), body => ({ jsonrpc: '1.0', id: body.id, result: { tools: [] } }), body => ({ jsonrpc: '2.0', id: body.id, result: { tools: [] }, error: { code: 0, message: 'ambiguous' } }), body => ({ jsonrpc: '2.0', id: body.id, result: null }), body => ({ jsonrpc: '2.0', id: body.id, error: { code: 'invalid', message: 'bad' } })]) {
    const f = native(), args = await f.bound(); f.psResponse = response;
    await assert.rejects(f.widgets.tools(args), { code: 'INVALID_RESPONSE' }); assert.equal(psCalls(f).length, 1);
  }
});
test('native JSON-RPC errors expose only a bounded error code and never replay', async () => {
  const f = native(), args = await f.bound(); f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'secret input', data: { requestState: 'private' } } });
  await assert.rejects(f.widgets.tools(args), error => error.code === 'MCP_ERROR' && error.details?.jsonRpcCode === -32602 && !/secret|private/.test(JSON.stringify(error)));
  assert.equal(psCalls(f).length, 1);
});
test('native continuation follows only a successful opaque state and revalidates the widget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = native(), args = await f.bound(); let round = 0;
  f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: round++ === 0 ? { resultType: 'input_required', requestState: 'private-state', inputRequests: {} } : { tools: [] } });
  const pending = f.widgets.tools(args); await flushed(); const beforeReads = f.calls.length;
  assert.equal(psCalls(f).length, 1); t.mock.timers.tick(1000); const value = await pending;
  assert.deepEqual(value.tools, []); assert.doesNotMatch(JSON.stringify(value), /private-state/);
  assert.equal(psCalls(f).length, 2); assert.ok(f.calls.length > beforeReads + 1);
  const [first, second] = psCalls(f).map(call => call.options.body);
  assert.notEqual(first.id, second.id); assert.deepEqual(second.params, first.params);
  assert.equal(second.requestState, 'private-state'); assert.deepEqual(second.inputResponses, {});
});
test('native continuation permits stable pending state until the acknowledged operation completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = native(), args = await f.bound(); let round = 0;
  f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: round++ < 2 ? { resultType: 'input_required', requestState: 'same-state', inputRequests: {} } : { tools: [] } });
  const pending = f.widgets.tools(args); await flushed(); t.mock.timers.tick(1000); await flushed(); t.mock.timers.tick(1000);
  assert.deepEqual((await pending).tools, []); assert.equal(psCalls(f).length, 3);
  assert.equal(psCalls(f)[1].options.body.requestState, psCalls(f)[2].options.body.requestState);
});

test('native continuation stops after the native 32-response limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = native(), args = await f.bound(); let round = 0;
  f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: `state-${round++}`, inputRequests: {} } });
  const pending = assert.rejects(f.widgets.tools(args), { code: 'CONTINUATION_LIMIT' }); await flushed();
  for (let i = 0; i < 31; i++) { t.mock.timers.tick(1000); await flushed(); }
  await pending; assert.equal(psCalls(f).length, 32);
});
test('native continuation rechecks account, card and active connection before sending again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [code, mutate] of [['ACCOUNT_CHANGED', f => { f.auth.accessToken = token('other-user'); }], ['STALE_ACTION', f => { f.items[0].attachments[0].messages[1].content.parts[0] = 'changed'; }], ['CONNECTION_UNAVAILABLE', f => { f.links[0].auth_status = 'EXPIRED'; }]]) {
    const f = native(), args = await f.bound(); f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'state', inputRequests: {} } });
    const pending = assert.rejects(f.widgets.tools(args), { code }); await flushed(); mutate(f); t.mock.timers.tick(1000); await pending;
    assert.equal(psCalls(f).length, 1);
  }
});
test('aborting a native continuation sends no further request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = native(), args = await f.bound(), controller = new AbortController();
  f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'state', inputRequests: {} } });
  const pending = assert.rejects(f.widgets.tools({ ...args, signal: controller.signal }), { name: 'AbortError' });
  await flushed(); controller.abort(); await pending; t.mock.timers.tick(1000); await flushed(); assert.equal(psCalls(f).length, 1);
});
test('interactive native input stays pending without leaking capabilities or sending guessed answers', async () => {
  for (const method of ['tools', 'resourceTemplates']) {
    const f = native(), args = await f.bound();
    f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: { resultType: 'input_required', requestState: 'secret-state', inputRequests: { secret: { method: 'elicitation/create', params: { message: 'private question', requestedSchema: {} } } } } });
    const value = await f.widgets[method](args);
    assert.equal(value.status, 'input_required'); assert.equal(value.requiresNativeContinuation, true);
    assert.doesNotMatch(JSON.stringify(value), /secret|private question|inputRequests/); assert.equal(psCalls(f).length, 1);
  }
});
test('native tool input-required projection preserves pending instead of claiming success', async () => {
  const f = native(), args = await f.bound();
  f.results['tools/call'] = { resultType: 'input_required', requestState: 'secret-state', inputRequests: { prompt: { message: 'private' } }, content: [{ type: 'text', text: 'not complete' }] };
  const value = await f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } });
  assert.equal(value.status, 'input_required'); assert.equal(value.content, undefined); assert.equal(value.isError, undefined);
  assert.doesNotMatch(JSON.stringify(value), /secret-state|private|not complete/);
  assert.equal(psCalls(f).filter(call => call.options.body.method === 'tools/call').length, 1);
});
test('native malformed input requests do not continue', async () => {
  for (const result of [{ resultType: 'input_required' }, { resultType: 'input_required', requestState: 'state', inputRequests: [] }, { resultType: 'input_required', requestState: 'state', inputRequests: JSON.parse('{"__proto__":{}}') }]) {
    const f = native(), args = await f.bound(); f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result });
    await assert.rejects(f.widgets.tools(args), { code: 'INVALID_RESPONSE' }); assert.equal(psCalls(f).length, 1);
  }
});
test('native transport errors never replay a tool or its continuation', async () => {
  const f = native(), args = await f.bound();
  f.results['tools/call'] = new DotError('NETWORK_ERROR', 'Unknown delivery', { delivery: 'unknown' });
  await assert.rejects(f.widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'NETWORK_ERROR' });
  assert.equal(psCalls(f).filter(call => call.options.body.method === 'tools/call').length, 1);
});

test('TPP widgets cross the real Transport header validation on both native API paths', async () => {
  const fixture = native('TPP'), calls = [];
  const transport = new Transport({ authLoader: async () => ({ ...fixture.auth }), fetchImpl: async (url, options) => {
    const route = new URL(url).pathname, body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ url: String(url), route, method: options.method, headers: options.headers, body, redirect: options.redirect });
    let result;
    if (route === '/backend-api/tbo/by-thread/thread-1') result = { messaging_room_id: 'room-1' };
    else if (route === '/backend-api/messaging/rooms/room-1/messages') result = { items: fixture.items };
    else if (route === '/backend-api/aip/connectors/links/list_accessible') result = { links: fixture.links };
    else if (route === '/backend-api/ps/mcp') result = { jsonrpc: '2.0', id: body.id, result: fixture.results[body.method] };
    else if (route === '/backend-api/ecosystem/call_mcp') result = fixture.results[body.method];
    else throw new Error('Unexpected route');
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  } });
  const widgets = new DotWidgets({ transport }), inspected = await widgets.inspect(ARG);
  const args = { ...ARG, requestFingerprint: inspected.requestFingerprint };
  const tools = await widgets.tools(args), resources = await widgets.resources(args);
  assert.equal(tools.tools[0].name, 'render'); assert.equal(resources.resources[0].uri, 'ui://widget/data');
  const requests = calls.filter(call => ['/backend-api/ps/mcp', '/backend-api/ecosystem/call_mcp'].includes(call.route));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(call => [call.route, call.body.method]), [['/backend-api/ps/mcp', 'tools/list'], ['/backend-api/ecosystem/call_mcp', 'resources/list']]);
  for (const call of requests) {
    assert.equal(call.method, 'POST'); assert.equal(call.headers['OAI-Product-Sku'], 'TPP');
    assert.equal(call.headers['ChatGPT-Account-Id'], 'account-1'); assert.equal(call.headers.Authorization, `Bearer ${fixture.auth.accessToken}`);
    assert.equal(call.redirect, 'manual'); assert.equal(new URL(call.url).origin, 'https://chatgpt.com');
  }
});

test('native widget uses the proven qualified name and canonical descriptor URI with a selected alternate link', async () => {
  const f = native(), d = f.results['tools/list'].tools[0];
  f.items[0].attachments[0].messages[0].metadata.chatgpt_sdk.link_id = 'link-2'; f.links[0].id = 'link-2';
  d.name = 'vercel.render'; d._meta = { connector_id: 'connector-1', link_id: 'link-1', link_accounts: [{ link_id: 'link-1' }, { link_id: 'link-2' }], _codex_apps: { resource_uri: '/connector-1/link-1/render', requires_explicit_link_id: true, contains_mcp_source: true } };
  d.inputSchema.properties.link_id = { type: 'string' }; d.inputSchema.required.push('link_id');
  await f.widgets.call({ ...await f.bound(), toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } });
  const p = psCalls(f).at(-1).options.body.params;
  assert.equal(p.name, 'vercel.render'); assert.equal(p._meta._codex_apps.resource_uri, '/connector-1/link-1/render');
  assert.equal(p.arguments.link_id, 'link-2'); assert.equal(p._meta['openai/link_id'], 'link-2');
});
test('native widget rejects an unproven alternate account when descriptor lacks an explicit selector', async () => {
  const f = native(), d = f.results['tools/list'].tools[0];
  f.items[0].attachments[0].messages[0].metadata.chatgpt_sdk.link_id = 'link-2'; f.links[0].id = 'link-2';
  d._meta.link_accounts = [{ link_id: 'link-2' }];
  await assert.rejects(f.widgets.call({ ...await f.bound(), toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(psCalls(f).filter(x => x.options.body.method === 'tools/call').length, 0);
});
test('widget rejects an action collision on a later catalog page before invoking', async () => {
  const f = native(); f.psResponse = body => ({ jsonrpc: '2.0', id: body.id, result: { tools: [{ ...f.results['tools/list'].tools[0], name: body.params.cursor ? 'second.render' : 'first.render' }], ...(body.params.cursor ? {} : { nextCursor: 'next' }) } });
  await assert.rejects(f.widgets.call({ ...await f.bound(), toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } }), { code: 'INVALID_RESPONSE' });
  assert.equal(psCalls(f).filter(x => x.options.body.method === 'tools/call').length, 0);
});
