import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DotError } from './errors.mjs';
import { DotLifecycle } from './lifecycle.mjs';
import { DotLive } from './live.mjs';

// Contracts: native-room-ecbd2ba1aadf.js; cloud-aeon-onboarding-2e6570831113.js;
// app-initial-90eb42395b7d.js; state-7182cd8c4d4c.js. Inspected 2026-10-18.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an ID returned by the API.`);
  return value;
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label} must be true or false.`); return value; }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value, fields) => Object.fromEntries(fields.filter(key => value[key] === null || ['string', 'boolean', 'number'].includes(typeof value[key])).map(key => [key, value[key]]));
function hidden(value) { return value.hidden || value.is_hidden || value.is_visually_hidden_from_conversation || value.deleted_at != null || value.is_user_visible === false || value.metadata?.hidden || value.metadata?.is_hidden || value.metadata?.is_visually_hidden_from_conversation || value.channel != null && !['final', 'commentary'].includes(value.channel) || value.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel) || value.recipient != null && value.recipient !== 'all' || value.metadata?.recipient != null && value.metadata.recipient !== 'all'; }
function pointer(value) {
  if (typeof value !== 'string') throw new DotError('INVALID_RESPONSE', 'The reference photo response did not contain an asset pointer.');
  const fileId = /^sediment:\/\/(?:[^#]+#)?(file_[^#]+)#thumbnail$/.exec(value)?.[1];
  value = fileId == null ? value : `sediment://${fileId}`;
  if (!/^sediment:\/\/[^\s?#]+$/.test(value) || value.length > 4096) throw new DotError('INVALID_RESPONSE', 'The reference photo returned an unsupported asset pointer.');
  return value;
}
function photo(value, expectedId) {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id) || expectedId != null && value.id !== expectedId) throw new DotError('INVALID_RESPONSE', 'The reference photo response did not match its target.');
  const result = scalar(value, ['id', 'kind', 'created_at', 'updated_at']);
  // Current image tags use an ImageAssetPointer object; older responses used
  // the flat field. Project only the asset identity, not owner or image metadata.
  const nested = value.image_asset_pointer?.asset_pointer;
  if (nested != null || value.asset_pointer != null) {
    result.asset_pointer = pointer(nested ?? value.asset_pointer);
    if (nested != null && value.asset_pointer != null && pointer(value.asset_pointer) !== result.asset_pointer) throw new DotError('INVALID_RESPONSE', 'The reference photo returned inconsistent asset pointers.');
  }
  return result;
}
async function imageFile(file, signal) {
  if (typeof file !== 'string' || !file || file.includes('\0')) fail('Provide a local PNG, JPEG, or WebP reference photo.');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 8 || before.size > 20 * 1024 * 1024) throw new DotError('INVALID_FILE', 'Reference photos must be regular image files of at most 20 MiB.');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { signal?.throwIfAborted(); const next = await handle.read(bytes, length, bytes.length - length, length); if (!next.bytesRead) break; length += next.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DotError('FILE_CHANGED', 'The reference photo changed while it was being read.');
    const data = bytes.subarray(0, length);
    const type = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? ['png', 'image/png']
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? ['jpg', 'image/jpeg']
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? ['webp', 'image/webp'] : null;
    if (!type) throw new DotError('INVALID_FILE', 'Only PNG, JPEG, or WebP reference photos are supported.');
    return { name: `reference-photo.${type[0]}`, mimeType: type[1], bytes: data };
  } catch (error) { if (error instanceof DotError || signal?.aborted) throw error; throw new DotError('FILE_READ_FAILED', 'Could not read the reference photo as a regular non-symlink file.'); }
  finally { await handle?.close(); }
}

