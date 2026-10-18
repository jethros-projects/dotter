import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotLibrary } from '../src/library.mjs';
import { LibraryContent } from '../src/library-content.mjs';
import { Transport } from '../src/transport.mjs';

const fileId = 'library-fixture', path = `/backend-api/files/library/files/${fileId}`;
const file = { id: fileId, kind: 'file', file_id: 'file_source', name: 'Fixture.txt' };
const snapshot = { id: fileId, kind: 'file', library_artifact_type: 'chat_message_snapshot' };
const missing = () => Response.json({ detail: 'Not found' }, { status: 404 });
const edge404 = () => new Response('<html>challenge</html>', { status: 404, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } });
function fixture(responses) {
  const calls = [];
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-fixture', accessToken: 'synthetic-token' }), fetchImpl: async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, method: options.method, body: options.body });
    assert.ok(responses.length, 'Unexpected request after a terminal response');
    return responses.shift();
  } });
  return { library: new DotLibrary({ transport }), content: new LibraryContent({ transport }), calls };
}

test('an edge404 on the primary Library read never attempts node, trash, or deletion', async () => {
  for (const operation of ['get', 'get-trashed', 'delete']) {
    const f = fixture([edge404()]);
    const pending = operation === 'delete' ? f.content.permanentDelete({ fileId, confirm: fileId })
      : f.library.get({ fileId, includeTrashed: operation === 'get-trashed' });
    await assert.rejects(pending, { code: 'EDGE_CHALLENGE', details: { status: 404 } });
    assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', path]]);
  }
});

test('an edge404 from node does not become a trash search after a real primary404', async () => {
  const f = fixture([missing(), edge404()]);
  await assert.rejects(f.library.get({ fileId, includeTrashed: true }), { code: 'EDGE_CHALLENGE' });
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', path], ['GET', `${path}/node`]]);
});

test('ordinary HTTP404 still resolves a Library node or exact trashed item', async () => {
  const node = fixture([missing(), Response.json(file)]);
  assert.deepEqual(await node.library.get({ fileId }), file); assert.equal(node.calls.length, 2);
  const trash = fixture([missing(), missing(), Response.json({ items: [{ ...file, trashed_at: '2026-10-18' }], cursor: null })]);
  assert.equal((await trash.library.get({ fileId, includeTrashed: true })).id, fileId);
  assert.deepEqual(trash.calls.map(call => call.method), ['GET', 'GET', 'POST']);
  assert.equal(JSON.parse(trash.calls[2].body).trashed_only, true);
});

for (const operation of ['download', 'content']) {
  test(`edge404 during Library ${operation} never resolves another target or saves output`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dot-library-edge-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'download.bin'), f = fixture([edge404()]);
    await assert.rejects(f.content[operation]({ fileId, output }), { code: 'EDGE_CHALLENGE' });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });
  test(`ordinary HTTP404 during Library ${operation} retains the legacy download fallback`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dot-library-missing-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'download.bin');
    const f = fixture([missing(), Response.json(file), Response.json({ download_url: 'https://files.oaiusercontent.com/fixture?sig=synthetic' }), new Response('fixture-bytes')]);
    await f.content[operation]({ fileId, output });
    assert.equal(await readFile(output, 'utf8'), 'fixture-bytes'); assert.equal(f.calls.length, 4);
    assert.equal(f.calls[1].url.pathname, path);
    assert.equal(f.calls[2].url.pathname, '/backend-api/files/download/file_source');
    assert.equal(f.calls[3].url.origin, 'https://files.oaiusercontent.com');
  });
}

test('snapshot raw refresh edge404 never falls through to node or permanent deletion', async () => {
  const f = fixture([Response.json(snapshot), edge404()]);
  await assert.rejects(f.content.permanentDelete({ fileId, confirm: fileId }), { code: 'EDGE_CHALLENGE' });
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', path], ['GET', path]]);
});

test('ordinary snapshot refresh404 still uses exact node metadata before deletion', async () => {
  const f = fixture([Response.json(snapshot), missing(), Response.json(snapshot), Response.json({ success: true })]);
  assert.deepEqual(await f.content.permanentDelete({ fileId, confirm: fileId }), { fileId, status: 'completed' });
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname]), [['GET', path], ['GET', path], ['GET', `${path}/node`], ['DELETE', path]]);
  assert.deepEqual([...f.calls[3].url.searchParams], [['soft_delete', 'false']]);
});
