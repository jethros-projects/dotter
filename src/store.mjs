import { open, lstat, realpath, link, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

export async function readPrivateJson(file, maxBytes = 65536) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new DotError('INVALID_STATE', 'The state file is not a small regular file.');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof DotError) throw error;
    throw new DotError('INVALID_STATE', 'Could not read the JSON state file.');
  } finally { await handle?.close(); }
}

export async function writePrivate(file, content, { overwrite = false, signal } = {}) {
  signal?.throwIfAborted();
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new DotError('INVALID_OUTPUT', 'Choose an output file.');
  if (typeof content !== 'string' && !ArrayBuffer.isView(content)) throw new DotError('INVALID_ARGUMENT', 'File content must be a string or a byte view.');
  const requested = resolve(file), parent = await realpath(dirname(requested)).catch(() => null);
  signal?.throwIfAborted();
  if (!parent) throw new DotError('INVALID_OUTPUT', 'The output directory does not exist.');
  const target = join(parent, basename(requested));
  let before;
  try { before = await lstat(target); } catch (error) { signal?.throwIfAborted(); if (error.code !== 'ENOENT') throw new DotError('INVALID_OUTPUT', 'Cannot inspect the output path.'); }
  signal?.throwIfAborted();
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new DotError('INVALID_OUTPUT', 'The output must be a regular file, not a symbolic link.');
  if (before && !overwrite) throw new DotError('OUTPUT_EXISTS', 'The output already exists. Use --overwrite explicitly.');
  const temp = join(parent, `.dot-cli-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600); signal?.throwIfAborted();
    await handle.writeFile(content, { signal }); signal?.throwIfAborted();
    await handle.sync(); signal?.throwIfAborted(); await handle.close(); handle = null;
    signal?.throwIfAborted();
    if (!overwrite) await link(temp, target);
    else {
      let current; try { current = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      signal?.throwIfAborted();
      if (current?.isSymbolicLink() || current && !current.isFile() || before && (!current || before.ino !== current.ino || before.dev !== current.dev) || !before && current) {
        throw new DotError('OUTPUT_CHANGED', 'The output changed while preparing the write.');
      }
      await rename(temp, target);
    }
    // The atomic publish is the commit point. Cancellation after it must not
    // report a failed write when the requested file already exists.
    return target;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof DotError) throw error;
    throw new DotError(error.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'WRITE_FAILED', 'The file could not be saved safely.');
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
