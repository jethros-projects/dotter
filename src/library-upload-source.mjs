import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DotError } from './errors.mjs';

const MAX_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_SLICE_BYTES = 16 * 1024 * 1024;
const TYPES = { '.txt':'text/plain', '.md':'text/markdown', '.csv':'text/csv', '.tsv':'text/tab-separated-values', '.json':'application/json', '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.zip':'application/zip', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
// Retain only small chunk hashes, never the complete file or an open descriptor.
// A resumed, deserialized source earns the same proof with one complete scan.
const proofs = new WeakMap();
const SOURCE_FIELDS = ['path', 'name', 'mimeType', 'mimeResolutionSource', 'sizeBytes', 'sha256', 'dev', 'ino', 'mtimeMs', 'ctimeMs'];
const fail = (code, message) => { throw new DotError(code, message); };
const changed = () => fail('FILE_CHANGED', 'The Library upload source changed; prepare it again before uploading.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checkAbort = signal => signal?.throwIfAborted();

function plain(value, label, limit = 8192) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/u.test(value))
    fail('INVALID_ARGUMENT', `${label} must be bounded text without control characters.`);
  return value;
}

function mime(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[\w.+-]+\/[\w.+-]+$/u.test(value))
    fail('INVALID_ARGUMENT', 'mimeType must be a supported MIME type.');
  return value;
}

function filename(value) {
  plain(value, 'filename', 240);
  if (/[\\/]/u.test(value)) fail('INVALID_ARGUMENT', 'Use a plain source filename.');
  return value;
}

function snapshot(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('INVALID_ARGUMENT', 'A prepared Library upload source is required.');
  const value = Object.fromEntries(SOURCE_FIELDS.map(key => [key, source[key]]));
  plain(value.path, 'source path');
  filename(value.name);
  mime(value.mimeType);
  if (resolve(value.path) !== value.path || basename(value.path) !== value.name
    || !['filename_extension', 'declared_mime'].includes(value.mimeResolutionSource)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || typeof value.dev !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value.dev)
    || typeof value.ino !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value.ino)
    || !Number.isFinite(value.mtimeMs) || !Number.isFinite(value.ctimeMs))
    fail('INVALID_ARGUMENT', 'The prepared Library upload source is invalid.');
  return Object.freeze(value);
}

function sameSource(left, right) {
  return SOURCE_FIELDS.every(key => left[key] === right[key]);
}

function sameStat(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function matchesSource(stat, source) {
  return stat.isFile() && String(stat.dev) === source.dev && String(stat.ino) === source.ino
    && stat.size === source.sizeBytes && stat.mtimeMs === source.mtimeMs && stat.ctimeMs === source.ctimeMs;
}

async function readExact(handle, buffer, offset, length, position, signal) {
  let read = 0;
  while (read < length) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(buffer, offset + read, length - read, position + read);
    checkAbort(signal);
    if (!bytesRead) changed();
    read += bytesRead;
  }
}

async function scan(handle, size, signal) {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
  const hash = createHash('sha256'), chunks = [];
  for (let position = 0; position < size; position += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, size - position);
    await readExact(handle, buffer, 0, length, position, signal);
    const bytes = buffer.subarray(0, length);
    hash.update(bytes);
    chunks.push(digest(bytes));
  }
  checkAbort(signal);
  return { sha256: hash.digest('hex'), chunks };
}

/** Prepare a native Library upload without retaining the file's contents. */
export async function readLibraryUploadSource(file, { mimeType, signal } = {}) {
  checkAbort(signal);
  plain(file, 'file');
  const requested = resolve(file), name = filename(basename(requested));
  const known = TYPES[extname(name).toLowerCase()];
  const resolvedMime = mime(mimeType ?? known ?? 'application/octet-stream');
  let handle;
  try {
    const path = join(await realpath(dirname(requested)), name);
    checkAbort(signal);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES)
      fail('INVALID_FILE', 'The Library upload source must be a regular file of 1 byte to 512 MiB.');
    const proof = await scan(handle, before.size, signal);
    const after = await handle.stat();
    checkAbort(signal);
    if (!sameStat(before, after)) changed();
    const source = Object.freeze({ path, name, mimeType: resolvedMime,
      mimeResolutionSource: mimeType === undefined && known ? 'filename_extension' : 'declared_mime',
      sizeBytes: before.size, sha256: proof.sha256, dev: String(before.dev), ino: String(before.ino),
      mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
    proofs.set(source, { source, chunks: proof.chunks });
    return { source };
  } catch (error) {
    if (error instanceof DotError || signal?.aborted) throw error;
    fail('INVALID_FILE', 'Cannot read the Library upload source; symbolic links are not supported.');
  } finally { await handle?.close(); }
}

function range(source, start, endExclusive, maxBytes) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0
    || endExclusive <= start || endExclusive > source.sizeBytes || endExclusive - start > maxBytes)
    fail('INVALID_ARGUMENT', maxBytes === MAX_SLICE_BYTES
      ? 'The upload slice must be within the source and contain 1 byte to 16 MiB.'
      : 'The upload range must be nonempty and within the source.');
  return { start, endExclusive, length: endExclusive - start };
}

async function verifiedRange(source, { start, endExclusive, signal }, retainBytes) {
  checkAbort(signal);
  const expected = snapshot(source);
  const bounds = range(expected, start, endExclusive, retainBytes ? MAX_SLICE_BYTES : MAX_BYTES);
  let proof = proofs.get(source), handle;
  if (proof && !sameSource(proof.source, expected)) changed();
  try {
    handle = await open(expected.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!matchesSource(before, expected)) changed();
    if (!proof) {
      const scanned = await scan(handle, expected.sizeBytes, signal);
      if (scanned.sha256 !== expected.sha256 || !matchesSource(await handle.stat(), expected)) changed();
      proof = { source: expected, chunks: scanned.chunks };
      proofs.set(source, proof);
    }
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, expected.sizeBytes));
    const bytes = retainBytes ? Buffer.allocUnsafe(bounds.length) : undefined;
    const hash = createHash('sha256');
    for (let position = Math.floor(start / CHUNK_BYTES) * CHUNK_BYTES; position < endExclusive; position += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, expected.sizeBytes - position);
      await readExact(handle, buffer, 0, length, position, signal);
      const chunk = buffer.subarray(0, length);
      if (digest(chunk) !== proof.chunks[position / CHUNK_BYTES]) changed();
      const from = Math.max(start, position), to = Math.min(endExclusive, position + length);
      const selected = chunk.subarray(from - position, to - position);
      hash.update(selected);
      if (bytes) selected.copy(bytes, from - start);
    }
    const after = await handle.stat();
    checkAbort(signal);
    if (!sameStat(before, after) || !matchesSource(after, expected) || !sameSource(expected, source)) changed();
    return { source: proof.source, bytes, sha256: hash.digest('hex'), bounds };
  } catch (error) {
    if (error instanceof DotError || signal?.aborted) throw error;
    changed();
  } finally { await handle?.close(); }
}

/** Return a small verified slice; multipart blocks can instead use a file-backed range. */
export async function readVerifiedUploadSlice(source, { start, endExclusive, signal } = {}) {
  return (await verifiedRange(source, { start, endExclusive, signal }, true)).bytes;
}

/** Verify and hash a range for file-backed transport, retaining at most one chunk. */
export async function prepareVerifiedUploadRange(source, { start, endExclusive, signal } = {}) {
  const result = await verifiedRange(source, { start, endExclusive, signal }, false);
  return Object.freeze({ source: result.source, offset: start, length: result.bounds.length, sha256: result.sha256 });
}
