import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Transport } from './transport.mjs';
import { DotError } from './errors.mjs';
import { taskSubscriptionTopic } from './task-subscription.mjs';

export function validateRoom(roomId) {
  if (typeof roomId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(roomId)) throw new DotError('INVALID_ROOM', 'Use a room ID returned by dotter status or dotter dots.');
  return roomId;
}

export function validateMessageId(value, name = 'message ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.~:-]{1,1024}$/.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `Use a ${name} returned by the API.`);
  return value;
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) throw new DotError('INVALID_ARGUMENT', `${label} has unsupported fields or is not a JSON object.`);
}

function textField(value, label, { nullable = false, nonempty = false } = {}) {
  if (nullable && value == null) return value;
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && !value.length)) throw new DotError('INVALID_ARGUMENT', `${label} must be ${nonempty ? 'a nonempty' : 'a'} string without NUL bytes.`);
  return value;
}

// The installed app accepts only this schema for user-provided message metadata.
// Never pass arbitrary metadata through to a model or return server metadata raw.
export function validateSendContext({ taskId, replyTo, pageContext, messageMetadata, browserAnnotations } = {}) {
  if (taskId != null) validateMessageId(taskId, 'task ID');
  if (replyTo != null) validateMessageId(replyTo, 'reply message ID');
  if (pageContext !== undefined) {
    object(pageContext, ['page_id', 'thread_id'], 'pageContext');
    if (!Object.hasOwn(pageContext, 'page_id')) throw new DotError('INVALID_ARGUMENT', 'pageContext must include page_id.');
    if (pageContext.page_id !== null) validateMessageId(pageContext.page_id, 'page ID');
    if (Object.hasOwn(pageContext, 'thread_id')) {
      if (pageContext.page_id === null) throw new DotError('INVALID_ARGUMENT', 'A Page comment thread requires a non-null page_id.');
      validateMessageId(pageContext.thread_id, 'Page comment thread ID');
    }
  }
  if (browserAnnotations !== undefined && messageMetadata !== undefined) throw new DotError('INVALID_ARGUMENT', 'Supply browserAnnotations or messageMetadata, not both.');
  const metadata = browserAnnotations === undefined ? messageMetadata : { browser_annotations: browserAnnotations };
  if (metadata === undefined) return { ...(pageContext === undefined ? {} : { pageContext }), ...(taskId == null ? {} : { taskId }) };
  object(metadata, ['browser_annotations'], 'messageMetadata');
  const annotation = metadata.browser_annotations;
  object(annotation, ['version', 'context_file_id', 'annotations'], 'browser_annotations');
  if (annotation.version !== 1 || !Array.isArray(annotation.annotations) || !annotation.annotations.length) throw new DotError('INVALID_ARGUMENT', 'Browser annotations require version 1 and at least one annotation.');
  textField(annotation.context_file_id, 'context_file_id', { nonempty: true });
  for (const item of annotation.annotations) {
    object(item, ['comment', 'target_label', 'screenshot_file_id', 'browser_target_immediate_text', 'browser_target_element_type', 'browser_annotation_kind', 'attached_browser_region', 'design_tweak', 'browser_selections', 'design_tweak_changes'], 'Annotation');
    textField(item.comment, 'Annotation comment');
    for (const field of ['target_label', 'browser_target_immediate_text', 'browser_target_element_type']) if (field in item) textField(item[field], field, { nullable: true });
    if ('screenshot_file_id' in item) textField(item.screenshot_file_id, 'screenshot_file_id', { nullable: true, nonempty: true });
    if (item.browser_annotation_kind != null && !['element', 'region', 'virtual', 'text'].includes(item.browser_annotation_kind)) throw new DotError('INVALID_ARGUMENT', 'Unsupported browser annotation kind.');
    for (const field of ['attached_browser_region', 'design_tweak']) if (item[field] != null && typeof item[field] !== 'boolean') throw new DotError('INVALID_ARGUMENT', `${field} must be boolean or null.`);
    if (item.browser_selections != null) {
      if (!Array.isArray(item.browser_selections)) throw new DotError('INVALID_ARGUMENT', 'browser_selections must be an array or null.');
      for (const selection of item.browser_selections) {
        if (selection?.kind === 'element') {
          object(selection, ['kind', 'immediate_text', 'label', 'element_type'], 'Element selection');
          for (const field of ['immediate_text', 'label', 'element_type']) if (field in selection) textField(selection[field], field, { nullable: true });
        } else if (selection?.kind === 'region') {
          object(selection, ['kind', 'area_number', 'immediate_text', 'label', 'element_type'], 'Region selection');
          if (!Number.isSafeInteger(selection.area_number)) throw new DotError('INVALID_ARGUMENT', 'Region area_number must be an integer.');
          for (const field of ['immediate_text', 'label', 'element_type']) if (field in selection && selection[field] !== null) throw new DotError('INVALID_ARGUMENT', `Region ${field} must be null when supplied.`);
        } else throw new DotError('INVALID_ARGUMENT', 'Unsupported browser selection kind.');
      }
    }
    if (item.design_tweak_changes != null) {
      if (!Array.isArray(item.design_tweak_changes)) throw new DotError('INVALID_ARGUMENT', 'design_tweak_changes must be an array or null.');
      for (const change of item.design_tweak_changes) {
        object(change, ['property', 'previous_value', 'next_value'], 'Design change');
        textField(change.property, 'Design property');
        for (const field of ['previous_value', 'next_value']) {
          const value = change[field];
          if (field === 'previous_value' && value == null) continue;
          if (!['string', 'boolean', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.includes('\0'))) throw new DotError('INVALID_ARGUMENT', `${field} must be a string, finite number, or boolean.`);
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16384) throw new DotError('INVALID_ARGUMENT', 'Browser annotation metadata cannot exceed 16 KiB.');
  return { ...(pageContext === undefined ? {} : { pageContext }), ...(taskId == null ? {} : { taskId }), messageMetadata: JSON.parse(JSON.stringify(metadata)) };
}

function cursor(value, name) {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 4096 || /[\0\r\n]/.test(value))) throw new DotError('INVALID_ARGUMENT', `${name} must be a cursor returned by the API.`);
}

function messageDetails(item) {
  const result = {};
  for (const [source, dest] of [['task_id', 'taskId'], ['reply_root_message_id', 'replyRootMessageId'], ['request_id', 'requestId']]) if (typeof item[source] === 'string') result[dest] = item[source];
  const sender = item.sender || item.author;
  const senderId = item.account_user_id ?? sender?.account_user_id ?? sender?.id;
  if (typeof senderId === 'string') result.senderId = senderId;
  const senderName = item.sender_name ?? sender?.name ?? sender?.display_name;
  if (typeof senderName === 'string') result.senderName = senderName;
  if (typeof item.is_task_update === 'boolean') result.isTaskUpdate = item.is_task_update;
  const state = item.delivery_state ?? item.deliveryState;
  if (typeof state === 'string' && state) result.deliveryState = ['pending', 'failed'].includes(state) ? state : 'unknown';
  const error = item.delivery_error ?? item.deliveryError ?? item.deliveryErrorMessage;
  if (typeof error === 'string' && error) result.deliveryError = error;
  if (item.reactions && typeof item.reactions === 'object' && !Array.isArray(item.reactions)) {
    const grouped = new Map();
    for (const [accountUserId, emoji] of Object.entries(item.reactions)) if (accountUserId && typeof emoji === 'string' && emoji) grouped.set(emoji, [...(grouped.get(emoji) ?? []), accountUserId]);
    result.reactions = [...grouped].map(([emoji, accountUserIds]) => ({ emoji, count: accountUserIds.length, accountUserIds }));
  }
  return result;
}

function visibleText(content) {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  return Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string').join('') : '';
}

// Dot's native-room adapter keeps type:"call" cards separately from file
// attachments. Its history view reads call_id, duration_ms and outcome, then
// uses the visible message text/generation status as the shared call summary.
// Evidence: app-initial-90eb42395b7d.js SYc/M and F4; native-room-ecbd2ba1aadf.js
// Da/ja (installed bundle, 2026-10-18). Raw call transcripts, provider payloads,
// participant lists and artifact pointers have no established card contract.
function attachmentRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function privatePart(value) {
  if (!attachmentRecord(value)) return true;
  const metadata = attachmentRecord(value.metadata) ? value.metadata : {};
  return value.hidden === true || value.is_hidden === true || value.is_visually_hidden_from_conversation === true
    || metadata.hidden === true || metadata.is_hidden === true || metadata.is_visually_hidden_from_conversation === true
    || value.deleted_at != null || value.deletedAt != null
    || [value.channel, metadata.channel].some(channel => channel != null && !['final', 'commentary'].includes(channel))
    || [value.recipient, metadata.recipient].some(recipient => recipient != null && recipient !== 'all');
}
function attachmentText(value, max = 1024) {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
function attachmentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.~:-]{1,1024}$/.test(value) && !['.', '..'].includes(value) ? value : undefined;
}
function normalizeAttachment(attachment) {
  if (privatePart(attachment)) return null;
  const type = typeof attachment.type === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/.test(attachment.type) ? attachment.type : 'unknown';
  if (type === 'call') {
    const callId = attachmentId(attachment.call_id);
    if (callId === undefined) return null;
    const result = { type: 'call', callId };
    const duration = attachment.duration_ms;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER) result.durationMs = duration;
    // Preserve unknown future outcome names only as "unknown", never arbitrary
    // server strings or nested provider state in a public history record.
    if (attachment.outcome != null) result.outcome = ['completed', 'ended', 'failed', 'interrupted', 'not_connected'].includes(attachment.outcome) ? attachment.outcome : 'unknown';
    return result;
  }
  const nestedFile = attachmentRecord(attachment.file) && !privatePart(attachment.file) ? attachment.file : {};
  if (attachment.file != null && privatePart(attachment.file)) return null;
  const result = { type };
  for (const [target, values, validator] of [
    ['attachmentId', [attachment.attachment_id], attachmentId],
    ['fileId', [attachment.file_id, nestedFile.file_id, nestedFile.id], attachmentId],
    ['name', [attachment.name, nestedFile.name, nestedFile.file_name], attachmentText],
    ['mimeType', [attachment.mime_type, nestedFile.mime_type], value => typeof value === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : undefined],
    ['title', [attachment.title, nestedFile.title], attachmentText],
  ]) {
    const value = values.map(item => validator(item)).find(item => item !== undefined);
    if (value !== undefined) result[target] = value;
  }
  const size = [attachment.size_bytes, nestedFile.size_bytes].find(value => Number.isSafeInteger(value) && value >= 0);
  if (size !== undefined) result.sizeBytes = size;
  // These are IDs to open a referenced native artifact, never download URLs,
  // raw messages, executable widget data, or attachment contents.
  for (const [source, target] of [['post_id', 'postId'], ['conversation_id', 'conversationId'], ['thread_id', 'threadId']]) {
    const value = attachmentId(attachment[source]); if (value !== undefined) result[target] = value;
  }
  return result;
}

