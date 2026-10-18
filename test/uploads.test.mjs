import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, readdir, symlink, rm, realpath, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadRecoverable } from '../src/uploads.mjs';
import { DotError } from '../src/errors.mjs';
import { MAX_UPLOAD_BYTES } from '../src/files.mjs';

const roomId = 'room_upload', fileId = 'file_upload';
const bytes = Buffer.from('recoverable bytes\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const pending = { id: fileId, status: 'uploading', expires_at: '2026-10-18T00:00:00Z' };
function client(responses = []) {
  const calls = [];
  const invoke = async (kind, method, route, options = {}) => {
    const call = { kind, method, route, ...options }; calls.push(call);
    assert.ok(calls.length <= responses.length, `Unexpected ${method} ${route}`);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(call) : response;
  };
  return { calls, resolveRoom: async value => value ?? roomId, transport: {
    request: (...args) => invoke('json', ...args), requestMultipart: (...args) => invoke('multipart', ...args),
  } };
}
async function setup(t) {
  const raw = await mkdtemp(join(tmpdir(), 'dot-uploads-test-')), dir = await realpath(raw);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'note.txt'), stateFile = join(dir, 'upload.json');
  await writeFile(file, bytes);
  return { dir, file, stateFile, roomId };
}
async function saved(t, changes = {}) {
  const options = await setup(t);
  await uploadRecoverable(client([{ id: fileId, status: 'ready' }]), options);
  const state = { ...JSON.parse(await readFile(options.stateFile, 'utf8')), ...changes };
  await writeFile(options.stateFile, JSON.stringify(state));
  return { options, state };
}
const missing = () => new DotError('HTTP_ERROR', 'HTTP 404', { status: 404 });

