import { constants } from 'node:fs';
import { open, lstat, realpath, link, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// These routes and the multipart field come from the installed Dot client.
// The app limits ordinary messaging attachments to 20 MiB.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,256}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const FILE_TYPES = new Map(Object.entries({
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip',
}));

function validId(value, kind = 'file') {
  if (typeof value !== 'string' || !ID.test(value)) throw new DotError('INVALID_ARGUMENT', `Use a ${kind} ID returned by Dot.`);
  return value;
}
function validName(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 240 || value === '.' || value === '..'
    || /[\x00-\x1f\x7f/\\]/u.test(value)) throw new DotError('INVALID_FILENAME', 'Use a plain filename without path separators or control characters, up to 240 bytes.');
  return value;
}
function text(value, max = 4096) { return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : undefined; }
function size(value) { return Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function mime(value) { return typeof value === 'string' && value.length <= 200 && MIME.test(value) ? value.toLowerCase() : undefined; }
async function room(client, roomId, signal) { return validId(await client.resolveRoom(roomId, signal), 'room'); }
function throwIfAborted(signal) { signal?.throwIfAborted(); }

function publicFile(data, fallback = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new DotError('INVALID_RESPONSE', 'Dot returned an invalid file response.');
  const fileId = data.id ?? data.file_id ?? fallback.fileId;
  if (typeof fileId !== 'string' || !ID.test(fileId)) throw new DotError('INVALID_RESPONSE', 'Dot returned an invalid file ID.');
  const name = data.name == null ? fallback.name : validName(data.name);
  return { fileId,
    ...(typeof data.library_file_id === 'string' && /^[A-Za-z0-9_.:~-]{1,1024}$/.test(data.library_file_id) ? { libraryFileId: data.library_file_id } : {}),
    ...(name == null ? {} : { name }),
    ...(mime(data.mime_type) ?? fallback.mimeType ? { mimeType: mime(data.mime_type) ?? fallback.mimeType } : {}),
    ...((size(data.size_bytes) ?? fallback.sizeBytes) == null ? {} : { sizeBytes: size(data.size_bytes) ?? fallback.sizeBytes }),
    ...(text(data.status, 100) ? { status: data.status } : {}) };
}

async function readUpload(file, signal) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new DotError('INVALID_ARGUMENT', 'Provide the path of a local file to upload.');
  const name = validName(basename(file));
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new DotError('INVALID_FILE', 'The upload source must be a regular file.');
    if (before.size < 1 || before.size > MAX_UPLOAD_BYTES) throw new DotError('FILE_SIZE', 'Dot attachments must contain 1 byte to 20 MiB.');
    throwIfAborted(signal);
    // Read a bounded buffer: a source growing during the read cannot exhaust memory.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw new DotError('FILE_CHANGED', 'The source file changed while it was being read. Retry with a stable file.');
    return { name, mimeType: FILE_TYPES.get(extname(name).toLowerCase()) ?? 'application/octet-stream', bytes: bytes.subarray(0, offset) };
  } catch (error) {
    if (error instanceof DotError || signal?.aborted) throw error;
    if (error.code === 'ELOOP') throw new DotError('INVALID_FILE', 'The upload source must not be a symbolic link.');
    throw new DotError('FILE_READ_FAILED', 'Could not read the local upload file.');
  } finally { await handle?.close(); }
}

export async function uploadFile(client, { roomId, file, name, mimeType, signal } = {}) {
  if (name !== undefined) validName(name);
  if (mimeType !== undefined && mime(mimeType) === undefined) throw new DotError('INVALID_ARGUMENT', 'mimeType must be a MIME media type.');
  const payload = await readUpload(file, signal);
  if (name !== undefined) payload.name = name;
  if (mimeType !== undefined) payload.mimeType = mimeType;
  if (typeof client.transport.requestMultipart !== 'function') throw new DotError('UNSUPPORTED_TRANSPORT', 'The transport does not support multipart file uploads.');
  roomId = await room(client, roomId, signal);
  const data = await client.transport.requestMultipart('POST', `/backend-api/messaging/rooms/${roomId}/files`, { file: payload, signal });
  const result = publicFile(data, { name: payload.name, mimeType: payload.mimeType, sizeBytes: payload.bytes.length });
  return { roomId, ...result,
    attachment: { type: 'file', file_id: result.fileId, name: result.name, mime_type: result.mimeType,
      size_bytes: result.sizeBytes, ...(result.status ? { status: result.status } : {}) } };
}