export function normalizeMessage(item, { assistantSenderIds } = {}) {
  if (!item || typeof item.id !== 'string' || privatePart(item) || item.content?.type === 'message_error') return null;
  if (item.metadata?.is_hidden || item.metadata?.hidden || item.metadata?.is_visually_hidden_from_conversation
    || item.is_hidden || item.hidden || item.is_visually_hidden_from_conversation) return null;
  if (item.channel && !['final', 'commentary'].includes(item.channel)) return null;
  if (item.recipient && item.recipient !== 'all') return null;
  let role = 'system', text = '', attachments = [];
  if (Array.isArray(item.raw_messages)) {
    role = 'assistant';
    text = item.raw_messages.filter(message => message?.author?.role === 'assistant' && !privatePart(message)
      && !message.metadata?.is_visually_hidden_from_conversation && !message.metadata?.is_hidden && !message.metadata?.hidden
      && !message.is_visually_hidden_from_conversation && !message.is_hidden && !message.hidden && message.deleted_at == null
      && (!message.channel || ['final', 'commentary'].includes(message.channel))
      && (!message.recipient || message.recipient === 'all')
      && ['text', 'multimodal_text'].includes(message.content?.content_type))
      .map(message => visibleText(message.content)).filter(text => text && text.trim() !== '::SKIP_COMPLETION::').join('\n\n');
    attachments = item.attachments || [];
  } else {
    role = typeof item.account_user_id === 'string' ? 'user' : ['user', 'assistant', 'system'].includes(item.role) ? item.role : 'system';
    // Current Dot replies can be ordinary user-shaped Calpico messages from
    // the room's AEON member. Classify only with verified room membership,
    // never a sender-ID prefix or another human's presence in the room.
    if (item.role === 'user' && assistantSenderIds?.has(item.account_user_id)) role = 'assistant';
    text = visibleText(item.content) || (typeof item.preview === 'string' ? item.preview : '');
    attachments = item.content?.attachments || [];
  }
  if (text.trim() === '::SKIP_COMPLETION::') return null;
  const files = Array.isArray(attachments) ? attachments.slice(0, 1000).map(normalizeAttachment).filter(Boolean) : [];
  if (!text && files.length === 0) return null;
  const calls = files.filter(attachment => attachment.type === 'call');
  return { id: item.id, role, text,
    createdAt: typeof item.created_at === 'string' ? item.created_at : null,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : null,
    replyTo: typeof item.reply_to?.message_id === 'string' ? item.reply_to.message_id : null,
    inProgress: item.generation?.status === 'in_progress', attachments: files,
    ...(calls.length ? { callHistory: { calls, summary: text, summarizing: item.generation?.status === 'in_progress' } } : {}), ...messageDetails(item) };
}

