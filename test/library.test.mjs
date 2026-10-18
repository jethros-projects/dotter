import test from 'node:test';
import assert from 'node:assert/strict';
import { DotLibrary, libraryCapabilities } from '../src/library.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';

const BASE = '/backend-api/files/library';
function fixture(responses = []) {
  const calls = [];
  const library = new DotLibrary({ transport: { async request(method, path, options = {}) {
    calls.push({ method, path, ...options });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  } } });
  return { library, calls };
}
const record = (extra = {}) => ({ id: 'file-1', file_id: 'content-1', file_name: 'Note.txt', kind: 'file', ...extra });

test('capabilities explicitly describe account scope and confirmation', () => {
  assert.match(libraryCapabilities().scope, /Entire signed-in ChatGPT account/);
  assert.match(libraryCapabilities().destructiveConfirmation, /fileId/);
});
test('browse uses exact node contract and projects safe metadata only', async () => {
  const { library, calls } = fixture([{ items: [record({ signed_url: 'secret', metadata: { analysis: 'private' }, body: 'not returned' }), record({ id: 'hidden', hidden: true })], cursor: 'next' }]);
  const result = await library.browse({ directoryId: 'library:root', query: 'Note', categories: ['documents'] });
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].path, `${BASE}/nodes`);
  assert.equal(calls[0].query.parent_directory_id, 'library:root');
  assert.equal(calls[0].query.q, 'Note'); assert.equal(calls[0].query.categories, 'documents');
  assert.equal(calls[0].query.include_hidden_files, false);
  assert.equal(calls[0].maxBytes, 2 * 1024 * 1024);
  assert.deepEqual(result, { items: [record()], cursor: 'next' });
});
test('browse folders sets include_files false and accepts root', async () => {
  const { library, calls } = fixture([{ items: [], cursor: null }]);
  await library.browse({ foldersOnly: true });
  assert.equal(calls[0].query.include_files, false);
});
test('search supports account file text, category filters, pagination, and trash', async () => {
  const { library, calls } = fixture([{ items: [record()], cursor: null }]);
  await library.search({ query: 'budget', limit: 10, cursor: 'next', categories: ['documents', 'pdfs'], trash: true });
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, BASE);
  assert.deepEqual(calls[0].body, { limit: 10, cursor: 'next', q: 'budget', trashed_only: true, include_hidden_files: false, include_saved_entities: true, include_sites: false, categories: ['documents', 'pdfs'] });
});
test('invalid filters fail before network calls', async () => {
  const { library, calls } = fixture();
  for (const options of [{ limit: 0 }, { limit: 101 }, { categories: ['unknown'] }, { query: '\0' }, { trash: 'true' }]) await assert.rejects(library.search(options), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('search rejects native provider selectors before HTTP or authentication', async () => {
  let authCalls = 0, fetchCalls = 0;
  const transport = new Transport({
    authLoader: async () => { authCalls++; throw new Error('Authentication must not be reached.'); },
    fetchImpl: async () => { fetchCalls++; throw new Error('HTTP must not be reached.'); },
  });
  const library = new DotLibrary({ transport });
  for (const providers of [['native'], ['native_shared'], ['google_drive', 'native']]) {
    await assert.rejects(library.search({ query: 'canary', providers }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /includeNativeFiles \(--include-native-files\)/);
      return true;
    });
  }
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});
test('search serializes all five supported mounted providers alongside the native-file flag', async () => {
  const { library, calls } = fixture([{ items: [], cursor: null }]);
  const providers = ['google_drive', 'box', 'dropbox', 'sharepoint', 'onedrive'];
  const externalAccountKeys = Object.fromEntries(providers.map(provider => [provider, ['account-1']]));
  await library.search({ query: 'canary', providers: [...providers, 'box'], externalAccountKeys, includeNativeFiles: true });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, BASE);
  assert.deepEqual(calls[0].body.providers, providers);
  assert.deepEqual(calls[0].body.external_account_keys, externalAccountKeys);
  assert.equal(calls[0].body.include_native_files, true);
});
test('search selects native files without inventing a provider value', async () => {
  const { library, calls } = fixture([{ items: [], cursor: null }]);
  await library.search({ query: 'native canary', includeNativeFiles: true });
  assert.equal(calls[0].body.include_native_files, true);
  assert.equal(Object.hasOwn(calls[0].body, 'providers'), false);
});
test('detail falls back from file to node on 404 only', async () => {
  const { library, calls } = fixture([new DotError('HTTP_ERROR', 'not found', { status: 404 }), record()]);
  assert.deepEqual(await library.get({ fileId: 'file-1' }), record());
  assert.equal(calls[1].path, `${BASE}/files/file-1/node`);
});
test('detail preserves forbidden errors and rejects mismatched or hidden response', async () => {
  const blocked = fixture([new DotError('FORBIDDEN', 'no', { status: 403 })]);
  await assert.rejects(blocked.library.get({ fileId: 'file-1' }), { code: 'FORBIDDEN' });
  assert.equal(blocked.calls.length, 1);
  await assert.rejects(fixture([record({ id: 'other' })]).library.get({ fileId: 'file-1' }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([record({ is_hidden: true })]).library.get({ fileId: 'file-1' }), { code: 'NOT_VISIBLE' });
});
test('IDs are path-segment encoded and path traversal rejected', async () => {
  const { library, calls } = fixture([record({ id: 'library:foo~bar' })]);
  await library.get({ fileId: 'library:foo~bar' });
  assert.equal(calls[0].path, `${BASE}/files/library%3Afoo~bar`);
  for (const fileId of ['../x', '.', '..', 'https://example.org/x', 'x?y', 'x%2Fy']) await assert.rejects(library.get({ fileId }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 1);
});
test('directory path and renaming use observed contracts', async () => {
  const dir = { id: 'dir-1', kind: 'directory', name: 'Reports', is_root: false };
  const { library, calls } = fixture([{ items: [dir] }, record(), record({ file_name: 'New.txt' }), dir]);
  assert.deepEqual((await library.directoryPath({ directoryId: 'dir-1' })).items, [dir]);
  await library.rename({ fileId: 'file-1', name: 'New.txt' });
  await library.renameDirectory({ directoryId: 'dir-1', name: 'Reports' });
  assert.equal(calls[0].path, `${BASE}/directories/path`);
  assert.deepEqual(calls[0].query, { directory_id: 'dir-1' });
  assert.deepEqual(calls[2].body, { file_name: 'New.txt' });
  assert.deepEqual(calls[3].body, { name: 'Reports' });
});
test('move permits explicit null root and checks server success', async () => {
  const { library, calls } = fixture([{ success: true }, { success: false }]);
  assert.deepEqual(await library.move({ fileId: 'file-1', directoryId: null }), { fileId: 'file-1', moved: true });
  assert.deepEqual(calls[0].body, { directory_id: null });
  await assert.rejects(library.move({ fileId: 'file-1', directoryId: 'dir-1' }), { code: 'MUTATION_UNCONFIRMED' });
});
test('directory moves reject self and missing destination before writes', async () => {
  const { library, calls } = fixture([{ id: 'dir-1', kind: 'directory', name: 'reports' }]);
  await assert.rejects(library.moveDirectory({ directoryId: 'dir-1', parentDirectoryId: 'dir-1' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.move({ fileId: 'file-1' }), { code: 'INVALID_ARGUMENT' });
  await library.moveDirectory({ directoryId: 'dir-1', parentDirectoryId: null });
  assert.deepEqual(calls[0].body, { parent_directory_id: null });
});
test('trash requires exact confirmation before even reading metadata', async () => {
  const { library, calls } = fixture();
  for (const confirm of [undefined, true, 'other']) await assert.rejects(library.trash({ fileId: 'file-1', confirm }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
test('trash loads current metadata and only issues soft deletion', async () => {
  const { library, calls } = fixture([record({ directory_id: 'dir-1' }), { success: true }]);
  assert.deepEqual(await library.trash({ fileId: 'file-1', confirm: 'file-1' }), { fileId: 'file-1', trashed: true });
  assert.equal(calls[1].method, 'DELETE');
  assert.deepEqual(calls[1].query, { soft_delete: true, file_id: 'content-1', parent_directory_id: 'dir-1', file_name: 'Note.txt' });
});
test('trash and restore reject separate Page site and directory semantics', async () => {
  for (const extra of [{ library_artifact_type: 'page' }, { library_artifact_type: 'site' }, { library_artifact_type: 'site_preview' }, { library_artifact_type: 'saved_entity' }, { library_artifact_type: 'chat_message_snapshot' }, { kind: 'directory' }]) {
    const trash = fixture([record(extra)]);
    await assert.rejects(trash.library.trash({ fileId: 'file-1', confirm: 'file-1' }), { code: 'UNSUPPORTED' });
    assert.equal(trash.calls.length, 1);
    const restore = fixture([record(extra)]);
    await assert.rejects(restore.library.restore({ fileId: 'file-1' }), { code: 'UNSUPPORTED' });
    assert.equal(restore.calls.length, 1);
  }
});
test('restore reports acceptance with projected response', async () => {
  const { library, calls } = fixture([record({ trashed_at: '2026-10-01' }), record({ trashed_at: null, secret: 'never' })]);
  const result = await library.restore({ fileId: 'file-1' });
  assert.equal(calls[1].path, `${BASE}/files/file-1/restore`);
  assert.equal(result.status, 'accepted'); assert.equal(result.file.trashed_at, null); assert.equal(result.file.secret, undefined);
});
test('restore resolves a trashed file by exact ID when both detail endpoints return404', async () => {
  const absent = () => new DotError('HTTP_ERROR', 'not found', { status: 404 });
  const { library, calls } = fixture([absent(), absent(), { items: [record({ id: 'other', trashed_at: '2026-10-18' })], cursor: 'next' },
    { items: [record({ trashed_at: '2026-10-18' })], cursor: null }, record({ trashed_at: null })]);
  const out = await library.restore({ fileId: 'file-1' });
  assert.equal(out.file.id, 'file-1');
  assert.equal(calls[2].body.trashed_only, true); assert.equal(calls[3].body.cursor, 'next');
  assert.equal(calls[4].path, `${BASE}/files/file-1/restore`);
  assert.equal(calls.filter(x => x.path.endsWith('/restore')).length, 1);
});
test('trash resolution never substitutes another ID or follows a forbidden detail response', async () => {
  const absent = () => new DotError('HTTP_ERROR', 'not found', { status: 404 });
  const missing = fixture([absent(), absent(), { items: [record({ id: 'other', trashed_at: '2026-10-18' })] }]);
  await assert.rejects(missing.library.restore({ fileId: 'file-1' }), { code: 'HTTP_ERROR' });
  assert.equal(missing.calls.filter(x => x.path.endsWith('/restore')).length, 0);
  const forbidden = fixture([new DotError('FORBIDDEN', 'forbidden', { status: 403 })]);
  await assert.rejects(forbidden.library.restore({ fileId: 'file-1' }), { code: 'FORBIDDEN' }); assert.equal(forbidden.calls.length, 1);
  const repeated = fixture([absent(), absent(), { items: [], cursor: 'same' }, { items: [], cursor: 'same' }]);
  await assert.rejects(repeated.library.restore({ fileId: 'file-1' }), { code: 'INVALID_RESPONSE' });
});
test('versions retains visible provenance metadata and excludes content', async () => {
  const { library, calls } = fixture([{ items: [{ library_file_id: 'file-1', version_number: 3, is_current: true, content: 'secret', version_provenance: { actor: 'agent', action: 'edit', auth: 'secret' } }], cursor: 'cursor-2' }]);
  assert.deepEqual(await library.versions({ fileId: 'file-1', limit: 20 }), { items: [{ library_file_id: 'file-1', version_number: 3, is_current: true, version_provenance: { actor: 'agent', action: 'edit' } }], cursor: 'cursor-2' });
  assert.equal(calls[0].path, `${BASE}/files/file-1/versions`);
});
test('versions accepts a real initial revision numbered zero', async () => {
  const { library } = fixture([{ items: [{ library_file_id: 'file-1', version_number: 0, is_current: true }], cursor: null }]);
  assert.equal((await library.versions({ fileId: 'file-1' })).items[0].version_number, 0);
  for (const version_number of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fixture([{ items: [{ version_number }] }]).library.versions({ fileId: 'file-1' }), { code: 'INVALID_RESPONSE' });
  }
});
test('version restore requires exact confirmation and optimistic version guard', async () => {
  const { library, calls } = fixture([record({ current_version_number: 4 })]);
  for (const options of [{}, { confirm: 'other', expectedCurrentVersion: 3 }, { confirm: 'file-1' }, { confirm: 'file-1', expectedCurrentVersion: 2 }]) {
    await assert.rejects(library.restoreVersion({ fileId: 'file-1', version: 2, ...options }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls.length, 0);
  const result = await library.restoreVersion({ fileId: 'file-1', version: 2, expectedCurrentVersion: 3, confirm: 'file-1' });
  assert.equal(result.current_version_number, 4);
  assert.equal(calls[0].path, `${BASE}/files/file-1/versions/2/restore`);
  assert.deepEqual(calls[0].body, { expected_current_version: 3 });
});
test('version restore rejects ambiguous successful response without retry', async () => {
  const { library, calls } = fixture([record()]);
  await assert.rejects(library.restoreVersion({ fileId: 'file-1', version: 1, expectedCurrentVersion: 2, confirm: 'file-1' }), { code: 'MUTATION_UNCONFIRMED' });
  assert.equal(calls.length, 1);
});
test('version restore permits zero as target and optimistic current version', async () => {
  for (const [target, current] of [[0, 1], [1, 0]]) {
    const { library, calls } = fixture([record({ current_version_number: 2 })]);
    await library.restoreVersion({ fileId: 'file-1', version: target, expectedCurrentVersion: current, confirm: 'file-1' });
    assert.equal(calls[0].path, `${BASE}/files/file-1/versions/${target}/restore`);
    assert.equal(calls[0].body.expected_current_version, current);
  }
  for (const options of [{ version: -1, expectedCurrentVersion: 0 }, { version: 0, expectedCurrentVersion: -1 }, { version: 0, expectedCurrentVersion: 0 }]) {
    const { library, calls } = fixture();
    await assert.rejects(library.restoreVersion({ fileId: 'file-1', confirm: 'file-1', ...options }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls.length, 0);
  }
});
test('favorites list excludes raw signed links and unrelated target content', async () => {
  const { library, calls } = fixture([{ items: [{ favorite_id: 'fav-1', availability: 'available', target_ref: { type: 'library_file', library_file_id: 'file-1' }, item: record({ download_url: 'secret' }), secret: 'no' }] }]);
  const result = await library.favorites();
  assert.deepEqual(result, { items: [{ favorite_id: 'fav-1', availability: 'available', target_ref: { type: 'library_file', library_file_id: 'file-1' }, item: record() }], cursor: null });
  assert.equal(calls[0].query.include_sites, false);
});
test('favorite and unfavorite use library target and favorite identity respectively', async () => {
  const { library, calls } = fixture([{ favorite_id: 'fav-1', token: 'secret' }, { completed: true }]);
  assert.deepEqual(await library.favorite({ fileId: 'file-1' }), { fileId: 'file-1', favoriteId: 'fav-1' });
  assert.deepEqual(calls[0].body, { target_ref: { type: 'library_file', library_file_id: 'file-1' } });
  assert.deepEqual(await library.unfavorite({ favoriteId: 'fav-1' }), { favoriteId: 'fav-1', removed: true });
  assert.equal(calls[1].path, `${BASE}/favorites/fav-1`);
});
test('favorite status batches at most 50 distinct IDs and validates response identity', async () => {
  const { library, calls } = fixture([{ items: [{ target_ref: { type: 'library_file', library_file_id: 'file-1' }, availability: 'available', favorite: { favorite_id: 'fav-1', secret: 'no' } }] }]);
  assert.deepEqual(await library.favoriteStatus({ fileIds: ['file-1', 'file-1'] }), { items: [{ fileId: 'file-1', available: true, favorited: true, favoriteId: 'fav-1' }] });
  assert.equal(calls[0].body.target_refs.length, 1);
  await assert.rejects(library.favoriteStatus({ fileIds: [] }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.favoriteStatus({ fileIds: Array(51).fill('file-1') }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(fixture([{ items: [{ target_ref: { type: 'library_file', library_file_id: 'other' } }] }]).library.favoriteStatus({ fileIds: ['file-1'] }), { code: 'INVALID_RESPONSE' });
});
test('storage usage returns bounded explicit account totals', async () => {
  const { library, calls } = fixture([{ used_bytes: 100, allowed_bytes: 1000, remaining_bytes: 900, is_over_limit: false, limit_tier: 'plus', secret: 'no' }]);
  assert.deepEqual(await library.storageUsage(), { used_bytes: 100, allowed_bytes: 1000, remaining_bytes: 900, is_over_limit: false, limit_tier: 'plus' });
  assert.equal(calls[0].path, `${BASE}/storage/usage`); assert.equal(calls[0].maxBytes, 65536);
});
test('oversized pages invalid cursors and invalid storage totals are rejected', async () => {
  await assert.rejects(fixture([{ items: Array(1001).fill(record()) }]).library.browse(), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([{ items: [], cursor: 1 }]).library.browse(), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([{ used_bytes: Infinity, allowed_bytes: '1000' }]).library.storageUsage(), { code: 'INVALID_RESPONSE' });
});
test('unavailable favorites do not expose retained file metadata', async () => {
  const { library } = fixture([{ items: [{ favorite_id: 'fav-1', availability: 'unavailable', item: record() }] }]);
  assert.deepEqual(await library.favorites(), { items: [{ favorite_id: 'fav-1', availability: 'unavailable' }], cursor: null });
});
test('favorites enforce the native maximum of 50 and preserve its boundary', async () => {
  const { library, calls } = fixture([{ items: [], cursor: null }]);
  for (const limit of [0, 51, 100]) await assert.rejects(library.favorites({ limit }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0); await library.favorites({ limit: 50 }); assert.equal(calls[0].query.limit, 50);
});
test('missing favorite status and explicit rejected restoration are errors', async () => {
  await assert.rejects(fixture([{ items: [] }]).library.favoriteStatus({ fileIds: ['file-1'] }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([record(), { success: false }]).library.restore({ fileId: 'file-1' }), { code: 'MUTATION_UNCONFIRMED' });
});

test('browse supports full verified provider/page/root options and repeated category arrays', async () => {
  const { library, calls } = fixture([{ items: [] }]);
  await library.browse({ directoryId: null, categories: ['documents', 'pdfs'], source: 'uploaded', includeFiles: false, includeProviderRoots: true, includePages: true, includeSites: true, includeFolderCounts: true, includeOneDrive: true, hydrateFolderThumbnails: true });
  assert.deepEqual(calls[0].query, { parent_directory_id: null, cursor: undefined, q: undefined, entry_surface: 'library', include_files: false, include_saved_entities: true, include_sites: true, include_folder_counts: true, include_hidden_files: false, include_onedrive: true, source: 'uploaded', include_provider_roots: true, include_pages: true, hydrate_folder_thumbnails: true, categories: ['documents', 'pdfs'] });
});
test('search maps native provider/account/ranking/state filters without dropping false', async () => {
  const { library, calls } = fixture([{ items: [] }]);
  await library.search({ state: 'ready', source: 'generated', ranking: 'suggested', providers: ['box', 'box'], externalAccountKeys: { box: ['acct'] }, allowlistIds: ['f1', 'f1'], includeNativeFiles: false, includeUploadedFiles: true, includeImagegenFiles: false, includeSavedEntities: false, includePages: true, includeSites: true, excludeSpaceRoots: true });
  assert.deepEqual(calls[0].body, { limit: 50, q: null, trashed_only: false, include_hidden_files: false, include_saved_entities: false, include_sites: true, state: 'ready', source: 'generated', ranking: 'suggested', providers: ['box'], external_account_keys: { box: ['acct'] }, allowlist_ids: ['f1'], include_native_files: false, include_uploaded_files: true, include_imagegen_files: false, include_pages: true, exclude_space_roots: true });
});
test('advanced library filters are checked before requests', async () => {
  const { library, calls } = fixture();
  for (const options of [{ state: 'unknown' }, { ranking: 'other' }, { providers: ['evil'] }, { allowlistIds: ['../x'] }, { externalAccountKeys: { evil: ['x'] } }, { providers: ['box'], externalAccountKeys: { google_drive: ['x'] } }, { includePages: 'yes' }]) await assert.rejects(library.search(options), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.browse({ includeProviderRoots: 'yes' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});
