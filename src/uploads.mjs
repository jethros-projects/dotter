import { constants } from 'node:fs';
import { open, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { MAX_UPLOAD_BYTES } from './files.mjs';
import { readPrivateJson, writePrivate } from './store.mjs';

const ID = /^[a-zA-Z0-9_-]{1,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASES = new Set(['prepared', 'reserving', 'reserved', 'completing', 'ready']);
const FILE_TYPES = new Map(Object.entries({
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip',
}));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validStatus = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/u.test(value);
function failResponse() { throw new DotError('INVALID_RESPONSE', 'Dot returned invalid or inconsistent upload information. The saved upload was retained.'); }
function abort(signal) { signal?.throwIfAborted(); }

async function statePath(file) {
  if (typeof file !== 'string' || !file || /\0/u.test(file)) throw new DotError('INVALID_ARGUMENT', 'Provide an explicit upload state file.');
  const requested = resolve(file);
  const parent = await realpath(dirname(requested)).catch(() => null);
  if (!parent) throw new DotError('INVALID_OUTPUT', 'The upload state directory must already exist.');
  return join(parent, basename(requested));
}

async function lockState(file) {
  const path = `${file}.lock`;
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const identity = await handle.stat();
    return async () => {
      await handle.close();
      try {
        const current = await lstat(path);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  } catch (error) {
    await handle?.close();
    if (error.code === 'EEXIST') throw new DotError('STATE_LOCKED', 'This upload state is locked. Wait for the active upload; after an interrupted process, remove its .lock file only after confirming it has stopped.');
    throw new DotError('STATE_WRITE_FAILED', 'Could not lock the upload state file.');
  }
}

async function sourceFile(file, signal) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new DotError('INVALID_ARGUMENT', 'Provide the path of a local file to upload.');
  const name = basename(file);
  if (!name || Buffer.byteLength(name) > 240 || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/u.test(name)) {
    throw new DotError('INVALID_FILENAME', 'Use a plain filename without separators or control characters, up to 240 bytes.');
  }
  let handle;
  try {
    const requested = resolve(file), parent = await realpath(dirname(requested));
    const path = join(parent, name);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new DotError('INVALID_FILE', 'The upload source must be a regular file.');
    if (before.size < 1 || before.size > MAX_UPLOAD_BYTES) throw new DotError('FILE_SIZE', 'Dot attachments must contain 1 byte to 20 MiB.');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new DotError('FILE_CHANGED', 'The upload source changed while it was being read.');
    }
    abort(signal);
    const contents = bytes.subarray(0, offset), mimeType = FILE_TYPES.get(extname(name).toLowerCase()) ?? 'application/octet-stream';
    return { bytes: contents, source: { path, name, mimeType, sizeBytes: offset, sha256: createHash('sha256').update(contents).digest('hex'),
      dev: String(before.dev), ino: String(before.ino), mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs } };
  } catch (error) {
    if (error instanceof DotError || signal?.aborted) throw error;
    if (error.code === 'ELOOP') throw new DotError('INVALID_FILE', 'The upload source must not be a symbolic link.');
    throw new DotError('FILE_READ_FAILED', 'Could not read the local upload file.');
  } finally { await handle?.close(); }
}

function checkState(state, source, roomId) {
  if (!object(state) || state.version !== 1 || state.kind !== 'dot-recoverable-upload' || !UUID.test(state.uploadId ?? '')
    || !PHASES.has(state.phase) || !object(state.source) || !(state.fileId === null || typeof state.fileId === 'string' && ID.test(state.fileId))
    || state.fileStatus !== null && !validStatus(state.fileStatus)
    || state.expiresAt !== null && (typeof state.expiresAt !== 'string' || !Number.isFinite(Date.parse(state.expiresAt)))
    || ['reserved', 'completing', 'ready'].includes(state.phase) && state.fileId === null) {
    throw new DotError('INVALID_STATE', 'The upload state file has an invalid format.');
  }
  if (state.roomId !== roomId) throw new DotError('UPLOAD_SCOPE_MISMATCH', 'This upload state belongs to a different Dot room. Use its original room or a new state file.');
  if (Object.keys(source).some(key => state.source[key] !== source[key])) {
    throw new DotError('UPLOAD_SOURCE_MISMATCH', 'This upload state belongs to a different or changed source file. Use its original file or a new state file.');
  }
  // Copy only known fields so external state content is never forwarded to Dot.
  return { version: 1, kind: 'dot-recoverable-upload', uploadId: state.uploadId, phase: state.phase, roomId, source,
    fileId: state.fileId, fileStatus: state.fileStatus, expiresAt: state.expiresAt };
}

function inspectResponse(data, state, { reservation = true } = {}) {
  if (!object(data) || typeof data.id !== 'string' || !ID.test(data.id) || state.fileId !== null && state.fileId !== data.id) failResponse();
  if (data.upload_id != null && data.upload_id !== state.uploadId || data.content_sha256 != null && data.content_sha256 !== state.source.sha256
    || data.name != null && data.name !== state.source.name || data.mime_type != null && data.mime_type !== state.source.mimeType
    || data.size_bytes != null && data.size_bytes !== state.source.sizeBytes) failResponse();
  if (reservation && !validStatus(data.status) || data.status != null && !validStatus(data.status)) failResponse();
  if (data.expires_at != null && (typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at)))) failResponse();
  return { fileId: data.id, status: data.status ?? 'ready', expiresAt: data.expires_at ?? null };
}

