import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { DotError } from './errors.mjs';

// Locks are recoverable only with a verified local owner whose process is gone.
// Age is deliberately irrelevant. Unknown locks and interrupted recovery guards
// are retained because their owners cannot be proved absent safely.
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
async function boundedRead(handle, limit) {
  const buffer = Buffer.alloc(limit + 1); let length = 0;
  while (length < buffer.length) { const value = await handle.read(buffer, length, buffer.length - length, length); if (value.bytesRead === 0) break; length += value.bytesRead; }
  return buffer.subarray(0, length);
}
function lockRecord() {
  return { version: 1, token: randomUUID(), host: hostname(), pid: process.pid,
    uid: process.getuid?.() ?? null };
}
async function releaseLock(file, owner) {
  try {
    const current = await lstat(file), held = await owner.handle.stat();
    if (current.isFile() && !current.isSymbolicLink() && current.dev === held.dev && current.ino === held.ino) await unlink(file);
  } catch { /* A changed lock is not ours to remove. */ }
  finally { await owner.handle.close(); }
}
async function createLock(file) {
  const handle = await open(file, 'wx', 0o600), value = lockRecord();
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); return { handle, value }; }
  catch (error) { await releaseLock(file, { handle, value }); throw error; }
}
async function readLock(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.mode & 0o077 || before.size < 2 || before.size > 4096 || process.getuid && before.uid !== process.getuid()) return null;
    const bytes = await boundedRead(handle, 4096), after = await handle.stat();
    if (bytes.length > 4096 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
    if (!record(value) || value.version !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.token ?? '') || value.host !== hostname()
      || value.uid !== (process.getuid?.() ?? null) || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    return { value, info: after };
  } catch (error) { if (error.code === 'ENOENT') return undefined; return null; }
  finally { await handle?.close(); }
}
function ownerIsGone(value) {
  try { process.kill(value.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function acquireLock(file, { busyCode, failedCode, label }) {
  const busy = (message, details) => { throw new DotError(busyCode, message, details); };
  const failed = message => { throw new DotError(failedCode, message); };
  const guardFile = `${file}.recovery-lock`;
  try { await lstat(guardFile); busy('An interrupted or active lock recovery requires review. Read the operation state before continuing.', { lockFile: guardFile, recovery: 'guard_requires_review' }); }
  catch (error) { if (error instanceof DotError) throw error; if (error.code !== 'ENOENT') failed(`Could not inspect the ${label} lock. No mutation was sent.`); }
  try { return await createLock(file); }
  catch (error) { if (error.code !== 'EEXIST') failed(`Could not lock the ${label} file. No mutation was sent.`); }
  // Serialize the inspection and replacement of an abandoned owner lock. A
  // guard left by a second crash is deliberately not reclaimed by age or PID.
  let guard;
  try { guard = await createLock(guardFile); }
  catch (error) { if (error.code !== 'EEXIST') failed(`Could not lock the ${label} file for recovery. No mutation was sent.`); busy('Another process is recovering this operation lock.', { lockFile: guardFile, recovery: 'guard_requires_review' }); }
  try {
    const old = await readLock(file);
    if (old === null) busy('The existing operation lock has no verifiable local owner. Read the operation state; do not repeat a submission.', { lockFile: file, recovery: 'owner_unknown' });
    if (old !== undefined) {
      if (!ownerIsGone(old.value)) busy('The operation lock owner is still running or cannot be verified as stopped.', { lockFile: file, ownerPid: old.value.pid, recovery: 'owner_active_or_unknown' });
      const current = await lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== old.info.dev || current.ino !== old.info.ino) busy('The operation lock changed during recovery.', { lockFile: file, recovery: 'changed' });
      await unlink(file);
    }
    try { return await createLock(file); }
    catch { busy('The operation was claimed while its abandoned lock was being recovered.', { lockFile: file, recovery: 'changed' }); }
  } finally { await releaseLock(guardFile, guard); }
}
export async function withOperationLock(file, work, { busyCode = 'STATE_BUSY', failedCode = 'STATE_BUSY', label = 'operation' } = {}) {
  const owner = await acquireLock(`${file}.lock`, { busyCode, failedCode, label });
  try { return await work(file); } finally { await releaseLock(`${file}.lock`, owner); }
}