// Do not permit arbitrary URLs returned in account data to turn this into an
// SSRF client. The exact file host is present in the installed client; the
// authenticated estuary routes are the only same-origin binary paths it uses.
export function fileDownloadTarget(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/u.test(value) || /%0[ad]/i.test(value)) throw new DotError('UNSAFE_DOWNLOAD_URL', 'Dot returned an unsafe file download URL.');
  let url;
  try { url = new URL(value, 'https://chatgpt.com'); } catch { throw new DotError('UNSAFE_DOWNLOAD_URL', 'Dot returned an invalid file download URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new DotError('UNSAFE_DOWNLOAD_URL', 'Only verified HTTPS file downloads are supported.');
  if (url.hostname === 'chatgpt.com'
    && /^\/backend-api\/estuary\/(?:content\/?|public_content\/enc\/[^/]+)$/u.test(url.pathname)) {
    return { kind: 'authenticated', route: url.pathname, query: Object.fromEntries(url.searchParams) };
  }
  // Library inline notes return a signed first-party content_download URL.
  // Accept only its observed route and query contract; never follow redirects.
  if (url.hostname === 'chatgpt.com' && url.pathname === '/backend-api/files/library/content_download') {
    const allowed = new Set(['library_file_id', 'inline', 'owner_id', 'drive_id', 'ts', 'p', 'sig', 'v']);
    const keys = [...url.searchParams.keys()];
    if (!/^[A-Za-z0-9_.:~-]{1,1024}$/.test(url.searchParams.get('library_file_id') ?? '')
      || !url.searchParams.get('sig') || keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length) {
      throw new DotError('UNSAFE_DOWNLOAD_URL', 'The Library content URL has an unverified query contract.');
    }
    return { kind: 'authenticated', route: url.pathname, query: Object.fromEntries(url.searchParams) };
  }
  if (url.hostname === 'files.oaiusercontent.com') return { kind: 'signed', url: url.href };
  if (/^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname) && /^\/files\/[A-Za-z0-9_-]{1,1024}\/raw$/.test(url.pathname)) {
    const keys = [...url.searchParams.keys()];
    const allowed = new Set(['se', 'sp', 'sv', 'sr', 'scid', 'skoid', 'sktid', 'skt', 'ske', 'sks', 'skv', 'sig']);
    if (['se', 'sp', 'sv', 'sr', 'sig'].every(key => Boolean(url.searchParams.get(key)))
      && url.searchParams.get('sp').includes('r') && url.searchParams.get('sr') === 'b'
      && keys.every(key => allowed.has(key)) && new Set(keys).size === keys.length) return { kind: 'signed', url: url.href };
  }
  throw new DotError('UNSAFE_DOWNLOAD_URL', 'The file download host or route is not verified for this CLI.');
}

