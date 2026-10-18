import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.mjs';
import { DotOperations } from '../src/operations.mjs';
import { normalizeNativeTools, nativeToolBinding, readNativeToolCatalog, MCP_CATALOG_MAX_BYTES } from '../src/mcp-catalog.mjs';
const descriptor = () => ({ name: 'vercel.open_deployments', inputSchema: { type: 'object', properties: { link_id: { type: 'string' }, projectId: { type: 'string' } }, required: ['link_id'] }, _meta: { connector_id: 'connector-1', link_id: 'link-1', resource_name: 'vercel.open_deployments', link_accounts: [{ link_id: 'link-1' }, { link_id: 'link-2' }], _codex_apps: { resource_uri: '/connector-1/link-1/open_deployments', requires_explicit_link_id: true } } });
const context = { connectorId: 'connector-1', linkId: 'link-1' };
const token = `a.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.s`;
function setup(result = { tools: [descriptor()] }, behavior) {
  const calls = [], auth = { accountId: 'account-1', accessToken: token };
  const transport = new Transport({ authLoader: async () => auth, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url: String(url), ...options, parsedBody: body });
    if (behavior) return behavior(body, options, calls);
    return new Response(JSON.stringify(body.method === 'tools/list' ? { jsonrpc: '2.0', id: body.id, result } : { content: [] }));
  } });
  return { transport, calls, auth, ops: new DotOperations({ transport }) };
}
test('native qualified names normalize to legacy actions while private routing retains the exact descriptor', () => {
  const [tool] = normalizeNativeTools({ tools: [descriptor()] }, context).tools;
  assert.equal(tool.name, 'open_deployments'); assert.equal(nativeToolBinding(tool).nativeName, 'vercel.open_deployments');
  assert.equal(nativeToolBinding(tool).resourceUri, '/connector-1/link-1/open_deployments');
  assert.equal(JSON.stringify(tool).includes('nativeName'), false);
});
test('native catalog rejects mismatching connector, link, name and ambiguous unqualified names', () => {
  for (const mutate of [t => t._meta.connector_id = 'other', t => t._meta.link_id = 'other', t => t._meta._codex_apps.resource_uri = '/other/link-1/open_deployments', t => t.name = 'vercel.other', t => t._meta.resource_name = 'other', t => t._meta.link_accounts = {}]) {
    const tool = descriptor(); mutate(tool); assert.throws(() => normalizeNativeTools({ tools: [tool] }, context), { code: 'INVALID_RESPONSE' });
  }
  const second = descriptor(); second.name = 'another.open_deployments'; second._meta.resource_name = second.name;
  assert.throws(() => normalizeNativeTools({ tools: [descriptor(), second] }, context), { code: 'INVALID_RESPONSE' });
});
test('only advertised synthetic account alternatives can override the catalog default', () => {
  assert.equal(nativeToolBinding(normalizeNativeTools({ tools: [descriptor()] }, { ...context, linkId: 'link-2' }).tools[0]).linkId, 'link-2');
  assert.throws(() => normalizeNativeTools({ tools: [descriptor()] }, { ...context, linkId: 'unknown' }), { code: 'CONNECTION_UNAVAILABLE' });
  const tool = descriptor(); tool._meta._codex_apps.requires_explicit_link_id = false;
  assert.equal(nativeToolBinding(normalizeNativeTools({ tools: [tool] }, { ...context, linkId: 'link-2' }).tools[0]).linkId, 'link-2');
});
test('real Transport admits a catalog larger than10MiB under the catalog-only32MiB bound', async () => {
  const large = descriptor(); large._meta.documentation = 'a'.repeat(11 * 1024 * 1024);
  const { ops, calls } = setup({ tools: [large] }); const result = await ops.toolList(context);
  assert.equal(result.tools[0].name, 'open_deployments'); assert.equal(calls[0].maxBytes, 32 * 1024 * 1024);
  assert.equal(calls[0].headers['OAI-Product-Sku'], 'CODEX'); assert.deepEqual(calls[0].parsedBody.params._meta['x-codex-turn-metadata'], { mcp_request_meta: { selected_connector_ids: ['connector-1'] } });
});
test('real Transport rejects a catalog beyond32MiB with no retries or ecosystem fallback', async () => {
  const { transport, calls } = setup(null, () => new Response(new ReadableStream({ start(controller) { const chunk = new Uint8Array(1024 * 1024); for (let i = 0; i < 33; i++) controller.enqueue(chunk); controller.close(); } })));
  await assert.rejects(readNativeToolCatalog(transport, context), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(calls.length, 1);
});
test('generic call uses compact native discovery and existing unqualified ecosystem dispatch', async () => {
  const { ops, calls } = setup(); await ops.toolCall({ ...context, name: 'open_deployments', arguments: { projectId: 'canary' } });
  assert.equal(new URL(calls[0].url).pathname, '/backend-api/ps/mcp'); assert.equal(new URL(calls[1].url).pathname, '/backend-api/ecosystem/call_mcp');
  assert.equal(calls[1].parsedBody.params.name, 'open_deployments'); assert.deepEqual(calls[1].parsedBody.params.arguments, { projectId: 'canary' });
  assert.equal(calls[1].parsedBody.params._meta['openai/link_id'], 'link-1'); assert.equal(calls[1].maxBytes, 10 * 1024 * 1024);
});
test('native catalog interactive input returns no private state and causes no continuation guess', async () => {
  const { ops, calls } = setup({ resultType: 'input_required', requestState: 'private-state', inputRequests: { private: {} } });
  await assert.rejects(ops.toolList(context), error => error.code === 'MCP_INPUT_REQUIRED' && !JSON.stringify(error).includes('private-state'));
  assert.equal(calls.length, 1);
});
test('native catalog validates cursors and contexts before touching credentials', async () => {
  let touched = false; const transport = { request: () => { touched = true; } };
  for (const extra of [{ cursor: {} }, { cursor: 'bad\n' }, { threadId: '../escape' }, { conversationId: {} }]) await assert.rejects(readNativeToolCatalog(transport, { ...context, ...extra }), { code: 'INVALID_ARGUMENT' });
  assert.equal(touched, false);
});
test('native JSON-RPC errors, identity changes and edge failures never fallback or retry', async () => {
  const a = setup(null, body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'private error' } })));
  await assert.rejects(a.ops.toolList(context), { code: 'MCP_ERROR' }); assert.equal(a.calls.length, 1);
  const b = setup(null, () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }));
  await assert.rejects(b.ops.toolList(context), { code: 'EDGE_CHALLENGE' }); assert.equal(b.calls.length, 1);
});

test('generic alternate advertised account preserves a genuine action link argument', async () => {
  const d = descriptor(); d._meta._codex_apps.requires_explicit_link_id = false;
  const { ops, calls } = setup({ tools: [d] });
  await ops.toolCall({ connectorId: 'connector-1', linkId: 'link-2', name: 'open_deployments', arguments: { link_id: 'provider-id' } });
  assert.equal(calls[1].parsedBody.params._meta['openai/link_id'], 'link-2'); assert.equal(calls[1].parsedBody.params.arguments.link_id, 'provider-id');
});
test('generic invocation rejects cross-page action-name collisions before any tool call', async () => {
  const { ops, calls } = setup(null, body => {
    const d = descriptor(); d.name = body.params.cursor ? 'second.open_deployments' : 'first.open_deployments'; d._meta.resource_name = d.name;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [d], ...(body.params.cursor ? {} : { nextCursor: 'next' }) } }));
  });
  await assert.rejects(ops.toolCall({ ...context, name: 'open_deployments' }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 2); assert.ok(calls.every(x=>x.parsedBody.method==='tools/list'));
});
