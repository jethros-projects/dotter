import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedEntities, buildSavedEntityRequest } from '../src/saved-entities.mjs';

// Native product-favorite-action C(e,t) preserves product_lookup_key verbatim.
// Its variant_options_query keys are option names, not object schema fields.
const spec = { kind: 'product', name: 'Synthetic product', productId: 'product-a', url: 'https://example.test/product', query: 'synthetic', provider: 'example' };
const accountId = 'account-a', fileId = 'saved-a';
const options = { color: 'blue', 'screen-size': '13-inch', 'Screen size': '13-inch', '1': 'one', constructor: 'native constructor option', prototype: 'native prototype option' };
const input = variants => ({ ...spec, productLookupKey: { variant_options_query: variants } });
const target = variants => ({ identity: { namespace: 'product', key: spec.productId }, sidebar_params: {
  name: spec.name, category: 'product_rationale_and_reviews', multi_message_mode: true,
  extra_params: { product_lookup_key: { variant_options_query: variants }, saved_product_shell: { id: spec.productId, url: spec.url, query: spec.query, provider: spec.provider } },
} });
const node = variants => ({ id: fileId, library_artifact_type: 'saved_entity', parent_directory_id: 'root-a', saved_entity: { saved_target: target(variants) } });
const saved = (variants, directory = null) => ({ saved_target: target(variants), library_file_id: fileId, library_directory_id: directory });
const status = (variants, directory = null) => ({ saved_targets: [target(variants)], saved_entities: [saved(variants, directory)] });
const mapOf = request => request.saved_target.sidebar_params.extra_params.product_lookup_key.variant_options_query;
function fixture(responses) {
  const calls = [];
  const client = new SavedEntities({ transport: { async request(method, route, requestOptions) {
    calls.push({ method, route, options: structuredClone(requestOptions) });
    assert.ok(responses.length, 'unexpected additional request');
    return structuredClone(responses.shift());
  } } });
  return { client, calls };
}
const invalidMaps = [
  ['empty key', { '': 'x' }], ['key beyond 1024', { ['k'.repeat(1025)]: 'x' }],
  ['control in key', { 'screen\nsize': 'x' }], ['DEL in key', { ['screen' + String.fromCharCode(127)]: 'x' }],
  ['value beyond 4096', { color: 'x'.repeat(4097) }], ['control in value', { color: 'a\nb' }],
  ['non-string value', { color: 1 }], ['nested value', { color: {} }],
  ['too many options', Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['key-' + i, 'x']))],
  ['array', []], ['scalar', 'blue'], ['reserved proto', JSON.parse('{"__proto__":"x"}')],
];

test('saved product constructor preserves native option names including constructor and prototype without aliasing input', () => {
  const value = input({ ...options }), result = buildSavedEntityRequest(value);
  assert.deepEqual(mapOf(result), options);
  value.productLookupKey.variant_options_query['Screen size'] = 'changed';
  assert.equal(mapOf(result)['Screen size'], '13-inch');
});

test('saved status sends and accepts the unchanged native option map', async () => {
  const f = fixture([status(options)]);
  const result = await f.client.status({ specs: [input(options)], accountId });
  assert.equal(result.items[0].saved, true);
  assert.deepEqual(f.calls[0].options.body.targets, [target(options)]);
  assert.equal(f.calls.length, 1);
});

test('save preserves native option names through its single mutation and verification', async () => {
  const f = fixture([{ saved_targets: [], saved_entities: [] }, saved(options), status(options)]);
  const result = await f.client.save({ spec: input(options), accountId });
  assert.equal(result.status, 'saved');
  assert.equal(result.entity.libraryFileId, fileId);
  assert.deepEqual(mapOf(f.calls[1].options.body), options);
  assert.deepEqual(f.calls.map(call => call.route), [
    '/backend-api/chat/frontend/v1/saved-entities/status', '/backend-api/chat/frontend/v1/saved-entities', '/backend-api/chat/frontend/v1/saved-entities/status',
  ]);
});

test('get hydrates native option names including constructor and prototype and checks exact Library identity', async () => {
  const f = fixture([node(options), status(options)]);
  const result = await f.client.get({ fileId, accountId });
  assert.equal(result.fileId, fileId);
  assert.equal(result.saved, true);
  assert.deepEqual(f.calls[1].options.body.targets, [target(options)]);
  assert.equal(f.calls.length, 2);
});

