import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, writeFile, readFile, symlink, rm, realpath, truncate, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLibraryUploadSource, readVerifiedUploadSlice, prepareVerifiedUploadRange } from '../src/library-upload-source.mjs';

const MiB = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { name = 'source.txt', bytes = Buffer.from('native Library source\n') } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-library-source-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  await writeFile(file, bytes);
  return { dir, file, bytes };
}

async function withReads(file, hook, run) {
  const probe = await open(file, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.read;
  await probe.close();
  prototype.read = function (...args) { return hook.call(this, original, args); };
  try { return await run(); } finally { prototype.read = original; }
}

async function withFixedStat(file, value, run) {
  const probe = await open(file, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.stat;
  await probe.close();
  prototype.stat = async function () { return value; };
  try { return await run(); } finally { prototype.stat = original; }
}

async function trackAllocation(run) {
  const original = Buffer.allocUnsafe;
  let max = 0;
  Buffer.allocUnsafe = function (size, ...rest) { max = Math.max(size, max); return original(size, ...rest); };
  try { return { value: await run(), max }; } finally { Buffer.allocUnsafe = original; }
}

test('source preparation returns immutable metadata and SHA256 without retaining bytes', async t => {
  const { file, bytes } = await fixture(t);
  const { source, ...rest } = await readLibraryUploadSource(file);
  assert.deepEqual(rest, {});
  assert.deepEqual(Object.keys(source).sort(), ['path', 'name', 'mimeType', 'mimeResolutionSource', 'sizeBytes', 'sha256', 'dev', 'ino', 'mtimeMs', 'ctimeMs'].sort());
  assert.equal(source.path, file);
  assert.equal(source.name, 'source.txt');
  assert.equal(source.mimeType, 'text/plain');
  assert.equal(source.mimeResolutionSource, 'filename_extension');
  assert.equal(source.sizeBytes, bytes.length);
  assert.equal(source.sha256, hash(bytes));
  assert.match(source.dev, /^\d+$/u);
  assert.match(source.ino, /^\d+$/u);
  assert.equal(typeof source.mtimeMs, 'number');
  assert.equal(typeof source.ctimeMs, 'number');
  assert.equal(Object.isFrozen(source), true);
});

test('preparation canonicalizes the parent while refusing a symbolic-link source', async t => {
  const { dir, file } = await fixture(t);
  const parentLink = join(dir, 'linked-parent');
  await symlink(dir, parentLink);
  assert.equal((await readLibraryUploadSource(join(parentLink, 'source.txt'))).source.path, file);
  const sourceLink = join(dir, 'linked.txt');
  await symlink(file, sourceLink);
  await assert.rejects(readLibraryUploadSource(sourceLink), { code: 'INVALID_FILE' });
});

test('all existing extension MIME mappings and explicit overrides are preserved', async t => {
  const { dir } = await fixture(t);
  const mappings = { txt:'text/plain', md:'text/markdown', csv:'text/csv', tsv:'text/tab-separated-values', json:'application/json', pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml', zip:'application/zip', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  for (const [extension, expected] of Object.entries(mappings)) {
    const file = join(dir, `test.${extension.toUpperCase()}`);
    await writeFile(file, 'x');
    const { source } = await readLibraryUploadSource(file);
    assert.equal(source.mimeType, expected);
    assert.equal(source.mimeResolutionSource, 'filename_extension');
  }
  const unknown = join(dir, 'unknown.custom');
  await writeFile(unknown, 'x');
  assert.equal((await readLibraryUploadSource(unknown)).source.mimeType, 'application/octet-stream');
  const { source } = await readLibraryUploadSource(unknown, { mimeType: 'application/vnd.custom+json' });
  assert.equal(source.mimeType, 'application/vnd.custom+json');
  assert.equal(source.mimeResolutionSource, 'declared_mime');
});

test('invalid MIME strings and unsafe or excessive filenames fail before opening the source', async t => {
  const { dir, file } = await fixture(t);
  for (const mimeType of ['', 'text/plain; charset=utf-8', 'text/plain\n', 'text/plain/extra', 'text/' + 'x'.repeat(201), null, 7]) {
    // null is the existing inferred-MIME behavior; all other supplied values must obey the grammar.
    if (mimeType === null) continue;
    await assert.rejects(readLibraryUploadSource(file, { mimeType }), { code: 'INVALID_ARGUMENT' });
  }
  for (const name of ['bad\\name.txt', 'bad\nname.txt', 'x'.repeat(241)])
    await assert.rejects(readLibraryUploadSource(join(dir, name)), { code: 'INVALID_ARGUMENT' });
});

test('empty, nonregular, missing, and larger-than-512MiB sources are rejected without scanning', async t => {
  const { dir } = await fixture(t);
  const empty = join(dir, 'empty'), oversized = join(dir, 'large.bin');
  await writeFile(empty, ''); await writeFile(oversized, ''); await truncate(oversized, 512 * MiB + 1);
  let reads = 0;
  await withReads(oversized, async function (original, args) { reads++; return original.apply(this, args); }, async () => {
    for (const file of [empty, oversized, dir, join(dir, 'missing')])
      await assert.rejects(readLibraryUploadSource(file), { code: 'INVALID_FILE' });
  });
  assert.equal(reads, 0);
  const single = join(dir, 'single'); await writeFile(single, 'x');
  assert.equal((await readLibraryUploadSource(single)).source.sizeBytes, 1);
});

test('source hashing uses at most 1MiB allocations and handles partial filesystem reads', async t => {
  const bytes = Buffer.alloc(3 * MiB + 17, 91), { file } = await fixture(t, { bytes });
  let reads = 0;
  const result = await trackAllocation(() => withReads(file, async function (original, args) {
    reads++; args[2] = Math.min(args[2], 64 * 1024); return original.apply(this, args);
  }, () => readLibraryUploadSource(file)));
  assert.equal(result.value.source.sha256, hash(bytes));
  assert.ok(result.max <= MiB);
  assert.ok(reads > 4);
});

test('source changes and early EOF during hashing fail instead of returning a descriptor', async t => {
  for (const operation of ['rewrite', 'truncate']) {
    const { file } = await fixture(t, { bytes: Buffer.alloc(2 * MiB, 91) });
    let changed = false;
    await withReads(file, async function (original, args) {
      const result = await original.apply(this, args);
      if (!changed) { changed = true; if (operation === 'rewrite') await writeFile(file, Buffer.alloc(2 * MiB, 90)); else await truncate(file, MiB); }
      return result;
    }, () => assert.rejects(readLibraryUploadSource(file), { code: 'FILE_CHANGED' }));
  }
});

test('preparation respects cancellation before opening and during scanning', async t => {
  const { file } = await fixture(t, { bytes: Buffer.alloc(2 * MiB, 91) });
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled before opening'));
  await assert.rejects(readLibraryUploadSource(file, { signal: cancelled.signal }), /cancelled before opening/u);
  const controller = new AbortController();
  await withReads(file, async function (original, args) {
    const result = await original.apply(this, args); controller.abort(new Error('cancelled during scan')); return result;
  }, () => assert.rejects(readLibraryUploadSource(file, { signal: controller.signal }), /cancelled during scan/u));
});

test('verified slices preserve exact bytes across chunk boundaries, including the final byte', async t => {
  const bytes = Buffer.alloc(3 * MiB + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const { file } = await fixture(t, { bytes });
  const { source } = await readLibraryUploadSource(file);
  for (const [start, endExclusive] of [[0, 1], [MiB - 11, 2 * MiB + 13], [bytes.length - 1, bytes.length], [0, bytes.length]])
    assert.deepEqual(await readVerifiedUploadSlice(source, { start, endExclusive }), bytes.subarray(start, endExclusive));
});

test('invalid descriptors and invalid or larger-than-16MiB slices fail before reading', async t => {
  const { file } = await fixture(t);
  await truncate(file, 17 * MiB);
  const { source } = await readLibraryUploadSource(file);
  for (const bounds of [{}, { start: -1, endExclusive: 1 }, { start: 1, endExclusive: 1 }, { start: 2, endExclusive: 1 },
    { start: 0.5, endExclusive: 1 }, { start: 0, endExclusive: Infinity }, { start: 0, endExclusive: source.sizeBytes + 1 },
    { start: 0, endExclusive: 16 * MiB + 1 }])
    await assert.rejects(readVerifiedUploadSlice(source, bounds), { code: 'INVALID_ARGUMENT' });
  for (const value of [null, [], {}, { ...source, sha256: 'bad' }, { ...source, path: 'relative.txt' }, { ...source, ino: '-1' }])
    await assert.rejects(readVerifiedUploadSlice(value, { start: 0, endExclusive: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('file-backed ranges permit large parts while retaining only one chunk and hash the exact range', async t => {
  const { file } = await fixture(t);
  await truncate(file, 20 * MiB + 17);
  const { source } = await readLibraryUploadSource(file);
  const start = MiB - 1, endExclusive = source.sizeBytes - 7;
  const result = await trackAllocation(() => prepareVerifiedUploadRange(source, { start, endExclusive }));
  assert.equal(result.value.source, source);
  assert.equal(result.value.offset, start);
  assert.equal(result.value.length, endExclusive - start);
  assert.equal(result.value.sha256, hash((await readFile(file)).subarray(start, endExclusive)));
  assert.equal(Object.isFrozen(result.value), true);
  assert.ok(result.max <= MiB);
  await assert.rejects(prepareVerifiedUploadRange(source, { start: 0, endExclusive: source.sizeBytes + 1 }), { code: 'INVALID_ARGUMENT' });
});

test('the exact 512MiB source and 16MiB slice limits are accepted with bounded reads', async t => {
  const { file } = await fixture(t);
  await truncate(file, 512 * MiB);
  let largestRead = 0;
  const prepared = await trackAllocation(() => withReads(file, async function (original, args) {
    largestRead = Math.max(largestRead, args[2]); return original.apply(this, args);
  }, () => readLibraryUploadSource(file)));
  assert.equal(prepared.value.source.sizeBytes, 512 * MiB);
  assert.ok(prepared.max <= MiB);
  assert.ok(largestRead <= MiB);
  const bytes = await readVerifiedUploadSlice(prepared.value.source, { start: 496 * MiB, endExclusive: 512 * MiB });
  assert.equal(bytes.length, 16 * MiB);
  assert.equal(bytes.every(byte => byte === 0), true);
});

test('source replacement, modification, and a later source symlink cannot supply upload slices', async t => {
  for (const operation of ['replace', 'rewrite', 'symlink']) {
    const { file, dir, bytes } = await fixture(t);
    const { source } = await readLibraryUploadSource(file);
    if (operation === 'replace') { await rename(file, join(dir, 'old')); await writeFile(file, bytes); }
    else if (operation === 'rewrite') await writeFile(file, Buffer.alloc(bytes.length, 90));
    else { await rename(file, join(dir, 'old')); await symlink(join(dir, 'old'), file); }
    await assert.rejects(readVerifiedUploadSlice(source, { start: 0, endExclusive: 1 }), { code: 'FILE_CHANGED' });
  }
});

test('chunk verification still detects modified bytes when metadata appears unchanged', async t => {
  const { file, bytes } = await fixture(t);
  const originalStat = await stat(file), { source } = await readLibraryUploadSource(file);
  await writeFile(file, Buffer.alloc(bytes.length, 90));
  await withFixedStat(file, originalStat, () => assert.rejects(readVerifiedUploadSlice(source, { start: 0, endExclusive: 1 }), { code: 'FILE_CHANGED' }));
});

test('serialized descriptors receive one complete SHA check and then reuse bounded chunk proofs', async t => {
  const { file } = await fixture(t, { bytes: Buffer.alloc(3 * MiB, 91) });
  const serialized = JSON.parse(JSON.stringify((await readLibraryUploadSource(file)).source));
  const counts = [];
  let total = 0;
  await withReads(file, async function (original, args) {
    const result = await original.apply(this, args); total += result.bytesRead; return result;
  }, async () => {
    await readVerifiedUploadSlice(serialized, { start: 1, endExclusive: 2 }); counts.push(total);
    await readVerifiedUploadSlice(serialized, { start: MiB + 1, endExclusive: MiB + 2 }); counts.push(total);
  });
  assert.deepEqual(counts, [4 * MiB, 5 * MiB]);
  serialized.sha256 = '0'.repeat(64);
  await assert.rejects(readVerifiedUploadSlice(serialized, { start: 0, endExclusive: 1 }), { code: 'FILE_CHANGED' });
});

test('an unproved descriptor with an incorrect complete-file hash is rejected', async t => {
  const { file } = await fixture(t);
  const { source } = await readLibraryUploadSource(file);
  await assert.rejects(readVerifiedUploadSlice({ ...source, sha256: '0'.repeat(64) }, { start: 0, endExclusive: 1 }), { code: 'FILE_CHANGED' });
});

test('ranges prepared from serialized sources retain an immutable verified identity', async t => {
  const { file } = await fixture(t);
  const serialized = JSON.parse(JSON.stringify((await readLibraryUploadSource(file)).source));
  const result = await prepareVerifiedUploadRange(serialized, { start: 0, endExclusive: serialized.sizeBytes });
  assert.equal(Object.isFrozen(result.source), true);
  assert.notEqual(result.source, serialized);
  serialized.path = '/different-source.txt';
  assert.equal(result.source.path, file);
  assert.equal(result.sha256, result.source.sha256);
});

test('a serialized descriptor changed during verification is rejected', async t => {
  const { file } = await fixture(t);
  const serialized = JSON.parse(JSON.stringify((await readLibraryUploadSource(file)).source));
  let modified = false;
  await withReads(file, async function (original, args) {
    const result = await original.apply(this, args);
    if (!modified) { modified = true; serialized.path = '/different-source.txt'; }
    return result;
  }, () => assert.rejects(prepareVerifiedUploadRange(serialized, { start: 0, endExclusive: serialized.sizeBytes }), { code: 'FILE_CHANGED' }));
});

test('range verification detects changes during reading and honors cancellation', async t => {
  const { file, bytes } = await fixture(t, { bytes: Buffer.alloc(2 * MiB, 91) });
  const { source } = await readLibraryUploadSource(file);
  let modified = false;
  await withReads(file, async function (original, args) {
    const result = await original.apply(this, args);
    if (!modified) { modified = true; await writeFile(file, bytes); }
    return result;
  }, () => assert.rejects(prepareVerifiedUploadRange(source, { start: 0, endExclusive: source.sizeBytes }), { code: 'FILE_CHANGED' }));
  const current = (await readLibraryUploadSource(file)).source;
  const controller = new AbortController();
  await withReads(file, async function (original, args) {
    const result = await original.apply(this, args); controller.abort(new Error('cancelled slice')); return result;
  }, () => assert.rejects(readVerifiedUploadSlice(current, { start: 0, endExclusive: 1, signal: controller.signal }), /cancelled slice/u));
});
