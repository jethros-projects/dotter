import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, readdir, symlink, rm, truncate, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFile, downloadFile, listArtifacts, fileDownloadTarget, MAX_UPLOAD_BYTES, MAX_DOWNLOAD_BYTES } from '../src/files.mjs';

const roomId = 'room_test';
const fileId = 'file_test';
const bytes = Buffer.from('test contents\n');

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-files-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
function mockClient({ metadata, upload, download = bytes, pages = [], onBytes } = {}) {
  const calls = [];
  const transport = {
    async request(method, path, options = {}) { calls.push({ kind: 'json', method, path, ...options }); return metadata; },
    async requestMultipart(method, path, options = {}) { calls.push({ kind: 'multipart', method, path, ...options }); return upload; },
    async requestBytes(method, path, options = {}) {
      calls.push({ kind: 'bytes', method, path, ...options }); await onBytes?.(); return download;
    },
    async fetchSigned(url, options = {}) { calls.push({ kind: 'signed', url, ...options }); await onBytes?.(); return download; },
  };
  return { calls, client: {
    transport,
    async resolveRoom(room) { return room ?? roomId; },
    async history(options) { calls.push({ kind: 'history', ...options }); return pages.shift(); },
  } };
}
function metadata(extra = {}) {
  return { id: fileId, name: 'result.txt', mime_type: 'text/plain', size_bytes: bytes.length,
    download_url: 'https://files.oaiusercontent.com/result?se=future&sig=secret', ...extra };
}

test('uploads one multipart file using the verified messaging route and safe attachment metadata', async t => {
  const dir = await scratch(t), path = join(dir, 'note.txt');
  await writeFile(path, bytes);
  const { client, calls } = mockClient({ upload: { id: fileId, status: 'ready', download_url: 'secret' } });
  const signal = new AbortController().signal;
  const result = await uploadFile(client, { roomId, file: path, signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'multipart');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}/files`);
  assert.equal(calls[0].signal, signal);
  assert.deepEqual(calls[0].file, { name: 'note.txt', mimeType: 'text/plain', bytes });
  assert.deepEqual(result, { roomId, fileId, name: 'note.txt', mimeType: 'text/plain', sizeBytes: bytes.length, status: 'ready',
    attachment: { type: 'file', file_id: fileId, name: 'note.txt', mime_type: 'text/plain', size_bytes: bytes.length, status: 'ready' } });
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('upload rejects empty, oversized, directory, symlink and unsafe-filename sources without network activity', async t => {
  const dir = await scratch(t), empty = join(dir, 'empty.txt'), large = join(dir, 'large.bin');
  await writeFile(empty, ''); await writeFile(large, ''); await truncate(large, MAX_UPLOAD_BYTES + 1);
  const target = join(dir, 'source.txt'); await writeFile(target, bytes);
  const symlinkPath = join(dir, 'link.txt'); await symlink(target, symlinkPath);
  const unsafe = join(dir, 'new\nline.txt'); await writeFile(unsafe, bytes);
  const { client, calls } = mockClient();
  for (const [file, code] of [[empty, 'FILE_SIZE'], [large, 'FILE_SIZE'], [dir, 'INVALID_FILE'], [symlinkPath, 'INVALID_FILE'], [unsafe, 'INVALID_FILENAME']]) {
    await assert.rejects(uploadFile(client, { file }), { code });
  }
  assert.equal(calls.length, 0);
});

test('upload validates response IDs and cancellation before posting', async t => {
  const dir = await scratch(t), path = join(dir, 'x.txt'); await writeFile(path, bytes);
  const { client, calls } = mockClient({ upload: { id: '../../bad' } });
  await assert.rejects(uploadFile(client, { file: path }), { code: 'INVALID_RESPONSE' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(uploadFile(client, { file: path, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('downloads a signed file without exposing the signed URL and writes an atomic private file', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  const { client, calls } = mockClient({ metadata: metadata() });
  const result = await downloadFile(client, { roomId, fileId, output });
  assert.deepEqual(result, { roomId, fileId, name: 'result.txt', mimeType: 'text/plain', sizeBytes: bytes.length, path: output });
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}/files/${fileId}`);
  assert.equal(calls[1].kind, 'signed');
  assert.equal(calls[1].maxBytes, MAX_DOWNLOAD_BYTES);
  assert.equal(calls[1].headers, undefined);
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['saved.txt']);
  assert.ok(!JSON.stringify(result).includes('sig='));
});

