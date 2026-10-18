import test from 'node:test';
import assert from 'node:assert/strict';
import { DotOperations } from '../src/operations.mjs';
function tool({ synthetic = true, required = ['link_id'], properties = {} } = {}) {
  return { name: 'example.get_profile', inputSchema: { type: 'object', properties: { link_id: { type: 'string' }, ...properties }, required }, _meta: {
    connector_id: 'connector_1', link_id: 'link_1', link_accounts: [{ link_id: 'link_1' }, { link_id: 'link_2' }],
    _codex_apps: { resource_uri: '/connector_1/link_1/get_profile', requires_explicit_link_id: synthetic }
  } };
}
function setup(descriptor = tool()) {
  const calls = [], ops = new DotOperations({ transport: { async request(method, path, options) {
    calls.push({ method, path, ...options });
    return path === '/backend-api/ps/mcp' ? { jsonrpc: '2.0', id: options.body.id, result: { tools: [descriptor] } } : { content: [] };
  } } });
  return { ops, calls };
}
const base = { connectorId: 'connector_1', name: 'get_profile' };
const invalid = error => error.code === 'INVALID_ARGUMENT';
test('native catalog synthetic selector is satisfied by the explicit account and stripped on ecosystem dispatch', async () => {
  const { ops, calls } = setup(); await ops.toolCall({ ...base, linkId: 'link_1' });
  assert.equal(calls.length, 2); assert.equal(calls[0].path, '/backend-api/ps/mcp');
  assert.equal(calls[1].body.params._meta['openai/link_id'], 'link_1'); assert.deepEqual(calls[1].body.params.arguments, {});
});
test('native synthetic argument selects an advertised alternate account without mutating input', async () => {
  const { ops, calls } = setup(tool({ required: ['link_id', 'query'], properties: { query: { type: 'string' } } }));
  const args = Object.freeze({ link_id: 'link_2', query: 'canary' }); await ops.toolCall({ ...base, arguments: args });
  assert.equal(calls[1].body.params._meta['openai/link_id'], 'link_2'); assert.deepEqual(calls[1].body.params.arguments, { query: 'canary' });
  assert.deepEqual(args, { link_id: 'link_2', query: 'canary' });
});
test('matching synthetic argument and selector use one account', async () => {
  const { ops, calls } = setup(); await ops.toolCall({ ...base, linkId: 'link_1', arguments: { link_id: 'link_1' } });
  assert.deepEqual(calls[1].body.params.arguments, {});
});
test('conflicting or unadvertised synthetic links never dispatch', async () => {
  for (const options of [{ linkId: 'link_1', arguments: { link_id: 'link_2' } }, { arguments: { link_id: 'unadvertised' } }]) {
    const { ops, calls } = setup(); await assert.rejects(ops.toolCall({ ...base, ...options }), invalid); assert.equal(calls.length, 1);
  }
});
test('invalid synthetic argument links are rejected before dispatch', async () => {
  for (const link_id of [null, undefined, '', '../other', 1, {}]) {
    const { ops, calls } = setup(); await assert.rejects(ops.toolCall({ ...base, arguments: { link_id } }), invalid); assert.equal(calls.length, 1);
  }
});
test('synthetic selection does not bypass missing selectors or other required arguments', async () => {
  for (const [descriptor, options] of [[tool(), base], [tool({ required: ['link_id', 'query'] }), { ...base, linkId: 'link_1' }]]) {
    const { ops, calls } = setup(descriptor); await assert.rejects(ops.toolCall(options), invalid); assert.equal(calls.length, 1);
  }
});
test('genuine action link_id remains an argument independently of the selected connection', async () => {
  const { ops, calls } = setup(tool({ synthetic: false })); await ops.toolCall({ ...base, linkId: 'link_1', arguments: { link_id: 'provider-owned-value' } });
  assert.equal(calls[1].body.params._meta['openai/link_id'], 'link_1'); assert.deepEqual(calls[1].body.params.arguments, { link_id: 'provider-owned-value' });
  const missing = setup(tool({ synthetic: false })); await assert.rejects(missing.ops.toolCall({ ...base, linkId: 'link_1' }), invalid);
});
test('a genuine nullable action link_id is never treated as routing metadata', async () => {
  const { ops, calls } = setup(tool({ synthetic: false })); await ops.toolCall({ ...base, linkId: 'link_1', arguments: { link_id: null } });
  assert.deepEqual(calls[1].body.params.arguments, { link_id: null });
});
