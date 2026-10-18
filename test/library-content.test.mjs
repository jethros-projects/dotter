import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryContent, libraryContentCapabilities } from '../src/library-content.mjs';
import { commands, createClient } from '../src/command-sets/library-content.mjs';

const BASE = '/backend-api/files/library';
const UUID = '11111111-1111-4111-8111-111111111111';
const record = (extra = {}) => ({ id: 'library:1', kind: 'file', file_id: 'upload-1', file_name: 'note.md', parent_directory_id: 'directory-1', ...extra });
function fixture(responses = [], binary = Buffer.from('body')) {
  const calls = [];
  const transport = { async request(method, path, options = {}) { calls.push({ method, path, ...options }); const value = responses.shift(); if (value instanceof Error) throw value; return value; },
    async requestBytes(method, path, options = {}) { calls.push({ method, path, ...options }); return typeof binary === 'function' ? binary() : binary; },
    async fetchSigned(url, options = {}) { calls.push({ kind: 'signed', url, ...options }); return typeof binary === 'function' ? binary() : binary; } };
  return { library: new LibraryContent({ transport }), calls };
}
async function scratch(fn) { const directory = await mkdtemp(join(tmpdir(), 'dot-lib-content-')); try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

test('content capabilities and CLI manifests expose real methods', () => {
  const { library } = fixture(); assert.equal(library.capabilities().limits.batchFiles, 25); assert.equal(libraryContentCapabilities().liveVerified, false);
  assert.ok(createClient({ transport: { request() {} } }) instanceof LibraryContent);
  for (const command of Object.values(commands)) assert.equal(typeof library[command.method], 'function');
  assert.equal(commands['library empty-trash'].required[0], 'confirm');
  assert.deepEqual(commands['library delete-permanently'].confirmMatch, [['confirm', 'fileId']]);
});
test('creates root and nested folders through the verified directory contract', async () => {
  const { library, calls } = fixture([{ id: 'folder-1', kind: 'directory', name: 'Reports' }, { id: 'folder-2', kind: 'directory', name: 'Archive' }]);
  await library.createDirectory({ name: ' Reports ' }); await library.createDirectory({ name: 'Archive', parentDirectoryId: 'folder-1' });
  assert.deepEqual(calls[0].body, { name: 'Reports', parent_directory_id: null }); assert.equal(calls[0].path, `${BASE}/directories`);
  assert.equal(calls[1].body.parent_directory_id, 'folder-1');
});
test('folder validation rejects traversal, empty names and unsafe fields before network', async () => {
  const { library, calls } = fixture();
  for (const name of ['', '  ', 'bad\nname', 'x'.repeat(1025)]) await assert.rejects(library.createDirectory({ name }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.createDirectory({ name: 'valid', parentDirectoryId: '../outside' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('folder deletion requires exact confirmation and explicit server success', async () => {
  const { library, calls } = fixture([{ success: true }, { success: false }]);
  await assert.rejects(library.deleteDirectory({ directoryId: 'folder-1', confirm: 'other' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0); assert.deepEqual(await library.deleteDirectory({ directoryId: 'folder-1', confirm: 'folder-1' }), { directoryId: 'folder-1', status: 'completed' });
  assert.equal(calls[0].path, `${BASE}/directories/folder-1`); assert.equal(calls[0].method, 'DELETE');
  await assert.rejects(library.deleteDirectory({ directoryId: 'folder-2', confirm: 'folder-2' }), { code: 'MUTATION_UNCONFIRMED' });
});
test('registers an external provider upload after its exact folder preflight without re-uploading bytes', async () => {
  const parentDirectoryId = 'external-box:folder:123';
  const { library, calls } = fixture([{ providers: { box: { capabilities: { library_browsing: { state: 'available' } } } } }, { items: [{ id: parentDirectoryId, kind: 'directory' }] }, record({ file_id: 'file-upload', file_name: 'report.pdf', parent_directory_id: parentDirectoryId, secret: 'no', download_url: 'https://x?token=s' })]);
  const result = await library.registerUpload({ fileId: 'file-upload', fileName: 'report.pdf', mimeType: 'application/pdf', parentDirectoryId });
  assert.deepEqual(calls[2].body, { parent_directory_id: parentDirectoryId, file_id: 'file-upload', file_name: 'report.pdf', mime_type: 'application/pdf' });
  assert.equal(result.secret, undefined); assert.equal(result.download_url, undefined);
});
test('upload registration rejects invalid MIME and IDs before network', async () => {
  const { library, calls } = fixture();
  await assert.rejects(library.registerUpload({ fileId: '../a', fileName: 'a' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.registerUpload({ fileId: 'a', fileName: 'a', mimeType: 'a\r\nb' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
  await assert.rejects(library.registerUpload({ fileId: 'CalpicoFile_room-file', fileName: 'a' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('inline creation preserves idempotency key and writing-block type', async () => {
  const { library, calls } = fixture([record()]); const result = await library.createInline({ content: '# New\nText', fileName: 'note.md', createKey: UUID });
  assert.equal(calls[0].path, `${BASE}/files/inline-content`); assert.deepEqual(calls[0].body, { content: '# New\nText', file_name: 'note.md', create_key: UUID, directory_id: null, library_file_info: { library_artifact_type: 'writing_block' } }); assert.equal(result.createKey, UUID);
});
test('inline empty text becomes the native newline and generates UUID once', async () => {
  const { library, calls } = fixture([record()]); await library.createInline({ content: '', fileName: 'note.md' }); assert.equal(calls[0].body.content, '\n'); assert.match(calls[0].body.create_key, /^[0-9a-f-]{36}$/);
});
test('inline writes validate all input and exact confirmation before network', async () => {
  const { library, calls } = fixture();
  for (const content of [null, '\0', 'a'.repeat(1024 * 1024 + 1)]) await assert.rejects(library.createInline({ content, fileName: 'note.md' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.createInline({ content: 'yes', fileName: 'note.md', createKey: 'key' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.updateInline({ fileId: 'library:1', content: 'yes', fileName: 'note.md', confirm: 'other' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('inline replacement uses observed patch fields and verifies returned identity', async () => {
  const { library, calls } = fixture([record(), record({ id: 'wrong' })]); await library.updateInline({ fileId: 'library:1', content: 'updated', fileName: 'note.md', confirm: 'library:1' });
  assert.equal(calls[0].path, `${BASE}/files/library%3A1`); assert.deepEqual(calls[0].body, { inline_content: 'updated', file_name: 'note.md' });
  await assert.rejects(library.updateInline({ fileId: 'library:1', content: 'updated', fileName: 'note.md', confirm: 'library:1' }), { code: 'INVALID_RESPONSE' });
});
test('recents uses native provider and account filters and projects visible metadata', async () => {
  const { library, calls } = fixture([{ items: [record({ download_url: 'secret' }), record({ id: 'hidden', hidden: true })], cursor: 'not-supported' }]);
  const result = await library.recents({ limit: 4, providers: ['native', 'dropbox'], externalAccountKeys: { dropbox: ['account-1'] } });
  assert.deepEqual(calls[0].query, { limit: 4, library_providers: ['native', 'dropbox'], external_account_keys: '{"dropbox":["account-1"]}' }); assert.equal(result.items.length, 1); assert.equal(result.items[0].download_url, undefined); assert.equal(result.cursor, null);
});
test('recents rejects invalid provider filters and oversized results', async () => {
  const { library, calls } = fixture();
  for (const options of [{ limit: 0 }, { providers: [] }, { providers: ['arbitrary'] }, { externalAccountKeys: ['bad\n'] }]) await assert.rejects(library.recents(options), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
  await assert.rejects(fixture([{ items: Array(1001).fill(record()) }]).library.recents(), { code: 'INVALID_RESPONSE' });
});
test('mark opened is an explicit write with a bounded acknowledgment', async () => {
  const { library, calls } = fixture([{ completed: true, token: 'secret' }]); assert.deepEqual(await library.markOpened({ fileId: 'library:1' }), { fileId: 'library:1', status: 'completed' }); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, `${BASE}/files/library%3A1/opened`);
});
test('download saves bytes privately without returning signed links', async () => scratch(async directory => {
  const { library, calls } = fixture([{ download_url: 'https://files.oaiusercontent.com/private?sig=secret' }]); const output = join(directory, 'a.bin');
  const result = await library.download({ fileId: 'library:1', output }); assert.deepEqual(await readFile(output), Buffer.from('body')); assert.equal((await stat(output)).mode & 0o777, 0o600); assert.equal(result.path, await realpath(output)); assert.equal(result.sizeBytes, 4); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(calls[1].kind, 'signed');
}));
test('mounted content and downloads require explicit materialization without a network write', async () => scratch(async directory => {
  const { library, calls } = fixture();
  for (const prefix of ['gdrive', 'box', 'dropbox', 'sharepoint', 'onedrive']) {
    const fileId = `external-${prefix}:file:sample`;
    for (const method of ['content', 'download']) {
      await assert.rejects(library[method]({ fileId, output: join(directory, prefix) }), error => {
        assert.equal(error.code, 'UNSUPPORTED');
        assert.match(error.message, /explicit materialization/);
        assert.match(error.message, /returned file_id/);
        return true;
      });
    }
  }
  assert.equal(calls.length, 0);
}));
test('content supports authenticated estuary with fixed origin only', async () => scratch(async directory => {
  const { library, calls } = fixture([{ content_url: '/backend-api/estuary/content?id=a&token=not-echoed' }]);
  await library.content({ fileId: 'library:1', output: join(directory, 'a.bin') }); assert.equal(calls[0].path, `${BASE}/files/library%3A1/content_url`); assert.equal(calls[1].path, '/backend-api/estuary/content'); assert.deepEqual(calls[1].query, { id: 'a', token: 'not-echoed' });
}));
test('download supports the verified signed Library content route and checks its file identity', async () => scratch(async directory => {
  const url = '/backend-api/files/library/content_download?library_file_id=library%3A1&sig=private-signature';
  const { library, calls } = fixture([{ download_url: url }]);
  const result = await library.download({ fileId: 'library:1', output: join(directory, 'note.bin') });
  assert.equal(calls[1].path, `${BASE}/content_download`); assert.equal(calls[1].query.library_file_id, 'library:1');
  assert.equal(JSON.stringify(result).includes('private-signature'), false);
  const other = fixture([{ download_url: url.replace('library%3A1', 'other') }]);
  await assert.rejects(other.library.download({ fileId: 'library:1', output: join(directory, 'other.bin') }), { code: 'INVALID_RESPONSE' });
  assert.equal(other.calls.length, 1);
}));
test('legacy Library nodes download through their verified underlying file ID', async () => scratch(async directory => {
  const absent = () => Object.assign(new Error('not found'), { code: 'HTTP_ERROR', details: { status: 404 } });
  const { library, calls } = fixture([absent(), absent(), record({ file_id: 'file_underlying' }), { download_url: 'https://files.oaiusercontent.com/raw?sig=private' }]);
  await library.download({ fileId: 'library:1', output: join(directory, 'legacy.bin') });
  assert.equal(calls[2].path, `${BASE}/files/library%3A1/node`);
  assert.equal(calls[3].path, '/backend-api/files/download/file_underlying');
  assert.equal(calls[3].query, undefined);
}));
test('materialized general Files IDs use the native downloader without room or Library lookups', async () => scratch(async directory => {
  for (const fileId of ['file-materialized', 'file_materialized']) {
    for (const method of ['download', 'content']) {
      const { library, calls } = fixture([{ file_id: fileId, download_url: 'https://files.oaiusercontent.com/materialized?sig=private' }]);
      await library[method]({ fileId, output: join(directory, fileId + '-' + method) });
      assert.equal(calls[0].path, `/backend-api/files/download/${fileId}`);
      assert.deepEqual(calls[0].query, method === 'content' ? { inline: 'true' } : undefined);
      assert.equal(calls.length, 2);
    }
  }
  const mismatch=fixture([{ file_id: 'file_other', download_url: 'https://files.oaiusercontent.com/materialized?sig=private' }]);
  await assert.rejects(mismatch.library.download({ fileId:'file_materialized',output:join(directory,'wrong') }), { code:'INVALID_RESPONSE' });
  assert.equal(mismatch.calls.length,1);
}));
test('legacy asset fallback never follows forbidden responses or directory sources', async () => scratch(async directory => {
  const forbidden = fixture([Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', details: { status: 403 } })]);
  await assert.rejects(forbidden.library.content({ fileId: 'library:1', output: join(directory, 'forbidden') }), { code: 'FORBIDDEN' });
  assert.equal(forbidden.calls.length, 1);
  const absent = () => Object.assign(new Error('not found'), { code: 'HTTP_ERROR', details: { status: 404 } });
  const folder = fixture([absent(), absent(), record({ kind: 'directory' })]);
  await assert.rejects(folder.library.download({ fileId: 'library:1', output: join(directory, 'folder') }), { code: 'UNSUPPORTED' });
  assert.equal(folder.calls.length, 3);
}));
test('thumbnail uses exact thumbnail URL contract', async () => scratch(async directory => {
  const { library, calls } = fixture([{ thumbnail_url: 'https://files.oaiusercontent.com/thumb' }], Buffer.from('png'));
  const result = await library.thumbnail({ fileId: 'library:1', output: join(directory, 'a.png') }); assert.equal(result.kind, 'thumbnail'); assert.equal(calls[0].path, `${BASE}/files/library%3A1/thumbnail_url`);
}));
test('download refuses arbitrary hosts, credentials and mismatched identity', async () => scratch(async directory => {
  for (const url of ['https://evil.test/file', 'https://files.oaiusercontent.com.evil.test/file', 'https://user@files.oaiusercontent.com/file', 'http://files.oaiusercontent.com/file', '/backend-api/accounts/me']) {
    const f = fixture([{ download_url: url }]); await assert.rejects(f.library.download({ fileId: 'library:1', output: join(directory, 'x') }), { code: 'UNSAFE_DOWNLOAD_URL' }); assert.equal(f.calls.length, 1);
  }
  await assert.rejects(fixture([{ id: 'other', download_url: 'https://files.oaiusercontent.com/file' }]).library.download({ fileId: 'library:1', output: join(directory, 'x') }), { code: 'INVALID_RESPONSE' });
}));
test('download validates output bounds and rejects invalid binary responses', async () => scratch(async directory => {
  const f = fixture(); for (const options of [{ maxBytes: 0 }, { maxBytes: 100 * 1024 * 1024 + 1 }, { overwrite: 'yes' }, { range: 'bytes=2-1' }, { range: 'bytes=0-' }, { range: 'bytes=0-100', maxBytes: 10 }]) await assert.rejects(f.library.download({ fileId: 'library:1', output: join(directory, 'x'), ...options }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
  await assert.rejects(fixture([{ download_url: 'https://files.oaiusercontent.com/x' }], 'text').library.download({ fileId: 'library:1', output: join(directory, 'x') }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fixture([{ download_url: 'https://files.oaiusercontent.com/x' }], Buffer.alloc(11)).library.download({ fileId: 'library:1', output: join(directory, 'x'), maxBytes: 10 }), { code: 'INVALID_RESPONSE' });
}));
test('valid range saves only confirmed range bytes', async () => scratch(async directory => {
  const { library, calls } = fixture([{ content_url: 'https://files.oaiusercontent.com/x' }], { status: 206, headers: new Headers({ 'content-range': 'bytes 2-4/10' }), body: Buffer.from('abc') });
  const result = await library.content({ fileId: 'library:1', output: join(directory, 'part'), range: 'bytes=2-4' }); assert.equal(result.range, 'bytes=2-4'); assert.equal(calls[1].range, 'bytes=2-4'); assert.equal(calls[1].includeResponse, true); assert.equal(await readFile(result.path, 'utf8'), 'abc');
}));
test('unhonored and malformed range responses are not saved', async () => scratch(async directory => {
  for (const binary of [{ status: 200, headers: new Headers(), body: Buffer.from('abc') }, { status: 206, headers: new Headers({ 'content-range': 'bytes 0-2/10' }), body: Buffer.from('abc') }, { status: 206, headers: new Headers({ 'content-range': 'bytes 2-4/10' }), body: Buffer.from('abcd') }]) {
    await assert.rejects(fixture([{ content_url: 'https://files.oaiusercontent.com/x' }], binary).library.content({ fileId: 'library:1', output: join(directory, 'part'), range: 'bytes=2-4' }), { code: 'INVALID_RANGE_RESPONSE' });
  }
}));
test('downloads never overwrite or follow symlink destinations implicitly', async () => scratch(async directory => {
  const output = join(directory, 'file'); await writeFile(output, 'original');
  await assert.rejects(fixture([{ download_url: 'https://files.oaiusercontent.com/x' }]).library.download({ fileId: 'library:1', output }), { code: 'OUTPUT_EXISTS' }); assert.equal(await readFile(output, 'utf8'), 'original');
  const link = join(directory, 'link'); await symlink(output, link);
  await assert.rejects(fixture([{ download_url: 'https://files.oaiusercontent.com/x' }]).library.download({ fileId: 'library:1', output: link, overwrite: true }), { code: 'INVALID_OUTPUT' }); assert.equal(await readFile(output, 'utf8'), 'original');
}));
test('plan summaries filter hidden reasoning and preserve visible structure', async () => {
  const { library, calls } = fixture([{ state: { plan_type: 'language_learning', title: 'Learn', sections: [{ title: 'One', text: 'visible' }, { channel: 'analysis', text: 'private' }], reasoning: 'private' }, code: { id: 'code-1' }, token: 'secret' }]);
  const result = await library.planSummary({ fileId: 'library:1' }); assert.equal(result.state.sections.length, 1); assert.equal(result.state.reasoning, undefined); assert.equal(result.token, undefined); assert.equal(calls[0].path, `${BASE}/files/library%3A1/plan-summary`);
});
test('saved report preview recursively suppresses secrets and hidden message metadata', async () => {
  const { library } = fixture([{ tool_output: { title: 'Report', sections: [{ text: 'keep' }, { metadata: { is_hidden: true }, text: 'private' }], links: ['https://source.test/article', 'https://files.oaiusercontent.com/x?sig=secret'] }, widget_state: { expanded: true }, tool_response_metadata: { token: 'secret' } }]);
  const result = await library.deepResearch({ fileId: 'library:1' }); assert.equal(result.tool_output.sections.length, 1); assert.deepEqual(result.tool_output.links, ['https://source.test/article']); assert.equal(result.tool_response_metadata, undefined); assert.deepEqual(result.widget_state, { expanded: true });
});
test('hidden report root is rejected and deep structures bounded', async () => {
  await assert.rejects(fixture([{ hidden: true, tool_output: { text: 'private' } }]).library.deepResearch({ fileId: 'library:1' }), { code: 'NOT_VISIBLE' });
  let nested = {}; for (let i = 0; i < 40; i++) nested = { child: nested }; await assert.rejects(fixture([nested]).library.planSummary({ fileId: 'library:1' }), { code: 'INVALID_RESPONSE' });
});
test('report tools use fixed allowlisted names and args envelopes', async () => {
  const { library, calls } = fixture([{ structuredContent: { title: 'Report', metadata: { token: 'secret' } } }, { structuredContent: { images: [] } }]);
  assert.equal((await library.deepResearchState({ fileId: 'library:1', args: { language: 'en' } })).structuredContent.title, 'Report');
  await library.deepResearchImages({ fileId: 'library:1' }); assert.equal(calls[0].path, `${BASE}/files/library%3A1/deep-research/tools/get_state`); assert.deepEqual(calls[0].body, { args: { language: 'en' } }); assert.equal(calls[1].path, `${BASE}/files/library%3A1/deep-research/tools/get_inline_images`);
});
test('report tool errors are explicit and response metadata not exposed', async () => {
  await assert.rejects(fixture([{ isError: true, structuredContent: { token: 'secret' } }]).library.deepResearchState({ fileId: 'library:1' }), { code: 'REPORT_TOOL_ERROR' });
  const result = await fixture([{ structuredContent: { text: 'okay' }, meta: { token: 'secret' } }]).library.deepResearchState({ fileId: 'library:1' }); assert.equal(result.meta, undefined);
});
test('report tool arguments reject non-JSON and oversized inputs before network', async () => {
  const { library, calls } = fixture(); const circular = {}; circular.self = circular;
  for (const args of [[], 'bad', new Date(), circular, { text: 'x'.repeat(65537) }, { text: '\0' }]) await assert.rejects(library.deepResearchImages({ fileId: 'library:1', args }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('report export writes filtered JSON privately and returns only destination', async () => scratch(async directory => {
  const { library, calls } = fixture([{ structuredContent: { format: 'markdown', text: '# Report', download_url: 'secret' }, meta: { token: 'secret' } }]);
  const result = await library.deepResearchExport({ fileId: 'library:1', args: { format: 'markdown' }, output: join(directory, 'export.json') }); assert.equal(calls[0].path, `${BASE}/files/library%3A1/deep-research/tools/export`); assert.equal(result.format, 'json'); assert.equal((await stat(result.path)).mode & 0o777, 0o600); const saved = JSON.parse(await readFile(result.path, 'utf8')); assert.equal(saved.structuredContent.text, '# Report'); assert.equal(JSON.stringify(saved).includes('secret'), false);
}));
test('permanent deletion validates exact ID and reads current metadata first', async () => {
  const { library, calls } = fixture([record(), { success: true }]); await assert.rejects(library.permanentDelete({ fileId: 'library:1', confirm: true }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
  assert.deepEqual(await library.permanentDelete({ fileId: 'library:1', confirm: 'library:1' }), { fileId: 'library:1', status: 'completed' }); assert.equal(calls[1].method, 'DELETE'); assert.deepEqual(calls[1].query, { soft_delete: false, file_id: 'upload-1', parent_directory_id: 'directory-1', file_name: 'note.md' });
});
test('permanent deletion resolves only the selected trashed file before deleting', async () => {
  const absent = () => Object.assign(new Error('not found'), { code: 'HTTP_ERROR', details: { status: 404 } });
  const { library, calls } = fixture([absent(), absent(), { items: [record({ trashed_at: '2026-10-18' })] }, { success: true }]);
  await library.permanentDelete({ fileId: 'library:1', confirm: 'library:1' });
  assert.equal(calls[2].body.trashed_only, true);
  assert.equal(calls[3].method, 'DELETE'); assert.equal(calls[3].query.soft_delete, false);
});
test('permanent deletion rejects Pages and directories without issuing delete', async () => {
  for (const extra of [{ kind: 'directory' }, { library_artifact_type: 'page' }, { library_artifact_type: 'site' }, { library_artifact_type: 'saved_entity' }]) {
    const f = fixture([record(extra)]); await assert.rejects(f.library.permanentDelete({ fileId: 'library:1', confirm: 'library:1' }), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 1);
  }
});
test('batch deletes confirmed regular files using fresh metadata and reports partial success', async () => {
  const { library, calls } = fixture([record(), record({ id: 'library:2', file_id: 'upload-2' }), { files: [{ library_file_id: 'library:1', success: true, token: 'secret' }, { library_file_id: 'library:2', success: false }] }]);
  const result = await library.deleteBatch({ fileIds: ['library:1', 'library:2'], confirmFileIds: ['library:2', 'library:1'] }); assert.equal(result.status, 'partial'); assert.equal(result.deletion, 'soft'); assert.equal(result.files[0].token, undefined); assert.equal(calls[2].path, `${BASE}/files/delete-batch`); assert.equal(calls[2].body.files[1].file_id, 'upload-2');
});
test('batch invalid IDs confirmations and duplicates fail before reads', async () => {
  const { library, calls } = fixture();
  for (const options of [{ fileIds: [], confirmFileIds: [] }, { fileIds: ['a'], confirmFileIds: ['b'] }, { fileIds: ['a', 'a'], confirmFileIds: ['a', 'a'] }, { fileIds: ['../a'], confirmFileIds: ['../a'] }, { fileIds: Array(26).fill('a'), confirmFileIds: [] }]) await assert.rejects(library.deleteBatch(options), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('batch response must account for every requested ID uniquely', async () => {
  for (const files of [[], [{ library_file_id: 'other', success: true }], [{ library_file_id: 'library:1', success: 'true' }]]) await assert.rejects(fixture([record(), { files }]).library.deleteBatch({ fileIds: ['library:1'], confirmFileIds: ['library:1'] }), { code: 'MUTATION_UNCONFIRMED' });
});
test('batch preflight rejects unsupported member before any deletion', async () => {
  const f = fixture([record(), record({ id: 'library:2', kind: 'directory' })]); await assert.rejects(f.library.deleteBatch({ fileIds: ['library:1', 'library:2'], confirmFileIds: ['library:1', 'library:2'] }), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('empty-trash is account-wide explicit confirmation and reports partial counts', async () => {
  const { library, calls } = fixture([{ deleted_count: 2, failed_count: 1, token: 'secret' }]); await assert.rejects(library.emptyTrash({ confirm: true }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
  assert.deepEqual(await library.emptyTrash({ confirm: 'EMPTY LIBRARY TRASH' }), { deletedCount: 2, failedCount: 1, status: 'partial' }); assert.equal(calls[0].method, 'DELETE'); assert.equal(calls[0].path, `${BASE}/trash`);
});
test('ambiguous trash response is not called success and never retried', async () => {
  const f = fixture([{ success: true }]); await assert.rejects(f.library.emptyTrash({ confirm: 'EMPTY LIBRARY TRASH' }), { code: 'MUTATION_UNCONFIRMED' }); assert.equal(f.calls.length, 1);
});

test('Page attachment content uses its explicit page scope and attach-auth marker', async () => scratch(async directory => {
  const { library, calls } = fixture([], Buffer.from('page bytes'));
  await library.content({ fileId: 'fde1_attachment', pageId: 'page-1', output: join(directory, 'page.bin') });
  assert.equal(calls[0].path, `${BASE}/files/fde1_attachment/content_redirect`); assert.deepEqual(calls[0].query, { page_id: 'page-1' }); assert.deepEqual(calls[0].headers, { 'X-OpenAI-Attach-Auth': '1' });
}));
test('Page attachment download explicitly requests download intent', async () => scratch(async directory => {
  const { library, calls } = fixture([], Buffer.from('page bytes'));
  await library.download({ fileId: 'fde2_attachment', pageId: 'page-1', output: join(directory, 'page.bin') });
  assert.equal(calls[0].path, `${BASE}/files/fde2_attachment/download_redirect`); assert.deepEqual(calls[0].query, { page_id: 'page-1', start_download: true });
}));
test('Page attachment requests reject invalid page scope and unsupported thumbnails before calls', async () => {
  const { library, calls } = fixture();
  await assert.rejects(library.content({ fileId: 'file', pageId: '../page', output: '/tmp/file' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(library.thumbnail({ fileId: 'file', pageId: 'page', output: '/tmp/file' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('recents requires the native provider-to-account mapping shape', async () => {
  const { library, calls } = fixture();
  for (const externalAccountKeys of [[], ['account'], { other: [] }, { dropbox: 'account' }, { dropbox: ['bad\n'] }]) await assert.rejects(library.recents({ externalAccountKeys }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('report helper rejects arbitrary tool routes before calls', async () => {
  const { library, calls } = fixture(); await assert.rejects(library._reportTool('../delete', { fileId: 'library:1' }), { code: 'INVALID_ARGUMENT' }); assert.equal(calls.length, 0);
});
test('download abort before publication does not write a file', async () => scratch(async directory => {
  const controller = new AbortController(); const f = fixture([{ download_url: 'https://files.oaiusercontent.com/x' }], () => { controller.abort(); return Buffer.from('data'); });
  await assert.rejects(f.library.download({ fileId: 'library:1', output: join(directory, 'cancelled'), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(readFile(join(directory, 'cancelled')), { code: 'ENOENT' });
}));

test('real transport forwards range only to approved signed file host without credentials', async () => scratch(async directory => {
  const { Transport } = await import('../src/transport.mjs'); const calls = [];
  const transport = new Transport({ authLoader: async () => ({ accessToken: 'test-secret', accountId: 'test-account' }), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes('/content_url')) return new Response(JSON.stringify({ content_url: 'https://files.oaiusercontent.com/file?sig=test' }), { headers: { 'content-type': 'application/json' } });
    return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/10' } });
  } });
  await new LibraryContent({ transport }).content({ fileId: 'library:1', output: join(directory, 'part'), range: 'bytes=2-4' });
  assert.equal(calls[0].headers.Authorization, 'Bearer test-secret'); assert.equal(calls[1].headers.Authorization, undefined); assert.equal(calls[1].headers['ChatGPT-Account-Id'], undefined); assert.equal(calls[1].headers.Range, 'bytes=2-4');
}));
test('real transport serializes recent providers as repeated query keys', async () => {
  const { Transport } = await import('../src/transport.mjs'); let target;
  const transport = new Transport({ authLoader: async () => ({ accessToken: 'test-secret' }), fetchImpl: async url => { target = new URL(url); return new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } }); } });
  await new LibraryContent({ transport }).recents({ providers: ['native', 'box'], externalAccountKeys: { box: ['account-1'] } }); assert.deepEqual(target.searchParams.getAll('library_providers'), ['native', 'box']); assert.equal(target.searchParams.get('external_account_keys'), '{"box":["account-1"]}');
});