test('downloads verified same-origin estuary content through the authenticated byte transport', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  const { client, calls } = mockClient({ metadata: metadata({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_test&download=true' }) });
  await downloadFile(client, { fileId, output });
  assert.equal(calls[1].kind, 'bytes');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].path, '/backend-api/estuary/content');
  assert.deepEqual(calls[1].query, { id: fileId, download: 'true' });
});

test('only verified HTTPS file hosts and content routes are accepted', () => {
  assert.equal(fileDownloadTarget('https://files.oaiusercontent.com/f?sig=secret').kind, 'signed');
  assert.equal(fileDownloadTarget('/backend-api/estuary/content?id=x').kind, 'authenticated');
  assert.equal(fileDownloadTarget('https://chatgpt.com/backend-api/estuary/public_content/enc/file-token').kind, 'authenticated');
  for (const url of [
    'http://files.oaiusercontent.com/file', 'https://files.oaiusercontent.com.evil.test/file',
    'https://sub.files.oaiusercontent.com/file', 'https://evil.test/file', 'https://127.0.0.1/file',
    'https://user:password@files.oaiusercontent.com/file', 'https://files.oaiusercontent.com:444/file',
    'https://files.oaiusercontent.com/file#secret', 'https://files.oaiusercontent.com/file\n',
    'https://chatgpt.com/backend-api/tbo/primary', 'https://chatgpt.com/backend-api/estuary/public_content/enc/a/b',
    'https://files.oaiusercontent.com\\@evil.test/file', 'https://files.oaiusercontent.com/file?sig=%0dheader',
  ]) assert.throws(() => fileDownloadTarget(url), { code: 'UNSAFE_DOWNLOAD_URL' }, url);
});
test('Library signed content_download URLs require the exact verified query contract', () => {
  const url = 'https://chatgpt.com/backend-api/files/library/content_download?library_file_id=library%3A1&inline=false&owner_id=u&drive_id=d&ts=1&p=pointer&sig=signature&v=1';
  const target = fileDownloadTarget(url);
  assert.equal(target.kind, 'authenticated'); assert.equal(target.route, '/backend-api/files/library/content_download');
  assert.equal(target.query.library_file_id, 'library:1');
  for (const bad of [url.replace('sig=signature', 'sig='), url + '&redirect=https://evil.test', url + '&library_file_id=other', url.replace('/content_download?', '/other?')]) {
    assert.throws(() => fileDownloadTarget(bad), { code: 'UNSAFE_DOWNLOAD_URL' });
  }
});
test('regional OpenAI raw-file SAS downloads are accepted only for the observed host and signed shape', () => {
  const url = 'https://sdmntprcentralus.oaiusercontent.com/files/12345678-1234-1234-1234-123456789abc/raw?se=2099-01-01&sp=r&sv=2024-01-01&sr=b&scid=scope&skoid=owner&sktid=tenant&skt=start&ske=end&sks=b&skv=2024-01-01&sig=private';
  assert.equal(fileDownloadTarget(url).kind, 'signed');
  for (const bad of [url.replace('.oaiusercontent.com', '.oaiusercontent.com.evil.test'), url.replace('sdmntprcentralus', 'sdmntother'), url.replace('/raw?', '/other?'), url.replace('&sig=private', ''), url + '&redirect=https://evil.test', url + '&sig=duplicate']) {
    assert.throws(() => fileDownloadTarget(bad), { code: 'UNSAFE_DOWNLOAD_URL' });
  }
});
test('download receipts expose the separate Library ID from room-file metadata', async t => {
  const dir = await scratch(t), output = join(dir, 'library-map.txt');
  const { client } = mockClient({ metadata: metadata({ library_file_id: 'library:map' }) });
  const out = await downloadFile(client, { fileId, output });
  assert.equal(out.fileId, fileId); assert.equal(out.libraryFileId, 'library:map');
});

test('download rejects bad IDs, mismatched metadata and unsafe filenames before byte transfer', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  for (const extra of [{ id: 'other' }, { name: '../escape.txt' }, { size_bytes: MAX_DOWNLOAD_BYTES + 1 }, { download_url: 'https://evil.test/f' }]) {
    const { client, calls } = mockClient({ metadata: metadata(extra) });
    await assert.rejects(downloadFile(client, { fileId, output }));
    assert.equal(calls.length, 1);
  }
  const { client, calls } = mockClient();
  await assert.rejects(downloadFile(client, { fileId: '../bad', output }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});

test('download refuses existing files and symlinks even when overwrite is requested for a symlink', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt'), link = join(dir, 'link.txt');
  await writeFile(output, 'original'); await symlink(output, link);
  for (const options of [{ output }, { output: link }, { output: link, overwrite: true }]) {
    const { client, calls } = mockClient({ metadata: metadata() });
    await assert.rejects(downloadFile(client, { fileId, ...options }));
    assert.equal(calls.length, 1);
  }
  assert.equal(await readFile(output, 'utf8'), 'original');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test('overwrite atomically replaces a regular file and makes the result private', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  await writeFile(output, 'old data', { mode: 0o644 });
  const { client } = mockClient({ metadata: metadata() });
  await downloadFile(client, { fileId, output, overwrite: true });
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['saved.txt']);
});

test('a file appearing during transfer is not overwritten', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  const { client } = mockClient({ metadata: metadata(), onBytes: () => writeFile(output, 'appeared') });
  await assert.rejects(downloadFile(client, { fileId, output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), 'appeared');
  assert.deepEqual(await readdir(dir), ['saved.txt']);
});

test('a symlink appearing during overwrite is not followed or replaced', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt'), victim = join(dir, 'victim.txt');
  await writeFile(output, 'old'); await writeFile(victim, 'victim');
  const { client } = mockClient({ metadata: metadata(), onBytes: async () => { await rm(output); await symlink(victim, output); } });
  await assert.rejects(downloadFile(client, { fileId, output, overwrite: true }), { code: 'UNSAFE_OUTPUT' });
  assert.equal(await readFile(victim, 'utf8'), 'victim');
  assert.equal((await lstat(output)).isSymbolicLink(), true);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.part')), false);
});