test('reserves and completes one file, keeps private state, and sends only verified fields', async t => {
  const options = await setup(t), api = client([pending, { id: fileId, status: 'ready', download_url: 'private-url' }]);
  const result = await uploadRecoverable(api, options);
  assert.equal(api.calls.length, 2);
  const [reserve, complete] = api.calls;
  assert.equal(reserve.method, 'POST');
  assert.equal(reserve.route, `/backend-api/messaging/rooms/${roomId}/files/uploads`);
  assert.deepEqual(reserve.body, { upload_id: result.uploadId, name: 'note.txt', mime_type: 'text/plain', content_sha256: digest });
  assert.equal(complete.route, `${reserve.route}/${result.uploadId}/complete`);
  assert.equal(complete.kind, 'multipart');
  assert.deepEqual(complete.file, { name: 'note.txt', mimeType: 'text/plain', bytes });
  assert.equal(result.fileId, fileId);
  assert.deepEqual(result.attachment, { type: 'file', file_id: fileId, name: 'note.txt', mime_type: 'text/plain', size_bytes: bytes.length, status: 'ready' });
  assert.ok(!JSON.stringify(result).includes('private-url'));
  const state = JSON.parse(await readFile(options.stateFile, 'utf8'));
  assert.equal(state.phase, 'ready'); assert.equal(state.source.sha256, digest);
  assert.equal((await lstat(options.stateFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(options.dir)).sort(), ['note.txt', 'upload.json']);
});

test('a ready reservation skips completion and resume reuses its server-verified file ID', async t => {
  const options = await setup(t), first = client([{ id: fileId, status: 'ready' }]);
  const result = await uploadRecoverable(first, options);
  assert.equal(first.calls.length, 1);
  const second = client([{ id: fileId, status: 'ready' }]);
  assert.deepEqual(await uploadRecoverable(second, options), result);
  assert.equal(second.calls.length, 1); assert.equal(second.calls[0].method, 'GET');
});

test('an uncertain reservation is not retried and its next invocation recovers through lookup', async t => {
  const options = await setup(t), failed = client([new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' })]);
  await assert.rejects(uploadRecoverable(failed, options), { code: 'NETWORK_ERROR' });
  assert.equal(failed.calls.length, 1);
  const state = JSON.parse(await readFile(options.stateFile, 'utf8'));
  assert.equal(state.phase, 'reserving'); assert.equal(state.fileId, null);
  const resumed = client([{ id: fileId, status: 'ready' }]);
  const result = await uploadRecoverable(resumed, options);
  assert.equal(resumed.calls[0].method, 'GET'); assert.equal(result.uploadId, state.uploadId);
});

test('an uncertain completion is not retried and server-ready lookup avoids resending bytes', async t => {
  const options = await setup(t), api = client([pending, new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' })]);
  await assert.rejects(uploadRecoverable(api, options), { code: 'NETWORK_ERROR' });
  assert.equal(api.calls.length, 2);
  const state = JSON.parse(await readFile(options.stateFile, 'utf8'));
  assert.equal(state.phase, 'completing'); assert.equal(state.fileId, fileId);
  const resumed = client([{ id: fileId, status: 'ready' }]);
  await uploadRecoverable(resumed, options);
  assert.equal(resumed.calls.length, 1);
});

test('resumes incomplete bytes only after lookup and keeps the original upload ID', async t => {
  const { options, state } = await saved(t, { phase: 'completing' });
  const api = client([pending, { id: fileId }]);
  const result = await uploadRecoverable(api, options);
  assert.deepEqual(api.calls.map(call => [call.kind, call.method]), [['json', 'GET'], ['multipart', 'POST']]);
  assert.equal(result.uploadId, state.uploadId); assert.equal(result.status, 'ready');
});

test('re-reserves a confirmed expired upload once with stable ID before completion', async t => {
  const { options, state } = await saved(t, { phase: 'reserved' });
  const api = client([{ id: fileId, status: 'expired' }, pending, { id: fileId, status: 'ready' }]);
  await uploadRecoverable(api, options);
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST', 'POST']);
  assert.equal(api.calls[1].body.upload_id, state.uploadId);
});

test('a non-ready confirmed 404 can re-reserve, while ready 404 is surfaced', async t => {
  const { options } = await saved(t, { phase: 'reserved' });
  const api = client([missing(), { id: fileId, status: 'ready' }]);
  await uploadRecoverable(api, options);
  assert.equal(api.calls.length, 2);
  const readyApi = client([missing()]);
  await assert.rejects(uploadRecoverable(readyApi, options), { code: 'HTTP_ERROR' });
  assert.equal(readyApi.calls.length, 1);
});

test('a 410 or ambiguous 404 never triggers a reservation retry', async t => {
  const { options } = await saved(t, { phase: 'reserved' });
  for (const error of [new DotError('HTTP_ERROR', 'gone', { status: 410 }), new DotError('HTTP_ERROR', 'unknown', { status: 404, delivery: 'unknown' })]) {
    const api = client([error]);
    await assert.rejects(uploadRecoverable(api, options), { code: 'HTTP_ERROR' });
    assert.equal(api.calls.length, 1);
  }
});

test('refuses changed file IDs on lookup, re-reservation, and completion', async t => {
  const { options } = await saved(t, { phase: 'reserved' });
  for (const responses of [[{ id: 'different', status: 'ready' }], [{ id: fileId, status: 'expired' }, { id: 'different', status: 'uploading' }],
    [pending, { id: 'different', status: 'ready' }]]) {
    const api = client(responses);
    await assert.rejects(uploadRecoverable(api, options), { code: 'INVALID_RESPONSE' });
    assert.equal(JSON.parse(await readFile(options.stateFile)).fileId, fileId);
  }
});

test('validates reservation identity, metadata, status, and expiration before completion', async t => {
  for (const invalid of [{ id: '../../bad', status: 'ready' }, { id: true, status: 'ready' }, { id: fileId }, { ...pending, name: 'other.txt' },
    { ...pending, mime_type: 'image/png' }, { ...pending, size_bytes: 1 }, { ...pending, content_sha256: 'wrong' },
    { ...pending, upload_id: 'other' }, { ...pending, expires_at: 'tomorrow' }, { ...pending, status: 'expired' }]) {
    const options = await setup(t), api = client([invalid]);
    await assert.rejects(uploadRecoverable(api, options), { code: 'INVALID_RESPONSE' });
    assert.equal(api.calls.length, 1);
  }
});

test('refuses a changed source or different room without an upload request', async t => {
  const { options } = await saved(t);
  const otherRoom = client();
  await assert.rejects(uploadRecoverable(otherRoom, { ...options, roomId: 'other_room' }), { code: 'UPLOAD_SCOPE_MISMATCH' });
  await writeFile(options.file, Buffer.from('recoverable bytes!'));
  const otherSource = client();
  await assert.rejects(uploadRecoverable(otherSource, options), { code: 'UPLOAD_SOURCE_MISMATCH' });
  assert.equal(otherSource.calls.length + otherRoom.calls.length, 0);
});

test('locks state against concurrent use and never replaces a lock symlink', async t => {
  const options = await setup(t), lock = `${options.stateFile}.lock`;
  await writeFile(lock, 'active');
  await assert.rejects(uploadRecoverable(client(), options), { code: 'STATE_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), 'active');
  await rm(lock); await symlink(options.file, lock);
  await assert.rejects(uploadRecoverable(client(), options), { code: 'STATE_LOCKED' });
  assert.deepEqual(await readFile(options.file), bytes);
});

test('refuses unsafe sources, oversized files, state symlinks, and invalid state without requests', async t => {
  const options = await setup(t), link = join(options.dir, 'link.txt'), empty = join(options.dir, 'empty.txt'), large = join(options.dir, 'large.bin');
  await symlink(options.file, link); await writeFile(empty, ''); await writeFile(large, ''); await truncate(large, MAX_UPLOAD_BYTES + 1);
  for (const [file, code] of [[link, 'INVALID_FILE'], [empty, 'FILE_SIZE'], [large, 'FILE_SIZE'], [options.dir, 'INVALID_FILE']]) {
    const api = client(); await assert.rejects(uploadRecoverable(api, { ...options, file }), { code }); assert.equal(api.calls.length, 0);
  }
  await symlink(options.file, options.stateFile);
  await assert.rejects(uploadRecoverable(client(), options), { code: 'INVALID_STATE' });
  await rm(options.stateFile); await writeFile(options.stateFile, '{"version":1}');
  await assert.rejects(uploadRecoverable(client(), options), { code: 'INVALID_STATE' });
});

test('requires explicit separate state and checks cancellation before touching files', async t => {
  const options = await setup(t);
  await assert.rejects(uploadRecoverable(client(), { ...options, stateFile: undefined }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(uploadRecoverable(client(), { ...options, stateFile: options.file }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(await readFile(options.file), bytes);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadRecoverable(client(), { ...options, signal: controller.signal }), { name: 'AbortError' });
});