function sorted(messages) {
  return messages.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.id.localeCompare(b.id));
}

function profileSummary(profile) {
  return { id: profile.id ?? null, name: typeof profile.display_name === 'string' ? profile.display_name : 'Dot',
    roomId: profile.messaging_room_id ?? null, threadId: profile.active_root_thread_id ?? null, kind: profile.aeon_kind ?? null };
}

export class DotClient {
  constructor(options = {}) { this.transport = options.transport ?? new Transport(options); this.assistantSendersByRoom = new Map(); }
  async primary({ signal, expectedAccountId } = {}) {
    const data = await this.transport.request('GET', '/backend-api/tbo/primary', { signal, ...(expectedAccountId !== undefined ? { expectedAccountId } : {}) });
    const selection = data.selection;
    if (!selection?.available) throw new DotError('DOT_UNAVAILABLE', 'No available primary Dot was returned for this account. Open or set up your Dot in ChatGPT.');
    let profile = data.profile;
    if (!profile && !selection.messaging_room_id && selection.thread_id) {
      profile = await this.transport.request('GET', `/backend-api/tbo/by-thread/${encodeURIComponent(selection.thread_id)}`, { signal, ...(expectedAccountId !== undefined ? { expectedAccountId } : {}) });
    }
    const roomId = selection.messaging_room_id ?? profile?.messaging_room_id;
    if (!roomId) throw new DotError('ROOM_UNAVAILABLE', 'The primary Dot does not have a messaging room. Use --room with an ID from dotter dots.');
    return { ...(profile ? profileSummary(profile) : { id: selection.aeon_id ?? null, name: 'Dot' }),
      roomId: validateRoom(roomId), threadId: selection.thread_id ?? profile?.active_root_thread_id ?? null, available: true,
      ...(selection.generation !== undefined ? { generation: selection.generation } : {}) };
  }
  async resolveRoom(roomId, signal) { return roomId ? validateRoom(roomId) : (await this.primary({ signal })).roomId; }
  async listDots({ signal } = {}) {
    const dots = [], seen = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const data = await this.transport.request('GET', '/backend-api/tbo', { query: { limit: 25, include_room_preview: false, cursor }, signal });
      if (!Array.isArray(data.items)) throw new DotError('INVALID_RESPONSE', 'The Dot list response did not contain an items array.');
      dots.push(...data.items.map(profileSummary));
      if (!data.cursor) return dots;
      if (typeof data.cursor !== 'string' || seen.has(data.cursor)) throw new DotError('CURSOR_LOOP', 'The API repeated a Dot list cursor.');
      seen.add(data.cursor); cursor = data.cursor;
    }
    throw new DotError('PAGE_LIMIT', 'The Dot list exceeded 100 pages.');
  }
  async history({ roomId, limit = 20, before, after, replyRootMessageId, taskId, around, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || [before, after, around].filter(value => value !== undefined).length > 1) throw new DotError('INVALID_ARGUMENT', 'Use a limit from 1 to 20 and only one of before, after, or around.');
    cursor(before, 'before'); cursor(after, 'after');
    for (const [value, label] of [[around, 'message ID'], [replyRootMessageId, 'reply root message ID'], [taskId, 'task ID']]) if (value !== undefined) validateMessageId(value, label);
    roomId = await this.resolveRoom(roomId, signal);
    const query = { limit, before, after,
      ...(replyRootMessageId ? { reply_root_message_id: replyRootMessageId } : {}),
      ...(taskId ? { task_id: taskId } : {}), ...(around ? { around } : {}) };
    const data = await this.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/messages`, { query, signal });
    if (!Array.isArray(data.items)) throw new DotError('INVALID_RESPONSE', 'The history response did not contain an items array.');
    if (!this.assistantSendersByRoom.has(roomId) && data.items.some(item => item?.role === 'user' && typeof item.account_user_id === 'string')) await this.room({ roomId, signal });
    const assistantSenderIds = this.assistantSendersByRoom.get(roomId);
    const messages = sorted(data.items.map(item => {
      const message = normalizeMessage(item, { assistantSenderIds });
      // Preserve context without task IDs and normal hidden-row filtering, but
      // inspect the raw identity before normalization can omit malformed IDs.
      if (message && taskId !== undefined && item.task_id != null
          && (typeof item.task_id !== 'string' || item.task_id !== taskId)) {
        throw new DotError('IDENTITY_MISMATCH', 'The task history returned a message for a different task.');
      }
      return message;
    }).filter(Boolean));
    const dated = data.items.filter(item => typeof item?.id === 'string' && Number.isFinite(Date.parse(item.created_at)))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
    // Current room responses may omit cursor fields. The native adapter uses
    // message IDs as boundaries; a full page must not be mistaken for EOF.
    // Filtered task/reply/around feeds keep their server-provided cursors.
    const fullUnfilteredPage = data.items.length >= limit && taskId === undefined && replyRootMessageId === undefined && around === undefined;
    const firstBoundary = data.items[0]?.id;
    const lastBoundary = data.items.at(-1)?.id;
    return { roomId, messages,
      prevCursor: data.prev_cursor ?? (fullUnfilteredPage && typeof firstBoundary === 'string' ? firstBoundary : null),
      nextCursor: data.next_cursor ?? (fullUnfilteredPage && after !== undefined && typeof lastBoundary === 'string' ? lastBoundary : null),
      // Hidden records can advance pagination without exposing their content.
      lastItemId: data.items.at(-1)?.id ?? null,
      newestItemId: dated.at(-1)?.id ?? messages.at(-1)?.id ?? data.items.at(-1)?.id ?? null };
  }
  async send({ roomId, text = '', attachmentIds = [], replyTo, taskId, pageContext, messageMetadata, browserAnnotations, idempotencyKey = randomUUID(), signal } = {}) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new DotError('INVALID_FILE', 'Use up to ten file IDs returned by upload.');
    if (typeof text !== 'string' || (!text.trim() && !attachmentIds.length) || text.length > 64000 || text.includes('\0')) throw new DotError('INVALID_MESSAGE', 'Use text or attachments, with text at most 64,000 characters without NUL bytes.');
    const context = validateSendContext({ taskId, replyTo, pageContext, messageMetadata, browserAnnotations });
    if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new DotError('INVALID_KEY', 'The idempotency key must be a UUID.');
    roomId = await this.resolveRoom(roomId, signal);
    const body = { content: { text, ...(attachmentIds.length ? { attachments: attachmentIds.map(file_id => ({ type: 'file', file_id })) } : {}) }, request_id: idempotencyKey, idempotency_token: idempotencyKey, timezone_offset_min: new Date().getTimezoneOffset(),
      ...(replyTo ? { reply_to: { message_id: replyTo } } : {}), ...(context.taskId ? { task_id: context.taskId } : {}),
      ...(context.pageContext ? { page_context: context.pageContext } : {}), ...(context.messageMetadata ? { message_metadata: context.messageMetadata } : {}) };
    const data = await this.transport.request('POST', `/backend-api/messaging/rooms/${roomId}/messages`, { body, signal, idempotencyKey });
    if (typeof data.id !== 'string') throw new DotError('INVALID_RESPONSE', 'The server did not return a message acknowledgment. Check history before trying again.', { delivery: 'unknown', idempotencyKey });
    return { accepted: true, roomId, messageId: data.id, idempotencyKey, createdAt: data.created_at ?? null };
  }
  async room({ roomId, signal } = {}) {
    roomId = await this.resolveRoom(roomId, signal);
    const data = await this.transport.request('GET', `/backend-api/messaging/rooms/${roomId}`, { signal });
    if (data?.id !== roomId || data.type !== 'DM' || data.app_source !== 'chatgpt:messaging' || !Array.isArray(data.members)) throw new DotError('INVALID_RESPONSE', 'The API did not return this Dot messaging room.');
    const snapshots = Array.isArray(data.member_profile_snapshots) ? data.member_profile_snapshots : [];
    const assistantSenderIds = new Set(typeof data.aeon_id === 'string' && data.aeon_id ? data.members.filter(member => member?.aeon_id === data.aeon_id && typeof member.account_user_id === 'string').map(member => member.account_user_id) : []);
    this.assistantSendersByRoom.set(roomId, assistantSenderIds);
    const members = data.members.filter(member => typeof member?.account_user_id === 'string').map(member => {
      const snapshot = snapshots.find(value => value?.account_user_id === member.account_user_id);
      return { id: member.account_user_id, aeonId: typeof member.aeon_id === 'string' ? member.aeon_id : null,
        name: typeof member.name === 'string' && member.name ? member.name : typeof snapshot?.name === 'string' ? snapshot.name : '',
        username: typeof member.username === 'string' && member.username ? member.username : typeof snapshot?.username === 'string' ? snapshot.username : '' };
    });
    return { id: roomId, type: 'DM', name: typeof data.name === 'string' ? data.name : '',
      aeonId: typeof data.aeon_id === 'string' ? data.aeon_id : null,
      updatedAt: typeof data.updated_at === 'string' ? data.updated_at : null,
      lastReadAt: typeof data.last_read_at === 'string' ? data.last_read_at : null,
      members, messages: sorted((Array.isArray(data.latest_messages) ? data.latest_messages : []).map(item => normalizeMessage(item, { assistantSenderIds })).filter(Boolean)) };
  }
  async typing({ roomId, signal } = {}) {
    roomId = await this.resolveRoom(roomId, signal);
    await this.transport.request('POST', `/backend-api/messaging/rooms/${roomId}/responding_heartbeat`, { signal, responseType: 'bytes', maxBytes: 65536 });
    return { roomId, completed: true };
  }
  async prepare({ roomId, signal } = {}) {
    roomId = await this.resolveRoom(roomId, signal);
    // The app intentionally discards the response body. It uses a private
    // routing header internally; the CLI does not surface or persist it.
    await this.transport.request('POST', `/backend-api/messaging/rooms/${roomId}/aeon/prepare`, { signal, responseType: 'bytes', maxBytes: 65536 });
    return { roomId, completed: true };
  }
  async taskSubscription({ roomId, taskId, signal } = {}) {
    validateMessageId(taskId, 'task ID');
    roomId = await this.resolveRoom(roomId, signal);
    const data = await this.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/tasks/${encodeURIComponent(taskId)}/subscription`, { signal });
    return { roomId, taskId, topicId: taskSubscriptionTopic(data, { roomId, taskId }) };
  }
  async watch({ roomId, intervalMs = 3000, fromStart = false, resumeAfter, signal, onMessage = () => {}, onReady = () => {}, onCursor = () => {} } = {}) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000) throw new DotError('INVALID_ARGUMENT', 'Watch interval must be between 1 second and 1 hour.');
    roomId = await this.resolveRoom(roomId, signal);
    const seen = new Map(); let anchor;
    const emit = async messages => {
      for (const message of messages) {
        const version = JSON.stringify(message);
        if (seen.get(message.id) !== version) { seen.set(message.id, version); await onMessage(message); }
      }
      while (seen.size > 5000) seen.delete(seen.keys().next().value);
    };
    if (resumeAfter) {
      anchor = resumeAfter;
      // A cursor identifies new records, not revisions of an older record.
      // Replay the current snapshot on reconnect so a response which finished
      // while the watcher was stopped is not silently lost. This is explicitly
      // at-least-once delivery; keep the saved anchor until its backlog drains.
      const current = await this.history({ roomId, limit: 20, signal });
      await emit(current.messages);
      await onReady({ roomId, initialCount: current.messages.length, resumed: true, replayed: true });
    } else {
      const initial = await this.history({ roomId, limit: 20, signal });
      for (const message of initial.messages) seen.set(message.id, JSON.stringify(message));
      anchor = initial.newestItemId;
      if (fromStart) for (const message of initial.messages) await onMessage(message);
      await onCursor({ roomId, anchor });
      await onReady({ roomId, initialCount: initial.messages.length });
    }
    while (!signal?.aborted) {
      await delay(intervalMs, undefined, { signal });
      // Only fully consumed cursor pages advance the watermark. A later
      // snapshot can race with new arrivals and must not skip the gap.
      let cursor = anchor, consumedAnchor = anchor; const cursors = new Set(); let finished = false;
      for (let page = 0; page < 100; page++) {
        const batch = await this.history({ roomId, limit: 20, after: cursor || undefined, signal });
        await emit(batch.messages);
        if (signal?.aborted) return;
        consumedAnchor = batch.newestItemId ?? consumedAnchor;
        if (!batch.nextCursor) { finished = true; break; }
        if (cursors.has(batch.nextCursor)) throw new DotError('CURSOR_LOOP', 'The API repeated a history cursor.');
        cursors.add(batch.nextCursor); cursor = batch.nextCursor;
      }
      if (!finished) throw new DotError('PAGE_LIMIT', 'Watch exceeded 100 history pages in one poll.');
      anchor = consumedAnchor;
      await onCursor({ roomId, anchor });
      const latest = await this.history({ roomId, limit: 20, signal });
      // Refresh known messages for streaming edits, but leave new arrivals to
      // the next cursor traversal so they are delivered in order, without gaps.
      await emit(latest.messages.filter(message => seen.has(message.id)));
    }
  }
}
