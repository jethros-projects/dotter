import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { DotError } from '../errors.mjs';

const MAX_FILE = 512 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs];
const fileError = (code, started) => new DotError(code, code === 'FILE_CHANGED'
  ? 'The upload source changed; no further request was sent.'
  : 'The upload source could not be read as a verified regular file.', { delivery: started ? 'unknown' : 'not_sent' });

/** Keep one descriptor and one bounded chunk; validate before any network byte. */
export async function verifiedFile(value, { prefix, suffix, signal }) {
  let handle, started = false, original;
  let source;
  const abort = () => signal?.throwIfAborted();
  const changed = () => { throw fileError('FILE_CHANGED', started); };
  const check = async () => {
    abort();
    let current, named;
    try { current = await handle.stat({ bigint: true }); named = await lstat(source.path, { bigint: true }); }
    catch { changed(); }
    abort();
    const fields = identity(current);
    if (!current.isFile() || !named.isFile() || String(current.dev) !== source.dev || String(current.ino) !== source.ino
        || current.size !== BigInt(source.sizeBytes) || current.dev !== named.dev || current.ino !== named.ino
        || Math.abs(Number(current.mtimeNs) / 1000 - source.mtimeMs * 1000) > 1
        || Math.abs(Number(current.ctimeNs) / 1000 - source.ctimeMs * 1000) > 1
        || original && fields.some((part, index) => part !== original[index])) changed();
    original = fields;
  };
  async function* range() {
    const digest = createHash('sha256');
    let position = source.offset, remaining = source.length;
    while (remaining) {
      await check();
      const bytes = Buffer.allocUnsafe(Math.min(remaining, CHUNK_SIZE));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      if (!bytesRead) changed();
      abort();
      const chunk = bytes.subarray(0, bytesRead);
      digest.update(chunk); position += bytesRead; remaining -= bytesRead;
      await check();
      // Do not send even the final chunk when its range hash is incorrect.
      if (!remaining && digest.digest('hex') !== source.sha256) changed();
      yield chunk;
    }
  }
  try {
    abort();
    source = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    if (typeof source.path !== 'string' || !isAbsolute(source.path) || normalize(source.path) !== source.path
        || source.path.length > 8192 || /[\0\r\n]/.test(source.path)
        || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > MAX_FILE
        || !Number.isSafeInteger(source.offset) || source.offset < 0 || !Number.isSafeInteger(source.length) || source.length < 1
        || source.offset + source.length > source.sizeBytes || !['dev', 'ino'].every(key => typeof source[key] === 'string' && /^(?:0|[1-9]\d*)$/.test(source[key]))
        || !['mtimeMs', 'ctimeMs'].every(key => typeof source[key] === 'number' && Number.isFinite(source[key]))
        || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)
        || constants.O_NOFOLLOW === undefined || await realpath(dirname(source.path)) !== dirname(source.path)) throw fileError('INVALID_FILE', false);
    abort();
    handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    await check();
    for await (const _ of range()) { /* Verify the complete range before creating a request. */ }
    await check();
    return {
      length: prefix.length + source.length + suffix.length,
      start() { started = true; },
      async *chunks() {
        await check();
        if (prefix.length) yield prefix;
        yield* range();
        if (suffix.length) { await check(); yield suffix; }
        await check();
      },
      check,
      async close() { if (handle) { const current = handle; handle = undefined; await current.close(); } },
    };
  } catch (error) {
    await handle?.close();
    if (signal?.aborted) throw signal.reason;
    throw error instanceof DotError ? error : fileError('INVALID_FILE', false);
  }
}
