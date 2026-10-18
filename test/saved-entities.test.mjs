import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SavedEntities, buildSavedEntityRequest } from '../src/saved-entities.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import * as api from '../src/index.mjs';
import { run } from '../src/cli.mjs';
import { parseV4Args } from '../src/v4-commands.mjs';

const spec = { kind: 'product', name: 'Test product', productId: 'product-1', url: 'https://example.com/product', query: 'test', provider: 'example' };
const accountId = 'account-1', fileId = 'saved-1';
const target = () => buildSavedEntityRequest(spec).saved_target;
const saved = (directory = null) => ({ saved_target: target(), library_file_id: fileId, library_directory_id: directory });
const status = (isSaved = true, directory = null) => ({ saved_targets: isSaved ? [target()] : [], saved_entities: isSaved ? [saved(directory)] : [] });
const rootPath = () => ({ items: [{ id: 'root-1', kind: 'directory', is_root: true }] });
const node = () => ({ id: fileId, name: spec.name, kind: 'file', library_artifact_type: 'saved_entity', parent_directory_id: 'root-1', saved_entity: { saved_target: target() } });
function fixture(responses, auths) {
  const calls = []; let step = 0, authStep = 0;
  const transport = { async request(method, route, options) { calls.push({ method, route, options }); const next = responses[step++]; if (typeof next === 'function') return next(calls.at(-1)); if (next instanceof Error) throw next; if (next === undefined) throw new Error('Unexpected request'); return structuredClone(next); } };
  if (auths) { transport.authLoader = async () => auths[Math.min(authStep++, auths.length - 1)]; transport.assertIdentity = auth => { assert.equal(auth.accountId, accountId); }; }
  return { client: new SavedEntities({ transport }), transport, calls };
}
const buffer = () => ({ text: '', write(value) { this.text += value; return true; } });

test('product constructor matches the native shape and omits absent optional fields', () => {
  assert.deepEqual(buildSavedEntityRequest(spec), { saved_target: { identity: { namespace: 'product', key: 'product-1' }, sidebar_params: { name: 'Test product', category: 'product_rationale_and_reviews', multi_message_mode: true, extra_params: { saved_product_shell: { id: 'product-1', url: spec.url, query: 'test', provider: 'example' } } } }, display_data: { name: 'Test product', image_url: null } });
  const lookup = { data: '{"id":"product-1"}', version: '1', last_variant_selection_group_id: null, variant_options_query: { color: 'blue' } };
  const value = buildSavedEntityRequest({ ...spec, productLookupKey: lookup, rewrittenQueries: ['one'], imageUrl: 'https://example.com/image.png', origin: { conversationId: 'conv-1', messageId: 'msg-1' } });
  assert.deepEqual(value.saved_target.sidebar_params.extra_params.product_lookup_key, lookup);
  assert.deepEqual(value.origin, { conversation_id: 'conv-1', message_id: 'msg-1' });
});

test('local-business constructor preserves native identity precedence and null fallback', () => {
  const base = { kind: 'local-business', name: 'Place' };
  assert.equal(buildSavedEntityRequest(base).saved_target.identity, null);
  assert.equal(buildSavedEntityRequest(base).saved_target.sidebar_params.extra_params, null);
  assert.deepEqual(buildSavedEntityRequest({ ...base, category: 'restaurant', provider: 'maps', businessId: 'business-1' }).saved_target.identity, { namespace: 'maps', key: 'business-1' });
  const entityLookupId = 'lbe1_' + 'A'.repeat(24);
  assert.deepEqual(buildSavedEntityRequest({ ...base, entityLookupId, entityKey: 'some-key', provider: 'maps', businessId: 'business-1' }).saved_target.identity, { namespace: 'local_business', key: entityLookupId });
});

for (const [label, value] of [
  ['unknown field', { ...spec, raw: {} }], ['unknown kind', { ...spec, kind: 'image' }], ['missing product key', { ...spec, productId: '' }], ['unsafe URL', { ...spec, url: 'javascript:alert(1)' }], ['credential URL', { ...spec, imageUrl: 'https://user:pass@example.com/image' }],
  ['mixed fields', { ...spec, businessId: 'x' }], ['unbounded strings', { ...spec, name: 'x'.repeat(1025) }], ['partial origin', { ...spec, origin: { conversationId: 'conv-1' } }], ['raw origin', { ...spec, origin: { conversationId: 'conv-1', messageId: 'msg-1', token: 'secret' } }],
  ['unknown local category', { kind: 'local-business', name: 'Place', category: 'image' }], ['partial local identity', { kind: 'local-business', name: 'Place', provider: 'maps' }], ['invalid lookup', { kind: 'local-business', name: 'Place', entityLookupId: 'bad' }], ['product fields in place', { kind: 'local-business', name: 'Place', url: spec.url }], ['empty rewritten queries', { ...spec, rewrittenQueries: [] }],
]) test(`constructor rejects ${label}`, () => assert.throws(() => buildSavedEntityRequest(value), { code: 'INVALID_ARGUMENT' }));