function uploadResult(state, file) {
  const status = state.fileStatus ?? 'ready';
  return { roomId: state.roomId, fileId: state.fileId, name: state.source.name, mimeType: state.source.mimeType,
    sizeBytes: state.source.sizeBytes, status, uploadId: state.uploadId, stateFile: file,
    attachment: { type: 'file', file_id: state.fileId, name: state.source.name, mime_type: state.source.mimeType,
      size_bytes: state.source.sizeBytes, status } };
}

/** Native whole-file reservation protocol. A failed write is never retried in the same invocation. */
export async function uploadRecoverable(client, { file, roomId, stateFile, signal } = {}) {
  abort(signal);
  const path = await statePath(stateFile);
  const release = await lockState(path);
  try {
    const payload = await sourceFile(file, signal);
    if (payload.source.path === path || payload.source.path === `${path}.lock`) throw new DotError('INVALID_ARGUMENT', 'The source and upload state must be separate files.');
    if (typeof client.transport?.requestMultipart !== 'function') throw new DotError('UNSUPPORTED_TRANSPORT', 'The transport does not support multipart file uploads.');
    roomId = await client.resolveRoom(roomId, signal);
    if (typeof roomId !== 'string' || !ID.test(roomId)) throw new DotError('INVALID_ARGUMENT', 'Use a room ID returned by Dot.');
    const previous = await readPrivateJson(path);
    let state = previous ? checkState(previous, payload.source, roomId) : { version: 1, kind: 'dot-recoverable-upload',
      roomId, source: payload.source, uploadId: randomUUID(), phase: 'prepared', fileId: null, fileStatus: null, expiresAt: null };
    const save = async () => { abort(signal); await writePrivate(path, `${JSON.stringify(state, null, 2)}\n`, { overwrite: true }); };
    if (!previous) await writePrivate(path, `${JSON.stringify(state, null, 2)}\n`);
    const route = `/backend-api/messaging/rooms/${roomId}/files/uploads`;
    const reserve = async () => {
      state.phase = 'reserving'; await save();
      const response = inspectResponse(await client.transport.request('POST', route, { signal, body: {
        upload_id: state.uploadId, name: state.source.name, mime_type: state.source.mimeType, content_sha256: state.source.sha256,
      } }), state);
      if (response.status === 'expired') failResponse();
      state = { ...state, fileId: response.fileId, fileStatus: response.status, expiresAt: response.expiresAt,
        phase: response.status === 'ready' ? 'ready' : 'reserved' };
      await save();
    };
    if (state.phase === 'prepared') await reserve();
    else {
      let response;
      try { response = inspectResponse(await client.transport.request('GET', `${route}/${state.uploadId}`, { signal }), state); }
      catch (error) {
        // The native client re-reserves a non-ready upload only on confirmed absence or expiry.
        if (!(error instanceof DotError && error.code === 'HTTP_ERROR' && error.details?.status === 404 && error.details?.deliveryUnknown !== true && error.details?.delivery !== 'unknown' && state.phase !== 'ready')) throw error;
      }
      if (!response || response.status === 'expired') await reserve();
      else {
        state = { ...state, fileId: response.fileId, fileStatus: response.status, expiresAt: response.expiresAt,
          phase: response.status === 'ready' ? 'ready' : 'reserved' };
        await save();
      }
    }
    if (state.phase !== 'ready') {
      state.phase = 'completing'; await save();
      const response = inspectResponse(await client.transport.requestMultipart('POST', `${route}/${state.uploadId}/complete`, {
        file: { name: payload.source.name, mimeType: payload.source.mimeType, bytes: payload.bytes }, signal,
      }), state, { reservation: false });
      if (response.status === 'expired') failResponse();
      state = { ...state, phase: 'ready', fileStatus: response.status, expiresAt: response.expiresAt };
      await save();
    }
    return uploadResult(state, path);
  } finally { await release(); }
}
