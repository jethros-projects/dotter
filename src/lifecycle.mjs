import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { DotError } from './errors.mjs';

// Installed client contracts inspected on 2026-10-17: app-initial,
// cloud-aeon-onboarding, save-character, desktop-connection, last-frame,
// panel, reboot-dialog, side-panel, aeon-summary-panel-identity and page-2ac0.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an ID returned by the API.`);
  return value;
}
function text(value, label, max = 4096, empty = false) {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value) || (!empty && !value.trim())) fail(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without line breaks.`);
  return value;
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`${label} must be true or false.`); return value; }
function confirm(value, target, label) { if (value !== target) fail(`${label} must exactly match the target ID.`); }
function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object.`);
  return value;
}
function scalarFields(value, fields) {
  object(value, 'API response');
  return Object.fromEntries(fields.filter(key => own(value, key) && (value[key] == null || ['string', 'number', 'boolean'].includes(typeof value[key])))
    .map(key => [key, value[key]]));
}
function hidden(value) {
  return Boolean(value?.hidden || value?.is_hidden || value?.is_visually_hidden_from_conversation || value?.deleted_at
    || value?.metadata?.hidden || value?.metadata?.is_hidden || value?.metadata?.is_visually_hidden_from_conversation
    || (value?.channel != null && !['final', 'commentary'].includes(value.channel))
    || (value?.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel))
    || (value?.recipient != null && value.recipient !== 'all') || (value?.metadata?.recipient != null && value.metadata.recipient !== 'all'));
}
function profile(value, expectedId) {
  object(value, 'Dot response');
  if (typeof value.id !== 'string' || !ID.test(value.id)) throw new DotError('INVALID_RESPONSE', 'The Dot response did not contain an ID. Check dots before retrying a write.', { delivery: 'unknown' });
  if (expectedId != null && value.id !== expectedId) throw new DotError('INVALID_RESPONSE', 'The Dot response did not match the requested Dot. Check the profile before retrying the write.', { delivery: 'unknown' });
  const stringOrNull = item => typeof item === 'string' ? item : null;
  return { id: value.id, name: stringOrNull(value.display_name), roomId: stringOrNull(value.messaging_room_id),
    threadId: stringOrNull(value.active_root_thread_id ?? value.root_thread_id), kind: stringOrNull(value.aeon_kind),
    status: stringOrNull(value.status), avatar: stringOrNull(value.avatar), avatarType: stringOrNull(value.avatar_type) };
}
function selection(value) {
  object(value, 'primary selection response');
  if (value.selection === null) return { selection: null };
  return { selection: scalarFields(object(value.selection, 'primary selection'), ['thread_id', 'generation', 'selected_at', 'aeon_id', 'available', 'messaging_room_id']) };
}
function snapshot(value) {
  object(value, 'avatar snapshot');
  if (value.schema_version !== 1 || typeof value.asset_pointer !== 'string'
    || !/^(?:sediment|file-service):\/\/[^\s?#]+$/.test(value.asset_pointer)) {
    throw new DotError('INVALID_RESPONSE', 'The avatar snapshot did not contain the expected asset pointer.');
  }
  return { schema_version: 1, asset_pointer: value.asset_pointer };
}
function jsonObject(value, label, max = 64 * 1024) {
  object(value, label);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(`${label} must contain JSON values.`); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > max) fail(`${label} exceeds the supported size.`);
  let count = 0;
  function check(item, depth = 0) {
    if (++count > 10000 || depth > 12) fail(`${label} is too deeply nested.`);
    if (item && typeof item === 'object') for (const [key, field] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} contains an unsupported field.`);
      check(field, depth + 1);
    }
    else if (typeof item === 'number' && !Number.isFinite(item)) fail(`${label} contains a non-finite number.`);
    else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) fail(`${label} must contain JSON values.`);
  }
  check(value);
  return JSON.parse(serialized);
}
function manifest(value, type, requireSnapshot = true) {
  value = jsonObject(value, 'avatarManifest');
  if (type === 'codex-pet') {
    id(value.pet_id, 'avatarManifest.pet_id');
    return { pet_id: value.pet_id, ...(value.snapshot == null ? {} : { snapshot: snapshot(value.snapshot) }) };
  }
  if (value.schema_version !== 1 || typeof value.resource_bundle_id !== 'string' || !/^[a-f0-9]{64}$/i.test(value.resource_bundle_id)) fail('A rendered avatar manifest requires schema_version 1 and its resource_bundle_id SHA-256.');
  const result = { schema_version: 1, resource_bundle_id: value.resource_bundle_id, appearance: jsonObject(value.appearance, 'avatarManifest.appearance', 16384) };
  if (requireSnapshot || value.snapshot != null) result.snapshot = snapshot(value.snapshot);
  return result;
}
function appearance(options) {
  const result = {};
  if (options.avatar != null) {
    if (options.avatarType != null || options.avatarManifest != null || options.avatarUrl != null) fail('Use either a legacy avatar name or avatarType/avatarManifest.');
    if (typeof options.avatar !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(options.avatar)) fail('avatar must be a legacy avatar name, such as default.');
    result.avatar = options.avatar;
  } else if (options.avatarType != null || options.avatarManifest != null || options.avatarUrl != null) {
    if (!['codex-pet', 'rendered-interactive'].includes(options.avatarType)) fail('avatarType must be codex-pet or rendered-interactive.');
    result.avatar_type = options.avatarType;
    result.avatar_manifest = manifest(options.avatarManifest, options.avatarType);
    if (options.avatarUrl != null) {
      const expected = result.avatar_manifest.snapshot?.asset_pointer;
      if (options.avatarType !== 'codex-pet' || options.avatarUrl !== expected) fail('avatarUrl must equal the uploaded pet snapshot asset_pointer.');
      result.avatar_url = expected;
    } else if (options.avatarType === 'codex-pet' && result.avatar_manifest.snapshot) result.avatar_url = result.avatar_manifest.snapshot.asset_pointer;
  }
  return result;
}
function visibleActivity(value) {
  if (hidden(value)) return null;
  const result = scalarFields(value, ['thread_id', 'parent_thread_id', 'title', 'emoji', 'status', 'outcome', 'created_at', 'updated_at']);
  if (value.preview != null && !hidden(value.preview)) {
    const preview = scalarFields(value.preview, ['turn_id', 'text']);
    if (preview.text?.trim() === '::SKIP_COMPLETION::') delete preview.text;
    result.preview = preview;
  }
  return result;
}
function reviewHash(dotId, explanation) { return createHash('sha256').update(JSON.stringify({ dotId, explanation })).digest('hex'); }
function workflow(value) {
  const result = scalarFields(value, ['status', 'workflow_id', 'schedule_id']);
  for (const field of ['schedule_url', 'workflow_url']) {
    try {
      const url = new URL(value[field]);
      if (url.protocol === 'https:' && !url.username && !url.password && ![...url.searchParams.keys()].some(key => /token|key|secret|signature/i.test(key))) result[field] = url.href;
    } catch { /* An omitted link cannot become an arbitrary browser action. */ }
  }
  return result;
}

export class DotLifecycle {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotLifecycle requires a DotClient.');
    this.client = client; this.transport = client.transport;
  }
  async resolveDot(dotId, signal) {
    return id(dotId ?? (await this.client.primary({ signal })).id, 'dotId');
  }
  async target({ dotId, threadId, signal } = {}) {
    dotId = await this.resolveDot(dotId, signal);
    if (threadId != null) id(threadId, 'threadId');
    const current = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}`, { signal });
    if (current.id !== dotId) throw new DotError('IDENTITY_MISMATCH', 'The returned Dot does not match the requested target.');
    const active = current.active_root_thread_id ?? current.root_thread_id;
    id(active, 'active root thread');
    if (threadId != null && active !== threadId) throw new DotError('STALE_TARGET', 'The selected thread is no longer this Dot’s active root thread. Refresh the profile before proceeding.');
    return { dotId, threadId: active, current };
  }
  async create({ name = '', createThread = true, createAdditional = true, shouldInitialize = true, signal, ...options } = {}) {
    const body = { display_name: text(name, 'name', 100, true).trim(), ...appearance(options),
      create_thread: bool(createThread, 'createThread'), create_additional: bool(createAdditional, 'createAdditional'), should_initialize: bool(shouldInitialize, 'shouldInitialize') };
    const result = await this.transport.request('POST', '/backend-api/tbo', { body, signal });
    return profile(result);
  }
  async remove({ dotId, confirmDotId, signal } = {}) {
    id(dotId, 'dotId'); confirm(confirmDotId, dotId, 'confirmDotId');
    await this.transport.request('DELETE', `/backend-api/tbo/${encodeURIComponent(dotId)}`, { signal });
    return { dotId, status: 'deletion-requested' };
  }
  async setPrimary({ dotId, signal } = {}) {
    id(dotId, 'dotId');
    return selection(await this.transport.request('PUT', '/backend-api/tbo/primary', { body: { tbo_id: dotId }, signal }));
  }
  async clearPrimary({ generation, confirm: confirmed, signal } = {}) {
    text(generation, 'generation', 1024); if (confirmed !== true) fail('Clearing the primary Dot requires confirm: true.');
    return selection(await this.transport.request('DELETE', '/backend-api/tbo/primary', { query: { generation }, signal }));
  }
  async avatar({ dotId, name, signal, ...options } = {}) {
    const body = appearance(options);
    // The native pet workflow has a distinct mutation contract (app-initial
    // offset 3112496). /tbo remains the route for legacy/rendered appearances.
    const pet = body.avatar_type === 'codex-pet';
    if (pet && (!body.avatar_url || !body.avatar_manifest?.snapshot)) fail('A pet avatar update requires its uploaded snapshot and asset pointer.');
    if (pet && name != null) fail('Rename the Dot separately before updating a pet avatar.');
    if (name != null) body.display_name = text(name, 'name', 100).trim();
    if (!Object.keys(body).length) fail('Provide an avatar or a name to update.');
    dotId = await this.resolveDot(dotId, signal);
    const route = pet ? `/backend-api/cloud-aeons/${encodeURIComponent(dotId)}` : `/backend-api/tbo/${encodeURIComponent(dotId)}`;
    return profile(await this.transport.request('PATCH', route, { body, signal }), dotId);
  }
  async uploadAvatarSnapshot({ file, avatarManifest, signal } = {}) {
    text(file, 'file', 32768);
    const validatedManifest = avatarManifest == null ? undefined : manifest(avatarManifest, 'rendered-interactive', false);
    let handle, bytes;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile() || before.size < 8 || before.size > 20 * 1024 * 1024) throw new DotError('INVALID_FILE', 'An avatar snapshot must be a PNG file of at most 20 MiB.');
      bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { signal?.throwIfAborted(); const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat();
      if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new DotError('FILE_CHANGED', 'The avatar file changed during the read.');
      bytes = bytes.subarray(0, count);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new DotError('INVALID_FILE', 'The avatar snapshot must be a PNG.');
    } catch (error) {
      if (error instanceof DotError || signal?.aborted) throw error;
      throw new DotError('FILE_READ_FAILED', 'The avatar file could not be read as a regular non-symlink file.');
    } finally { await handle?.close(); }
    const boundary = `dot-cli-avatar-${randomUUID()}`;
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`), bytes];
    if (validatedManifest) chunks.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="avatar_manifest"\r\n\r\n${JSON.stringify(validatedManifest)}`));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const response = await this.transport.request('POST', '/backend-api/cloud-aeons/avatar-snapshots', { bodyBytes: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}`, signal });
    return { snapshot: snapshot(response.snapshot), ...(validatedManifest ? { avatarManifest: { ...validatedManifest, snapshot: snapshot(response.snapshot) } } : {}) };
  }
  async ensureRoom({ dotId, signal } = {}) {
    dotId = await this.resolveDot(dotId, signal);
    const response = await this.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/messaging-room`, { signal });
    const roomId = response.messaging_room_id;
    if (typeof roomId !== 'string') throw new DotError('INVALID_RESPONSE', 'The API did not confirm a messaging room. Check the Dot profile before retrying.', { delivery: 'unknown', dotId });
    return { dotId, roomId: id(roomId, 'messaging room') };
  }
  async rootThread({ dotId, signal } = {}) {
    dotId = await this.resolveDot(dotId, signal);
    const response = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/root-thread`, { signal });
    return { dotId, threadId: response.root_thread_id == null ? null : id(response.root_thread_id, 'root thread') };
  }
  async reboot({ dotId, confirmDotId, signal } = {}) {
    id(dotId, 'dotId'); confirm(confirmDotId, dotId, 'confirmDotId');
    const primary = await this.client.primary({ signal });
    if (primary.id !== dotId) throw new DotError('PRIMARY_MISMATCH', 'Reboot only supports the current primary Dot. The primary selection has changed.');
    await this.transport.request('POST', '/backend-api/cloud-aeons/primary/reboot', { signal, responseType: 'bytes' });
    return { dotId, status: 'reboot-requested' };
  }
  async environmentStatus(options = {}) {
    const { dotId, threadId } = await this.target(options);
    const response = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/environment/status`, { query: { thread_id: threadId }, signal: options.signal });
    const result = scalarFields(response, ['environmentId', 'status']);
    result.capabilities = Array.isArray(response.capabilities) ? response.capabilities.filter(value => !hidden(value)).map(value => scalarFields(value, ['type', 'status'])) : [];
    return { dotId, threadId, ...result };
  }
  async recreateEnvironment(options = {}) {
    id(options.dotId, 'dotId'); confirm(options.confirmDotId, options.dotId, 'confirmDotId');
    const { dotId, threadId } = await this.target(options);
    await this.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/environment/recreate`, { query: { thread_id: threadId }, signal: options.signal });
    return { dotId, threadId, status: 'recreation-requested' };
  }
  async listComputers(options = {}) {
    const { dotId, threadId } = await this.target(options);
    const response = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/computers`, { query: { expected_thread_id: threadId }, signal: options.signal });
    if (response.thread_id !== threadId) throw new DotError('STALE_TARGET', 'The computer response belongs to a different root thread.');
    if (!Array.isArray(response.computers)) throw new DotError('INVALID_RESPONSE', 'The computer response did not contain a computers list.');
    return { dotId, threadId, computers: response.computers.filter(value => !hidden(value)).map(value => scalarFields(value, ['kind', 'environment_id', 'display_name', 'status', 'is_attached'])) };
  }
  async computer(action, options = {}) {
    if (!['connect', 'connect-and-replace', 'disconnect'].includes(action)) fail('Unsupported computer action.');
    const environmentId = id(options.environmentId, 'environmentId');
    if (action !== 'connect') confirm(options.confirmEnvironmentId, environmentId, 'confirmEnvironmentId');
    const { dotId, threadId } = await this.target(options);
    // Catalog membership and the expected thread protect against stale or invented targets.
    const catalog = await this.listComputers({ dotId, threadId, signal: options.signal });
    if (!catalog.computers.some(value => value.environment_id === environmentId && value.kind === 'user')) throw new DotError('COMPUTER_UNAVAILABLE', 'The requested user computer is not in this Dot’s current computer list.');
    await this.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/computers/${encodeURIComponent(environmentId)}/${action}`, { query: { expected_thread_id: threadId }, signal: options.signal });
    return { dotId, threadId, environmentId, status: `${action}-requested` };
  }
  connectComputer(options) { return this.computer('connect', options); }
  replaceComputer(options) { return this.computer('connect-and-replace', options); }
  disconnectComputer(options) { return this.computer('disconnect', options); }
  async activity({ dotId, limit = 5, cursor, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be an integer from 1 to 100.');
    if (cursor != null) text(cursor, 'cursor', 8192);
    dotId = await this.resolveDot(dotId, signal);
    const response = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/activity`, { query: { limit, cursor }, signal });
    if (!Array.isArray(response.data)) throw new DotError('INVALID_RESPONSE', 'The activity response did not contain a data list.');
    return { dotId, data: response.data.map(visibleActivity).filter(Boolean), nextCursor: typeof response.next_cursor === 'string' ? response.next_cursor : null };
  }
  async doctorCheckIn({ threadId, signal } = {}) {
    id(threadId, 'threadId');
    return workflow(await this.transport.request('POST', `/backend-api/cloud-aeons/by-thread/${encodeURIComponent(threadId)}/doctor/check-in`, { signal }));
  }
  async doctorSetup({ threadId, confirm: confirmed, signal } = {}) {
    id(threadId, 'threadId'); if (confirmed !== true) fail('Recurring doctor setup requires confirm: true.');
    return workflow(await this.transport.request('POST', `/backend-api/cloud-aeons/by-thread/${encodeURIComponent(threadId)}/doctor/setup`, { signal }));
  }
  async safetyReview({ dotId, signal } = {}) {
    dotId = await this.resolveDot(dotId, signal);
    const response = await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/misalignment-review`, { signal });
    const explanation = typeof response.detailed_explanation === 'string' ? response.detailed_explanation.trim() : null;
    return { dotId, explanation, reviewFingerprint: reviewHash(dotId, explanation) };
  }
  async resumeReviewed(options = {}) {
    id(options.dotId, 'dotId'); confirm(options.confirmDotId, options.dotId, 'confirmDotId');
    if (typeof options.reviewFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(options.reviewFingerprint)) fail('Provide the reviewFingerprint from an explicitly reviewed safety-review response.');
    const { dotId, threadId } = await this.target(options);
    const review = await this.safetyReview({ dotId, signal: options.signal });
    if (!review.explanation || review.reviewFingerprint !== options.reviewFingerprint) throw new DotError('REVIEW_CHANGED', 'The safety review is empty or has changed. Review the current finding before resuming.');
    const response = await this.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/runtime/resume`, { body: { clear_safety_flag: true }, signal: options.signal });
    if (response.status !== 'applied' || response.thread_id !== threadId) throw new DotError('RESUME_UNCONFIRMED', 'The API did not confirm continuation of the reviewed Dot and thread. Check the profile before retrying.', { delivery: 'unknown', dotId, threadId });
    return { dotId, threadId, status: 'applied' };
  }
}