test('remove sends the exact hydrated native option map only after status preflight', async () => {
  const f = fixture([node(options), status(options), { completed: true }, { saved_targets: [], saved_entities: [] }]);
  const result = await f.client.remove({ fileId, confirm: fileId, accountId });
  assert.equal(result.removed, true);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[2].options.body, { saved_target: target(options) });
  assert.equal(f.calls[2].route, '/backend-api/chat/frontend/v1/saved-entities/remove');
});

test('move verifies the same native option target before and after the single move', async () => {
  const f = fixture([node(options), { items: [{ id: 'folder-a', kind: 'directory' }] }, status(options), { success: true }, status(options, 'folder-a')]);
  const result = await f.client.move({ fileId, directoryId: 'folder-a', accountId });
  assert.equal(result.moved, true);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.deepEqual(f.calls[2].options.body.targets, [target(options)]);
  assert.deepEqual(f.calls[4].options.body.targets, [target(options)]);
});

test('null and empty native variant maps remain valid', async () => {
  for (const variants of [null, {}]) {
    assert.deepEqual(mapOf(buildSavedEntityRequest(input(variants))), variants);
    const f = fixture([node(variants), status(variants)]);
    assert.equal((await f.client.get({ fileId, accountId })).saved, true);
  }
});

test('native variant map limits accept the last valid key, value, and item count', async () => {
  for (const variants of [{ ['k'.repeat(1024)]: 'x' }, { color: 'x'.repeat(4096) }, Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['key-' + i, 'x']))]) {
    assert.deepEqual(mapOf(buildSavedEntityRequest(input(variants))), variants);
    const f = fixture([node(variants), status(variants)]);
    assert.equal((await f.client.get({ fileId, accountId })).saved, true);
  }
});

test('invalid variant map neighbors fail with INVALID_ARGUMENT before any request', async () => {
  for (const [label, variants] of invalidMaps) {
    const f = fixture([]);
    await assert.rejects(f.client.save({ spec: input(variants), accountId }), { code: 'INVALID_ARGUMENT' }, label);
    assert.equal(f.calls.length, 0, label);
  }
});

test('invalid returned variant maps fail before status or removal', async () => {
  for (const [label, variants] of invalidMaps) {
    const f = fixture([node(variants)]);
    await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'INVALID_RESPONSE' }, label);
    assert.equal(f.calls.length, 1, label);
    assert.equal(f.calls[0].method, 'GET', label);
  }
});

test('the variant map exception does not allow arbitrary schema keys elsewhere', async () => {
  for (const alter of [
    value => { value.saved_entity.saved_target.sidebar_params.extra_params['screen-size'] = 'x'; },
    value => { value.saved_entity.saved_target.sidebar_params.extra_params.variant_options_query = { 'screen-size': 'x' }; },
    value => { value.saved_entity.saved_target.sidebar_params.extra_params.product_lookup_key.wrapper = { variant_options_query: { 'screen-size': 'x' } }; },
  ]) {
    const value = node(options); alter(value); const f = fixture([value]);
    await assert.rejects(f.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 1);
  }
});

test('a lookalike variant path through an array cannot bypass generic key validation', async () => {
  const value = node(options);
  value.saved_entity.saved_target.sidebar_params.extra_params.product_lookup_key = [{ variant_options_query: { 'screen-size': 'x' } }];
  const f = fixture([value]);
  await assert.rejects(f.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' });
  assert.equal(f.calls.length, 1);
});

test('variant maps remain subject to the total 64 KiB target limit', async () => {
  const variants = Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['key-' + i, 'x'.repeat(4096)]));
  assert.throws(() => buildSavedEntityRequest(input(variants)), { code: 'INVALID_RESPONSE' });
  const f = fixture([node(variants)]);
  await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'INVALID_RESPONSE' });
  assert.equal(f.calls.length, 1);
});

test('ordinary neighboring nested fields retain generic data and depth checks', async () => {
  const value = node(options); value.saved_entity.saved_target.sidebar_params.extra_params.other = { okay: 'x' };
  const f = fixture([value, status(options)]);
  assert.equal((await f.client.get({ fileId, accountId })).saved, true);
  let nested = { value: 'x' }; for (let i = 0; i < 9; i++) nested = { value: nested };
  const deep = node(options); deep.saved_entity.saved_target.sidebar_params.extra_params.other = nested;
  const g = fixture([deep]);
  await assert.rejects(g.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' });
  assert.equal(g.calls.length, 1);
});
