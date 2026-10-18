import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryContent } from '../src/library-content.mjs';
import { DotLibrary } from '../src/library.mjs';
import { Transport } from '../src/transport.mjs';
import { DotError } from '../src/errors.mjs';
import { commands } from '../src/command-sets/library-content.mjs';

const BASE = '/backend-api/files/library';
const ID = 'snapshot:one';
const PATH = `${BASE}/files/snapshot%3Aone`;
const snapshot = (extra = {}) => ({ id: ID, kind: 'file', library_artifact_type: 'chat_message_snapshot', ...extra });
const options = { fileId: ID, confirm: ID };
function fixture(responses) {
  const calls = [];
  const transport = { async request(method, path, request = {}) {
    calls.push({ method, path, ...request });
    assert.ok(responses.length, 'unexpected extra request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(calls.at(-1)) : next;
  } };
  return { content: new LibraryContent({ transport }), library: new DotLibrary({ transport }), calls };
}
const deletes = calls => calls.filter(call => call.method === 'DELETE');

test('snapshot deletion requires exact confirmation before auth or HTTP', async () => {
  let authCalls = 0, fetchCalls = 0;
  const transport = new Transport({
    authLoader: async () => { authCalls++; throw new Error('unexpected auth'); },
    fetchImpl: async () => { fetchCalls++; throw new Error('unexpected HTTP'); },
  });
  const content = new LibraryContent({ transport });
  for (const input of [{ fileId: ID }, { fileId: ID, confirm: 'source-file' }, { fileId: '../snapshot', confirm: '../snapshot' }]) {
    await assert.rejects(content.permanentDelete(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(authCalls, 0); assert.equal(fetchCalls, 0);
});

test('snapshot removal targets only its Library record, never source metadata', async () => {
  const source = { file_id: 'source-file', file_name: 'original.md', name: 'original.md', parent_directory_id: 'source-folder',
    origination_thread_id: 'source-conversation', origination_message_id: 'source-message' };
  const f = fixture([snapshot(source), snapshot(source), { success: true }]);
  assert.deepEqual(await f.content.permanentDelete(options), { fileId: ID, status: 'completed' });
  assert.deepEqual(f.calls.map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: PATH }, { method: 'GET', path: PATH }, { method: 'DELETE', path: PATH },
  ]);
  assert.deepEqual(f.calls[2].query, { soft_delete: false });
  assert.equal(f.calls[2].body, undefined);
  assert.equal(JSON.stringify(f.calls[2]).includes('source-'), false);
});

test('minimal typed snapshot does not need invented ownership or source fields', async () => {
  const f = fixture([snapshot(), snapshot(), { success: true }]);
  assert.equal((await f.content.permanentDelete(options)).status, 'completed');
  assert.equal(deletes(f.calls).length, 1);
});

test('both snapshot reads must retain the exact target identity', async () => {
  for (const responses of [[snapshot({ id: 'other' })], [snapshot(), snapshot({ id: 'other' })]]) {
    const f = fixture(responses);
    await assert.rejects(f.content.permanentDelete(options), { code: 'INVALID_RESPONSE' });
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('raw snapshot refresh rejects changed type, directories and saved entities', async () => {
  for (const extra of [{ kind: 'directory' }, { kind: null }, { library_artifact_type: 'writing_block' },
    { library_artifact_type: null }, { saved_entity: { saved_target: {} } }]) {
    const f = fixture([snapshot(), snapshot(extra)]);
    await assert.rejects(f.content.permanentDelete(options), { code: 'UNSUPPORTED' });
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('fresh raw visibility flags cannot be lost through the general Library projection', async () => {
  for (const extra of [{ hidden: true }, { is_hidden: true }, { is_visually_hidden_from_conversation: true },
    { channel: 'analysis' }, { recipient: 'tool' }, { is_user_visible: false },
    { metadata: { hidden: true } }, { metadata: { channel: 'analysis' } }, { metadata: { is_user_visible: false } },
    { deleted_at: '2026-10-18' }, { trashed_at: '2026-10-18' }, { is_deleted: true }, { is_trashed: true },
    { metadata: { deleted_at: '2026-10-18' } }, { metadata: { trashed_at: '2026-10-18' } }, { pendingResponseFavorite: true }]) {
    const f = fixture([snapshot(), snapshot(extra)]);
    await assert.rejects(f.content.permanentDelete(options), { code: 'NOT_VISIBLE' });
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('raw native shared and provider indicators forbid snapshot deletion', async () => {
  for (const extra of [{ access_kind: 'shared' }, { access_kind: 'mounted' }, { is_root: true }, { is_shared: true }, { shared_by: {} }, { direct_share_id: 'share' },
    { has_opened_shared_membership: true }, { parent_directory_id: 'library:shared-directory:one' },
    ...['native_shared', 'google_drive', 'box', 'dropbox', 'sharepoint', 'onedrive', 'unrecognized-provider'].map(provider => ({ provider }))]) {
    const f = fixture([snapshot(), snapshot(extra)]);
    await assert.rejects(f.content.permanentDelete(options), { code: 'UNSUPPORTED' });
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('external and pending target IDs cannot masquerade as native saved snapshots', async () => {
  for (const fileId of ['external-gdrive:file:one', 'pending:conversation:message', 'library:shared-directory:one', 'library:collection:shared-with-me']) {
    const f = fixture([snapshot({ id: fileId }), snapshot({ id: fileId })]);
    await assert.rejects(f.content.permanentDelete({ fileId, confirm: fileId }), { code: 'UNSUPPORTED' });
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('aborting before or during either metadata read sends no delete', async () => {
  for (const abortAt of [0, 1, 2]) {
    const controller = new AbortController();
    const responses = [1, 2].map(step => () => { if (abortAt === step) controller.abort(); return snapshot(); });
    const f = fixture(responses);
    if (abortAt === 0) controller.abort();
    await assert.rejects(f.content.permanentDelete({ ...options, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.calls.length, abortAt);
    assert.equal(deletes(f.calls).length, 0);
  }
});

test('failed raw refresh stops without mutation or retry', async () => {
  for (const code of ['EDGE_CHALLENGE', 'AUTH_REQUIRED', 'HTTP_ERROR']) {
    const error = new DotError(code, 'synthetic failure', { status: 403 });
    const f = fixture([snapshot(), error]);
    await assert.rejects(f.content.permanentDelete(options), { code });
    assert.equal(f.calls.length, 2); assert.equal(deletes(f.calls).length, 0);
  }
});

test('fresh snapshot refresh supports the existing exact node fallback only after404', async () => {
  const absent = () => new DotError('HTTP_ERROR', 'not found', { status: 404 });
  for (const responses of [[snapshot(), absent(), snapshot(), { success: true }],
    [absent(), snapshot(), absent(), snapshot(), { success: true }]]) {
    const f = fixture(responses);
    assert.equal((await f.content.permanentDelete(options)).status, 'completed');
    assert.equal(f.calls.at(-2).path, `${PATH}/node`);
    assert.equal(deletes(f.calls).length, 1);
    assert.deepEqual(f.calls.at(-1).query, { soft_delete: false });
    assert.ok(f.calls.every(call => call.method === 'DELETE' || call.method === 'GET'));
  }
});

test('fresh node fallback must preserve snapshot identity and type, and never searches trash', async () => {
  const absent = () => new DotError('HTTP_ERROR', 'not found', { status: 404 });
  for (const [value, code] of [[snapshot({ id: 'other' }), 'INVALID_RESPONSE'],
    [snapshot({ library_artifact_type: 'writing_block' }), 'UNSUPPORTED'], [snapshot({ kind: 'directory' }), 'UNSUPPORTED'],
    [absent(), 'HTTP_ERROR']]) {
    const f = fixture([snapshot(), absent(), value]);
    await assert.rejects(f.content.permanentDelete(options), { code });
    assert.equal(f.calls.length, 3); assert.equal(deletes(f.calls).length, 0);
    assert.equal(f.calls[2].path, `${PATH}/node`);
  }
});

test('aborting a404 refresh prevents its node fallback', async () => {
  const controller = new AbortController();
  const f = fixture([snapshot(), () => { controller.abort(); throw new DotError('HTTP_ERROR', 'not found', { status: 404 }); }]);
  await assert.rejects(f.content.permanentDelete({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 2); assert.equal(deletes(f.calls).length, 0);
});

test('ambiguous or rejected snapshot delete acknowledgments preserve unknown delivery', async () => {
  for (const response of [undefined, null, {}, { completed: true }, { success: false }, { success: 'true' }]) {
    const f = fixture([snapshot(), snapshot(), response]);
    await assert.rejects(f.content.permanentDelete(options), error => {
      assert.equal(error.code, 'MUTATION_UNCONFIRMED'); assert.equal(error.details.delivery, 'unknown'); return true;
    });
    assert.equal(deletes(f.calls).length, 1); assert.equal(f.calls.length, 3);
  }
});

test('real transport sends only soft_delete=false and does not call HTTP204 confirmed', async () => {
  for (const status of [200, 204]) {
    const calls = [];
    const transport = new Transport({ authLoader: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-account' }),
      fetchImpl: async (url, request) => {
        calls.push({ url: new URL(url), ...request });
        if (request.method === 'GET') return Response.json(snapshot({ file_id: 'source-file', parent_directory_id: 'source-folder' }));
        return status === 204 ? new Response(null, { status }) : Response.json({ success: true });
      } });
    const operation = new LibraryContent({ transport }).permanentDelete(options);
    if (status === 204) await assert.rejects(operation, { code: 'MUTATION_UNCONFIRMED', details: { delivery: 'unknown' } });
    else assert.equal((await operation).status, 'completed');
    const deletion = calls.find(call => call.method === 'DELETE');
    assert.equal(deletion.url.pathname, PATH);
    assert.deepEqual([...deletion.url.searchParams], [['soft_delete', 'false']]);
    assert.equal(deletion.body, undefined); assert.equal(calls.length, 3);
  }
});

test('ordinary file permanent deletion retains its existing single-read query contract', async () => {
  for (const naming of [{ file_name: 'file.md', parent_directory_id: 'parent' }, { name: 'file.md', directory_id: 'parent' }]) {
    const f = fixture([{ id: ID, kind: 'file', file_id: 'source-file', ...naming }, { success: true }]);
    assert.deepEqual(await f.content.permanentDelete(options), { fileId: ID, status: 'completed' });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].query, { soft_delete: false, file_id: 'source-file', parent_directory_id: 'parent', file_name: 'file.md' });
  }
});

test('snapshot exception does not enable batch deletion, trash or restore', async () => {
  for (const action of ['batch', 'trash', 'restore']) {
    const f = fixture([snapshot()]);
    const operation = action === 'batch' ? f.content.deleteBatch({ fileIds: [ID], confirmFileIds: [ID] })
      : f.library[action](options);
    await assert.rejects(operation, { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 1); assert.equal(deletes(f.calls).length, 0);
  }
});

test('existing CLI command retains positional exact-ID confirmation for snapshots', () => {
  const command = commands['library delete-permanently'];
  assert.equal(command.method, 'permanentDelete');
  assert.deepEqual(command.positionals, ['fileId']);
  assert.deepEqual(command.confirmMatch, [['confirm', 'fileId']]);
  assert.match(command.description, /saved chat snapshot/);
});
