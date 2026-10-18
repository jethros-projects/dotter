import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryProviders } from '../src/library-providers.mjs';
import { LibraryContent } from '../src/library-content.mjs';
import { Transport } from '../src/transport.mjs';
import { DotError } from '../src/errors.mjs';

const BASE = '/backend-api/files/library';
const mountedId = 'external-gdrive:account:fixture:file:abc-123';
const microsoftId = 'external-sharepoint:file:fixture';
const token = subject => `h.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.s`;
const materialize = api => api.materialize({ fileId: mountedId, name: 'fixture.txt', mimeType: 'text/plain' });
function fixture(response) {
  const calls = [], transport = { request: async (method, route, options) => { calls.push({ method, route, ...options }); return typeof response === 'function' ? response(calls.at(-1)) : response; } };
  return { calls, api: new LibraryProviders({ transport }) };
}
function registration(receipt, parent = 'external-box:account:work:folder:123') {
  const calls = [];
  const transport = { request: async (method, route, options) => {
    calls.push({ method, route, ...options });
    if (route.endsWith('/mounted/capabilities')) return { providers: { box: { capabilities: { library_browsing: { state: 'available' } } } } };
    if (route.endsWith('/directories/path')) return { items: [{ id: parent }] };
    return receipt;
  } };
  return { api: new LibraryContent({ transport }), calls, input: { fileId: 'file-source', fileName: 'fixture.txt', parentDirectoryId: parent } };
}

for (const value of [null, [], {}, { file_id: mountedId }, { file_id: 'library:fixture' }, { file_id: 'file-../private' },
  { file_id: 'file-fixture', hidden: true }, { file_id: 'file-fixture', metadata: { channel: 'analysis' } }, { file_id: 'file-fixture', kind: 'directory' }]) {
  test(`unusable materialization receipt reports unknown delivery without a replay (${JSON.stringify(value)})`, async () => {
    const { api, calls } = fixture(value);
    await assert.rejects(materialize(api), error => error?.code === 'MUTATION_UNCONFIRMED' && error.details?.delivery === 'unknown');
    assert.equal(calls.length, 1); assert.equal(calls[0].route, `${BASE}/mounted/materialize`);
  });
}

test('materialization preserves transport uncertainty and never registers or retries an import', async () => {
  const error = new DotError('NETWORK_ERROR', 'Synthetic request outcome unknown', { delivery: 'unknown' });
  const { api, calls } = fixture(() => { throw error; });
  await assert.rejects(materialize(api), exception => exception === error);
  assert.equal(calls.length, 1);
});

test('materialization rejects explicit unavailable receipt flags without requiring a ready-state field', async () => {
  const flags = [{ deleted: true }, { is_deleted: true }, { is_removed: true }, { internal: true }, { redacted: true },
    { deleted_at: '2026-10-18T00:00:00Z' }, { trashed_at: '2026-10-18T00:00:00Z' }];
  for (const flag of [...flags, ...flags.map(metadata => ({ metadata }))]) {
    const h = fixture({ file_id: 'file-materialized', ...flag });
    await assert.rejects(materialize(h.api), error => error?.code === 'MUTATION_UNCONFIRMED' && error.details?.delivery === 'unknown');
    assert.equal(h.calls.length, 1);
  }
  assert.deepEqual(await materialize(fixture({ file_id: 'file-materialized' }).api), { file_id: 'file-materialized' });
  assert.deepEqual(await materialize(fixture({ file_id: 'file-materialized', state: 'processing' }).api), { file_id: 'file-materialized', state: 'processing' });
});

test('materialized general Files ID downloads exact bytes through its native route without re-registration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-materialized-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic provider contents\n'), requests = [];
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-fixture', accessToken: token('user-fixture') }),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (url.pathname === `${BASE}/mounted/materialize`) return Response.json({ file_id: 'file-materialized', name: 'fixture.txt', download_url: 'private-ignored-url' });
      if (url.pathname === '/backend-api/files/download/file-materialized') return Response.json({ download_url: 'https://files.oaiusercontent.com/fixture?sig=synthetic' });
      if (url.hostname === 'files.oaiusercontent.com') return new Response(bytes);
      throw new Error('Unexpected route');
    } });
  const client = { transport }, receipt = await materialize(new LibraryProviders(client));
  const saved = await new LibraryContent(client).download({ fileId: receipt.file_id, output: join(directory, 'fixture.txt') });
  assert.deepEqual(await readFile(saved.path), bytes); assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  assert.deepEqual(requests.map(entry => new URL(entry.url).pathname), [`${BASE}/mounted/materialize`, '/backend-api/files/download/file-materialized', '/fixture']);
  assert.equal(requests[2].options.headers.Authorization, undefined);
  assert.equal(JSON.stringify({ receipt, saved }).includes('synthetic'), false);
});

