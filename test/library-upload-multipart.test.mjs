import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LibraryUpload } from '../src/library-upload.mjs';
import { DotError } from '../src/errors.mjs';

const ACCOUNT = 'account_multipart_test';
const SUBJECT = 'subject_multipart_test';
const FILE_ID = 'file_multipart_test';
const LIBRARY_ID = 'library:multipart_test';
const CONTENT = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789!');
const UPLOAD_URL = 'https://dotfixture.blob.core.windows.net/upload/canary?sig=private-signature&sp=w&sv=2020-04-08';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blockId = index => Buffer.from(String(index).padStart(8, '0')).toString('base64');
const auth = (accountId = ACCOUNT, subject = SUBJECT) => ({ accountId,
  accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.private-token` });
const strategy = (extra = {}) => ({ kind: 'direct_azure_multipart', part_size_bytes: 10,
  part_count: Math.ceil(CONTENT.length / 10), max_part_concurrency: 2, ...extra });
const unknown = () => new DotError('NETWORK_ERROR', 'The upload response was lost.', { delivery: 'unknown' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const timeout = ms => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Test timed out waiting for upload workers.')), ms); timer.unref(); });
async function within(promise) { return Promise.race([promise, timeout(5000)]); }

async function fixture(t, content = CONTENT) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-library-multipart-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'canary.txt'), stateFile = join(dir, 'upload.json');
  await writeFile(file, content);
  return { dir, file, stateFile, expectedAccountId: ACCOUNT };
}
async function journal(options) { return JSON.parse(await readFile(options.stateFile, 'utf8')); }

function client({ uploadStrategy = strategy(), uploadUrl = UPLOAD_URL, content = CONTENT,
  onCall, onBlock, onCommit, reservationError, processingError } = {}) {
  const calls = [];
  const api = { calls, currentAuth: auth(), transport: {
    async authLoader() { return api.currentAuth; },
    assertIdentity() {},
    async request(method, route, options = {}) {
      const call = { kind: 'request', method, route, ...options };
      calls.push(call); await onCall?.(call);
      if (method === 'POST' && route === '/backend-api/files') {
        if (reservationError) throw reservationError;
        return { file_id: FILE_ID, upload_url: uploadUrl, upload_headers: {}, direct_library_upload_strategy: uploadStrategy };
      }
      if (method === 'POST' && route === '/backend-api/files/process_upload_stream') {
        if (processingError) throw processingError;
        return `${JSON.stringify({ event: 'file.processing.completed', file_id: FILE_ID,
          extra: { metadata_object_id: LIBRARY_ID, library_file_name: 'canary.txt', mime_type: 'text/plain' } })}\n`;
      }
      if (method === 'GET' && route === `/backend-api/files/library/files/${encodeURIComponent(LIBRARY_ID)}`) {
        return { id: LIBRARY_ID, kind: 'file', file_id: FILE_ID, file_name: 'canary.txt', mime_type: 'text/plain',
          file_size_bytes: content.length, parent_directory_id: null, state: 'ready' };
      }
      throw new Error(`Unexpected ${method} ${route}`);
    },
    async uploadAzureBlock(url, options) {
      const call = { kind: 'block', url, ...options }; calls.push(call); await onCall?.(call);
      return await onBlock?.(call) ?? { uploaded: true, sizeBytes: options.length };
    },
    async commitAzureBlocks(url, options) {
      const call = { kind: 'commit', url, ...options }; calls.push(call); await onCall?.(call);
      return await onCommit?.(call) ?? { uploaded: true };
    },
    async uploadSignedFile() { throw new Error('Multipart upload must not use whole-file transport.'); },
    async uploadSigned() { throw new Error('Multipart upload must not buffer and upload the whole file.'); },
  } };
  api.upload = new LibraryUpload(api);
  return api;
}

const blocks = api => api.calls.filter(call => call.kind === 'block');
const commits = api => api.calls.filter(call => call.kind === 'commit');
const processing = api => api.calls.filter(call => call.route === '/backend-api/files/process_upload_stream');
const reservations = api => api.calls.filter(call => call.route === '/backend-api/files');

test('multipart upload sends exact file-backed block ranges, hashes and ordered deterministic IDs before processing', async t => {
  const options = await fixture(t), api = client();
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true);
  assert.equal(reservations(api).length, 1);
  assert.equal(reservations(api)[0].body.supports_direct_azure_multipart, true);
  assert.deepEqual(blocks(api).map(({ offset, length, sha256, blockId: id }) => ({ offset, length, sha256, blockId: id })).sort((a, b) => a.offset - b.offset),
    [0, 10, 20, 30].map((offset, index) => ({ offset, length: Math.min(10, CONTENT.length - offset),
      sha256: hash(CONTENT.subarray(offset, offset + 10)), blockId: blockId(index) })));
  for (const call of blocks(api)) {
    assert.equal(call.url, UPLOAD_URL); assert.equal(call.source.path, options.file);
    assert.equal(call.source.sha256, hash(CONTENT)); assert.equal(call.contentType, 'text/plain');
    assert.equal(call.bytes, undefined, 'the transport receives a verified file range, not retained whole-file bytes');
  }
  assert.equal(commits(api).length, 1);
  assert.deepEqual(commits(api)[0].blockIds, [0, 1, 2, 3].map(blockId));
  assert.equal(commits(api)[0].contentType, 'text/plain');
  assert.equal(processing(api).length, 1);
  assert.ok(api.calls.indexOf(commits(api)[0]) < api.calls.indexOf(processing(api)[0]));
  assert.equal((await journal(options)).phase, 'complete');
  assert.equal(JSON.stringify(result).includes('private-signature'), false);
});

test('multipart journal records each intent before its block and all receipts before commit', async t => {
  const options = await fixture(t), seen = [];
  const api = client({ onCall: async call => {
    if (!['block', 'commit'].includes(call.kind)) return;
    const state = await journal(options); seen.push({ call, state });
    assert.equal(state.phase, call.kind === 'block' ? 'uploading_parts' : 'committing');
    assert.equal(state.reservation.fileId, FILE_ID);
  } });
  await api.upload.upload(options);
  assert.equal(seen.filter(entry => entry.call.kind === 'block').length, 4);
  const beforeCommit = seen.find(entry => entry.call.kind === 'commit').state;
  assert.equal(beforeCommit.source.sha256, hash(CONTENT));
  // Every deterministic ID and hash must already be durable when a write starts.
  for (const { call, state } of seen.filter(entry => entry.call.kind === 'block')) {
    const part = state.transfer.parts.find(part => part.blockId === call.blockId);
    assert.deepEqual(part, { index: call.offset / 10, blockId: call.blockId, offset: call.offset,
      length: call.length, sha256: call.sha256, status: 'inflight' });
    assert.equal(state.transfer.fileId, FILE_ID);
    assert.equal(state.transfer.sourceSha256, hash(CONTENT));
  }
  assert.deepEqual(beforeCommit.transfer.parts.map(part => part.status), ['uploaded', 'uploaded', 'uploaded', 'uploaded']);
  assert.deepEqual(beforeCommit.transfer.parts.map(part => part.blockId), [0, 1, 2, 3].map(blockId));
});

test('multipart workers honor the server limit and hard cap concurrent writes at five', async t => {
  for (const [requested, expected] of [[1, 1], [3, 3], [20, 5]]) {
    const options = await fixture(t), gate = deferred(), started = deferred();
    let active = 0, maximum = 0, entered = 0;
    const api = client({ uploadStrategy: strategy({ part_size_bytes: 4, part_count: 10, max_part_concurrency: requested }),
      onBlock: async () => {
        active++; entered++; maximum = Math.max(maximum, active);
        if (entered === expected) started.resolve();
        try { await gate.promise; } finally { active--; }
      } });
    const running = api.upload.upload(options);
    try { await within(started.promise); assert.equal(active, expected); }
    finally { gate.resolve(); }
    await running;
    assert.equal(maximum, expected); assert.equal(blocks(api).length, 10);
  }
});

test('failed blocks abort siblings, await their settlement, and never commit or process', async t => {
  const options = await fixture(t), entered = deferred(), release = deferred();
  let count = 0, settled = 0, finished = false, aborted = 0;
  const api = client({ uploadStrategy: strategy({ part_size_bytes: 13, part_count: 3, max_part_concurrency: 3 }),
    onBlock: async call => {
      call.signal?.addEventListener('abort', () => { aborted++; }, { once: true });
      if (++count === 3) entered.resolve();
      await entered.promise;
      if (call.offset === 0) { settled++; throw unknown(); }
      await release.promise; settled++;
    } });
  const running = api.upload.upload(options).finally(() => { finished = true; });
  const rejected = assert.rejects(running);
  try {
    await within(entered.promise);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'the invocation must wait for every already-started block');
    assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
  } finally { release.resolve(); }
  await rejected;
  assert.equal(settled, 3); assert.ok(aborted >= 2);
  assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
  assert.equal((await journal(options)).phase, 'uploading_parts');
});

test('partial upload requires explicit resume and replays only unacknowledged deterministic blocks', async t => {
  const options = await fixture(t), first = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }),
    onBlock: call => { if (call.offset === 10) throw unknown(); } });
  await assert.rejects(first.upload.upload(options));
  assert.deepEqual(blocks(first).map(call => call.blockId), [blockId(0), blockId(1)]);
  const status = await first.upload.status(options);
  assert.equal(status.phase, 'uploading_parts'); assert.equal(status.canResume, false); assert.equal(status.canResumeParts, true);
  assert.equal(status.transfer.uploadedParts, 1); assert.equal(status.transfer.parts, 4);
  assert.equal(JSON.stringify(status).includes('private-signature'), false);
  const automatic = client();
  await assert.rejects(automatic.upload.upload(options));
  assert.equal(automatic.calls.length, 0);
  const resumed = client();
  const result = await resumed.upload.upload({ ...options, resumeParts: true });
  assert.equal(result.completed, true); assert.equal(reservations(resumed).length, 0);
  assert.deepEqual(blocks(resumed).map(call => call.blockId), [blockId(1), blockId(2), blockId(3)]);
  assert.equal(blocks(resumed)[0].sha256, blocks(first)[1].sha256);
  assert.equal(commits(resumed).length, 1); assert.equal(processing(resumed).length, 1);
});

test('unknown commit remains read-only and cannot be replayed even with explicit multipart resume', async t => {
  const options = await fixture(t), first = client({ onCommit: () => { throw unknown(); } });
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, 'committing');
  assert.equal(processing(first).length, 0);
  const status = await first.upload.status(options);
  assert.equal(status.canResumeParts, false); assert.equal(status.canResume, false);
  assert.equal(status.status, 'outcome_unknown');
  for (const resumeParts of [false, true]) {
    const resumed = client();
    await assert.rejects(resumed.upload.upload({ ...options, resumeParts }), { code: 'UPLOAD_OUTCOME_UNKNOWN' });
    assert.equal(resumed.calls.length, 0);
  }
});

test('processing does not start while the multipart commit acknowledgement is pending', async t => {
  const options = await fixture(t), entered = deferred(), release = deferred();
  const api = client({ onCommit: async () => { entered.resolve(); await release.promise; } });
  const running = api.upload.upload(options);
  try {
    await within(entered.promise);
    assert.equal((await journal(options)).phase, 'committing');
    assert.equal(processing(api).length, 0);
  } finally { release.resolve(); }
  await running;
  assert.equal(processing(api).length, 1);
});

test('explicit multipart resume cannot replay uncertain reservation or processing requests', async t => {
  for (const failure of [{ reservationError: unknown() }, { processingError: unknown() }]) {
    const options = await fixture(t), first = client(failure);
    await assert.rejects(first.upload.upload(options));
    const resumed = client();
    await assert.rejects(resumed.upload.upload({ ...options, resumeParts: true }));
    assert.equal(resumed.calls.length, 0);
  }
});

test('multipart resume rejects changed bytes, account, subject or destination before any API call', async t => {
  for (const change of ['bytes', 'account', 'subject', 'destination']) {
    const options = await fixture(t), first = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: () => { throw unknown(); } });
    await assert.rejects(first.upload.upload(options));
    const resumed = client();
    if (change === 'bytes') await writeFile(options.file, Buffer.from('A'.repeat(CONTENT.length)));
    if (change === 'account') resumed.currentAuth = auth('other_account');
    if (change === 'subject') resumed.currentAuth = auth(ACCOUNT, 'other_subject');
    const arguments_ = { ...options, resumeParts: true, ...(change === 'destination' ? { directoryId: 'other_directory' } : {}) };
    await assert.rejects(resumed.upload.upload(arguments_));
    assert.equal(resumed.calls.length, 0);
  }
});

test('multipart resume validates recorded file identity and every block receipt before writing', async t => {
  const changes = [
    state => { state.transfer.fileId = 'file_other'; },
    state => { state.transfer.sourceSha256 = 'a'.repeat(64); },
    state => { state.transfer.parts[0].index = 7; },
    state => { state.transfer.parts[0].blockId = blockId(7); },
    state => { state.transfer.parts[0].offset = 1; },
    state => { state.transfer.parts[0].length = 1; },
    state => { state.transfer.parts[0].sha256 = 'not-a-hash'; },
    state => { state.transfer.parts[0].status = 'complete'; },
    state => { state.transfer.parts.push({ ...state.transfer.parts[0] }); },
  ];
  for (const change of changes) {
    const options = await fixture(t), first = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: () => { throw unknown(); } });
    await assert.rejects(first.upload.upload(options));
    const state = await journal(options); change(state);
    await writeFile(options.stateFile, JSON.stringify(state), { mode: 0o600 });
    const resumed = client();
    await assert.rejects(resumed.upload.upload({ ...options, resumeParts: true }));
    assert.equal(resumed.calls.length, 0);
  }
});

test('multipart resume rejects a substituted signed blob target before sending bytes', async t => {
  const options = await fixture(t), first = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: () => { throw unknown(); } });
  await assert.rejects(first.upload.upload(options));
  const state = await journal(options);
  state.reservation.uploadUrl = UPLOAD_URL.replace('/upload/canary?', '/upload/other-blob?');
  await writeFile(options.stateFile, JSON.stringify(state), { mode: 0o600 });
  const resumed = client();
  await assert.rejects(resumed.upload.upload({ ...options, resumeParts: true }));
  assert.equal(resumed.calls.length, 0);
});

test('an acknowledged block whose receipt cannot be saved stops before another block or commit', async t => {
  const options = await fixture(t), backup = join(options.dir, 'original-journal.json');
  const api = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: async () => {
    await rename(options.stateFile, backup); await symlink(options.file, options.stateFile);
  } });
  await assert.rejects(api.upload.upload(options), { code: 'UPLOAD_RECEIPT_NOT_SAVED' });
  assert.equal(blocks(api).length, 1); assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
  assert.deepEqual(await readFile(options.file), CONTENT);
  await rm(options.stateFile); await rename(backup, options.stateFile);
  assert.equal((await journal(options)).phase, 'uploading_parts');
  const implicit = client(); await assert.rejects(implicit.upload.upload(options)); assert.equal(implicit.calls.length, 0);
});

test('invalid or unsupported multipart strategies stop before a storage write and preserve the reservation', async t => {
  for (const invalid of [
    strategy({ part_size_bytes: 0 }), strategy({ part_size_bytes: 1.5 }), strategy({ part_size_bytes: -1 }),
    strategy({ part_count: 1 }), strategy({ part_count: 50001 }), strategy({ part_count: 3 }),
    strategy({ max_part_concurrency: 0 }), strategy({ max_part_concurrency: 1.5 }),
    strategy({ kind: 'azure_multipart' }), strategy({ kind: 'future_strategy' }),
  ]) {
    const options = await fixture(t), api = client({ uploadStrategy: invalid });
    await assert.rejects(api.upload.upload(options));
    assert.equal(reservations(api).length, 1); assert.equal(blocks(api).length, 0);
    assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
    const state = await journal(options); assert.equal(state.reservation.fileId, FILE_ID);
    const resumed = client(); await assert.rejects(resumed.upload.upload({ ...options, resumeParts: true }));
    assert.equal(resumed.calls.length, 0);
  }
});

test('multipart cannot send blocks to an untrusted or non-Azure reservation target', async t => {
  for (const uploadUrl of ['https://example.test/upload?sig=private', 'http://dotfixture.blob.core.windows.net/upload?sig=private',
    'https://files.oaiusercontent.com/upload?sig=private']) {
    const options = await fixture(t), api = client({ uploadUrl });
    await assert.rejects(api.upload.upload(options));
    assert.equal(reservations(api).length, 1); assert.equal(blocks(api).length, 0);
    assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
  }
});

test('an identity change after the first block prevents later blocks, commit and processing', async t => {
  const options = await fixture(t);
  let api;
  api = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: () => { api.currentAuth = auth(ACCOUNT, 'changed_subject'); } });
  await assert.rejects(api.upload.upload(options), { code: 'ACCOUNT_CHANGED' });
  assert.equal(blocks(api).length, 1); assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
});

test('a source mutation after the first block prevents later ranges and commit', async t => {
  const options = await fixture(t);
  const api = client({ uploadStrategy: strategy({ max_part_concurrency: 1 }), onBlock: async call => {
    if (call.offset === 0) await writeFile(options.file, Buffer.from('Z'.repeat(CONTENT.length)));
  } });
  await assert.rejects(api.upload.upload(options));
  assert.equal(blocks(api).length, 1); assert.equal(commits(api).length, 0); assert.equal(processing(api).length, 0);
});

test('completion and status never expose the signed multipart target or per-block secret material', async t => {
  const options = await fixture(t), api = client();
  const completed = await api.upload.upload(options), status = await api.upload.status(options);
  for (const value of [completed, status]) {
    assert.equal(value.completed, true);
    assert.equal(JSON.stringify(value).includes(UPLOAD_URL), false);
    assert.equal(JSON.stringify(value).includes('private-signature'), false);
    assert.equal(JSON.stringify(value).includes('private-token'), false);
  }
  const fresh = client();
  await fresh.upload.upload({ ...options, resumeParts: true });
  assert.equal(fresh.calls.length, 0);
});
