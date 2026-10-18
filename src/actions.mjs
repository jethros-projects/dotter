import { createHash } from 'node:crypto';
import { DotError } from './errors.mjs';
import { validateRoom } from './client.mjs';
import { validateActionForm } from './action-forms.mjs';
import { inspectNativeApproval } from './action-approvals.mjs';

// Contracts verified in ChatGPT.app's app-initial-90eb42395b7d.js,
// card-25996ba7d872.js and details-c9ccc0e03378.js messaging bundles.
// These are internal APIs; a verified route is not a guarantee of account access.
export const actionManifest = Object.freeze({
  list: { supported: true, description: 'List visible elicitation, email, widget and call attachments.' },
  elicitationRead: { supported: true },
  elicitationRespond: { supported: true, actions: ['accept', 'decline', 'cancel'], modes: ['form', 'openaiForm', 'openai/form'], resourceInputs: 'server-provided selections; native Dot local-picker handback unavailable', schemaValidation: 'draft-2020-12, draft-2019-09 and draft-07 in a bounded worker', requires: ['requestId', 'requestFingerprint'] },
  emailRead: { supported: true },
  reactionSet: { supported: true },
  reactionClear: { supported: true },
  roomMarkRead: { supported: true },
  widgetRespond: { supported: false, reason: 'Widget interaction is no longer exposed by this CLI.' },
  draftSend: { supported: false, reason: 'No Dot email-draft send API was verified.' },
  draftEdit: { supported: false, reason: 'No Dot email-draft edit API was verified.' },
  draftDiscard: { supported: false, reason: 'No Dot email-draft discard API was verified.' },
  computerHandback: { supported: false, reason: 'No standalone Dot HTTP contract for computer handback was verified.' },
  computerDismiss: { supported: false, reason: 'No standalone Dot computer-call dismissal API was verified.' }
});

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function bad(code, message) { throw new DotError(code, message); }
function id(value, name = 'message ID') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:~-]{0,1023}$/.test(value)) bad('INVALID_ARGUMENT', `Use a ${name} returned by Dot.`);
  return value;
}
function nonempty(value, name, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) bad('INVALID_ARGUMENT', `A valid ${name} is required.`);
  return value;
}
function hidden(value) {
  return !record(value) || value.deleted_at != null || value.is_hidden === true || value.hidden === true
    || value.is_visually_hidden_from_conversation === true || value.metadata?.is_hidden === true
    || value.metadata?.hidden === true || value.metadata?.is_visually_hidden_from_conversation === true
    || (value.channel != null && !['final', 'commentary'].includes(value.channel))
    || (value.recipient != null && value.recipient !== 'all');
}
function visible(item) { return !hidden(item) && item.content?.type !== 'message_error'; }
async function room(client, roomId, signal) {
  return validateRoom(await client.resolveRoom(roomId, signal));
}
function messageRoute(roomId, messageId) {
  return `/backend-api/messaging/rooms/${validateRoom(roomId)}/messages/${encodeURIComponent(id(messageId))}`;
}
async function getMessage(client, roomId, messageId, signal, expectedAccountId) {
  const data = await client.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/messages`, {
    query: { around: id(messageId), limit: 20 }, signal, ...(expectedAccountId ? { expectedAccountId } : {})
  });
  if (!Array.isArray(data.items)) bad('INVALID_RESPONSE', 'The message lookup response did not contain an items array.');
  const item = data.items.find(item => item?.id === messageId && visible(item));
  if (!item) bad('MESSAGE_UNAVAILABLE', 'That visible message is no longer available in this room.');
  return item;
}
function publicRequest(request) {
  if (!record(request) || typeof request.request_id !== 'string' || !request.request_id.trim()
      || typeof request.thread_id !== 'string' || !request.thread_id.trim() || !record(request.params)
      || request.params.threadId !== request.thread_id
      || (request.params.turnId != null && request.params.turnId !== request.turn_id)) {
    bad('INVALID_RESPONSE', 'The elicitation response contained an invalid request identity.');
  }
  const params = request.params;
  // Native _x chooses explicit OpenAI-form and approval schemas before the
  // legacy form metadata fallback. An invalid selected schema cannot fall back
  // to another, more permissive schema from the same request.
  const metadata = record(params._meta) ? params._meta : {};
  const persist = metadata.persist;
  const offeredPersistence = ['session', 'always'].includes(persist)
    || Array.isArray(persist) && persist.length >= 1 && persist.length <= 2 && persist.every(value => ['session', 'always'].includes(value));
  const nativeApproval = ['mcp_tool_call', 'tool_suggestion'].includes(metadata.codex_approval_kind)
    || ['browser', 'browser-use'].includes(params.serverName) && record(params.requestedSchema?.properties)
      && Object.keys(params.requestedSchema.properties).length === 0 && offeredPersistence
      && typeof metadata.origin === 'string' && metadata.origin.trim();
  const selectedSchema = (params.mode ?? 'form') === 'form' && !nativeApproval && Object.hasOwn(metadata, 'openai/elicitation')
    ? metadata['openai/elicitation']?.requestedSchema : params.requestedSchema;
  return {
    requestId: request.request_id, threadId: request.thread_id, turnId: request.turn_id ?? null,
    status: request.status ?? null, mode: params.mode ?? 'form',
    serverName: typeof params.serverName === 'string' ? params.serverName : null,
    message: typeof params.message === 'string' ? params.message : null,
    requestedSchema: record(selectedSchema) ? structuredClone(selectedSchema) : null,
    approvalKind: typeof params._meta?.codex_approval_kind === 'string' ? params._meta.codex_approval_kind : null,
    ...inspectNativeApproval(params),
    requiresApp: params.mode === 'url' || params.mode === 'openai/userVerification'
      || Object.hasOwn(params._meta ?? {}, 'openai/location')
      || ['wallet_enrollment', 'browser_auth', 'browser_email_otp'].includes(params._meta?.codex_approval_kind)
  };
}
function inspectResponse(data, roomId, messageId) {
  const request = publicRequest(data?.elicitation);
  if (typeof data.request_fingerprint !== 'string' || !data.request_fingerprint.trim()) bad('INVALID_RESPONSE', 'The elicitation response did not include a request fingerprint.');
  return { roomId, messageId, ...request, requestFingerprint: data.request_fingerprint,
    canRespond: data.can_respond === true, runtimeStatus: typeof data.runtime_status === 'string' ? data.runtime_status : null };
}
async function inspect(client, roomId, messageId, signal, expectedAccountId) {
  await getMessage(client, roomId, messageId, signal, expectedAccountId);
  const data = await client.transport.request('GET', `${messageRoute(roomId, messageId)}/elicitation`, { query: { inspect: true }, signal, ...(expectedAccountId ? { expectedAccountId } : {}) });
  return { data, summary: inspectResponse(data, roomId, messageId) };
}

async function identity(client) {
  if (typeof client.transport.authLoader !== 'function') return null;
  const auth = await client.transport.authLoader({ authFile: client.transport.authFile });
  client.transport.assertIdentity?.(auth);
  let subject;
  try { subject = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub; } catch { /* opaque access token */ }
  return { accountId: auth.accountId, subject: typeof subject === 'string' ? subject : createHash('sha256').update(auth.accessToken).digest('hex') };
}
async function assertIdentity(client, snapshot) {
  if (!snapshot) return;
  const current = await identity(client);
  if (current.accountId !== snapshot.accountId || current.subject !== snapshot.subject) bad('ACCOUNT_CHANGED', 'The signed-in identity changed while inspecting this request.');
}
export async function readElicitation(client, { roomId, messageId, signal } = {}) {
  const snapshot = await identity(client);
  roomId = await room(client, roomId, signal);
  const result = (await inspect(client, roomId, id(messageId), signal, snapshot?.accountId)).summary;
  await assertIdentity(client, snapshot);
  return result;
}

function jsonValue(value, depth = 0) {
  if (depth > 64) bad('INVALID_ARGUMENT', 'Response content is nested too deeply.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) bad('INVALID_ARGUMENT', 'Response content contains a reserved property.');
      jsonValue(item, depth + 1);
    }
    return;
  }
  bad('INVALID_ARGUMENT', 'Response content must contain only JSON values.');
}

export async function respondElicitation(client, { roomId, messageId, requestFingerprint, requestId, action, content, persist, signal } = {}) {
  id(messageId); nonempty(requestFingerprint, 'request fingerprint'); nonempty(requestId, 'request ID');
  if (!['accept', 'decline', 'cancel'].includes(action)) bad('INVALID_ARGUMENT', 'Elicitation action must be accept, decline, or cancel.');
  if (content !== undefined && !record(content)) bad('INVALID_ARGUMENT', 'Elicitation content must be a JSON object.');
  if (action !== 'accept' && (content !== undefined || persist !== undefined)) bad('INVALID_ARGUMENT', 'Only accept responses can include content or persistence.');
  if (persist !== undefined && !['session', 'always'].includes(persist)) bad('INVALID_ARGUMENT', 'Persistence must be session or always.');
  if (content !== undefined) { jsonValue(content); if (JSON.stringify(content).length > 64000) bad('INVALID_ARGUMENT', 'Response content exceeds 64,000 characters.'); }
  const snapshot = await identity(client);
  roomId = await room(client, roomId, signal);
  const { data, summary } = await inspect(client, roomId, messageId, signal, snapshot?.accountId);
  if (summary.requestFingerprint !== requestFingerprint || summary.requestId !== requestId) bad('STALE_ACTION', 'The request changed. Inspect it again before responding.');
  if (!summary.canRespond || summary.runtimeStatus !== 'pending' || ['resolved', 'expired', 'applied'].includes(summary.status)) bad('ACTION_UNAVAILABLE', 'This request is no longer pending and answerable.');
  if (action === 'accept' && summary.approvalDisabled) bad('ACTION_UNAVAILABLE', 'This request does not expose a valid, reviewable approval and cannot be accepted.');
  if (action === 'accept' && summary.requiresApp) bad('UNSUPPORTED_ACTION', 'This request requires the app’s location, browser, verification, or wallet flow.');
  if (action === 'accept') {
    if (!['form', 'openai/form', 'openaiForm'].includes(summary.mode)) bad('UNSUPPORTED_ACTION', 'This form uses an app-specific response format.');
    if (!summary.requestedSchema) bad('UNSUPPORTED_ACTION', 'This request does not expose a valid response schema.');
    content = await validateActionForm(content ?? {}, summary.requestedSchema, { signal });
  }
  if (persist !== undefined) {
    if (summary.executionBound) bad('INVALID_ARGUMENT', 'This approval applies only to the displayed database change and cannot be persisted.');
    const allowed = data.elicitation.params._meta?.persist;
    if (!(Array.isArray(allowed) ? allowed.includes(persist) : allowed === persist)) bad('INVALID_ARGUMENT', 'This request does not offer that persistence mode.');
  }
  await assertIdentity(client, snapshot); signal?.throwIfAborted();
  const result = { action, content: content ?? null, _meta: persist ? { persist } : null };
  const response = await client.transport.request('POST', `${messageRoute(roomId, messageId)}/elicitation/response`, {
    body: { request_fingerprint: summary.requestFingerprint, result }, signal, ...(snapshot?.accountId ? { expectedAccountId: snapshot.accountId } : {})
  });
  if (response?.status !== 'applied') throw new DotError('ACTION_UNCONFIRMED', 'The server did not confirm that the response was applied. Inspect the request before trying again.', { delivery: 'unknown' });
  return { roomId, messageId, requestId, action, applied: true };
}

export async function listActions(client, { roomId, limit = 20, before, after, signal } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || before && after) bad('INVALID_ARGUMENT', 'Use a limit from 1 to 20 and only one of before/after.');
  roomId = await room(client, roomId, signal);
  const data = await client.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/messages`, { query: { limit, before, after }, signal });
  if (!Array.isArray(data.items)) bad('INVALID_RESPONSE', 'The action-list response did not contain an items array.');
  const actions = [];
  for (const item of data.items) {
    if (!visible(item) || typeof item.id !== 'string') continue;
    if (item.content?.elicitation) {
      try { actions.push({ type: 'elicitation', messageId: item.id, ...publicRequest(item.content.elicitation) }); }
      catch (error) { if (!(error instanceof DotError)) throw error; }
    }
    const email = item.content?.email;
    if (email?.provider === 'botmail') actions.push({ type: 'email', messageId: item.id, subject: email.subject ?? null, bodyPreview: email.body_preview ?? null, recipientRole: email.recipient_role ?? null, supported: true });
    const attachments = Array.isArray(item.raw_messages) ? item.attachments : item.content?.attachments;
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (!record(attachment) || !['widget', 'call'].includes(attachment.type)) continue;
      const entry = { type: attachment.type, messageId: item.id, attachmentId: attachment.attachment_id ?? null, supported: false };
      if (attachment.type === 'widget') {
        const messages = Array.isArray(attachment.messages) ? attachment.messages : [];
        const meta = messages.find(message => message?.author?.role === 'tool' && !hidden(message))?.metadata?.chatgpt_sdk;
        if (typeof meta?.resource_name === 'string') entry.resourceName = meta.resource_name;
        if (typeof meta?.tool_title === 'string') entry.title = meta.tool_title;
        entry.reason = actionManifest.widgetRespond.reason;
      } else entry.reason = 'No standalone Dot action contract was verified for call attachments.';
      actions.push(entry);
    }
  }
  return { roomId, actions, prevCursor: data.prev_cursor ?? null, nextCursor: data.next_cursor ?? null };
}