test('account or subject changes after materialization prevent the subsequent file metadata read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-materialized-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const scope of ['account', 'subject']) {
    let authReads = 0; const requests = [];
    const transport = new Transport({ authLoader: async () => ({ accountId: ++authReads > 1 && scope === 'account' ? 'other-account' : 'account-fixture',
      accessToken: token(authReads > 1 && scope === 'subject' ? 'other-user' : 'user-fixture') }),
      fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return Response.json({ file_id: 'file-materialized' }); } });
    const client = { transport }, receipt = await materialize(new LibraryProviders(client));
    await assert.rejects(new LibraryContent(client).download({ fileId: receipt.file_id, output: join(directory, `${scope}.txt`) }), { code: 'AUTH_IDENTITY_CHANGED' });
    assert.equal(requests.length, 1);
  }
});

for (const previewUrl of ['javascript:private-token', 'https://evil.example/preview?token=private-token', 'https://user:private-token@tenant.sharepoint.com/preview', 'https://tenant.sharepoint.com:444/preview', 'https://tenant.sharepoint.com:443/preview', 'https://@tenant.sharepoint.com/preview', 'HTTPS://tenant.sharepoint.com/preview', 'https://a.b.sharepoint.com/preview', 'https://tenant-my.sharepoint.com/preview', `https://tenant.sharepoint.com/${'x'.repeat(16385)}`]) {
  test('Microsoft preview availability requires a bounded native-compatible preview URL', async () => {
    const { api, calls } = fixture({ file_id: microsoftId, web_url: 'https://tenant.sharepoint.com/file', preview_url: previewUrl });
    await assert.rejects(api.preview({ provider: 'sharepoint', fileId: microsoftId }), error => error?.code === 'INVALID_RESPONSE' && !JSON.stringify(error).includes('private-token'));
    assert.equal(calls.length, 1);
  });
}

test('OneDrive native preview accepts a personal SharePoint host and exposes only availability', async () => {
  const fileId = 'external-onedrive:file:fixture';
  const { api } = fixture({ file_id: fileId, web_url: 'https://tenant-my.sharepoint.com/file?token=private-token', preview_url: 'https://tenant-my.sharepoint.com/embed?token=private-token' });
  assert.deepEqual(await api.preview({ provider: 'onedrive', fileId }), { fileId, provider: 'onedrive', sourceUrl: 'https://tenant-my.sharepoint.com/file', previewAvailable: true });
});

test('Dropbox has a source-link preview and never reports an embedded preview', async () => {
  const fileId = 'external-dropbox:file:id:fixture';
  const { api } = fixture({ file_id: fileId, shared_link_url: 'https://www.dropbox.com/s/fixture/document?rlkey=private-token', preview_url: 'https://evil.example' });
  assert.deepEqual(await api.preview({ provider: 'dropbox', fileId }), { fileId, provider: 'dropbox', sourceUrl: 'https://www.dropbox.com/s/fixture/document', previewAvailable: false });
});

for (const receipt of [
  { id: 'external-gdrive:file:abc-123' },
  { id: 'external-box:account:other: file:123'.replace(' ', '') },
  { id: 'library:fixture', parent_directory_id: 'external-box:account:work:folder:123', directory_id: 'external-box:folder:999' },
  { id: 'library:fixture', file_name: 'fixture.txt', name: 'different.txt' },
  { id: 'library:fixture', trashed_at: '2026-10-18T00:00:00Z' },
]) test('registration rejects an explicit conflicting or trashed receipt with unknown delivery', async () => {
  const h = registration(receipt);
  await assert.rejects(h.api.registerUpload(h.input), error => error?.code === 'INVALID_RESPONSE' && error.details?.delivery === 'unknown');
  assert.equal(h.calls.length, 3); assert.deepEqual(h.calls.map(call => call.method), ['GET', 'GET', 'POST']);
});

test('registration retains native minimal receipt compatibility', async () => {
  const h = registration({ id: 'external-box:file:123' });
  assert.deepEqual(await h.api.registerUpload(h.input), { id: 'external-box:file:123' });
});

test('registration rejects explicit malformed Box file tails instead of returning unusable IDs', async () => {
  for (const id of ['external-box:file:', 'external-box:file:not-numeric', 'external-box:file:0', 'external-box:file:001']) {
    const h = registration({ id });
    await assert.rejects(h.api.registerUpload(h.input), error => error?.code === 'INVALID_RESPONSE' && error.details?.delivery === 'unknown');
    assert.equal(h.calls.length, 3);
  }
});

