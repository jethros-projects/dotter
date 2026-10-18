import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryProviders, libraryProviderCapabilities } from '../src/library-providers.mjs';
import { commands, createClient } from '../src/command-sets/library-providers.mjs';
import { DotError } from '../src/errors.mjs';

const BASE = '/backend-api/files/library';
const EXTERNAL = 'external-gdrive:account:acct:file:abc-1';
const UUID = '12345678-1234-1234-1234-123456789abc';
const record = (extra = {}) => ({ id: 'libfile-1', kind: 'file', name: 'Notes', state: 'ready', ...extra });
function fixture(responses = []) {
  const calls = [];
  const transport = { async request(method, route, options = {}) { calls.push({ method, route, ...options }); const value = responses.shift(); if (value instanceof Error) throw value; return value; },
    async fetchSigned(url, options) { calls.push({ method: 'SIGNED', url, ...options }); return Buffer.from('image'); },
    async requestBytes(method, route, options) { calls.push({ method, route, ...options }); return Buffer.from('image'); } };
  return { api: new LibraryProviders({ transport }), calls };
}

test('provider capabilities explain scope and unverified runtime', () => {
  assert.equal(libraryProviderCapabilities().liveVerified, false);
  assert.match(libraryProviderCapabilities().scope, /Entire signed-in account/);
});
test('manifest exposes real methods with no duplicate names and exact confirmation', () => {
  const api = createClient({ transport: { request() {} } });
  for (const command of Object.values(commands)) assert.equal(typeof api[command.method], 'function', command.method);
  assert.deepEqual(commands['library references delete'].confirmMatch, [['confirm', 'referenceImageId']]);
  assert.equal(commands['library references add'].key, 'idempotencyKey');
  assert.equal(commands['library browse'].flags['--category'].target, 'categories');
});
test('mounted capabilities project provider/link states without secrets', async () => {
  const { api, calls } = fixture([{ providers: { google_drive: { secret: 'never', capabilities: { library_browsing: { state: 'available', token: 'no' } } }, unexpected: { token: 'secret' } }, eligible_link_browsing: { box: true, unsafe: true }, link_browsing: { box: { 'link-1': { state: 'available', password: 'never' } } }, auth: 'secret' }]);
  const out = await api.mountedCapabilities({ provider: 'google_drive', linkId: 'link-1' });
  assert.deepEqual(out, { providers: { google_drive: { capabilities: { library_browsing: { state: 'available' } } } }, eligible_link_browsing: { box: true }, link_browsing: { box: { 'link-1': { state: 'available' } } } });
  assert.equal(calls[0].route, `${BASE}/mounted/capabilities`);
  assert.deepEqual(calls[0].query, { provider: 'google_drive', link_id: 'link-1' });
});
test('onedrive status uses distinct observed endpoint', async () => {
  const { api, calls } = fixture([{ state: 'unknown', access_token: 'never' }]);
  assert.deepEqual(await api.oneDriveCapability(), { state: 'unknown' });
  assert.equal(calls[0].route, `${BASE}/mounted/capabilities/onedrive`);
});
test('mounted search uses repeated-array contract and hides private node fields', async () => {
  const { api, calls } = fixture([{ items: [record({ id: EXTERNAL, signed_url: 'never', external_account: { key: 'acct', name: 'Work', secret: 'no' } }), record({ hidden: true })], cursor: 'next' }]);
  const out = await api.search({ query: 'Notes', providers: ['google_drive', 'box', 'box'], limit: 10 });
  assert.deepEqual(calls[0].query, { q: 'Notes', limit: 10, providers: ['google_drive', 'box'] });
  assert.equal(calls[0].route, `${BASE}/mounted/search`);
  assert.equal(out.items.length, 1); assert.equal(out.items[0].signed_url, undefined);
  assert.deepEqual(out.items[0].external_account, { key: 'acct', name: 'Work' });
});
test('cached provider search handles cache misses without a fallback request', async () => {
  const { api, calls } = fixture([null]);
  assert.deepEqual(await api.searchCache({ query: 'x', provider: 'box' }), { items: [], cursor: null, cacheMiss: true });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].query, { q: 'x', limit: 20, provider: 'box' });
});
test('cached provider search recognizes the live HTTP204 transport sentinel', async () => {
  const { api, calls } = fixture([{ completed: true }]);
  assert.deepEqual(await api.searchCache({ query: 'x', provider: 'google_drive' }), { items: [], cursor: null, cacheMiss: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  await assert.rejects(fixture([{ completed: false }]).api.searchCache({ query: 'x', provider: 'google_drive' }), { code: 'INVALID_RESPONSE' });
});
test('provider cache hit projects file page', async () => {
  const { api } = fixture([{ items: [record()], cursor: null }]);
  assert.deepEqual(await api.searchCache({ query: 'x', provider: 'box' }), { items: [record()], cursor: null, cacheMiss: false });
});
test('recents has provider list and JSON external account mapping', async () => {
  const { api, calls } = fixture([{ items: [] }]);
  await api.recents({ providers: ['google_drive'], externalAccountKeys: { google_drive: ['acct', 'acct'] } });
  assert.deepEqual(calls[0].query, { limit: 20, library_providers: ['google_drive'], external_account_keys: '{"google_drive":["acct"]}' });
});
test('invalid provider/search filters fail before auth requests', async () => {
  const { api, calls } = fixture();
  for (const options of [{ providers: [] }, { providers: ['evil'] }, { providers: ['box'], limit: 101 }, { providers: ['box'], query: '\0' }]) await assert.rejects(api.search({ query: 'x', ...options }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.recents({ providers: ['box'], externalAccountKeys: { google_drive: ['acct'] } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.mountedCapabilities({ linkId: '../x' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('materialize defaults to no retrieval indexing and excludes returned links', async () => {
  const { api, calls } = fixture([{ file_id: 'file-new', name: 'Notes', download_url: 'never' }]);
  assert.deepEqual(await api.materialize({ fileId: EXTERNAL, name: 'Notes' }), { file_id: 'file-new', name: 'Notes' });
  assert.equal(calls[0].route, `${BASE}/mounted/materialize`);
  assert.deepEqual(calls[0].body, { file_id: EXTERNAL, name: 'Notes', mime_type: null, index_for_retrieval: false });
});
test('materialization is a single write with unknown delivery on failure', async () => {
  const error = new DotError('NETWORK_ERROR', 'failure', { delivery: 'unknown' });
  const { api, calls } = fixture([error]);
  await assert.rejects(api.materialize({ fileId: EXTERNAL, name: 'Notes', indexForRetrieval: true }), error);
  assert.equal(calls.length, 1);
  await assert.rejects(fixture([{}]).api.materialize({ fileId: EXTERNAL, name: 'Notes' }), { code: 'MUTATION_UNCONFIRMED' });
});
test('materialize and metadata reject non-mounted and provider-mismatched IDs', async () => {
  const { api, calls } = fixture();
  await assert.rejects(api.materialize({ fileId: 'file-1', name: 'Notes' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.fileMetadata({ provider: 'box', fileId: EXTERNAL }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.materialize({ fileId: EXTERNAL, name: 'Notes', indexForRetrieval: 'yes' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('file metadata checks response identity', async () => {
  const { api, calls } = fixture([{ file_id: EXTERNAL, name: 'Notes', secret: 'no' }]);
  assert.deepEqual(await api.fileMetadata({ provider: 'google_drive', fileId: EXTERNAL }), { file_id: EXTERNAL, name: 'Notes' });
  assert.equal(calls[0].route, `${BASE}/mounted/google_drive/file_metadata`);
  await assert.rejects(fixture([{ file_id: 'other' }]).api.fileMetadata({ provider: 'google_drive', fileId: EXTERNAL }), { code: 'INVALID_RESPONSE' });
});
test('resolve Google and Box IDs uses file metadata rather than invented URL routes', async () => {
  const { api, calls } = fixture([{ file_id: 'external-gdrive:file:abcde', name: 'G' }, { file_id: 'external-box:file:123', name: 'B' }]);
  await api.resolve({ provider: 'google_drive', nativeFileId: 'abcde' }); await api.resolve({ provider: 'box', nativeFileId: '123' });
  assert.deepEqual(calls.map(x => x.route), [`${BASE}/mounted/google_drive/file_metadata`, `${BASE}/mounted/box/file_metadata`]);
});
test('resolve Microsoft URL uses shared sharepoint endpoint and omits source URL', async () => {
  const { api, calls } = fixture([{ file_id: 'external-onedrive:file:abc', name: 'Notes', web_url: 'https://tenant.sharepoint.com/?token=secret' }]);
  const out = await api.resolve({ provider: 'onedrive', url: 'https://tenant.sharepoint.com/file/abc' });
  assert.equal(calls[0].route, `${BASE}/mounted/sharepoint/resolve_file_url`); assert.equal(out.web_url, undefined);
});
test('provider URL resolution rejects foreign hosts, userinfo, backslashes and HTTP', async () => {
  const { api, calls } = fixture();
  for (const url of ['https://evil.test/x', 'https://tenant.sharepoint.com.evil.test/x', 'https://user@tenant.sharepoint.com/x', 'http://tenant.sharepoint.com/x', 'https://tenant.sharepoint.com/\\x']) await assert.rejects(api.resolve({ provider: 'sharepoint', url }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.resolve({ provider: 'box', url: 'https://app.box.com/x', nativeFileId: '123' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('preview verifies file ID and strips URL queries and signed preview values', async () => {
  const fileId = 'external-sharepoint:file:abc';
  const { api, calls } = fixture([{ file_id: fileId, web_url: 'https://tenant.sharepoint.com/site/file?auth=secret#frag', preview_url: 'https://tenant.sharepoint.com/embed?token=secret' }]);
  assert.deepEqual(await api.preview({ provider: 'sharepoint', fileId }), { fileId, provider: 'sharepoint', sourceUrl: 'https://tenant.sharepoint.com/site/file', previewAvailable: true });
  assert.equal(calls[0].route, `${BASE}/mounted/sharepoint/preview`);
  await assert.rejects(fixture([{ file_id: 'other' }]).api.preview({ provider: 'sharepoint', fileId }), { code: 'INVALID_RESPONSE' });
});
test('Dropbox previews expose source availability without signed query parameters', async () => {
  const fileId = 'external-dropbox:file:id:abc';
  const { api } = fixture([{ file_id: fileId, shared_link_url: 'https://www.dropbox.com/s/x?rlkey=secret' }]);
  assert.deepEqual(await api.preview({ provider: 'dropbox', fileId }), { fileId, provider: 'dropbox', sourceUrl: 'https://www.dropbox.com/s/x', previewAvailable: false });
});
test('shared search uses fixed observed query and filters invisible records', async () => {
  const { api, calls } = fixture([{ items: [record(), record({ metadata: { channel: 'analysis' } })] }]);
  assert.equal((await api.sharedSearch({ query: 'budget' })).items.length, 1);
  assert.deepEqual(calls[0].query, { q: 'budget', limit: 20 });
});
test('federated search builds exact library, space and ownership requests', async () => {
  const { api, calls } = fixture([{ items: [{ id: 'r1', title: 'Found', source_type: 'library', snippet: 'Visible', payload: { kind: 'library_file', library_item_id: 'libfile-1', secret: 'no', file_id: 'file-1', signed_url: 'no' } }], cursor: 'next', partial_results: true, source_statuses: [{ source_key: 'library', status: 'ok', secret: 'no' }] }]);
  const out = await api.globalSearch({ query: 'budget', queryId: UUID, providers: ['native', 'native_shared', 'google_drive'], externalAccountKeys: { google_drive: ['acct'] }, includePages: true, includeSites: true, includeSpaceFiles: false, ownership: 'owned', pageSearchTarget: 'all' });
  assert.equal(calls[0].route, '/backend-api/global/search');
  assert.deepEqual(calls[0].body.source_requests, [{ type: 'library', filters: { lanes: ['image', 'document', 'folder'], library_providers: ['native', 'native_shared', 'google_drive'], include_sites: true, external_account_keys: { google_drive: ['acct'] } } }, { type: 'space', filters: {}, include_files: false, page_search_target: 'all' }]);
  assert.deepEqual(calls[0].body.scope, { ownership: 'owned' });
  assert.equal(out.partialResults, true); assert.equal(out.items[0].payload.secret, undefined); assert.equal(out.items[0].payload.signed_url, undefined);
  assert.deepEqual(out.sourceStatuses, [{ source_key: 'library', status: 'ok' }]);
});
test('global search uses files source only on its first page', async () => {
  const { api, calls } = fixture([{ items: [] }, { items: [] }]);
  await api.globalSearch({ query: 'x', includePages: true, spaceSearchSource: 'files' });
  await api.globalSearch({ query: 'x', includePages: true, spaceSearchSource: 'files', cursor: 'next' });
  assert.deepEqual(calls[0].body.source_requests[1], { type: 'files', include_files: false });
  assert.equal(calls[1].body.source_requests.length, 1);
});
test('global search carries root, source, file-type and allowlist filters', async () => {
  const { api, calls } = fixture([{ items: [] }]);
  await api.globalSearch({ query: 'x', directoryId: 'external-gdrive:root', fileTypes: ['pdfs'], source: 'uploaded', allowlistIds: ['libfile-1', 'libfile-1'], includePages: true });
  const filters = calls[0].body.source_requests[0].filters;
  assert.equal(filters.directory_id, null); assert.deepEqual(filters.file_types, ['pdfs']); assert.deepEqual(filters.allowlist_ids, ['libfile-1']);
  assert.equal(calls[0].body.source_requests.length, 1);
});
test('empty account selections and allowlist short-circuit without network', async () => {
  const { api, calls } = fixture();
  assert.deepEqual(await api.globalSearch({ query: 'x', providers: ['box'], externalAccountKeys: { box: [] } }), { items: [], cursor: null, partialResults: false });
  assert.deepEqual(await api.globalSearch({ query: 'x', allowlistIds: [] }), { items: [], cursor: null, partialResults: false });
  assert.equal(calls.length, 0);
});
test('global search invalid filters fail before requests', async () => {
  const { api, calls } = fixture();
  for (const options of [{ lanes: ['analysis'] }, { source: 'other' }, { ownership: 'any' }, { fileTypes: ['code'] }, { allowlistIds: ['../x'] }, { directoryId: '../x' }, { limit: 0 }, { includeSites: 'yes' }, { entrypoint: 'x' }, { spaceSearchSource: 'x' }]) await assert.rejects(api.globalSearch({ query: 'x', ...options }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('all hidden markers are filtered from search pages and payloads', async () => {
  const markers = [{ hidden: true }, { is_hidden: true }, { is_visually_hidden_from_conversation: true }, { deleted_at: 'now' }, { channel: 'analysis' }, { recipient: 'tool' }, { metadata: { channel: 'analysis' } }];
  const { api } = fixture([{ items: [...markers.map(x => ({ id: 'no', ...x })), { id: 'yes', payload: { kind: 'file', hidden: true, file_id: 'secret' } }] }]);
  const out = await api.globalSearch({ query: 'x' });
  assert.deepEqual(out.items, []);
});
test('reference catalog projects bounded pointers and safe metadata', async () => {
  const { api, calls } = fixture([{ items: [{ id: 'r1', entity_name: 'Cat', entity_type: 'pet', asset_pointer: 'sediment://file_1', thumbnail_asset_pointer: 'https://evil.test', content_url: 'secret', thumbnail_url: 'secret', token: 'no' }], next_cursor: 'next' }]);
  assert.deepEqual(await api.referenceImages({ limit: 10 }), { items: [{ id: 'r1', entity_name: 'Cat', entity_type: 'pet', asset_pointer: 'sediment://file_1', hasContent: true, hasThumbnail: true }], cursor: 'next' });
  assert.deepEqual(calls[0].query, { limit: 10 });
});
test('manual reference creation uses fixed 0 image index and preserved idempotency key', async () => {
  const { api, calls } = fixture([{ id: 'r1', entity_name: 'Cat', entity_type: 'pet' }]);
  await api.createReferenceImage({ entityName: 'Cat', entityType: 'pet', assetPointer: 'sediment://file_1', idempotencyKey: UUID });
  assert.deepEqual(calls[0].body, { asset_pointer: 'sediment://file_1', entity_name: 'Cat', entity_type: 'pet', idempotency_key: UUID, image_index: 0, request_kind: 'manual_asset' });
  assert.equal(calls[0].idempotencyKey, UUID);
});
test('suggestion reference creation sends message-bound source fields', async () => {
  const { api, calls } = fixture([{ id: 'r1' }]);
  await api.createReferenceImage({ requestKind: 'suggestion_library', entityName: 'Cafe', entityType: 'place', entityDescription: 'Corner cafe', libraryFileId: 'libfile-1', sourceConversationId: 'c1', sourceMessageId: 'm1', suggestionMessageId: 'm2', imageIndex: 2 });
  assert.deepEqual(calls[0].body, { entity_name: 'Cafe', entity_type: 'place', entity_description: 'Corner cafe', image_index: 2, library_file_id: 'libfile-1', source_conversation_id: 'c1', source_message_id: 'm1', suggestion_message_id: 'm2', request_kind: 'suggestion_library' });
});
test('reference changes reject malformed pointers, types, identities and confirmations', async () => {
  const { api, calls } = fixture();
  for (const options of [{ assetPointer: 'https://example.test' }, { entityType: 'other' }, { imageIndex: 1 }, { idempotencyKey: 'bad' }]) await assert.rejects(api.createReferenceImage({ entityName: 'Cat', entityType: 'pet', assetPointer: 'sediment://file_1', ...options }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.createReferenceImage({ requestKind: 'suggestion_library', entityName: 'Cat', entityType: 'pet' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.deleteReferenceImage({ referenceImageId: 'r1', confirm: 'r2' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('reference update and delete target exact encoded identity without retries', async () => {
  const { api, calls } = fixture([{ id: 'ref:1', entity_name: 'Cat', entity_type: 'pet' }, { completed: true }]);
  await api.updateReferenceImage({ referenceImageId: 'ref:1', entityName: 'Cat', entityType: 'pet' });
  assert.equal(calls[0].route, `${BASE}/reference-images/ref%3A1`); assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(await api.deleteReferenceImage({ referenceImageId: 'ref:1', confirm: 'ref:1' }), { referenceImageId: 'ref:1', deleted: true });
  assert.equal(calls[1].method, 'DELETE');
  await assert.rejects(fixture([{ id: 'other' }]).api.updateReferenceImage({ referenceImageId: 'r1', entityName: 'Cat', entityType: 'pet' }), { code: 'INVALID_RESPONSE' });
});
test('reference thumbnail availability never returns signed URLs', async () => {
  const { api, calls } = fixture([{ thumbnail_url: 'https://files.oaiusercontent.com/image?sig=secret' }, {}]);
  assert.deepEqual(await api.referenceThumbnail({ referenceImageId: 'r1' }), { referenceImageId: 'r1', available: true });
  assert.deepEqual(await api.referenceThumbnail({ referenceImageId: 'r1' }), { referenceImageId: 'r1', available: false });
  assert.equal(calls.length, 2);
});
test('reference thumbnail saves private bytes with no overwrite and blocks foreign URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-reference-'));
  try {
    const output = join(dir, 'image.png');
    const { api, calls } = fixture([{ thumbnail_url: 'https://files.oaiusercontent.com/image?sig=secret' }, { thumbnail_url: 'https://files.oaiusercontent.com/image?sig=secret' }]);
    const out = await api.referenceThumbnail({ referenceImageId: 'r1', output });
    assert.equal(out.path, await realpath(output)); assert.equal(await readFile(output, 'utf8'), 'image'); assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(calls[1].method, 'SIGNED');
    await assert.rejects(api.referenceThumbnail({ referenceImageId: 'r1', output }), { code: 'OUTPUT_EXISTS' });
    await assert.rejects(fixture([{ thumbnail_url: 'https://evil.test/image' }]).api.referenceThumbnail({ referenceImageId: 'r1', output }), { code: 'UNSAFE_DOWNLOAD_URL' });
  } finally { await rm(dir, { recursive: true }); }
});
test('reference thumbnail uses authenticated estuary route only and rejects symlink writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-reference-'));
  try {
    const output = join(dir, 'link'); await symlink('other', output);
    const { api, calls } = fixture([{ thumbnail_url: '/backend-api/estuary/content?id=x' }]);
    await assert.rejects(api.referenceThumbnail({ referenceImageId: 'r1', output, overwrite: true }), { code: 'INVALID_OUTPUT' });
    assert.equal(calls[1].route, '/backend-api/estuary/content');
    assert.deepEqual(calls[1].query, { id: 'x' });
  } finally { await rm(dir, { recursive: true }); }
});
test('image favorite takes only observed source keys and drops response links', async () => {
  const { api, calls } = fixture([{ favorite_id: 'f1', library_file_id: 'libfile-1', url: 'secret' }]);
  const source = { content_url: 'https://example.test/cat.png', original_content_url: 'https://example.test/cat-full.png' };
  assert.deepEqual(await api.imageFavorite({ source }), { favorite_id: 'f1', library_file_id: 'libfile-1' });
  assert.deepEqual(calls[0].body, source);
});
test('image source validation excludes local protocols, credentials and unknown fields', async () => {
  const { api, calls } = fixture();
  for (const source of [{ content_url: 'file:///secret' }, { content_url: 'https://user:pass@example.test/x' }, { content_url: 'https://example.test/x', token: 'no' }, {}]) await assert.rejects(api.imageFavorite({ source }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('image favorite status preserves source order without echoing sources', async () => {
  const { api, calls } = fixture([[{}, { favorite_id: 'f2', library_file_id: 'libfile-2', content_url: 'secret' }]]);
  const out = await api.imageFavoriteStatus({ sources: [{ content_url: 'https://example.test/1' }, { content_url: 'https://example.test/2' }] });
  assert.deepEqual(out, { items: [{ index: 0 }, { index: 1, favorite_id: 'f2', library_file_id: 'libfile-2' }] });
  assert.equal(calls[0].route, `${BASE}/image-favorites/status`);
  await assert.rejects(fixture([[]]).api.imageFavoriteStatus({ sources: [{ content_url: 'https://example.test/1' }] }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(api.imageFavoriteStatus({ sources: Array(51).fill({ content_url: 'https://example.test/1' }) }), { code: 'INVALID_ARGUMENT' });
});
test('retired chat-message saving fails before any request', async () => {
  const { api, calls } = fixture();
  await assert.rejects(api.saveChatMessage({ conversationId: 'c1', messageId: 'm1' }), { code: 'UNSUPPORTED' });
  assert.equal(calls.length, 0);
});
test('conversation favorites return message identity and preserve cursor', async () => {
  const { api, calls } = fixture([{ items: [{ favorite_id: 'f1', message_id: 'm1', target_ref: { type: 'library_file', library_file_id: 'libfile-1', secret: 'no' }, content: 'private' }], cursor: 'next' }]);
  assert.deepEqual(await api.conversationFavorites({ conversationId: 'c1', cursor: 'prev' }), { items: [{ favorite_id: 'f1', message_id: 'm1', target_ref: { type: 'library_file', library_file_id: 'libfile-1' } }], cursor: 'next' });
  assert.equal(calls[0].route, `${BASE}/favorites/conversations/c1`); assert.deepEqual(calls[0].query, { limit: 20, cursor: 'prev' });
});
test('oversized and invalid result pages fail deterministically', async () => {
  await assert.rejects(fixture([{ items: Array(1001).fill(record()) }]).api.search({ query: 'x', providers: ['box'] }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([{ items: [], cursor: {} }]).api.search({ query: 'x', providers: ['box'] }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([{ items: [{ entity_name: 'No ID' }] }]).api.referenceImages(), { code: 'INVALID_RESPONSE' });
});

test('Google Drive and Box preview links are derived without unnecessary API mutations', async () => {
  const { api, calls } = fixture();
  assert.deepEqual(await api.preview({ provider: 'google_drive', fileId: EXTERNAL }), { provider: 'google_drive', fileId: EXTERNAL, sourceUrl: 'https://drive.google.com/file/d/abc-1/view', previewAvailable: false });
  assert.deepEqual(await api.preview({ provider: 'box', fileId: 'external-box:file:123' }), { provider: 'box', fileId: 'external-box:file:123', sourceUrl: 'https://app.box.com/file/123', previewAvailable: false });
  assert.equal(calls.length, 0);
});

test('hidden nested Library payload removes the entire federated result including snippet', async () => {
  const { api } = fixture([{ items: [{ id: 'outer', snippet: 'private', payload: { kind: 'site', library_file: { channel: 'analysis' } } }] }]);
  assert.deepEqual((await api.globalSearch({ query: 'x' })).items, []);
});

test('mounted IDs follow native provider formats including opaque Microsoft IDs', async () => {
  const fileId = 'external-sharepoint:account:tenant%2Fuser:file:drive/item+opaque=value';
  const { api, calls } = fixture([{ file_id: fileId, name: 'MS file' }]);
  await api.fileMetadata({ provider: 'sharepoint', fileId });
  assert.equal(calls[0].body.file_id, fileId);
  await assert.rejects(api.fileMetadata({ provider: 'box', fileId: 'external-box:file:abc' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(api.fileMetadata({ provider: 'google_drive', fileId: 'external-gdrive:file:x' }), { code: 'INVALID_ARGUMENT' });
});


test('mounted capability projection retains the observed backend five-provider shape including iManage', async () => {
  const status = state => ({ schema_version: 1, rules_version: 1, link_id: null,
    evaluated_at: '2026-10-18T00:00:00Z', expires_at: '2026-10-18T00:05:00Z',
    capabilities: { mention_search: { state }, library_browsing: { state, token: 'private' } } });
  const providers = Object.fromEntries(['google_drive', 'dropbox', 'box', 'sharepoint', 'imanage'].map(key => [key, status('unavailable')]));
  const { api, calls } = fixture([{ providers, eligible_link_browsing: {}, link_browsing: {} }]);
  const result = await api.mountedCapabilities({ provider: 'google_drive', linkId: 'link-fixture' });
  assert.deepEqual(Object.keys(result.providers), Object.keys(providers));
  assert.deepEqual(result.providers.imanage, { link_id: null, capabilities: {
    mention_search: { state: 'unavailable' }, library_browsing: { state: 'unavailable' } } });
  assert.deepEqual(result.eligible_link_browsing, {});
  assert.deepEqual(result.link_browsing, {});
  assert.deepEqual(calls.map(call => [call.method, call.route]), [['GET', `${BASE}/mounted/capabilities`]]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('iManage capability maps retain supported metadata and remove unrecognized providers and secrets', async () => {
  const { api } = fixture([{
    providers: { imanage: { link_id: 'link-fixture', access_token: 'secret', capabilities: { library_browsing: { state: 'unavailable', reason: 'not_connected', password: 'secret' } } }, unknown: { state: 'available' } },
    eligible_link_browsing: { imanage: false, unknown: true },
    link_browsing: { imanage: { 'link-fixture': { state: 'unavailable', enabled: false, cookie: 'secret' } }, unknown: { 'link-other': { state: 'available' } } },
  }]);
  assert.deepEqual(await api.mountedCapabilities(), {
    providers: { imanage: { link_id: 'link-fixture', capabilities: { library_browsing: { state: 'unavailable', reason: 'not_connected' } } } },
    eligible_link_browsing: { imanage: false },
    link_browsing: { imanage: { 'link-fixture': { state: 'unavailable', enabled: false } } },
  });
});

test('retaining iManage capability metadata does not enable provider selectors or operations', async () => {
  const { api, calls } = fixture();
  const cases = [
    ['mountedCapabilities', { provider: 'imanage' }],
    ['search', { query: 'fixture', providers: ['imanage'] }],
    ['searchCache', { query: 'fixture', provider: 'imanage' }],
    ['recents', { providers: ['imanage'] }],
    ['fileMetadata', { provider: 'imanage', fileId: 'external-imanage:file:fixture' }],
    ['resolve', { provider: 'imanage', nativeFileId: 'fixture' }],
    ['preview', { provider: 'imanage', fileId: 'external-imanage:file:fixture' }],
    ['globalSearch', { query: 'fixture', providers: ['imanage'] }],
    ['librarySearch', { query: 'fixture', providers: ['imanage'] }],
    ['materialize', { fileId: 'external-imanage:file:fixture', name: 'fixture.txt' }],
  ];
  for (const [method, options] of cases) await assert.rejects(api[method](options), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