export class DotExtras {
  constructor(client) { this.client = client; this.transport = client.transport; this.lifecycle = new DotLifecycle(client); }
  async listThreads({ dotId, includeHidden = false, limit = 100, cursor, signal } = {}) {
    bool(includeHidden, 'includeHidden');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be from 1 to 100.');
    if (cursor != null && (typeof cursor !== 'string' || cursor.length > 8192 || /[\0\r\n]/.test(cursor))) fail('Use a valid cursor.');
    dotId = id(dotId ?? (await this.client.primary({ signal })).id, 'dotId');
    const value = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/threads`, { query: { limit, cursor, include_hidden: includeHidden }, signal });
    if (!object(value) || !Array.isArray(value.items)) throw new DotError('INVALID_RESPONSE', 'The thread response did not contain an items list.');
    return { items: value.items.filter(item => object(item) && (includeHidden || !hidden(item))).map(item => {
      const isHidden = Boolean(hidden(item));
      // Explicit hidden discovery exposes identity/status metadata, never title,
      // preview, model messages, or other content from a hidden thread.
      return { ...scalar(item, ['thread_id', 'kind', 'status', 'created_at', 'updated_at']), hidden: isHidden,
        ...(!isHidden ? scalar(item, ['title']) : {}) };
    }), cursor: typeof value.cursor === 'string' ? value.cursor : null, metadataOnly: includeHidden };
  }
  async avatar({ dotId, onlyIfDefault = false, ...options } = {}) {
    bool(onlyIfDefault, 'onlyIfDefault');
    if (!onlyIfDefault) return this.lifecycle.avatar({ dotId, ...options });
    if (typeof options.avatar !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(options.avatar) || options.name != null || options.avatarType != null || options.avatarManifest != null || options.avatarUrl != null) fail('onlyIfDefault requires a legacy avatar name without other appearance changes.');
    dotId = id(dotId ?? (await this.client.primary({ signal: options.signal })).id, 'dotId');
    const value = await this.transport.request('PATCH', `/backend-api/tbo/${encodeURIComponent(dotId)}`, { body: { avatar: options.avatar, only_if_default_avatar: true }, signal: options.signal });
    if (!object(value) || value.id !== dotId) throw new DotError('INVALID_RESPONSE', 'The conditional avatar response did not match its Dot.', { delivery: 'unknown' });
    return scalar(value, ['id', 'display_name', 'avatar', 'avatar_type']);
  }
  async recoverDeletions({ confirm = false, signal } = {}) {
    if (confirm !== true) fail('Pending deletion recovery requires confirm: true. It finalizes pending deletion; it does not restore deleted Dots.');
    await this.transport.request('POST', '/backend-api/tbo/deletion-recovery', { signal });
    return { status: 'deletion-recovery-requested' };
  }
  async setPrimaryThread({ threadId, signal } = {}) {
    id(threadId, 'threadId');
    const value = await this.transport.request('PUT', '/backend-api/cloud-aeons/primary', { body: { thread_id: threadId }, signal });
    if (!object(value) || !object(value.selection) || value.selection.thread_id !== threadId) throw new DotError('INVALID_RESPONSE', 'The primary selection did not match its requested thread.', { delivery: 'unknown' });
    return { selection: scalar(value.selection, ['thread_id', 'generation', 'selected_at', 'aeon_id', 'available', 'messaging_room_id']) };
  }
  async listReferencePhotos({ signal } = {}) {
    const value = await this.transport.request('GET', '/backend-api/images/image-tags', { signal });
    if (!object(value) || !Array.isArray(value.items)) throw new DotError('INVALID_RESPONSE', 'The reference photo response did not contain an items list.');
    return { items: value.items.map(item => photo(item)) };
  }
  async uploadReferencePhoto({ file, kind = 'self', signal } = {}) {
    if (!['self', 'full_body_likeness'].includes(kind)) fail('kind must be self or full_body_likeness.');
    return this.#saveReferencePhoto({ file, kind, signal });
  }
  async updateReferencePhoto({ file, imageTagId, signal } = {}) {
    id(imageTagId, 'imageTagId');
    return this.#saveReferencePhoto({ file, imageTagId, signal });
  }
  async #saveReferencePhoto({ file, kind, imageTagId, signal }) {
    const payload = await imageFile(file, signal);
    if (typeof this.transport.requestMultipart !== 'function') throw new DotError('UNSUPPORTED_TRANSPORT', 'The transport does not support reference photo uploads.');
    const context = await new DotLive(this.client).pinAccount();
    if (imageTagId != null) {
      const current = await context.transport.request('GET', '/backend-api/images/image-tags', { signal });
      if (!Array.isArray(current?.items) || !current.items.some(item => item.id === imageTagId)) throw new DotError('PHOTO_UNAVAILABLE', 'The reference photo is not in the current account.');
    }
    await context.assert();
    const uploaded = await context.transport.requestMultipart('POST', '/backend-api/calpico/chatgpt/profile_files', { file: payload, signal });
    const assetPointer = pointer(uploaded.asset_pointer);
    await context.assert(); signal?.throwIfAborted();
    const result = await context.transport.request(imageTagId == null ? 'POST' : 'PATCH', imageTagId == null ? '/backend-api/images/image-tags' : `/backend-api/images/image-tags/${encodeURIComponent(imageTagId)}`, { body: imageTagId == null ? { kind, asset_pointer: assetPointer } : { asset_pointer: assetPointer }, signal });
    return photo(result, imageTagId);
  }
  async removeReferencePhoto({ imageTagId, confirmImageTagId, signal } = {}) {
    id(imageTagId, 'imageTagId');
    if (confirmImageTagId !== imageTagId) fail('confirmImageTagId must exactly match imageTagId.');
    await this.transport.request('DELETE', `/backend-api/images/image-tags/${encodeURIComponent(imageTagId)}`, { signal });
    return { imageTagId, status: 'deletion-requested' };
  }
}