test('an unscoped registration parent cannot admit a malformed returned provider account component', async () => {
  for (const account of ['%ZZ', 'tenant%2fuser', '%', 'x'.repeat(513)]) {
    const h = registration({ id: `external-box:account:${account}:file:123` }, 'external-box:folder:123');
    await assert.rejects(h.api.registerUpload(h.input), error => error?.code === 'INVALID_RESPONSE' && error.details?.delivery === 'unknown');
  }
  const h = registration({ id: 'external-box:account:tenant%2Fuser:file:123' }, 'external-box:folder:123');
  assert.equal((await h.api.registerUpload(h.input)).id, 'external-box:account:tenant%2Fuser:file:123');
});

test('registration cannot cross an account or subject change between its fresh reads and sole write', async () => {
  for (const switchBefore of [2, 3]) for (const scope of ['account', 'subject']) {
    let authReads = 0; const sent = [];
    const transport = new Transport({ authLoader: async () => { const changed = ++authReads >= switchBefore;
      return { accountId: changed && scope === 'account' ? 'other-account' : 'account-fixture', accessToken: token(changed && scope === 'subject' ? 'other-user' : 'user-fixture') }; },
      fetchImpl: async (url, options) => {
        sent.push(options.method);
        return Response.json(url.pathname.endsWith('/mounted/capabilities')
          ? { providers: { box: { capabilities: { library_browsing: { state: 'available' } } } } }
          : { items: [{ id: 'external-box:folder:123' }] });
      } });
    await assert.rejects(new LibraryContent({ transport }).registerUpload({ fileId: 'file-source', fileName: 'fixture.txt', parentDirectoryId: 'external-box:folder:123' }), { code: 'AUTH_IDENTITY_CHANGED' });
    assert.deepEqual(sent, Array(switchBefore - 1).fill('GET'));
  }
});

test('short ranged downloads are rejected unless the response proves exact EOF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-provider-range-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const total of ['100', '*', '5']) {
    const output = join(directory, total === '*' ? 'unknown' : total), bytes = Buffer.from('abc');
    const transport = { request: async () => ({ download_url: 'https://files.oaiusercontent.com/fixture?sig=synthetic' }),
      fetchSigned: async () => ({ status: 206, headers: new Headers({ 'content-range': `bytes 2-4/${total}` }), body: bytes }) };
    const promise = new LibraryContent({ transport }).download({ fileId: 'file-materialized', output, range: 'bytes=2-9' });
    if (total === '5') { const result = await promise; assert.deepEqual(await readFile(result.path), bytes); }
    else { await assert.rejects(promise, { code: 'INVALID_RANGE_RESPONSE' }); await assert.rejects(stat(output), { code: 'ENOENT' }); }
  }
});

test('cancellation during download, thumbnail, or export preparation never publishes partial local output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-provider-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of ['download', 'thumbnail', 'export']) {
    const output = join(directory, kind), controller = new AbortController(), reason = new Error('synthetic cancellation');
    const bytes = Buffer.alloc(1024 * 1024, 1);
    const schedule = value => { setImmediate(() => controller.abort(reason)); return value; };
    const transport = { request: async () => kind === 'export' ? schedule({ structuredContent: { report: 'visible' } })
      : { [kind === 'thumbnail' ? 'thumbnail_url' : 'download_url']: 'https://files.oaiusercontent.com/fixture?sig=synthetic' },
      fetchSigned: async () => schedule(bytes) };
    const client = { transport };
    const pending = kind === 'thumbnail' ? new LibraryProviders(client).referenceThumbnail({ referenceImageId: 'reference-fixture', output, signal: controller.signal })
      : kind === 'export' ? new LibraryContent(client).deepResearchExport({ fileId: 'library-fixture', output, signal: controller.signal })
      : new LibraryContent(client).download({ fileId: 'file-materialized', output, signal: controller.signal });
    await assert.rejects(pending, error => error === reason);
    await assert.rejects(stat(output), { code: 'ENOENT' }); assert.deepEqual(await readdir(directory), []);
  }
});

test('cancellation during overwrite preparation preserves the existing output bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-provider-preserve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'existing'), original = Buffer.from('existing private data'); await writeFile(output, original, { mode: 0o600 });
  const controller = new AbortController(), reason = new Error('synthetic cancellation');
  const transport = { request: async () => ({ download_url: 'https://files.oaiusercontent.com/fixture?sig=synthetic' }),
    fetchSigned: async () => { setImmediate(() => controller.abort(reason)); return Buffer.alloc(1024 * 1024, 1); } };
  await assert.rejects(new LibraryContent({ transport }).download({ fileId: 'file-materialized', output, overwrite: true, signal: controller.signal }), error => error === reason);
  assert.deepEqual(await readFile(output), original); assert.deepEqual(await readdir(directory), ['existing']);
});
