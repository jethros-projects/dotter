import { DotError } from './errors.mjs';

// Account-scoped ChatGPT conversations. Contracts inspected in the installed
// app-initial-90eb42395b7d.js, page-3f186ee79aef.js and dialog-3fd48ccc540e.js.
// These APIs neither create nor preserve a Dot identity.
const ROOT = '/backend-api';
const IDENTIFIER = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const SUMMARY_FIELDS = ['id', 'conversation_id', 'title', 'create_time', 'update_time', 'is_archived', 'is_starred', 'conversation_origin', 'gizmo_id', 'async_status', 'latest_assistant_turn_created_at'];
const SHARE_FIELDS = ['id', 'share_id', 'conversation_id', 'current_node_id', 'highlighted_message_id', 'title', 'is_anonymous', 'is_public', 'is_visible', 'create_time', 'update_time', 'moderation_state', 'workspace_id'];
const historyPagesWithCurrentNode = new WeakSet();
function fail(code, message, details) { throw new DotError(code, message, details); }
function id(value, label = 'conversationId') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || value === '.' || value === '..') fail('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function text(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail('INVALID_ARGUMENT', `${label} must be a nonempty string without NUL bytes or newlines (maximum ${max} characters).`);
  return value;
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function object(value) { if (!record(value)) fail('INVALID_RESPONSE', 'The conversation API returned an invalid object.'); return value; }
function pick(value, fields) {
  object(value);
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key) && (value[key] === null || typeof value[key] === 'boolean' || (typeof value[key] === 'number' && Number.isFinite(value[key])) || (typeof value[key] === 'string' && value[key].length <= 8192))).map(key => [key, value[key]]));
}
function hidden(value) {
  return !record(value) || value.hidden === true || value.is_hidden === true || value.is_visually_hidden_from_conversation === true || value.deleted_at != null
    || (value.channel != null && !['final', 'commentary'].includes(value.channel)) || (value.recipient != null && value.recipient !== 'all')
    || (record(value.metadata) && hidden(value.metadata));
}
function summary(value, expected) {
  object(value); const actual = value.id ?? value.conversation_id;
  if (expected !== undefined && ['id', 'conversation_id'].some(key => Object.hasOwn(value, key) && value[key] !== expected)) {
    fail('INVALID_RESPONSE', 'The response did not match the requested conversation.');
  }
  if (typeof actual !== 'string' || (expected !== undefined && actual !== expected)) fail('INVALID_RESPONSE', 'The response did not match the requested conversation.');
  return { ...pick(value, SUMMARY_FIELDS), id: actual };
}
function pageCursor(value) {
  const cursor = value ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192)) fail('INVALID_RESPONSE', 'The API returned an invalid pagination cursor.');
  return cursor;
}
function limit(value, label = 'limit', max = 100) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail('INVALID_ARGUMENT', `${label} must be an integer from 1 to ${max}.`);
  return value;
}
function bool(value, label) { if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${label} must be true or false.`); return value; }
function confirmId(expected, confirm) { if (confirm !== expected) fail('CONFIRMATION_REQUIRED', `confirm must exactly match ${expected} for this operation.`); }
function ack(value, detail) {
  object(value);
  if (value.success !== true && value.completed !== true) fail('MUTATION_UNCONFIRMED', 'The server did not confirm the conversation change. Inspect the resource before retrying.', { delivery: 'unknown', ...detail });
  return { ...detail, confirmed: true };
}
function visibleMessage(value, nodeId) {
  if (hidden(value) || !['user', 'assistant'].includes(value.author?.role) || hidden(value.author)) return null;
  const content = value.content;
  if (!record(content) || !['text', 'multimodal_text', 'code'].includes(content.content_type)) return null;
  // Do not serialize code/tool results or arbitrary multimodal payloads. Only
  // plain visible text and non-secret file identifiers leave this module.
  if (content.content_type === 'code') return null;
  const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === 'string' ? [content.text] : [];
  const strings = parts.filter(part => typeof part === 'string' && part.trim() !== '::SKIP_COMPLETION::');
  const result = { id: id(value.id, 'messageId'), nodeId: id(nodeId ?? value.id, 'nodeId'), role: value.author.role, text: strings.join('\n') };
  if (typeof value.create_time === 'number' && Number.isFinite(value.create_time)) result.createTime = value.create_time;
  if (typeof value.status === 'string') result.status = value.status;
  if (typeof value.channel === 'string') result.channel = value.channel;
  if (typeof value.has_versions === 'boolean') result.hasVersions = value.has_versions;
  const files = parts.filter(part => record(part) && ['image_asset_pointer', 'file'].includes(part.content_type ?? part.type)).map(part => pick(part, ['file_id', 'content_type', 'type', 'name', 'mime_type']));
  if (files.length) result.files = files;
  if (!result.text && !files.length) return null;
  return result;
}
function selectedNodes(value, selected) {
  object(value.mapping);
  const current = selected ?? value.current_node;
  if (typeof current !== 'string' || !Object.hasOwn(value.mapping, current)) fail('INVALID_RESPONSE', 'The conversation did not identify its selected branch.');
  const seen = new Set(), result = []; let next = current;
  while (next != null) {
    if (typeof next !== 'string' || seen.has(next) || seen.size > 100000 || !record(value.mapping[next])) fail('INVALID_RESPONSE', 'The conversation branch is invalid or cyclic.');
    seen.add(next); const node = value.mapping[next];
    if (node.id !== undefined && node.id !== next) fail('INVALID_RESPONSE', 'The conversation node identity did not match its mapping.');
    if (node.message && !hidden(node)) { const message = visibleMessage(node.message, next); if (message) result.push(message); }
    next = node.parent;
  }
  return result.reverse();
}
function historyPage(value, conversationId, { requestBoundIdentity = false } = {}) {
  object(value);
  // Native Msi/h merges /conversations/{id}/messages into its initial
  // envelope. Secondary message pages may omit that envelope's identity;
  // only this exact request-bound route can supply it, never a first page.
  if (requestBoundIdentity && !Object.hasOwn(value, 'id') && !Object.hasOwn(value, 'conversation_id')
    && Array.isArray(value.messages) && record(value.page_info)) {
    value = { ...value, conversation_id: conversationId };
  }
  const conversation = summary(value, conversationId);
  let messages, cursor = null;
  if (Array.isArray(value.messages)) {
    if (value.messages.length > 10000) fail('INVALID_RESPONSE', 'The conversation page was oversized.');
    messages = value.messages.map(message => visibleMessage(message)).filter(Boolean);
    object(value.page_info); cursor = value.page_info.has_previous_page === true ? pageCursor(value.page_info.start_cursor) : null;
  } else { messages = selectedNodes(value); }
  const result = { conversation, messages, cursor, currentNodeId: typeof value.current_node === 'string' ? value.current_node : null };
  if (Object.hasOwn(value, 'current_node')) historyPagesWithCurrentNode.add(result);
  return result;
}
function share(value, expectedId) {
  object(value);
  // The owner GET returns a public snapshot: conversation_id is the share ID,
  // while backing_conversation_id identifies the source account conversation.
  // Creation/list responses use the separate id/share_id fields instead.
  const snapshot = expectedId != null && value.id === undefined && value.share_id === undefined
    && value.conversation_id === expectedId;
  const actual = value.share_id ?? value.id ?? (snapshot ? value.conversation_id : undefined);
  if (typeof actual !== 'string' || (expectedId != null && actual !== expectedId)) fail('INVALID_RESPONSE', 'The response did not match the requested share.');
  const result = { ...pick(value, SHARE_FIELDS), id: actual };
  if (snapshot) {
    delete result.conversation_id;
    if (value.backing_conversation_id != null) result.conversation_id = id(value.backing_conversation_id);
    if (value.current_node != null) result.current_node_id = id(value.current_node, 'current_node');
  }
  if (typeof value.share_url === 'string') {
    let url; try { url = new URL(value.share_url); } catch { fail('INVALID_RESPONSE', 'The share URL was invalid.'); }
    if (url.origin !== 'https://chatgpt.com' || !/^\/share\/(?:e\/)?[A-Za-z0-9_.~:-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) fail('INVALID_RESPONSE', 'The share URL was not a ChatGPT share link.');
    result.url = url.href;
  }
  if (record(value.moderation_state)) result.moderation_state = pick(value.moderation_state, ['has_been_auto_blocked', 'has_been_auto_moderated', 'has_been_blocked']);
  return result;
}
function checkModeration(value) {
  const state = value?.moderation_state;
  if ((record(state) && ['has_been_auto_blocked', 'has_been_auto_moderated', 'has_been_blocked'].some(key => state[key] === true)) || ['blocked', 'blocked_by_moderation', 'failed'].includes(state)) fail('SHARE_BLOCKED', 'The service did not allow this conversation share.');
}

export function conversationCapabilities() {
  return { scope: 'Signed-in ChatGPT account conversations, separate from Dot identities.', supported: ['list', 'search', 'batch', 'selected-branch-history', 'paginated-history', 'rename', 'archive', 'unarchive', 'delete', 'select-response', 'response-versions', 'pin', 'move-project', 'inbox', 'mark-read', 'clear-async-status', 'share-create', 'share-get', 'share-list', 'share-update', 'share-revoke'], limitations: ['History includes only user-visible user/assistant text and file metadata.', 'Conversation branch creation requires a native completion workflow that the CLI does not provide.', 'Share publication and deletion require exact resource-ID confirmation.'], liveVerified: false };
}

export class ConversationClient {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('ConversationClient requires a DotClient.');
    this.transport = client.transport; this.accountId = undefined;
  }
  capabilities() { return conversationCapabilities(); }
  async account(expectedAccountId) {
    if (expectedAccountId !== undefined) text(expectedAccountId, 'expectedAccountId', 1024);
    const auth = typeof this.transport.authLoader === 'function' ? await this.transport.authLoader({ authFile: this.transport.authFile }) : null;
    const actual = auth?.accountId ?? expectedAccountId ?? this.accountId;
    if (typeof actual !== 'string' || !actual) fail('AUTH_ACCOUNT_REQUIRED', 'Conversation APIs require an explicit signed-in account selector.');
    if ((this.accountId !== undefined && actual !== this.accountId) || (expectedAccountId !== undefined && expectedAccountId !== actual)) fail('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
    if (auth) this.transport.assertIdentity?.(auth);
    this.accountId = actual; return actual;
  }
  async request(method, route, options = {}) {
    const expectedAccountId = await this.account(options.expectedAccountId);
    return this.transport.request(method, `${ROOT}${route}`, { ...options, expectedAccountId, maxBytes: options.maxBytes ?? 4 * 1024 * 1024 });
  }
  async list({ limit: count = 20, offset = 0, order = 'updated', conversationOrigin, excludeConversationOrigin, expand = false, hideSnorlax, archived, starred, signal, expectedAccountId } = {}) {
    limit(count); if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENT', 'offset must be a nonnegative integer.');
    if (order === 'created') fail('UNSUPPORTED', 'Created-time conversation ordering is unavailable in this CLI. Use order=updated or omit order.');
    if (order !== 'updated') fail('INVALID_ARGUMENT', 'order must be updated.');
    bool(expand, 'expand'); for (const [name, value] of Object.entries({ hideSnorlax, archived, starred })) if (value !== undefined) bool(value, name);
    for (const [name, value] of Object.entries({ conversationOrigin, excludeConversationOrigin })) if (value !== undefined) text(value, name, 100);
    const value = object(await this.request('GET', '/conversations', { query: { limit: count, offset, order, expand, conversation_origin: conversationOrigin, exclude_conversation_origin: excludeConversationOrigin, hide_snorlax: hideSnorlax, is_archived: archived, is_starred: starred }, expectedAccountId, signal }));
    if (!Array.isArray(value.items) || value.items.length > 1000) fail('INVALID_RESPONSE', 'The conversation list was invalid.');
    return { items: value.items.filter(v => !hidden(v)).map(v => summary(v)), ...pick(value, ['total', 'limit', 'offset', 'has_missing_conversations']) };
  }
  async search({ query, cursor, signal, expectedAccountId } = {}) {
    text(query, 'query'); if (cursor !== undefined && cursor !== null) text(cursor, 'cursor', 8192);
    const value = object(await this.request('GET', '/conversations/search', { query: { query, cursor }, signal, expectedAccountId }));
    if (!Array.isArray(value.items) || value.items.length > 1000) fail('INVALID_RESPONSE', 'The conversation search was invalid.');
    // Search snippets are deliberately omitted: the backend may match hidden content.
    return { items: value.items.filter(v => !hidden(v)).map(v => summary(v)), cursor: pageCursor(value.cursor) };
  }
  async batch({ conversationIds, signal, expectedAccountId } = {}) {
    if (!Array.isArray(conversationIds) || !conversationIds.length || conversationIds.length > 100 || new Set(conversationIds).size !== conversationIds.length) fail('INVALID_ARGUMENT', 'conversationIds must contain 1 to 100 unique IDs.');
    conversationIds.forEach(value => id(value));
    const value = await this.request('POST', '/conversations/batch', { body: { conversation_ids: conversationIds }, signal, expectedAccountId });
    if (!Array.isArray(value) || value.length > conversationIds.length || value.some(v => !conversationIds.includes(v?.id))) fail('INVALID_RESPONSE', 'The batch contained an unexpected conversation.');
    return { items: value.filter(v => !hidden(v)).map(v => summary(v)) };
  }
  async get({ conversationId, signal, expectedAccountId } = {}) {
    id(conversationId);
    return historyPage(await this.request('GET', `/conversation/${encodeURIComponent(conversationId)}`, { signal, expectedAccountId, maxBytes: 16 * 1024 * 1024 }), conversationId);
  }
  async history({ conversationId, before, numTurns = 20, signal, expectedAccountId } = {}) {
    id(conversationId); limit(numTurns, 'numTurns'); if (before != null) text(before, 'before', 8192);
    const path = before == null ? `/conversations/${encodeURIComponent(conversationId)}` : `/conversations/${encodeURIComponent(conversationId)}/messages`;
    return historyPage(await this.request('GET', path, { query: { before, num_turns: numTurns, include_has_versions: true }, expectedAccountId, signal }), conversationId,
      { requestBoundIdentity: before != null });
  }
  async historyPages({ pages = 1, ...options } = {}) {
    limit(pages, 'pages', 1000); const seen = new Set(), ids = new Set(); let before = options.before, result;
    const messages = []; let conversation, currentNodeId = null;
    for (let page = 0; page < pages; page++) {
      if (before != null) { if (seen.has(before)) fail('INVALID_RESPONSE', 'The conversation pagination cursor did not advance.'); seen.add(before); }
      result = await this.history({ ...options, before });
      conversation = { ...conversation, ...result.conversation };
      if (historyPagesWithCurrentNode.has(result)) currentNodeId = result.currentNodeId;
      const fresh = result.messages.filter(item => !ids.has(item.id)); fresh.forEach(item => ids.add(item.id)); messages.unshift(...fresh);
      before = result.cursor; if (before == null) break;
    }
    return { ...result, conversation, currentNodeId, messages, cursor: before };
  }
  async rename({ conversationId, title, signal, expectedAccountId } = {}) {
    id(conversationId); text(title, 'title', 1024);
    return ack(await this.request('POST', `/conversation/id/${encodeURIComponent(conversationId)}/rename`, { body: { title: title.trim() }, signal, expectedAccountId }), { conversationId, renamed: true });
  }
  async setArchived({ conversationId, archived, signal, expectedAccountId } = {}) {
    id(conversationId); bool(archived, 'archived');
    return ack(await this.request('PATCH', `/conversation/${encodeURIComponent(conversationId)}`, { body: { is_archived: archived }, signal, expectedAccountId }), { conversationId, archived });
  }
  archive(options) { return this.setArchived({ ...options, archived: true }); }
  unarchive(options) { return this.setArchived({ ...options, archived: false }); }
  async delete({ conversationId, confirm, signal, expectedAccountId } = {}) {
    id(conversationId); confirmId(conversationId, confirm);
    return ack(await this.request('DELETE', `/conversation/id/${encodeURIComponent(conversationId)}`, { signal, expectedAccountId }), { conversationId, deleted: true });
  }
  async selectResponse({ conversationId, nodeId, signal, expectedAccountId } = {}) {
    id(conversationId); id(nodeId, 'nodeId');
    const value = object(await this.request('GET', `/conversation/${encodeURIComponent(conversationId)}`, { signal, expectedAccountId, maxBytes: 16 * 1024 * 1024 }));
    summary(value, conversationId); const node = value.mapping?.[nodeId];
    if (!record(node) || hidden(node) || !visibleMessage(node.message, nodeId) || node.message.author.role !== 'assistant') fail('NOT_VISIBLE', 'The selected response must be a visible assistant message.');
    selectedNodes(value, nodeId); // Validate the branch before sending its identity.
    const seen = new Set(); let currentNodeId = nodeId;
    while (value.mapping[currentNodeId]?.children?.[0] != null) {
      if (seen.has(currentNodeId) || seen.size > 100000) fail('INVALID_RESPONSE', 'The response continuation is cyclic.');
      seen.add(currentNodeId); const child = value.mapping[currentNodeId].children[0];
      if (typeof child !== 'string' || !record(value.mapping[child]) || value.mapping[child].parent !== currentNodeId) fail('INVALID_RESPONSE', 'The response continuation is invalid.');
      currentNodeId = child;
    }
    return ack(await this.request('PATCH', `/conversation/${encodeURIComponent(conversationId)}`, { body: { current_node_id: currentNodeId }, signal, expectedAccountId }), { conversationId, selectedResponseNodeId: nodeId, currentNodeId });
  }
  async responses({ conversationId, signal, expectedAccountId } = {}) {
    id(conversationId);
    const value = object(await this.request('GET', `/conversation/${encodeURIComponent(conversationId)}`, { signal, expectedAccountId, maxBytes: 16 * 1024 * 1024 }));
    summary(value, conversationId); const selected = new Set(selectedNodes(value).map(message => message.nodeId));
    const items = [];
    for (const [nodeId, node] of Object.entries(value.mapping)) {
      if (hidden(node)) continue;
      const message = node.message && visibleMessage(node.message, nodeId);
      if (message?.role === 'assistant') items.push({ ...message, selected: selected.has(nodeId) });
    }
    return { conversationId, items };
  }
  async setPinned({ conversationId, pinned, signal, expectedAccountId } = {}) {
    id(conversationId); bool(pinned, 'pinned');
    return ack(await this.request('PATCH', `/conversation/${encodeURIComponent(conversationId)}`, { body: { is_starred: pinned }, signal, expectedAccountId }), { conversationId, pinned });
  }
  pin(options) { return this.setPinned({ ...options, pinned: true }); }
  unpin(options) { return this.setPinned({ ...options, pinned: false }); }
  async moveProject({ conversationId, projectId, root = false, signal, expectedAccountId } = {}) {
    id(conversationId); bool(root, 'root');
    if (root && projectId !== undefined) fail('INVALID_ARGUMENT', 'Choose projectId or root, not both.');
    if (!root) id(projectId, 'projectId');
    return ack(await this.request('PATCH', `/conversation/${encodeURIComponent(conversationId)}`, { body: { gizmo_id: root ? '' : projectId }, signal, expectedAccountId }), { conversationId, projectId: root ? null : projectId });
  }
  async inbox({ unreadOnly = true, limit: count = 100, cursor, signal, expectedAccountId } = {}) {
    bool(unreadOnly, 'unreadOnly'); limit(count); if (cursor != null) text(cursor, 'cursor', 8192);
    const value = object(await this.request('GET', '/inbox/items', { query: { unread_only: unreadOnly, limit: count, cursor }, signal, expectedAccountId }));
    if (!Array.isArray(value.items) || value.items.length > 1000) fail('INVALID_RESPONSE', 'The inbox response was invalid.');
    return { items: value.items.filter(v => !hidden(v)).map(v => pick(v, ['id', 'conversation_id', 'title', 'activity_text', 'activity_version', 'created_at', 'updated_at', 'read_at', 'is_read', 'type'])), cursor: pageCursor(value.cursor) };
  }
  async markRead({ itemIds, signal, expectedAccountId } = {}) {
    if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 100 || new Set(itemIds).size !== itemIds.length) fail('INVALID_ARGUMENT', 'itemIds must contain 1 to 100 unique inbox IDs.');
    itemIds.forEach(value => id(value, 'itemId'));
    return ack(await this.request('POST', '/inbox/items/mark-read', { body: { item_ids: itemIds }, signal, expectedAccountId }), { itemIds, read: true });
  }
  async clearAsyncStatus({ conversationId, signal, expectedAccountId } = {}) {
    id(conversationId);
    return ack(await this.request('POST', `/conversation/${encodeURIComponent(conversationId)}/async-status`, { body: { status: null }, signal, expectedAccountId }), { conversationId, asyncStatus: null });
  }
  async shareList({ signal, expectedAccountId } = {}) {
    const value = object(await this.request('GET', '/shared_conversations', { query: { order: 'created' }, signal, expectedAccountId }));
    if (!Array.isArray(value.items) || value.items.length > 10000) fail('INVALID_RESPONSE', 'The share list was invalid.');
    return { items: value.items.filter(v => !hidden(v)).map(v => share(v)) };
  }
  async shareGet({ shareId, signal, expectedAccountId } = {}) {
    id(shareId, 'shareId'); return share(await this.request('GET', `/share/${encodeURIComponent(shareId)}`, { signal, expectedAccountId }), shareId);
  }
  async ownedShare(shareId, options) {
    const owned = await this.shareList(options);
    const listed = owned.items.find(item => item.id === shareId);
    if (!listed) fail('SHARE_NOT_OWNED', 'The share is not in this account’s owned conversation links.');
    const current = await this.shareGet({ ...options, shareId });
    if (listed.conversation_id != null && current.conversation_id != null && listed.conversation_id !== current.conversation_id) fail('INVALID_RESPONSE', 'The owned share source differs from its current listing.');
    return current;
  }
  async shareCreate({ conversationId, nodeId, publish = false, confirm, signal, expectedAccountId } = {}) {
    id(conversationId); id(nodeId, 'nodeId'); bool(publish, 'publish'); confirmId(conversationId, confirm);
    const current = await this.get({ conversationId, signal, expectedAccountId });
    if (!current.messages.some(message => message.nodeId === nodeId)) fail('NOT_VISIBLE', 'The share snapshot must end at a visible message in the selected branch.');
    const value = await this.request('POST', publish ? '/share/v2/create' : '/share/create', { body: { conversation_id: conversationId, current_node_id: nodeId, is_anonymous: true }, signal, expectedAccountId });
    checkModeration(value); const result = share(value);
    if (result.conversation_id !== undefined && result.conversation_id !== conversationId) fail('INVALID_RESPONSE', 'The share response referred to a different conversation.');
    return { ...result, publicationRequested: publish };
  }
  async shareUpdate({ shareId, nodeId, title, publish, visible, confirm, signal, expectedAccountId } = {}) {
    id(shareId, 'shareId'); id(nodeId, 'nodeId'); if (title !== undefined) text(title, 'title', 1024);
    if (publish !== undefined) bool(publish, 'publish'); if (visible !== undefined) bool(visible, 'visible'); confirmId(shareId, confirm);
    const current = await this.ownedShare(shareId, { signal, expectedAccountId });
    if (typeof current.conversation_id !== 'string') fail('INVALID_RESPONSE', 'The owned share did not identify its source conversation.');
    const conversation = await this.get({ conversationId: current.conversation_id, signal, expectedAccountId });
    if (!conversation.messages.some(message => message.nodeId === nodeId)) fail('NOT_VISIBLE', 'The share snapshot must end at a visible message in the selected branch.');
    const publication = publish ?? current.is_public, visibility = visible ?? current.is_visible;
    if (typeof publication !== 'boolean' || typeof visibility !== 'boolean') fail('INVALID_RESPONSE', 'The current share did not identify its publication and visibility state. Supply explicit state flags when the snapshot omits them.');
    const body = { current_node_id: nodeId, highlighted_message_id: current.highlighted_message_id ?? null, is_anonymous: current.is_anonymous ?? true, is_public: publication, is_visible: visibility, title: title ?? current.title ?? '' };
    const value = await this.request('PATCH', `/share/${encodeURIComponent(shareId)}`, { body, signal, expectedAccountId });
    checkModeration(value);
    // The native PATCH may return an acknowledgement without a share identity.
    // Read the exact snapshot back before reporting the requested update.
    let updated;
    try { updated = await this.shareGet({ shareId, signal, expectedAccountId }); }
    catch (error) {
      fail('MUTATION_UNCONFIRMED', 'The update request completed, but the share could not be verified. Inspect the link before retrying.',
        { delivery: 'unknown', shareId, verificationError: error?.code ?? 'UNKNOWN' });
    }
    checkModeration(updated);
    if (updated.conversation_id !== current.conversation_id || updated.current_node_id !== nodeId
        || updated.title !== body.title || updated.is_public !== body.is_public
        || typeof updated.is_visible === 'boolean' && updated.is_visible !== body.is_visible) {
      fail('MUTATION_UNCONFIRMED', 'The update request completed, but the share state did not match. Inspect the link before retrying.', { delivery: 'unknown', shareId });
    }
    return { ...updated, publicationRequested: body.is_public, visibilityRequested: body.is_visible };
  }
  async shareRevoke({ shareId, confirm, signal, expectedAccountId } = {}) {
    id(shareId, 'shareId'); confirmId(shareId, confirm); await this.ownedShare(shareId, { signal, expectedAccountId });
    // Native deletion may return a scalar/null JSON body. Confirm disappearance
    // rather than treating an arbitrary successful response as an acknowledgement.
    await this.request('DELETE', `/share/${encodeURIComponent(shareId)}`, { signal, expectedAccountId, responseType: 'text' });
    try { await this.shareGet({ shareId, signal, expectedAccountId }); }
    catch (error) {
      if (error?.code === 'HTTP_ERROR' && error?.details?.status === 404) return { shareId, revoked: true, confirmed: true };
      fail('MUTATION_UNCONFIRMED', 'The deletion request completed, but share revocation could not be verified. Inspect the link before retrying.',
        { delivery: 'unknown', shareId, verificationError: error?.code ?? 'UNKNOWN' });
    }
    fail('MUTATION_UNCONFIRMED', 'The deletion request completed, but the share is still readable. Inspect the link before retrying.', { delivery: 'unknown', shareId });
  }
}