test('constructing FullDotClient exposes SavedEntities without I/O', () => { const client = new FullDotClient({ transport: { request() { throw new Error('I/O'); } } }); assert.ok(client.savedEntities instanceof SavedEntities); assert.equal(api.SavedEntities, SavedEntities); assert.ok(client.capabilities().savedEntities.supported.includes('remove')); });

test('status pins account, sets exact native header and deduplicates identities', async () => {
  const f = fixture([status()], [{ accountId }]);
  const result = await f.client.status({ specs: [spec, { ...spec, name: 'Other label' }], accountId });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].saved, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].route, '/backend-api/chat/frontend/v1/saved-entities/status');
  assert.deepEqual(f.calls[0].options.headers, { 'x-openai-use-sheep': '1' }); assert.equal(f.calls[0].options.expectedAccountId, accountId);
  assert.deepEqual(f.calls[0].options.body.targets, [target()]);
  assert.deepEqual(Object.keys(result.items[0].target).sort(), ['category', 'identity', 'name']);
});

for (const count of [0, 101]) test(`status rejects ${count} specs before I/O`, async () => { const f = fixture([]); await assert.rejects(f.client.status({ specs: Array(count).fill(spec), accountId }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0); });
for (const [label, response] of [
  ['missing array', {}], ['unrequested target', { saved_targets: [buildSavedEntityRequest({ ...spec, productId: 'other' }).saved_target] }], ['duplicate target', { saved_targets: [target(), target()] }], ['unconfirmed entity', { saved_targets: [], saved_entities: [saved()] }], ['duplicate entity', { saved_targets: [target()], saved_entities: [saved(), saved()] }], ['invalid ID', { saved_targets: [target()], saved_entities: [{ ...saved(), library_file_id: '../secret' }] }],
]) test(`status rejects ${label}`, async () => { const f = fixture([response]); await assert.rejects(f.client.status({ specs: [spec], accountId }), { code: 'INVALID_RESPONSE' }); });

test('status correlates null identity by canonical sidebar defaults and key order', async () => {
  const local = { kind: 'local-business', name: 'Place' }; const localTarget = buildSavedEntityRequest(local).saved_target;
  const returned = { identity: null, sidebar_params: { category: 'local_business', name: 'Place' } };
  const f = fixture([{ saved_targets: [returned] }]); const result = await f.client.status({ specs: [local], accountId }); assert.equal(result.items[0].saved, true); assert.equal(localTarget.sidebar_params.extra_params, null);
});

test('account mismatch and cancellation prevent requests', async () => {
  const f = fixture([], [{ accountId: 'different' }]); await assert.rejects(f.client.status({ specs: [spec], accountId }), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.calls.length, 0);
  const a = fixture([]); const controller = new AbortController(); controller.abort(); await assert.rejects(a.client.status({ specs: [spec], accountId, signal: controller.signal }), { name: 'AbortError' }); assert.equal(a.calls.length, 0);
});

test('account changed after read is not returned as current state', async () => { const f = fixture([status()], [{ accountId }, { accountId: 'different' }]); await assert.rejects(f.client.status({ specs: [spec], accountId }), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.calls.length, 1); });

test('get verifies exact node and current status without exposing arbitrary target data', async () => {
  const n = node(); n.saved_entity.saved_target.sidebar_params.extra_params.secret = 'must not print';
  const f = fixture([n, status()]); const result = await f.client.get({ fileId, accountId });
  assert.equal(result.saved, true); assert.equal(result.fileId, fileId); assert.ok(!JSON.stringify(result).includes('must not print'));
  assert.equal(f.calls[0].options.headers, undefined);
});

test('get uses native node fallback only after a real 404', async () => {
  const error = Object.assign(new Error(), { code: 'HTTP_ERROR', details: { status: 404 } }); const f = fixture([error, node(), status()]); await f.client.get({ fileId, accountId }); assert.match(f.calls[1].route, /\/saved-1\/node$/);
  const edge = Object.assign(new Error(), { code: 'EDGE_CHALLENGE', details: { status: 403 } }); const g = fixture([edge]); await assert.rejects(g.client.get({ fileId, accountId }), { code: 'EDGE_CHALLENGE' }); assert.equal(g.calls.length, 1);
});

for (const [label, patch] of [['wrong ID', { id: 'other' }], ['ordinary file', { saved_entity: undefined, library_artifact_type: null }], ['wrong artifact', { library_artifact_type: 'page' }], ['hidden', { hidden: true }], ['invalid directory', { parent_directory_id: '../bad' }]]) test(`get refuses ${label} before status or writes`, async () => { const f = fixture([{ ...node(), ...patch }]); await assert.rejects(f.client.get({ fileId, accountId })); assert.equal(f.calls.length, 1); });
test('get hydrates a lean native node from bounded pages of its exact parent folder', async () => {
  const lean = { ...node(), saved_entity: undefined }, f = fixture([lean, { items: [{ id: 'unrelated' }], cursor: 'next-page' }, { items: [node()], cursor: null }, status()]);
  const result = await f.client.get({ fileId, accountId }); assert.equal(result.saved, true);
  assert.equal(f.calls[1].options.query.parent_directory_id, 'root-1'); assert.equal(f.calls[1].options.query.include_files, true); assert.equal(f.calls[2].options.query.cursor, 'next-page');
});
test('get refuses missing target and repeated hydration cursors before writes', async () => {
  const lean = { ...node(), saved_entity: undefined };
  const f = fixture([lean, { items: [] }]); await assert.rejects(f.client.get({ fileId, accountId }), { code: 'SAVED_TARGET_UNAVAILABLE' });
  const g = fixture([lean, { items: [], cursor: 'same' }, { items: [], cursor: 'same' }]); await assert.rejects(g.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' }); assert.equal(g.calls.length, 3);
});
const favoriteItem = (item = node()) => ({ favorite_id: 'favorite-1', target_ref: { type: 'library_file', library_file_id: fileId }, availability: 'available', item });
test('null-parent saved nodes hydrate from native favorites and expose validated origin', async () => {
  const lean = { ...node(), parent_directory_id: null, saved_entity: undefined }, hydrated = node();
  hydrated.saved_entity.origin = { conversation_id: 'conversation-1', message_id: 'message-1' };
  const f = fixture([lean, { items: [favoriteItem(hydrated)] }, status()]);
  const result = await f.client.get({ fileId, accountId });
  assert.deepEqual(result.origin, { conversationId: 'conversation-1', messageId: 'message-1' });
  assert.equal(f.calls[1].route, '/backend-api/files/library/favorites'); assert.equal(f.calls[1].options.query.limit, 50);
  assert.equal(f.calls.some(x => x.route.endsWith('/nodes')), false);
});
test('favorite hydration follows bounded cursors and still verifies current saved Library identity', async () => {
  const lean = { ...node(), parent_directory_id: null, saved_entity: undefined };
  const f = fixture([lean, { items: [], cursor: 'next' }, { items: [favoriteItem()] }, { saved_targets: [target()], saved_entities: [{ ...saved(), library_file_id: 'different' }] }]);
  await assert.rejects(f.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls[2].options.query.cursor, 'next');
});
for (const [label, favorite] of [['hidden favorite', { ...favoriteItem(), hidden: true }], ['unavailable favorite', { ...favoriteItem(), availability: 'unavailable' }], ['hidden item', favoriteItem({ ...node(), metadata: { channel: 'analysis' } })], ['mismatched item', favoriteItem({ ...node(), id: 'different' })]]) test(`favorite hydration rejects ${label}`, async () => {
  const f = fixture([{ ...node(), parent_directory_id: null, saved_entity: undefined }, { items: [favorite] }]); await assert.rejects(f.client.get({ fileId, accountId })); assert.equal(f.calls.length, 2);
});
test('favorite hydration rejects repeated cursors before querying or mutating a target', async () => {
  const f = fixture([{ ...node(), parent_directory_id: null, saved_entity: undefined }, { items: [], cursor: 'repeat' }, { items: [], cursor: 'repeat' }]);
  await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 3);
});
test('favorite and folder hydration stop at bounded page counts with no mutation', async () => {
  const pages = Array.from({ length: 100 }, (_, i) => ({ items: [], cursor: 'favorite-' + i }));
  const f = fixture([{ ...node(), parent_directory_id: null, saved_entity: undefined }, ...pages, { items: [] }]);
  await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'SAVED_TARGET_UNAVAILABLE' });
  assert.equal(f.calls.length, 102); assert.equal(f.calls.some(x => x.route.endsWith('/remove')), false);
});
test('malformed stored origins are not returned', async () => {
  const item = node(); item.saved_entity.origin = { conversation_id: '../bad', message_id: 'message-1' };
  const f = fixture([item]); await assert.rejects(f.client.get({ fileId, accountId }), { code: 'INVALID_RESPONSE' });
});
test('product lookup key accepts native nullable fields and rejects arbitrary strings or values', () => {
  assert.equal(buildSavedEntityRequest({ ...spec, productLookupKey: null }).saved_target.sidebar_params.extra_params.product_lookup_key, null);
  for (const productLookupKey of ['key', { version: 1 }, { raw: {} }, { variant_options_query: { color: 1 } }]) assert.throws(() => buildSavedEntityRequest({ ...spec, productLookupKey }), { code: 'INVALID_ARGUMENT' });
});