async function currentTarget(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new DotError('UNSAFE_OUTPUT', 'The download destination must be a regular file, never a symbolic link.');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function outputPath(output, fileName, overwrite) {
  if (output !== undefined && (typeof output !== 'string' || !output || /\0/u.test(output))) throw new DotError('INVALID_ARGUMENT', 'Provide a valid output file path.');
  const requested = resolve(output ?? validName(fileName));
  // Canonicalize an existing parent once. Do not implicitly create directories.
  let parent;
  try { parent = await realpath(dirname(requested)); } catch { throw new DotError('INVALID_OUTPUT', 'The output directory does not exist or cannot be accessed.'); }
  const path = join(parent, validName(basename(requested)));
  const existing = await currentTarget(path);
  if (existing && !overwrite) throw new DotError('OUTPUT_EXISTS', 'The output file already exists. Use --overwrite to replace it.');
  return { path, existing };
}

async function atomicSave(destination, bytes, overwrite, signal) {
  const temp = join(dirname(destination.path), `.dot-download-${randomUUID()}.part`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(bytes, { signal });
    await handle.sync();
    await handle.close(); handle = null;
    throwIfAborted(signal);
    if (!overwrite) {
      // A hard-link publish is atomic and fails if anything appeared at the
      // destination, including a symlink, after the initial existence check.
      await link(temp, destination.path);
    } else {
      const current = await currentTarget(destination.path);
      throwIfAborted(signal);
      if (destination.existing && (!current || current.dev !== destination.existing.dev || current.ino !== destination.existing.ino)
        || !destination.existing && current) throw new DotError('OUTPUT_CHANGED', 'The destination changed while the file was downloading; it was not replaced.');
      await rename(temp, destination.path);
    }
  } catch (error) {
    if (error instanceof DotError || signal?.aborted) throw error;
    if (error.code === 'EEXIST') throw new DotError('OUTPUT_EXISTS', 'The output file appeared while downloading; it was not replaced.');
    throw new DotError('FILE_WRITE_FAILED', 'Could not save the downloaded file.');
  } finally { await handle?.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function downloadFile(client, { roomId, fileId, output, overwrite = false, signal } = {}) {
  validId(fileId);
  if (typeof overwrite !== 'boolean') throw new DotError('INVALID_ARGUMENT', 'Overwrite must be true or false.');
  roomId = await room(client, roomId, signal);
  const metadata = await client.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/files/${fileId}`, { signal });
  const result = publicFile(metadata, { fileId, name: fileId });
  if (result.fileId !== fileId) throw new DotError('INVALID_RESPONSE', 'The download metadata returned a different file ID.');
  if (result.sizeBytes > MAX_DOWNLOAD_BYTES) throw new DotError('FILE_SIZE', 'This download exceeds the 100 MiB safety limit.');
  const target = fileDownloadTarget(metadata.download_url);
  const destination = await outputPath(output, result.name ?? fileId, overwrite);
  throwIfAborted(signal);
  let bytes;
  if (target.kind === 'authenticated') {
    if (typeof client.transport.requestBytes !== 'function') throw new DotError('UNSUPPORTED_TRANSPORT', 'The transport does not support binary file downloads.');
    bytes = await client.transport.requestBytes('GET', target.route, { query: target.query, signal, maxBytes: MAX_DOWNLOAD_BYTES });
  } else {
    if (typeof client.transport.fetchSigned !== 'function') throw new DotError('UNSUPPORTED_TRANSPORT', 'The transport does not support signed file downloads.');
    bytes = await client.transport.fetchSigned(target.url, { signal, maxBytes: MAX_DOWNLOAD_BYTES });
  }
  if (!(bytes instanceof Uint8Array)) throw new DotError('INVALID_RESPONSE', 'The download transport did not return file bytes.');
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new DotError('FILE_SIZE', 'This download exceeds the 100 MiB safety limit.');
  if (result.sizeBytes != null && bytes.byteLength !== result.sizeBytes) throw new DotError('FILE_SIZE_MISMATCH', 'The downloaded size differs from the file metadata. No file was saved.');
  await atomicSave(destination, bytes, overwrite, signal);
  return { roomId, ...result, sizeBytes: bytes.byteLength, path: destination.path };
}

function artifact(attachment, message) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return null;
  const type = text(attachment.type, 100) ?? 'unknown';
  const fileId = attachment.fileId ?? attachment.file_id;
  const result = { messageId: message.id, createdAt: message.createdAt ?? null, type,
    ...(typeof fileId === 'string' && ID.test(fileId) ? { fileId } : {}) };
  for (const key of ['name', 'title', 'description', 'status', 'postId', 'conversationId', 'threadId']) {
    const value = text(attachment[key]); if (value !== undefined) result[key] = value;
  }
  const mimeType = mime(attachment.mimeType ?? attachment.mime_type ?? attachment.mime);
  if (mimeType) result.mimeType = mimeType;
  const sizeBytes = size(attachment.sizeBytes ?? attachment.size_bytes);
  if (sizeBytes !== undefined) result.sizeBytes = sizeBytes;
  for (const key of ['width', 'height']) if (size(attachment[key]) !== undefined) result[key] = attachment[key];
  return result;
}

export async function listArtifacts(client, { roomId, pages = 10, signal } = {}) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new DotError('INVALID_ARGUMENT', 'Artifact pages must be an integer from 1 to 100.');
  roomId = await room(client, roomId, signal);
  const artifacts = [], seen = new Set(), cursors = new Set();
  let before, pagesRead = 0;
  for (; pagesRead < pages; pagesRead++) {
    throwIfAborted(signal);
    const batch = await client.history({ roomId, limit: 20, before, signal });
    if (!Array.isArray(batch.messages)) throw new DotError('INVALID_RESPONSE', 'The history response did not contain messages.');
    for (const message of batch.messages) {
      if (typeof message?.id !== 'string' || !Array.isArray(message.attachments)) continue;
      for (const attachment of message.attachments) {
        const item = artifact(attachment, message); if (!item) continue;
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); artifacts.push(item); }
      }
    }
    before = batch.prevCursor;
    if (!before) { pagesRead++; break; }
    if (typeof before !== 'string' || before.length > 16384 || cursors.has(before)) throw new DotError('CURSOR_LOOP', 'The API returned an invalid or repeated history cursor.');
    cursors.add(before);
  }
  return { roomId, artifacts, pagesRead, nextCursor: before ?? null, truncated: Boolean(before) };
}