test('bad byte responses and size mismatches never publish a file', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt');
  for (const download of [Buffer.from('wrong length'), 'not bytes']) {
    const { client } = mockClient({ metadata: metadata(), download });
    await assert.rejects(downloadFile(client, { fileId, output }));
    assert.deepEqual(await readdir(dir), []);
  }
});

test('abort during transfer does not save a file', async t => {
  const dir = await scratch(t), output = join(dir, 'saved.txt'), abort = new AbortController();
  const { client } = mockClient({ metadata: metadata(), onBytes: () => abort.abort() });
  await assert.rejects(downloadFile(client, { fileId, output, signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(dir), []);
});

test('artifact listing follows only visible normalized messages and strips secret URLs and unknown fields', async () => {
  const pages = [
    { messages: [{ id: 'm2', createdAt: '2026-10-17', attachments: [
      { type: 'file', fileId, name: 'result.txt', mimeType: 'text/plain', sizeBytes: 12, download_url: 'secret', raw_messages: 'hidden' },
      { type: 'link', title: 'Link', url: 'https://example.com?token=secret' },
    ] }], prevCursor: 'older' },
    { messages: [{ id: 'm1', attachments: [{ type: 'file', file_id: 'file_old', name: 'old.pdf' }] }], prevCursor: null },
  ];
  const { client, calls } = mockClient({ pages });
  const result = await listArtifacts(client, { pages: 4 });
  assert.deepEqual(result, { roomId, artifacts: [
    { messageId: 'm2', createdAt: '2026-10-17', type: 'file', fileId, name: 'result.txt', mimeType: 'text/plain', sizeBytes: 12 },
    { messageId: 'm2', createdAt: '2026-10-17', type: 'link', title: 'Link' },
    { messageId: 'm1', createdAt: null, type: 'file', fileId: 'file_old', name: 'old.pdf' },
  ], pagesRead: 2, nextCursor: null, truncated: false });
  assert.equal(calls[1].before, 'older');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('hidden'));
});

test('artifact listing reports bounded truncation and rejects repeated cursors', async () => {
  const bounded = mockClient({ pages: [{ messages: [], prevCursor: 'more' }] });
  assert.deepEqual(await listArtifacts(bounded.client, { pages: 1 }), { roomId, artifacts: [], pagesRead: 1, nextCursor: 'more', truncated: true });
  const repeated = mockClient({ pages: [{ messages: [], prevCursor: 'same' }, { messages: [], prevCursor: 'same' }] });
  await assert.rejects(listArtifacts(repeated.client), { code: 'CURSOR_LOOP' });
  for (const pages of [0, 101, 1.5, '1']) await assert.rejects(listArtifacts(mockClient().client, { pages }), { code: 'INVALID_ARGUMENT' });
});
