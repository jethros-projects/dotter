import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, readdir, symlink, rm, realpath, chmod, rename, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LibraryUpload } from '../src/library-upload.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';

const ACCOUNT = 'account_test';
const SUBJECT = 'subject_test';
const FILE_ID = 'file_test_upload';
const LIBRARY_ID = 'library:test_upload';
const DIRECTORY_ID = 'directory_test';
const ROOT_ID = 'root_test';
const CONTENT = Buffer.from('standalone Library upload canary\n');
const HASH = createHash('sha256').update(CONTENT).digest('hex');
const SIGNED_URL = 'https://files.oaiusercontent.com/file/test?sig=private-upload-secret';
const auth = (accountId = ACCOUNT, subject = SUBJECT) => ({ accountId,
  accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.private-token` });
const reserve = (extra = {}) => ({ file_id: FILE_ID, upload_url: SIGNED_URL, upload_headers: {}, ...extra });
const event = (name = 'file.processing.completed', extra = {}, fileId = FILE_ID) => JSON.stringify({ event: name, file_id: fileId,
  extra: { metadata_object_id: LIBRARY_ID, library_file_name: 'canary.txt', mime_type: 'text/plain', ...extra } });
const metadata = (extra = {}) => ({ id: LIBRARY_ID, kind: 'file', file_id: FILE_ID, file_name: 'canary.txt', mime_type: 'text/plain',
  file_size_bytes: CONTENT.length, parent_directory_id: null, state: 'ready', ...extra });
const unknown = () => new DotError('NETWORK_ERROR', 'The request failed.', { delivery: 'unknown' });

async function setup(t, changes = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-library-upload-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'canary.txt'), stateFile = join(dir, 'upload.json');
  await writeFile(file, CONTENT);
  return { dir, file, stateFile, expectedAccountId: ACCOUNT, ...changes };
}

function client({ reserveResult = reserve(), stream = `${event()}\n`, record = metadata(), uploadResult = { uploaded: true, sizeBytes: CONTENT.length },
  onCall, currentAuth = auth(), search = { items: [], cursor: null }, moveResult = { success: true }, movedRecord,
  directoryPath = call => ({ items: [{ id: call.query?.directory_id ?? ROOT_ID, kind: 'directory', name: 'Canaries',
    ...(call.query?.directory_id == null ? { is_root: true } : {}) }], cursor: null }) } = {}) {
  const calls = [];
  const api = { calls, currentAuth, transport: {
    async authLoader() { return api.currentAuth; },
    assertIdentity() {},
    async request(method, route, options = {}) {
      const call = { kind: 'request', method, route, ...options }; calls.push(call); await onCall?.(call);
      let value;
      if (method === 'POST' && route === '/backend-api/files') value = reserveResult;
      else if (method === 'POST' && route === '/backend-api/estuary/upload_content_bytes') value = { completed: true };
      else if (method === 'POST' && route === '/backend-api/files/process_upload_stream') value = stream;
      else if (method === 'GET' && route === `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}`) value = api.moved
        ? movedRecord ?? (record instanceof Error || typeof record === 'function' ? record : { ...record, parent_directory_id: api.movedTo }) : record;
      else if (method === 'GET' && route === '/backend-api/files/library/directories/path') value = directoryPath;
      else if (method === 'POST' && route === '/backend-api/files/library') value = search;
      else if (method === 'PATCH' && route === `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}/move`) value = moveResult;
      else throw new Error(`Unexpected ${method} ${route}`);
      if (value instanceof Error) throw value;
      const response = typeof value === 'function' ? await value(call) : value;
      if (method === 'PATCH' && response?.success === true) { api.moved = true; api.movedTo = options.body.directory_id; }
      return response;
    },
    async uploadSignedFile(url, options = {}) {
      const call = { kind: 'signed-upload', url, ...options }; calls.push(call); await onCall?.(call);
      if (uploadResult instanceof Error) throw uploadResult;
      return typeof uploadResult === 'function' ? uploadResult(call) : uploadResult;
    },
    async uploadEstuaryFile(url, options = {}) {
      const call = { kind: 'estuary-upload', url, ...options }; calls.push(call); await onCall?.(call);
      if (uploadResult instanceof Error) throw uploadResult;
      return typeof uploadResult === 'function' ? uploadResult(call) : uploadResult;
    },
  } };
  api.upload = new LibraryUpload(api);
  return api;
}

async function journal(options) { return JSON.parse(await readFile(options.stateFile, 'utf8')); }
const writes = calls => calls.filter(call => call.kind === 'signed-upload' || call.method !== 'GET');

test('standalone Library upload reserves, uploads and processes exactly once without registering again', async t => {
  const options = await setup(t), api = client({ reserveResult: reserve({ upload_headers: { 'x-ms-version': '2020-04-08' } }) });
  const result = await api.upload.upload(options);
  assert.deepEqual(api.calls.map(call => [call.kind, call.method, call.route]), [
    ['request', 'POST', '/backend-api/files'], ['signed-upload', undefined, undefined],
    ['request', 'POST', '/backend-api/files/process_upload_stream'],
    ['request', 'GET', `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}`],
  ]);
  const [reservation, bytes, processing] = api.calls;
  assert.deepEqual(reservation.body, {
    entry_surface: 'codex_library_upload', file_name: 'canary.txt', file_size: CONTENT.length,
    client_resolved_mime_type: 'text/plain', mime_resolution_source: 'filename_extension', mime_type: 'text/plain',
    reset_rate_limits: false, supports_direct_azure_multipart: true, timezone_offset_min: new Date().getTimezoneOffset(),
    upload_source: 'codex_library_upload', use_case: 'my_files', store_in_library: true, library_persistence_mode: 'required',
  });
  assert.equal(bytes.url, SIGNED_URL);
  assert.equal(bytes.source.path, options.file); assert.equal(bytes.source.sizeBytes, CONTENT.length); assert.equal(bytes.source.sha256, HASH);
  assert.equal(Object.hasOwn(bytes, 'bytes'), false);
  assert.equal(bytes.contentType, 'text/plain'); assert.deepEqual(bytes.requiredHeaders, { 'x-ms-version': '2020-04-08' });
  assert.deepEqual(processing.body, {
    entry_surface: 'codex_library_upload', file_id: FILE_ID, file_name: 'canary.txt', index_for_retrieval: true,
    library_persistence_mode: 'required', metadata: { store_in_library: true }, mime_type: 'text/plain',
    upload_source: 'codex_library_upload', use_case: 'my_files',
  });
  assert.equal(processing.responseType, 'text');
  assert.equal(result.fileId, FILE_ID); assert.equal(result.libraryFileId, LIBRARY_ID);
  assert.equal(result.completed, true);
  assert.equal((await journal(options)).phase, 'complete');
  assert.equal((await lstat(options.stateFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes('private-upload-secret'));
  assert.ok(!JSON.stringify(result).includes('private-token'));
  assert.equal(api.calls.some(call => call.route === '/backend-api/files/library/files'), false);
  assert.deepEqual((await readdir(options.dir)).sort(), ['canary.txt', 'upload.json']);
});

test('root uploads omit directory while CRLF, blank lines and final unterminated NDJSON still complete', async t => {
  const options = await setup(t, { directoryId: undefined });
  const api = client({ stream: `\r\n${event('file.processing.file_ready')}\r\n\n${event()}`, record: metadata({ parent_directory_id: null }) });
  await api.upload.upload(options);
  assert.equal(Object.hasOwn(api.calls[2].body, 'directory_id'), false);
});

test('each write is preceded by a durable phase and receipt advances before the next write', async t => {
  const options = await setup(t), seen = [];
  const api = client({ onCall: async call => { const state = await journal(options); seen.push([call.kind, call.route, state.phase]); } });
  await api.upload.upload(options);
  assert.deepEqual(seen.map(item => item[2]), ['reserving', 'uploading', 'processing', 'processed']);
  assert.equal((await journal(options)).source.sha256, HASH);
});

for (const [stage, configuration, phase, count] of [
  ['reservation', { reserveResult: unknown() }, 'reserving', 1],
  ['byte upload', { uploadResult: unknown() }, 'uploading', 2],
  ['processing', { stream: unknown() }, 'processing', 3],
]) test(`uncertain ${stage} never replays a write on the next invocation`, async t => {
  const options = await setup(t), api = client(configuration);
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, phase); assert.equal(api.calls.length, count);
  const resumed = client();
  await assert.rejects(resumed.upload.upload(options));
  assert.equal(writes(resumed.calls).length, 0);
});

test('incomplete or foreign processing events never authorize readback or a second processing request', async t => {
  for (const stream of [
    `${event('file.processing.file_ready')}\n`,
    `${event('file.processing.completed', {}, 'file_other')}\n`,
    `${event('file.processing.completed', { metadata_object_id: undefined })}\n`,
    `${event('file.processing.failed')}\n`, '{not-json}\n',
  ]) {
    const options = await setup(t), api = client({ stream });
    await assert.rejects(api.upload.upload(options));
    assert.equal((await journal(options)).phase, 'processing');
    assert.equal(api.calls.some(call => call.method === 'GET'), false);
    const resumed = client(); await assert.rejects(resumed.upload.upload(options));
    assert.equal(writes(resumed.calls).length, 0);
  }
});

test('readback must match general file ID, name, size, directory and regular-file type', async t => {
  for (const extra of [{ file_id: 'file_other' }, { file_name: 'other.txt' }, { file_size_bytes: CONTENT.length + 1 },
    { parent_directory_id: 'directory_other' }, { kind: 'directory' }]) {
    const options = await setup(t), api = client({ record: metadata(extra) });
    await assert.rejects(api.upload.upload(options));
    assert.equal((await journal(options)).phase, 'processed');
  }
});

test('a processed journal retries only metadata readback after a transient read failure', async t => {
  const options = await setup(t), first = client({ record: unknown() });
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, 'processed');
  const resumed = client(); await resumed.upload.upload(options);
  assert.equal(resumed.calls.length, 1); assert.equal(resumed.calls[0].method, 'GET');
  assert.equal((await journal(options)).phase, 'complete');
});

test('completed state and status expose no credential or signed URL and do not repeat writes', async t => {
  const options = await setup(t), first = client(); await first.upload.upload(options);
  const resumed = client(), status = await resumed.upload.status(options);
  const result = await resumed.upload.upload(options);
  assert.equal(writes(resumed.calls).length, 0);
  for (const value of [status, result]) {
    assert.ok(!JSON.stringify(value).includes('private-upload-secret'));
    assert.ok(!JSON.stringify(value).includes('private-token'));
    assert.equal(value.libraryFileId, LIBRARY_ID);
  }
});

test('changing source bytes or account identity prevents a resumed upload from issuing requests', async t => {
  for (const change of ['source', 'account', 'subject']) {
    const options = await setup(t), first = client({ uploadResult: unknown() });
    await assert.rejects(first.upload.upload(options));
    if (change === 'source') await writeFile(options.file, Buffer.from('different source bytes\n'));
    const resumed = client({ currentAuth: change === 'account' ? auth('account_other') : change === 'subject' ? auth(ACCOUNT, 'subject_other') : auth() });
    await assert.rejects(resumed.upload.upload(options));
    assert.equal(resumed.calls.length, 0);
  }
});

test('rejects source and state symlinks, empty or oversized sources, and permissive journal modes', async t => {
  const options = await setup(t), sourceLink = join(options.dir, 'source-link.txt'), empty = join(options.dir, 'empty.txt'), large = join(options.dir, 'large.bin');
  await symlink(options.file, sourceLink); await writeFile(empty, ''); await writeFile(large, ''); await truncate(large, 512 * 1024 * 1024 + 1);
  for (const file of [sourceLink, empty, large, options.dir]) {
    const api = client(); await assert.rejects(api.upload.upload({ ...options, file })); assert.equal(api.calls.length, 0);
  }
  await symlink(options.file, options.stateFile);
  const linked = client(); await assert.rejects(linked.upload.upload(options)); assert.equal(linked.calls.length, 0);
  await rm(options.stateFile);
  await client().upload.upload(options);
  await chmod(options.stateFile, 0o644);
  const exposed = client(); await assert.rejects(exposed.upload.status(options)); assert.equal(exposed.calls.length, 0);
});

test('refuses a live lock or lock symlink without modifying its target', async t => {
  const options = await setup(t), lock = `${options.stateFile}.lock`;
  await writeFile(lock, 'active');
  const active = client(); await assert.rejects(active.upload.upload(options)); assert.equal(active.calls.length, 0);
  assert.equal(await readFile(lock, 'utf8'), 'active');
  await rm(lock); await symlink(options.file, lock);
  const linked = client(); await assert.rejects(linked.upload.upload(options)); assert.equal(linked.calls.length, 0);
  assert.deepEqual(await readFile(options.file), CONTENT);
});

test('a reservation receipt that cannot be committed never starts byte upload', async t => {
  const options = await setup(t), backup = join(options.dir, 'original-journal.json');
  const api = client({ reserveResult: async () => {
    await rename(options.stateFile, backup); await symlink(options.file, options.stateFile); return reserve();
  } });
  await assert.rejects(api.upload.upload(options));
  assert.equal(api.calls.length, 1); assert.deepEqual(await readFile(options.file), CONTENT);
  await rm(options.stateFile); await rename(backup, options.stateFile);
  assert.equal((await journal(options)).phase, 'reserving');
  const resumed = client(); await assert.rejects(resumed.upload.upload(options)); assert.equal(writes(resumed.calls).length, 0);
});

test('a concurrent invocation cannot reserve or overwrite the active upload journal', async t => {
  const options = await setup(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const first = client({ reserveResult: async () => { entered(); return pending; } });
  const running = first.upload.upload(options);
  await started;
  try {
    const second = client(); await assert.rejects(second.upload.upload(options)); assert.equal(second.calls.length, 0);
    assert.equal((await journal(options)).phase, 'reserving');
  } finally { release(reserve()); }
  await running;
  assert.equal((await journal(options)).phase, 'complete');
});

test('an account or user change between write stages stops the next write', async t => {
  for (const after of ['reserve', 'upload']) {
    const options = await setup(t);
    let api;
    api = client({ onCall: call => {
      if (after === 'reserve' && call.route === '/backend-api/files' || after === 'upload' && call.kind === 'signed-upload') {
        api.currentAuth = auth(ACCOUNT, 'different_subject');
      }
    } });
    await assert.rejects(api.upload.upload(options), { code: 'ACCOUNT_CHANGED' });
    assert.equal(api.calls.length, after === 'reserve' ? 1 : 2);
    assert.equal(api.calls.some(call => call.route === '/backend-api/files/process_upload_stream'), false);
  }
});

test('invalid reservation identities are not used to upload any bytes', async t => {
  for (const response of [{}, reserve({ file_id: '../not-a-file' }), reserve({ file_id: null }), reserve({ upload_url: null })]) {
    const options = await setup(t), api = client({ reserveResult: response });
    await assert.rejects(api.upload.upload(options));
    assert.equal(api.calls.length, 1); assert.equal((await journal(options)).phase, response.file_id === FILE_ID ? 'reserved' : 'reserving');
  }
});

test('read-only reconciliation recovers a processed upload by its exact general file ID', async t => {
  const options = await setup(t), interrupted = client({ stream: unknown() });
  await assert.rejects(interrupted.upload.upload(options));
  const unrelated = metadata({ id: 'library:other', file_id: 'file_other' });
  const api = client({ search: { items: [unrelated, metadata()], cursor: null } });
  const result = await api.upload.reconcile(options);
  assert.equal(result.libraryFileId, LIBRARY_ID); assert.equal((await journal(options)).phase, 'complete');
  assert.ok(api.calls.some(call => call.route === '/backend-api/files/library'));
  assert.equal(api.calls.some(call => call.kind === 'signed-upload' || call.route === '/backend-api/files' || call.route === '/backend-api/files/process_upload_stream'), false);
});

test('reconciliation refuses absent or ambiguous mappings instead of matching by name', async t => {
  for (const items of [[metadata({ file_id: 'file_other' })], [metadata(), metadata({ id: 'library:duplicate' })]]) {
    const options = await setup(t), interrupted = client({ stream: unknown() });
    await assert.rejects(interrupted.upload.upload(options));
    const api = client({ search: { items, cursor: null } });
    if (items.length > 1) await assert.rejects(api.upload.reconcile(options), { code: 'INVALID_RESPONSE' });
    else {
      const result = await api.upload.reconcile(options);
      assert.equal(result.completed, false); assert.equal(result.reconciled, false); assert.equal(result.libraryFileId, null);
    }
    assert.equal((await journal(options)).phase, 'processing');
    assert.equal(api.calls.some(call => call.kind === 'signed-upload' || call.route === '/backend-api/files' || call.route === '/backend-api/files/process_upload_stream'), false);
  }
});

test('reconciliation of a reservation without a returned general file ID never searches by filename', async t => {
  const options = await setup(t), interrupted = client({ reserveResult: unknown() });
  await assert.rejects(interrupted.upload.upload(options));
  const api = client({ search: { items: [metadata()], cursor: null } });
  const result = await api.upload.reconcile(options);
  assert.equal(result.completed, false); assert.equal(result.reconciled, false); assert.equal(result.fileId, null);
  assert.equal(api.calls.length, 0);
});

test('Estuary uploads pass a verified source descriptor and pinned account before processing', async t => {
  const options = await setup(t);
  const uploadUrl = `https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=${encodeURIComponent(SIGNED_URL)}`;
  const api = client({ reserveResult: reserve({ upload_url: uploadUrl }) });
  await api.upload.upload(options);
  const upload = api.calls.find(call => call.kind === 'estuary-upload');
  assert.equal(upload.url, SIGNED_URL);
  assert.equal(upload.source.path, options.file); assert.equal(upload.source.sha256, HASH);
  assert.equal(upload.expectedAccountId, ACCOUNT);
  assert.equal(api.calls.some(call => call.kind === 'signed-upload'), false);
});

test('untrusted or malformed reservation upload targets never receive bytes', async t => {
  for (const uploadUrl of ['https://attacker.example/upload?sig=secret', 'http://files.oaiusercontent.com/file?sig=secret',
    'https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=https%3A%2F%2Fattacker.example%2Fupload%3Fsig%3Dsecret',
    'https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=x&extra=y']) {
    const options = await setup(t), api = client({ reserveResult: reserve({ upload_url: uploadUrl }) });
    await assert.rejects(api.upload.upload(options), { code: 'INVALID_RESPONSE' });
    assert.equal(api.calls.length, 1);
  }
});

for (const stage of ['upload', 'processing']) test(`an uncommitted ${stage} receipt stops further writes and remains uncertain`, async t => {
  const options = await setup(t), backup = join(options.dir, 'original-journal.json');
  const replaceState = async () => {
    await rename(options.stateFile, backup); await symlink(options.file, options.stateFile);
  };
  const api = client(stage === 'upload'
    ? { uploadResult: async () => { await replaceState(); return { uploaded: true, sizeBytes: CONTENT.length }; } }
    : { stream: async () => { await replaceState(); return `${event()}\n`; } });
  await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_RECEIPT_NOT_SAVED' });
  assert.equal(api.calls.length, stage === 'upload' ? 2 : 3);
  await rm(options.stateFile); await rename(backup, options.stateFile);
  assert.equal((await journal(options)).phase, stage === 'upload' ? 'uploading' : 'processing');
  const resumed = client(); await assert.rejects(resumed.upload.upload(options), { code: 'UPLOAD_OUTCOME_UNKNOWN' });
  assert.equal(resumed.calls.length, 0);
});

test('reconciliation cannot declare a unique mapping after reaching its page limit', async t => {
  const options = await setup(t), interrupted = client({ stream: unknown() });
  await assert.rejects(interrupted.upload.upload(options));
  let page = 0;
  const api = client({ search: () => ({ items: page++ === 0 ? [metadata()] : [], cursor: `cursor-${page}` }) });
  let outcome;
  try { outcome = await api.upload.reconcile(options); }
  catch (error) { assert.ok(error instanceof DotError); }
  if (outcome) assert.equal(outcome.completed, false, 'an unexhausted search cannot rule out another mapping');
  const state = await journal(options);
  assert.equal(state.phase, 'processing');
  assert.equal(state.processing.libraryFileId, undefined);
  assert.equal(api.calls.some(call => call.method === 'GET'), false);
});

test('unsupported required storage headers stop before bytes and retries preserve the known reservation', async t => {
  const options = await setup(t), api = client({ reserveResult: reserve({ upload_headers: { Authorization: 'private-credential' } }) });
  await assert.rejects(api.upload.upload(options), { code: 'INVALID_HEADERS' });
  assert.equal(api.calls.length, 1); assert.equal((await journal(options)).phase, 'reserved');
  const resumed = client();
  await assert.rejects(resumed.upload.upload(options), { code: 'INVALID_HEADERS' });
  assert.equal(resumed.calls.length, 0);
  const status = await resumed.upload.status(options);
  assert.equal(status.fileId, FILE_ID); assert.ok(!JSON.stringify(status).includes('private-credential'));
});

test('unsupported MIME syntax is rejected before a reservation or journal is created', async t => {
  const options = await setup(t), api = client();
  await assert.rejects(api.upload.upload({ ...options, mimeType: 'application/x!test' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(api.calls.length, 0); await assert.rejects(lstat(options.stateFile), { code: 'ENOENT' });
});

test('bare terminal processing errors are fatal before and after a completed event', async t => {
  for (const terminal of ['error', 'cancelled', 'failed', 'unknown']) {
    for (const lines of [[event(terminal), event()], [event(), event(terminal)]]) {
      const options = await setup(t), api = client({ stream: `${lines.join('\n')}\n` });
      await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_PROCESSING_ERROR' });
      assert.equal((await journal(options)).phase, 'processing');
      assert.equal(api.calls.some(call => call.method === 'GET'), false);
    }
  }
});

test('LibraryUpload completes Estuary through the real Transport header and multipart checks', async t => {
  const options = await setup(t), calls = [];
  const uploadUrl = `https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=${encodeURIComponent(SIGNED_URL)}`;
  const transport = new Transport({ authLoader: async () => auth(), fetchImpl: async (url, request) => {
    calls.push({ url: new URL(url), ...request });
    switch (new URL(url).pathname) {
      case '/backend-api/files': return Response.json(reserve({ upload_url: uploadUrl }));
      case '/backend-api/estuary/upload_content_bytes': return Response.json({});
      case '/backend-api/files/process_upload_stream': return new Response(`${event()}\n`, { headers: { 'content-type': 'application/x-ndjson' } });
      case `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}`: return Response.json(metadata());
      default: throw new Error(`Unexpected transport path: ${new URL(url).pathname}`);
    }
  } });
  const result = await new LibraryUpload({ transport }).upload(options);
  assert.equal(result.completed, true); assert.equal(calls.length, 4);
  const upload = calls[1];
  assert.equal(upload.headers['X-OpenAI-Attach-Auth'], '1');
  assert.equal(upload.headers['ChatGPT-Account-Id'], ACCOUNT);
  assert.equal(upload.headers.Authorization, `Bearer ${auth().accessToken}`);
  assert.equal(upload.body, undefined); assert.equal(upload.bodyFile.path, options.file); assert.equal(upload.bodyFile.sha256, HASH);
  assert.equal(upload.bodyFile.multipart.name, 'canary.txt'); assert.equal(upload.bodyFile.multipart.uploadUrl, SIGNED_URL);
  assert.match(upload.headers['Content-Type'], /^multipart\/form-data; boundary=dot-library-/);
  assert.equal(upload.redirect, 'manual');
  assert.equal(calls[2].method, 'POST'); assert.equal(calls[2].headers['Content-Type'], 'application/json');
  assert.equal((await journal(options)).phase, 'complete');
});

test('native raw-file fallback completes a persistent file and reports unavailable indexing', async t => {
  const options = await setup(t);
  const stream = `${event('file.processing.file_ready')}\n${event('file.indexing.error', {
    raw_file_fallback_available: true, error_code: 'unhandled_mime_type',
  })}\n`;
  const api = client({ stream });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.libraryFileId, LIBRARY_ID);
  assert.equal(result.retrievalIndexingUnavailable, true);
  assert.equal(result.indexingStatus, 'unavailable'); assert.equal(result.indexed, false);
  assert.equal(api.calls.at(-1).method, 'GET');
  assert.equal((await journal(options)).phase, 'complete');
  const status = await api.upload.status(options);
  assert.equal(status.retrievalIndexingUnavailable, true);
  assert.equal(status.indexingStatus, 'unavailable'); assert.equal(status.indexed, false);
});

test('native raw-file fallback still requires matching ready persistent Library metadata', async t => {
  const options = await setup(t);
  const stream = `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: true })}\n`;
  const api = client({ stream, record: metadata({ state: 'processing' }) });
  await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_READBACK_PENDING' });
  const state = await journal(options);
  assert.equal(state.phase, 'processed'); assert.equal(state.processing.retrievalIndexingUnavailable, true);
  const resumed = client();
  const result = await resumed.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.retrievalIndexingUnavailable, true);
  assert.equal(resumed.calls.length, 1); assert.equal(resumed.calls[0].method, 'GET');
});

test('an indexing error cannot claim raw fallback without a matching prior ready event and explicit flag', async t => {
  const fallback = event('file.indexing.error', { raw_file_fallback_available: true });
  const streams = [
    fallback,
    `${event('file.processing.file_ready', {}, 'file_other')}\n${fallback}`,
    `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: true }, 'file_other')}`,
    `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: false })}`,
    `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: 'true' })}`,
  ];
  for (const stream of streams) {
    const options = await setup(t), api = client({ stream });
    await assert.rejects(api.upload.upload(options));
    assert.equal((await journal(options)).phase, 'processing');
    assert.equal(api.calls.some(call => call.method === 'GET'), false);
  }
});

test('temporary persistence and later terminal failures cannot be rescued by raw-file fallback', async t => {
  const ready = event('file.processing.file_ready');
  const fallback = event('file.indexing.error', { raw_file_fallback_available: true });
  for (const [stream, code] of [
    [`${ready}\n${event('file.indexing.error', { raw_file_fallback_available: true, library_persistence_result: 'temporary' })}`, 'UPLOAD_PERSISTENCE_REQUIRED'],
    [`${event('file.processing.file_ready', { library_persistence_result: 'temporary' })}\n${fallback}`, 'UPLOAD_PERSISTENCE_REQUIRED'],
    [`${ready}\n${fallback}\n${event('error')}`, 'UPLOAD_PROCESSING_ERROR'],
  ]) {
    const options = await setup(t), api = client({ stream });
    await assert.rejects(api.upload.upload(options), { code });
    assert.equal((await journal(options)).phase, 'processing');
    assert.equal(api.calls.some(call => call.method === 'GET'), false);
  }
});

test('unknown upload strategies preserve the reservation without sending bytes', async t => {
  for (const strategy of [
    { kind: 'unknown_future_strategy', private_field: 'do-not-print' },
    'future_strategy', {},
  ]) {
    const options = await setup(t), api = client({ reserveResult: reserve({ direct_library_upload_strategy: strategy }) });
    await assert.rejects(api.upload.upload(options), { code: 'UNSUPPORTED_UPLOAD_STRATEGY' });
    assert.equal(api.calls.length, 1);
    const state = await journal(options);
    assert.equal(state.phase, 'reserved'); assert.equal(state.reservation.fileId, FILE_ID);
    assert.ok(!JSON.stringify(state.reservation.uploadStrategy).includes('do-not-print'));
    const resumed = client();
    await assert.rejects(resumed.upload.upload(options), { code: 'UNSUPPORTED_UPLOAD_STRATEGY' });
    assert.equal(resumed.calls.length, 0, 'unsupported strategies cannot trigger another reservation or any upload');
  }
});

test('invalid stored source metadata and phase identities are rejected before status or recovery', async t => {
  const options = await setup(t), api = client(); await api.upload.upload(options);
  const original = await journal(options);
  for (const change of [
    state => { state.source.sha256 = 'not-a-hash'; },
    state => { state.source.sizeBytes = -1; },
    state => { state.source.mimeType = 'application/x!test'; },
    state => { state.source.name = '../outside'; },
    state => { state.processing.libraryFileId = null; },
    state => { state.reservation.fileId = null; },
    state => { state.operationId = 'not-a-uuid'; },
  ]) {
    const state = structuredClone(original); change(state);
    await writeFile(options.stateFile, JSON.stringify(state), { mode: 0o600 });
    const fresh = client();
    await assert.rejects(fresh.upload.status(options), { code: 'INVALID_UPLOAD_STATE' });
    await assert.rejects(fresh.upload.reconcile(options), { code: 'INVALID_UPLOAD_STATE' });
    assert.equal(fresh.calls.length, 0);
  }
});

test('an omitted root destination accepts only its explicitly resolved native root ID', async t => {
  const options = await setup(t), rootId = 'root_test';
  const api = client({ record: metadata({ parent_directory_id: rootId }),
    directoryPath: { items: [{ id: rootId, kind: 'directory', name: 'Library', is_root: true }], cursor: null } });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.directoryId, null);
  const rootRead = api.calls.at(-1);
  assert.equal(rootRead.method, 'GET'); assert.equal(rootRead.route, '/backend-api/files/library/directories/path');
  assert.deepEqual(rootRead.query, { directory_id: null });
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 2);
});

test('root normalization rejects a different root, missing root marker, or ambiguous root path', async t => {
  const rootId = 'root_test';
  for (const items of [
    [{ id: 'root_other', kind: 'directory', is_root: true }],
    [{ id: rootId, kind: 'directory' }],
    [{ id: rootId, kind: 'directory', is_root: false }],
    [{ id: rootId, kind: 'directory', is_root: true }, { id: 'folder_other', kind: 'directory' }],
  ]) {
    const options = await setup(t), api = client({ record: metadata({ parent_directory_id: rootId }), directoryPath: { items, cursor: null } });
    await assert.rejects(api.upload.upload(options), { code: 'INVALID_RESPONSE' });
    assert.equal((await journal(options)).phase, 'processed');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 2);
  }
});

test('malformed reservation headers stay invalid across resume and never become an empty usable header set', async t => {
  for (const uploadHeaders of [[], ['x-ms-version'], { 'x-ms-version': 7 }, { 'x-ms-version': 'bad\r\nvalue' }]) {
    const options = await setup(t), api = client({ reserveResult: reserve({ upload_headers: uploadHeaders }) });
    await assert.rejects(api.upload.upload(options), { code: 'INVALID_RESPONSE' });
    assert.equal(api.calls.length, 1);
    const state = await journal(options);
    assert.equal(state.phase, 'reserved'); assert.equal(state.reservation.fileId, FILE_ID);
    assert.equal(state.reservation.metadataValid, false);
    const resumed = client();
    const status = await resumed.upload.status(options);
    assert.equal(status.status, 'invalid_reservation'); assert.equal(status.canResume, false); assert.equal(status.canReconcile, true);
    await assert.rejects(resumed.upload.upload(options), { code: 'INVALID_RESPONSE' });
    assert.equal(resumed.calls.length, 0, 'invalid stored metadata must not trigger another reservation, byte upload, or processing');
  }
});

test('processing diagnostics retain safe terminal names and codes without copying raw error payloads', async t => {
  const options = await setup(t), privateText = 'Private arbitrary server explanation';
  const progress = JSON.stringify({ event: 'file.processing.started', file_id: FILE_ID, extra: { raw: privateText } });
  const terminal = JSON.stringify({ event: 'file.processing.error', file_id: FILE_ID,
    error: privateText, download_url: SIGNED_URL, raw_payload: { private_token: 'private-payload-token' },
    extra: { error_code: 'file_processing_failed', error: privateText, download_url: SIGNED_URL } });
  const api = client({ stream: `${progress}\n${progress}\n${terminal}\n` });
  await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_PROCESSING_ERROR' });
  const state = await journal(options);
  assert.deepEqual(state.processing.eventNames, ['file.processing.started', 'file.processing.error']);
  assert.equal(state.processing.failureEvent, 'file.processing.error');
  assert.equal(state.processing.failureCode, 'file_processing_failed');
  assert.equal(state.phase, 'processing');
  const status = await api.upload.status(options);
  for (const value of [state, status]) {
    const serialized = JSON.stringify(value);
    for (const secret of [privateText, SIGNED_URL, 'private-payload-token', 'raw_payload', 'download_url']) assert.equal(serialized.includes(secret), false);
  }
});

test('unbounded, control-containing and URL error codes are omitted from saved processing diagnostics', async t => {
  for (const errorCode of ['x'.repeat(129), 'bad\ncode', 'https://example.test/private?sig=secret']) {
    const options = await setup(t);
    const terminal = JSON.stringify({ event: 'file.indexing.error', file_id: FILE_ID, extra: { error_code: errorCode } });
    const api = client({ stream: `${terminal}\n` });
    await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_PROCESSING_ERROR' });
    const state = await journal(options);
    assert.equal(state.processing.failureEvent, 'file.indexing.error');
    assert.equal(state.processing.failureCode, undefined);
    assert.deepEqual(state.processing.eventNames, ['file.indexing.error']);
    assert.equal(JSON.stringify(state).includes(errorCode), false);
    assert.equal(JSON.stringify(await api.upload.status(options)).includes(errorCode), false);
  }
});

test('processing event diagnostics stay distinct and bounded while preserving a terminal failure separately', async t => {
  const options = await setup(t);
  const progress = Array.from({ length: 260 }, (_, index) => JSON.stringify({ event: `file.progress.phase_${index}`, file_id: FILE_ID }));
  const stream = [...progress, ...progress.slice(0, 5), JSON.stringify({ event: 'file.processing.failed', file_id: FILE_ID,
    extra: { error_code: 'x'.repeat(128) } })].join('\n');
  const api = client({ stream });
  await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_PROCESSING_ERROR' });
  const state = await journal(options);
  assert.equal(state.processing.eventNames.length, 256);
  assert.equal(new Set(state.processing.eventNames).size, 256);
  assert.equal(state.processing.failureEvent, 'file.processing.failed');
  assert.equal(state.processing.failureCode, 'x'.repeat(128));
});

test('folder uploads stage in the root, move only after verified persistence, and verify the final destination', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID }), phases = [];
  const api = client({ record: metadata({ parent_directory_id: ROOT_ID }),
    onCall: async call => phases.push({ call, phase: (await journal(options)).phase }) });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.directoryId, DIRECTORY_ID);
  assert.ok(phases.some(({ call }) => call.route === '/backend-api/files/library/directories/path' && call.query.directory_id === DIRECTORY_ID));
  const process = phases.find(({ call }) => call.route === '/backend-api/files/process_upload_stream');
  assert.equal(Object.hasOwn(process.call.body, 'directory_id'), false);
  const moveIndex = phases.findIndex(({ call }) => call.method === 'PATCH');
  assert.ok(moveIndex > phases.indexOf(process));
  assert.equal(phases[moveIndex].phase, 'moving');
  assert.equal(phases[moveIndex].call.route, `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}/move`);
  assert.deepEqual(phases[moveIndex].call.body, { directory_id: DIRECTORY_ID });
  assert.ok(phases.slice(0, moveIndex).some(({ call, phase }) => call.method === 'GET' && call.route.endsWith(encodeURIComponent(LIBRARY_ID)) && phase === 'processed'));
  assert.ok(phases.slice(moveIndex + 1).some(({ call, phase }) => call.method === 'GET' && call.route.endsWith(encodeURIComponent(LIBRARY_ID)) && phase === 'moved'));
  assert.equal((await journal(options)).phase, 'complete');
});

test('an uncertain folder move is never replayed and root reconciliation stays uncertain', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  const api = client({ record: metadata({ parent_directory_id: ROOT_ID }), moveResult: unknown() });
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, 'moving');
  assert.equal(api.calls.filter(call => call.method === 'PATCH').length, 1);
  const resumed = client(); await assert.rejects(resumed.upload.upload(options), { code: 'UPLOAD_OUTCOME_UNKNOWN' });
  assert.equal(resumed.calls.length, 0);
  const stillRoot = client({ record: metadata({ parent_directory_id: ROOT_ID }) });
  const result = await stillRoot.upload.reconcile(options);
  assert.equal(result.completed, false); assert.equal(result.phase, 'moving');
  assert.equal(stillRoot.calls.some(call => call.method === 'PATCH'), false);
  assert.equal((await journal(options)).phase, 'moving');
});

test('read-only reconciliation confirms an uncertain move only from exact target metadata', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  const api = client({ record: metadata({ parent_directory_id: ROOT_ID }), moveResult: unknown() });
  await assert.rejects(api.upload.upload(options));
  const moved = client({ record: metadata({ parent_directory_id: DIRECTORY_ID }) });
  const result = await moved.upload.reconcile(options);
  assert.equal(result.completed, true); assert.equal(result.reconciled, true);
  assert.equal(moved.calls.every(call => call.method === 'GET'), true);
  assert.equal((await journal(options)).phase, 'complete');
});

test('reconciling a processed folder upload exposes an explicit move-resume step without writing', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  const interrupted = client({ stream: unknown() });
  await assert.rejects(interrupted.upload.upload(options));
  const recovered = client({ record: metadata({ parent_directory_id: ROOT_ID }), search: { items: [metadata({ parent_directory_id: ROOT_ID })], cursor: null } });
  const result = await recovered.upload.reconcile(options);
  assert.equal(result.completed, false); assert.equal(result.phase, 'processed'); assert.equal(result.status, 'awaiting_move');
  assert.equal(result.canResume, true); assert.equal(result.stagedAtRoot, true); assert.equal(recovered.calls.some(call => call.method === 'PATCH'), false);
  const resumed = client({ record: metadata({ parent_directory_id: ROOT_ID }) });
  assert.equal((await resumed.upload.upload(options)).completed, true);
  assert.equal(resumed.calls.some(call => call.kind === 'signed-upload' || call.kind === 'estuary-upload' || call.route === '/backend-api/files/process_upload_stream' || call.route === '/backend-api/files'), false);
  assert.equal(resumed.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('a moved response cannot complete before metadata confirms the requested destination', async t => {
  for (const movedRecord of [metadata({ parent_directory_id: ROOT_ID }), metadata({ parent_directory_id: 'directory_other' }), metadata({ parent_directory_id: DIRECTORY_ID, state: 'processing' })]) {
    const options = await setup(t, { directoryId: DIRECTORY_ID });
    const api = client({ record: metadata({ parent_directory_id: ROOT_ID }), movedRecord });
    await assert.rejects(api.upload.upload(options));
    assert.equal((await journal(options)).phase, 'moved');
    const finalRead = client({ record: metadata({ parent_directory_id: DIRECTORY_ID }) });
    assert.equal((await finalRead.upload.upload(options)).completed, true);
    assert.equal(finalRead.calls.every(call => call.method === 'GET'), true);
  }
});

test('an inaccessible requested folder fails before reservation, upload, processing or move', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  const api = client({ directoryPath: { items: [{ id: 'directory_other', kind: 'directory' }], cursor: null } });
  await assert.rejects(api.upload.upload(options), { code: 'INVALID_ARGUMENT' });
  assert.equal(api.calls.every(call => call.method === 'GET'), true);
  assert.equal((await journal(options)).phase, 'prepared');
});

test('files above the old 20 MiB limit use a source descriptor without materializing upload bytes', async t => {
  const options = await setup(t), sizeBytes = 21 * 1024 * 1024;
  await truncate(options.file, sizeBytes);
  const api = client({ record: metadata({ file_size_bytes: sizeBytes }) });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.sizeBytes, sizeBytes);
  const upload = api.calls.find(call => call.kind === 'signed-upload');
  assert.equal(upload.source.sizeBytes, sizeBytes); assert.equal(upload.source.path, options.file);
  assert.equal(Object.hasOwn(upload, 'bytes'), false); assert.equal(Object.hasOwn(upload.source, 'bytes'), false);
});

test('a moved receipt stays moved while root metadata is stale and never permits another move', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  const first = client({ record: metadata({ parent_directory_id: ROOT_ID }), movedRecord: metadata({ parent_directory_id: ROOT_ID }) });
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, 'moved');
  const stale = client({ record: metadata({ parent_directory_id: ROOT_ID }) });
  const result = await stale.upload.reconcile(options);
  assert.equal(result.completed, false); assert.equal(result.phase, 'moved');
  assert.equal((await journal(options)).phase, 'moved');
  await assert.rejects(stale.upload.upload(options), { code: 'INVALID_RESPONSE' });
  assert.equal(stale.calls.some(call => call.method === 'PATCH'), false);
});

test('an existing complete receipt never moves a file again after its external location changes', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID });
  await client({ record: metadata({ parent_directory_id: ROOT_ID }) }).upload.upload(options);
  assert.equal((await journal(options)).phase, 'complete');
  const changed = client({ record: metadata({ parent_directory_id: ROOT_ID }) });
  assert.equal((await changed.upload.upload(options)).completed, true);
  assert.equal(changed.calls.length, 0);
  await assert.rejects(changed.upload.reconcile(options), { code: 'INVALID_RESPONSE' });
  assert.equal(changed.calls.some(call => call.method === 'PATCH'), false);
  assert.equal((await journal(options)).phase, 'complete');
});

test('a lost move receipt stays uncertain until read-only reconciliation sees the target', async t => {
  const options = await setup(t, { directoryId: DIRECTORY_ID }), backup = join(options.dir, 'before-move-receipt.json');
  const first = client({ record: metadata({ parent_directory_id: ROOT_ID }), moveResult: async () => {
    await rename(options.stateFile, backup); await symlink(options.file, options.stateFile); return { success: true };
  } });
  await assert.rejects(first.upload.upload(options), { code: 'UPLOAD_RECEIPT_NOT_SAVED' });
  await rm(options.stateFile); await rename(backup, options.stateFile);
  assert.equal((await journal(options)).phase, 'moving');
  const resumed = client(); await assert.rejects(resumed.upload.upload(options), { code: 'UPLOAD_OUTCOME_UNKNOWN' });
  assert.equal(resumed.calls.length, 0);
  const reconciled = client({ record: metadata({ parent_directory_id: DIRECTORY_ID }) });
  assert.equal((await reconciled.upload.reconcile(options)).completed, true);
  assert.equal(reconciled.calls.every(call => call.method === 'GET'), true);
});