export async function reactToMessage(client, { roomId, messageId, reaction, signal } = {}) {
  id(messageId);
  if (reaction !== null && (typeof reaction !== 'string' || reaction.length > 64 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(reaction)
      || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(reaction)].length !== 1)) bad('INVALID_ARGUMENT', 'Use one emoji reaction, or null to clear your reaction.');
  roomId = await room(client, roomId, signal);
  await getMessage(client, roomId, messageId, signal);
  await client.transport.request(reaction === null ? 'DELETE' : 'POST', `${messageRoute(roomId, messageId)}/reactions`, { ...(reaction === null ? {} : { body: { reaction } }), signal });
  return { roomId, messageId, reaction, accepted: true };
}

export async function markRoomRead(client, { roomId, messageId, signal } = {}) {
  roomId = await room(client, roomId, signal);
  const item = await getMessage(client, roomId, id(messageId), signal);
  if (typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at))) bad('INVALID_RESPONSE', 'The message did not include a valid read timestamp.');
  await client.transport.request('POST', `/backend-api/messaging/rooms/${roomId}/read`, { body: { last_read_at: item.created_at }, signal });
  return { roomId, messageId, lastReadAt: item.created_at, accepted: true };
}

export async function readEmail(client, { roomId, messageId, signal } = {}) {
  roomId = await room(client, roomId, signal);
  const item = await getMessage(client, roomId, id(messageId), signal);
  if (item.content?.email?.provider !== 'botmail') bad('ACTION_UNAVAILABLE', 'That message does not contain a saved Dot email.');
  const data = await client.transport.request('GET', `${messageRoute(roomId, messageId)}/email`, { signal });
  if (!record(data) || typeof data.body_text !== 'string' || !Array.isArray(data.to_addresses) || !Array.isArray(data.cc_addresses) || !Array.isArray(data.attachment_names)) bad('INVALID_RESPONSE', 'The email detail response was not in the expected format.');
  const email = {};
  for (const key of ['from_address', 'subject', 'sent_at', 'body_text']) email[key] = typeof data[key] === 'string' ? data[key] : null;
  for (const key of ['to_addresses', 'cc_addresses', 'attachment_names']) email[key] = data[key].filter(value => typeof value === 'string');
  for (const key of ['headers_truncated', 'to_addresses_truncated', 'cc_addresses_truncated', 'body_text_truncated', 'body_text_total_utf8_bytes_is_lower_bound', 'mime_structure_truncated', 'attachments_truncated']) email[key] = data[key] === true;
  if (Number.isSafeInteger(data.body_text_total_utf8_bytes) && data.body_text_total_utf8_bytes >= 0) email.body_text_total_utf8_bytes = data.body_text_total_utf8_bytes;
  return { roomId, messageId, email };
}

export function unsupportedAction(name) {
  const entry = actionManifest[name];
  if (!entry || entry.supported) bad('INVALID_ARGUMENT', 'Choose an unsupported action from the capability manifest.');
  bad('UNSUPPORTED_ACTION', entry.reason);
}