test('save reads absent status, writes once and verifies exact Library acknowledgement', async () => {
  const f = fixture([status(false), saved(), status()]); const result = await f.client.save({ spec, accountId });
  assert.equal(result.status, 'saved'); assert.equal(result.entity.libraryFileId, fileId);
  assert.deepEqual(f.calls.map(x => x.method), ['POST', 'POST', 'POST']); assert.deepEqual(f.calls[1].options.body, buildSavedEntityRequest(spec));
});
test('save already-saved result performs no mutation', async () => { const f = fixture([status()]); const result = await f.client.save({ spec, accountId }); assert.equal(result.status, 'already-saved'); assert.equal(f.calls.length, 1); });
test('save never retries an uncertain write', async () => { const error = Object.assign(new Error(), { code: 'NETWORK_ERROR' }); const f = fixture([status(false), error]); await assert.rejects(f.client.save({ spec, accountId }), { code: 'NETWORK_ERROR' }); assert.equal(f.calls.length, 2); });
test('save rejects unrelated acknowledgements without another request', async () => { const f = fixture([status(false), { ...saved(), saved_target: buildSavedEntityRequest({ ...spec, productId: 'other' }).saved_target }]); await assert.rejects(f.client.save({ spec, accountId }), { code: 'MUTATION_UNCONFIRMED', details: { delivery: 'unknown' } }); assert.equal(f.calls.length, 2); });
test('save preserves acknowledged Library ID when verification fails', async () => { const f = fixture([status(false), saved(), status(false)]); await assert.rejects(f.client.save({ spec, accountId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'acknowledged' && error.details.libraryFileId === fileId); assert.equal(f.calls.length, 3); });

test('remove fetches native target and confirms absence without generic deletion', async () => { const f = fixture([node(), status(), { completed: true }, status(false)]); assert.deepEqual(await f.client.remove({ fileId, confirm: fileId, accountId }), { accountId, fileId, removed: true }); assert.equal(f.calls[2].route, '/backend-api/chat/frontend/v1/saved-entities/remove'); assert.deepEqual(f.calls[2].options.body, { saved_target: target() }); });
test('remove requires matching confirmation before I/O', async () => { const f = fixture([]); await assert.rejects(f.client.remove({ fileId, confirm: 'other', accountId }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0); });
test('remove refuses a changed saved-node mapping', async () => { const f = fixture([node(), { saved_targets: [target()], saved_entities: [{ ...saved(), library_file_id: 'other' }] }]); await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'STATE_CHANGED' }); assert.equal(f.calls.length, 2); });
test('remove refuses status without a matching current Library ID', async () => { const f = fixture([node(), { saved_targets: [target()] }]); await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), { code: 'STATE_CHANGED' }); assert.equal(f.calls.length, 2); });
for (const metadata of [{ channel: 'analysis' }, { recipient: 'private-tool' }]) test(`get refuses nonvisible metadata ${JSON.stringify(metadata)}`, async () => { const f = fixture([{ ...node(), metadata }]); await assert.rejects(f.client.get({ fileId, accountId }), { code: 'NOT_VISIBLE' }); assert.equal(f.calls.length, 1); });
test('remove reports accepted but still saved without resending', async () => { const f = fixture([node(), status(), {}, status()]); await assert.rejects(f.client.remove({ fileId, confirm: fileId, accountId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'acknowledged'); assert.equal(f.calls.length, 4); });

test('move verifies native destination, applies once and checks returned status folder', async () => { const f = fixture([node(), { items: [{ id: 'folder-1', kind: 'directory' }] }, status(), { success: true }, status(true, 'folder-1')]); assert.deepEqual(await f.client.move({ fileId, accountId, directoryId: 'folder-1' }), { accountId, fileId, directoryId: 'folder-1', moved: true }); assert.equal(f.calls[3].method, 'PATCH'); assert.deepEqual(f.calls[3].options.body, { directory_id: 'folder-1' }); });
test('native directory path may omit kind', async () => { const f = fixture([node(), { items: [{ id: 'root-1', is_root: true }, { id: 'folder-1', is_root: false }] }, status(), { success: true }, status(true, 'folder-1')]); assert.equal((await f.client.move({ fileId, accountId, directoryId: 'folder-1' })).moved, true); });
test('root move uses null destination and no guessed root ID', async () => { const f = fixture([node(), rootPath(), status(true, 'folder-1'), { success: true }, status()]); assert.equal((await f.client.move({ fileId, accountId, root: true })).moved, true); assert.deepEqual(f.calls[3].options.body, { directory_id: null }); });
test('same folder move returns without a mutation', async () => { const f = fixture([node(), rootPath(), status()]); const result = await f.client.move({ fileId, accountId, root: true }); assert.equal(result.moved, false); assert.equal(f.calls.length, 3); });
test('root move accepts only a concrete root ID identified by fresh native path', async () => { const f = fixture([node(), rootPath(), status(true, 'folder-1'), { success: true }, status(true, 'root-1')]); const result = await f.client.move({ fileId, accountId, root: true }); assert.equal(result.moved, true); assert.equal(result.directoryId, null); });
for (const options of [{}, { root: true, directoryId: 'folder-1' }, { root: 'true' }, { directoryId: '../bad' }]) test(`invalid move destination ${JSON.stringify(options)} makes no request`, async () => { const f = fixture([]); await assert.rejects(f.client.move({ fileId, accountId, ...options }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0); });
test('move refuses provider or non-directory destination', async () => { const f = fixture([node(), { items: [{ id: 'external-root', kind: 'directory' }] }]); await assert.rejects(f.client.move({ fileId, accountId, directoryId: 'external-root' }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 2); });
test('move rejects missing success and never repeats a mutation', async () => { const f = fixture([node(), rootPath(), status(true, 'folder-1'), {}]); await assert.rejects(f.client.move({ fileId, accountId, root: true }), { code: 'MUTATION_UNCONFIRMED' }); assert.equal(f.calls.length, 4); });
test('move reports accepted but mismatched folder', async () => { const f = fixture([node(), rootPath(), status(true, 'folder-1'), { success: true }, status(true, 'folder-1')]); await assert.rejects(f.client.move({ fileId, accountId, root: true }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'acknowledged'); assert.equal(f.calls.length, 5); });

test('CLI file inputs reach real status and save methods', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saved-entities-')); t.after(() => rm(dir, { recursive: true, force: true })); const specs = join(dir, 'specs.json'), one = join(dir, 'spec.json'); await writeFile(specs, JSON.stringify([spec])); await writeFile(one, JSON.stringify(spec));
  for (const [argv, responses] of [[['library','saved','status','--account',accountId,'--specs-file',specs], [status(false)]], [['library','saved','save','--account',accountId,'--file',one], [status(false),saved(),status()]]]) { const f = fixture(responses), stdout = buffer(), stderr = buffer(); const result = await run(argv, { createClient: async () => ({ transport: f.transport }), stdout, stderr }); assert.equal(result.accountId, accountId, stderr.text); assert.equal(JSON.parse(stdout.text).accountId, accountId); }
});
test('CLI requires explicit account and exact remove confirmation', () => { assert.throws(() => parseV4Args('library', ['saved','get',fileId])); assert.throws(() => parseV4Args('library', ['saved','remove',fileId,'--account',accountId,'--confirm','other'])); });
test('CLI rejects unsupported favorite limits before sending a request', async () => {
  const f = fixture([]); await assert.rejects(run(['library', 'favorites', '--limit', '51'], { createClient: async () => ({ transport: f.transport }), stdout: buffer(), stderr: buffer() }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
});
