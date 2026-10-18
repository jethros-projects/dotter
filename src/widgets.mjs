import { createHash, randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { validateRoom } from './client.mjs';
import { validateActionForm } from './action-forms.mjs';
import { writePrivate } from './store.mjs';
import { MCP_CATALOG_MAX_BYTES, readNativeToolCatalog, nativeToolBinding } from './mcp-catalog.mjs';

// ChatGPT.app app-initial-90eb42395b7d.js: SDr/rJc widget projection,
// DDr session replacement, D7o/A7o native MCP adapters and C7o continuation.
// CODEX/TPP use ps/mcp except resources/list and prompts/list.
const ROOT = '/backend-api';
const METHODS = new Set(['tools/list', 'tools/call', 'resources/read', 'resources/list', 'resources/templates/list', 'prompts/list']);
const CONTINUATION_LIMIT = 32;
const PROTOCOL_VERSION = '2026-07-28';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code, message, details) { throw new DotError(code, message, details); }
function id(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ARGUMENT', `Use a valid ${label}.`); return value; }
function string(value, label, max = 8192) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail('INVALID_ARGUMENT', `Use a valid ${label}.`); return value; }
function json(value, depth = 0) {
  if (depth > 48) fail('INVALID_RESPONSE', 'The widget data exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key) && key !== '_meta').map(([key, child]) => [key, json(child, depth + 1)]));
  fail('INVALID_RESPONSE', 'The widget returned invalid JSON data.');
}
function hidden(value, inner = false) { return !object(value) || value.deleted_at != null || value.is_hidden === true || value.hidden === true || value.is_visually_hidden_from_conversation === true || value.metadata?.is_hidden === true || value.metadata?.hidden === true || value.metadata?.is_visually_hidden_from_conversation === true || !inner && ((value.channel != null && !['final', 'commentary'].includes(value.channel)) || (value.recipient != null && value.recipient !== 'all')) || value.content?.type === 'message_error'; }
function scalar(value) { return typeof value === 'string' && value.trim() ? value : null; }
function productSku(value) {
  if (typeof value !== 'string') return null;
  return value.toLowerCase() === 'aeon' ? 'aeon' : ['CODEX', 'TPP'].includes(value.toUpperCase()) ? value.toUpperCase() : null;
}
function pauseContinuation(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error === undefined ? resolve() : reject(error); };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(), 1000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
function inputRequired(result) {
  return result?.resultType === 'input_required' ? { status: 'input_required', requiresNativeContinuation: true,
    message: 'This widget requested interactive input. CLI continuation is unavailable; repeating the command could invoke the tool again.' } : null;
}
function nativeResult(response, requestId) {
  if (!object(response) || response.jsonrpc !== '2.0' || response.id !== requestId || Object.hasOwn(response, 'error') === Object.hasOwn(response, 'result')) fail('INVALID_RESPONSE', 'The native widget response did not match its JSON-RPC request.');
  if (Object.hasOwn(response, 'error')) {
    if (!object(response.error) || !Number.isInteger(response.error.code) || typeof response.error.message !== 'string') fail('INVALID_RESPONSE', 'The native widget error response is invalid.');
    // Error messages/data may contain upstream private input or capability URLs.
    fail('MCP_ERROR', 'The native widget MCP request failed.', { jsonRpcCode: response.error.code });
  }
  if (!object(response.result)) fail('INVALID_RESPONSE', 'The native widget MCP result is invalid.');
  return response.result;
}
function safeUri(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) return null;
  let parsed; try { parsed = new URL(value); } catch { return null; }
  if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /token|secret|signature|credential|password|^sig$/i.test(key))) return null;
  return value;
}
function contentResult(message) {
  const content = message.content;
  let value = object(content) && Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string').join('') : object(content) && typeof content.text === 'string' ? content.text : null;
  if (value !== null) { try { return JSON.parse(value); } catch { return { content: [{ type: 'text', text: value }] }; } }
  return object(content) && (Array.isArray(content.content) || Object.hasOwn(content, 'structuredContent')) ? content : {};
}
function project(item) {
  if (hidden(item) || typeof item.id !== 'string') return [];
  const attachments = Array.isArray(item.raw_messages) ? item.attachments : item.content?.attachments;
  return (Array.isArray(attachments) ? attachments : []).flatMap(attachment => {
    const sku = productSku(attachment?.product_sku);
    if (attachment?.type !== 'widget' || !sku || !ID.test(attachment.attachment_id ?? '') || !ID.test(attachment.original_message_id ?? '') || !Array.isArray(attachment.messages)) return [];
    const origin = attachment.messages.find(message => message?.id === attachment.original_message_id && message.author?.role === 'assistant' && !hidden(message, true));
    if (!origin) return [];
    return attachment.messages.flatMap(message => {
      if (message.author?.role !== 'tool' || hidden(message, true) || !ID.test(message.id ?? '')) return [];
      const metadata = { ...(object(origin.metadata?.chatgpt_sdk) ? origin.metadata.chatgpt_sdk : {}), ...(object(message.metadata?.chatgpt_sdk) ? message.metadata.chatgpt_sdk : {}) };
      const appUri = scalar(metadata.resolved_pineapple_uri), template = scalar(metadata.html_asset_pointer);
      if (!appUri || !template || appUri.startsWith('internal://') || template.startsWith('internal://')) return [];
      const connectorId = scalar(metadata.attribution_id) ?? scalar(metadata['openai/connector_id']) ?? (appUri.startsWith('connectors://') ? appUri.slice(13) : appUri);
      const linkId = scalar(metadata.link_id) ?? scalar(metadata['openai/link_id']);
      if (!ID.test(connectorId ?? '') || !ID.test(linkId ?? '') || ![connectorId, `connectors://${connectorId}`].includes(appUri) || linkId.startsWith('implicit_link::') || linkId.startsWith('synthetic_link::')) return [];
      const result = contentResult(message);
      const closed = metadata.is_widget_closed === true, isError = message.metadata?.is_error === true || metadata.is_error === true || result.isError === true;
      if (isError && !closed) return [];
      const sessionId = scalar(metadata.widget_session_id) ?? scalar(metadata.session_id);
      const sessionKey = JSON.stringify([appUri, connectorId, linkId, template, sessionId]);
      const sourceAction = scalar(metadata.action_name) ?? scalar(metadata.resource_name);
      const key = [item.id, attachment.attachment_id, message.id, sku, metadata, result];
      return [{ messageId: item.id, attachmentId: attachment.attachment_id, widgetMessageId: message.id, originalMessageId: attachment.original_message_id,
        productSku: sku, connectorId, linkId, appUri, template, sessionId, closed, title: scalar(metadata.tool_title), sourceAction, sessionKey, fingerprintData: key }];
    });
  });
}
function publicCard(card, context) {
  return { ...context, messageId: card.messageId, attachmentId: card.attachmentId, widgetMessageId: card.widgetMessageId, originalMessageId: card.originalMessageId,
    productSku: card.productSku, connectorId: card.connectorId, linkId: card.linkId, appUri: card.appUri, template: safeUri(card.template), sessionId: card.sessionId, title: card.title,
    closed: card.closed, requestFingerprint: digest([context, card.fingerprintData]), methods: [...METHODS] };
}
function actionName(value, card) {
  string(value, 'tool name', 2048);
  const parts = value.startsWith('/') ? value.slice(1).split('/') : value.split('/');
  if (parts.length === 3) { if (parts[0] !== card.connectorId || parts[1] !== card.linkId) fail('INVALID_ARGUMENT', 'The tool belongs to a different widget connection.'); }
  else if (parts.length !== 1) fail('INVALID_ARGUMENT', 'The tool name is not bound to this widget connection.');
  const name = parts.at(-1); if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(name)) fail('INVALID_ARGUMENT', 'Use a tool returned by this widget.'); return name;
}
function projectedResult(result) {
  if (!object(result)) fail('INVALID_RESPONSE', 'The widget response is not an MCP result.');
  if (inputRequired(result)) return inputRequired(result);
  const output = { isError: result.isError === true };
  if (Array.isArray(result.content)) output.content = result.content.flatMap(item => {
    if (!object(item)) return [];
    if (item.type === 'text' && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
    if (item.type === 'resource_link' && safeUri(item.uri)) return [{ type: 'resource_link', uri: item.uri, ...(typeof item.name === 'string' ? { name: item.name } : {}) }];
    if (item.type === 'resource' && object(item.resource) && safeUri(item.resource.uri) && typeof item.resource.text === 'string') return [{ type: 'resource', resource: { uri: item.resource.uri, text: item.resource.text, ...(typeof item.resource.mimeType === 'string' ? { mimeType: item.resource.mimeType } : {}) } }];
    return [];
  });
  if (Object.hasOwn(result, 'structuredContent')) output.structuredContent = json(result.structuredContent);
  return output;
}
export class DotWidgets {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('DotWidgets requires a DotClient.'); this.client = client; this.transport = client.transport; }
  async identity(expectedAccountId) {
    if (expectedAccountId !== undefined) id(expectedAccountId, 'account ID');
    if (typeof this.transport.authLoader !== 'function') { if (!expectedAccountId) fail('AUTH_ACCOUNT_REQUIRED', 'Select the widget account.'); return { accountId: expectedAccountId, subject: expectedAccountId }; }
    const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
    if (!auth.accountId || expectedAccountId !== undefined && auth.accountId !== expectedAccountId) fail('ACCOUNT_CHANGED', 'The widget account does not match the current login.');
    this.transport.assertIdentity?.(auth);
    let claims; try { claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); } catch { /* bind opaque tokens without displaying them */ }
    return { accountId: auth.accountId, subject: typeof claims?.sub === 'string' ? claims.sub : digest(auth.accessToken) };
  }
  async assertIdentity(identity) { const current = await this.identity(identity.accountId); if (current.subject !== identity.subject) fail('ACCOUNT_CHANGED', 'The signed-in user changed during the widget request.'); }
  request(method, path, identity, options = {}) { return this.transport.request(method, ROOT + path, { ...options, expectedAccountId: identity.accountId }); }
  async context(args, identity) {
    id(args.threadId, 'Dot thread ID');
    const profile = await this.request('GET', `/tbo/by-thread/${encodeURIComponent(args.threadId)}`, identity, { signal: args.signal });
    const roomId = validateRoom(args.roomId ?? profile?.messaging_room_id);
    if (profile?.messaging_room_id !== roomId) fail('WIDGET_UNAVAILABLE', 'The selected thread does not belong to this messaging room.');
    await this.assertIdentity(identity); return { accountId: identity.accountId, roomId, threadId: args.threadId };
  }
  async page(context, identity, query, signal) {
    const data = await this.request('GET', `/messaging/rooms/${context.roomId}/messages`, identity, { query: { limit: 20, ...query }, signal });
    if (!Array.isArray(data?.items)) fail('INVALID_RESPONSE', 'The widget history response has no items.');
    // The native room API may omit cursors even on a full page. Its oldest
    // raw message ID is the before boundary, including hidden records.
    const boundary = data.items.length >= 20 && typeof data.items[0]?.id === 'string' ? data.items[0].id : null;
    return { ...data, prev_cursor: data.prev_cursor ?? boundary };
  }
  async list(args = {}) {
    if (args.before !== undefined) string(args.before, 'history cursor');
    const identity = await this.identity(args.expectedAccountId), context = await this.context(args, identity);
    const page = await this.page(context, identity, { before: args.before }, args.signal);
    const cards = [...page.items].sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)).flatMap(project), latest = new Map();
    for (const card of cards) latest.set(card.sessionKey, card);
    await this.assertIdentity(identity);
    return { ...context, widgets: cards.map(card => ({ ...publicCard(card, context), replaced: latest.get(card.sessionKey) !== card })), prevCursor: page.prev_cursor ?? null };
  }
  async current(args, identity) {
    id(args.messageId, 'message ID'); id(args.attachmentId, 'widget attachment ID'); if (args.widgetMessageId !== undefined) id(args.widgetMessageId, 'widget message ID');
    const context = await this.context(args, identity), first = await this.page(context, identity, {}, args.signal);
    const firstDigest = digest(first.items); const seen = new Set(); let page = first, found, newer = [];
    for (let count = 0; count < 100; count++) {
      const ordered = [...page.items].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
      for (const item of ordered) {
        const cards = project(item);
        if (item.id === args.messageId) {
          const matches = cards.filter(card => card.attachmentId === args.attachmentId && (args.widgetMessageId === undefined || card.widgetMessageId === args.widgetMessageId));
          if (matches.length !== 1) fail('WIDGET_UNAVAILABLE', 'Choose one current widget message in this attachment.');
          found = matches[0];
          const laterInAttachment = cards.slice(cards.indexOf(found) + 1);
          const ambiguousTime = page.items.filter(other => other.id !== item.id && other.created_at === item.created_at).flatMap(project);
          if (found.closed || [...newer, ...laterInAttachment, ...ambiguousTime].some(card => card.sessionKey === found.sessionKey)) fail('STALE_ACTION', 'This widget was closed or replaced by a newer card.');
          break;
        }
        newer.push(...cards);
      }
      if (found) break;
      const cursor = page.prev_cursor; if (!cursor) break;
      if (typeof cursor !== 'string' || seen.has(cursor)) fail('CURSOR_LOOP', 'The widget history repeated a cursor.');
      seen.add(cursor); page = await this.page(context, identity, { before: cursor }, args.signal);
    }
    if (!found) fail('WIDGET_UNAVAILABLE', 'The selected visible widget could not be found within the history limit.');
    const fresh = await this.page(context, identity, {}, args.signal);
    if (digest(fresh.items) !== firstDigest) fail('STALE_ACTION', 'The conversation changed while inspecting this widget. Inspect it again.');
    await this.assertIdentity(identity);
    return { card: found, context, public: publicCard(found, context) };
  }
  async inspect(args = {}) { return (await this.current(args, await this.identity(args.expectedAccountId))).public; }
  async bound(args, identity) {
    string(args.requestFingerprint, 'widget fingerprint', 64);
    const state = await this.current(args, identity);
    if (state.public.requestFingerprint !== args.requestFingerprint) fail('STALE_ACTION', 'The widget changed. Inspect it again before acting.');
    const links = await this.request('POST', '/aip/connectors/links/list_accessible', identity, { body: { principals: [], link_refresh_strategy: 'NONE' }, headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, signal: args.signal });
    const matches = Array.isArray(links?.links) ? links.links.filter(link => link?.id === state.card.linkId && link.connector_id === state.card.connectorId) : [];
    if (matches.length > 1) fail('INVALID_RESPONSE', 'The widget connection list is ambiguous.');
    const link = matches[0];
    if (!link || link.auth_status !== 'ACTIVE' || link.visibility === 'HIDDEN' || ['DISABLED', 'DISABLED_BY_ADMIN'].includes(link.connector_status) || link.unavailable_reason != null) fail('CONNECTION_UNAVAILABLE', 'The widget connection is not active and accessible.');
    await this.assertIdentity(identity); return state;
  }
  async invoke(state, identity, method, params, signal, descriptor) {
    if (!METHODS.has(method)) fail('INVALID_ARGUMENT', 'Unsupported native widget method.');
    await this.assertIdentity(identity); signal?.throwIfAborted();
    const sku = state.card.productSku;
    if (method === 'tools/list') return readNativeToolCatalog(this.transport, { connectorId: state.card.connectorId, linkId: state.card.linkId,
      cursor: params.cursor, threadId: state.context.threadId, productSku: sku === 'TPP' ? 'TPP' : 'CODEX', expectedAccountId: identity.accountId, signal,
      assertCurrent: () => this.assertIdentity(identity), beforeContinue: () => this.bound({ ...state.public, signal }, identity) });
    if (sku === 'aeon' || method === 'resources/list' || method === 'prompts/list') {
      const result = await this.request('POST', '/ecosystem/call_mcp', identity, { headers: { 'OAI-Product-Sku': sku }, body: { app_uri: state.card.appUri, conversation_id: null, thread_id: state.context.threadId, launcher_host: 'chatgpt', message_id: state.card.originalMessageId, method, params }, signal,
        ...(['resources/list', 'resources/templates/list', 'prompts/list'].includes(method) ? { maxBytes: MCP_CATALOG_MAX_BYTES } : {}) });
      await this.assertIdentity(identity); return result;
    }
    if (!['CODEX', 'TPP'].includes(sku)) fail('WIDGET_UNAVAILABLE', 'The widget product is unsupported.');
    let nativeParams = { ...(params.cursor === undefined ? {} : { cursor: params.cursor }) };
    if (method === 'tools/call') {
      const name = actionName(params.name, state.card), resourceUri = `/${state.card.connectorId}/${state.card.linkId}/${name}`;
      const declared = descriptor?._meta?._codex_apps, binding = nativeToolBinding(descriptor);
      if (declared != null && (!object(declared) || declared.resource_uri !== resourceUri && !(binding?.syntheticSelection && binding.connectorId === state.card.connectorId && binding.linkId === state.card.linkId))) fail('TOOL_UNAVAILABLE', 'The native tool descriptor does not match this widget connection.');
      nativeParams = { name: binding?.nativeName ?? name, arguments: params.arguments, _meta: { ...params._meta, _codex_apps: {
        resource_uri: binding?.resourceUri ?? resourceUri,
        ...(declared?.requires_explicit_link_id === true ? { requires_explicit_link_id: true } : {}),
        ...(declared?.contains_mcp_source === true ? { contains_mcp_source: true } : {}) } } };
    } else if (method === 'resources/read') nativeParams = { uri: params.uri, _meta: { connector_id: state.card.connectorId, link_id: state.card.linkId } };
    let requestState;
    for (let round = 0; round < CONTINUATION_LIMIT; round++) {
      await this.assertIdentity(identity); signal?.throwIfAborted();
      const requestId = randomUUID(), result = nativeResult(await this.request('POST', '/ps/mcp', identity, {
        headers: { 'OAI-Product-Sku': sku }, signal,
        ...(method === 'resources/templates/list' ? { maxBytes: MCP_CATALOG_MAX_BYTES } : {}),
        body: { jsonrpc: '2.0', id: requestId, method, params: { ...nativeParams, _meta: { ...nativeParams._meta,
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } },
          'x-codex-turn-metadata': { ...(method === 'tools/call' ? { source: 'mcp_app' } : {}),
            ...(method === 'tools/list' ? { mcp_request_meta: { selected_connector_ids: [state.card.connectorId] } } : {}), thread_id: state.context.threadId } } },
          ...(requestState === undefined ? {} : { requestState, inputResponses: {} }) }
      }), requestId);
      await this.assertIdentity(identity); signal?.throwIfAborted();
      if (result.resultType !== 'input_required') return result;
      if (round === CONTINUATION_LIMIT - 1) fail('CONTINUATION_LIMIT', 'The native widget exceeded 32 continuation responses. No request was restarted.');
      if (result.inputRequests != null && (!object(result.inputRequests) || Object.keys(result.inputRequests).some(key => RESERVED.has(key)))) fail('INVALID_RESPONSE', 'The native widget input request is invalid.');
      if (Object.keys(result.inputRequests ?? {}).length > 0) return result;
      if (typeof result.requestState !== 'string' || result.requestState.length > 65536) fail('INVALID_RESPONSE', 'The native widget returned an empty or invalid continuation.');
      requestState = result.requestState;
      await pauseContinuation(signal);
      // The opaque state can only be reused for the same current, visible card,
      // signed-in identity and active link. It is never returned or persisted.
      await this.bound({ ...state.public, signal }, identity);
    }
  }
  async catalog(args, method, field) {
    const identity = await this.identity(args.expectedAccountId), state = await this.bound(args, identity);
    if (args.cursor !== undefined) string(args.cursor, 'catalog cursor');
    const result = await this.invoke(state, identity, method, args.cursor === undefined ? {} : { cursor: args.cursor }, args.signal);
    if (inputRequired(result)) return { ...state.public, ...inputRequired(result) };
    if (!Array.isArray(result?.[field])) fail('INVALID_RESPONSE', 'The widget catalog response is invalid.');
    const projected = json(result[field]);
    if (JSON.stringify(projected).length > 1024 * 1024) fail('INVALID_RESPONSE', 'The widget catalog exceeds its output limit.');
    return { ...state.public, [field]: projected, nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null };
  }
  tools(args = {}) { return this.catalog(args, 'tools/list', 'tools'); }
  resources(args = {}) { return this.catalog(args, 'resources/list', 'resources'); }
  resourceTemplates(args = {}) { return this.catalog(args, 'resources/templates/list', 'resourceTemplates'); }
  prompts(args = {}) { return this.catalog(args, 'prompts/list', 'prompts'); }
  async findDescriptor(state, identity, args, method, field, predicate) {
    let cursor, found; const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const result = await this.invoke(state, identity, method, cursor === undefined ? {} : { cursor }, args.signal);
      if (inputRequired(result)) fail('WIDGET_INPUT_REQUIRED', inputRequired(result).message, { requiresNativeContinuation: true });
      if (!Array.isArray(result?.[field])) fail('INVALID_RESPONSE', 'The widget catalog response is invalid.');
      const matches = result[field].filter(predicate);
      if (matches.length > 1 || found && matches.length) fail('INVALID_RESPONSE', 'The widget catalog contains an ambiguous entry.');
      if (matches.length) found = matches[0];
      if (result.nextCursor == null) return found ?? null;
      string(result.nextCursor, 'catalog cursor'); if (seen.has(result.nextCursor)) fail('CURSOR_LOOP', 'The widget catalog repeated a cursor.'); seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    fail('PAGE_LIMIT', 'The widget catalog exceeded its page limit.');
  }
  async call(args = {}) {
    string(args.toolName, 'tool name', 2048); if (args.confirmTool !== args.toolName) fail('CONFIRMATION_REQUIRED', 'Confirm the exact widget tool name before invoking it.');
    if (!object(args.arguments)) fail('INVALID_ARGUMENT', 'Tool arguments must be a JSON object.');
    const identity = await this.identity(args.expectedAccountId), state = await this.bound(args, identity), name = actionName(args.toolName, state.card);
    const descriptor = await this.findDescriptor(state, identity, args, 'tools/list', 'tools', tool => tool?.name === name);
    if (!descriptor || !object(descriptor.inputSchema)) fail('TOOL_UNAVAILABLE', 'That tool and its input schema were not returned by this widget.');
    let argumentsValue = args.arguments;
    if (nativeToolBinding(descriptor)?.syntheticSelection) {
      if (Object.hasOwn(args.arguments, 'link_id') && args.arguments.link_id !== state.card.linkId) fail('INVALID_ARGUMENT', 'Tool arguments select a different widget connection.');
      argumentsValue = { ...args.arguments, link_id: state.card.linkId };
    }
    const input = await validateActionForm(argumentsValue, descriptor.inputSchema, { signal: args.signal });
    const wireInput = { ...input };
    if (state.card.productSku === 'aeon' && nativeToolBinding(descriptor)?.syntheticSelection) delete wireInput.link_id;
    await this.bound(args, identity);
    const result = await this.invoke(state, identity, 'tools/call', { name, arguments: wireInput, _meta: { 'openai/action_name': name, 'openai/connector_id': state.card.connectorId, 'openai/link_id': state.card.linkId } }, args.signal, descriptor);
    return { ...state.public, toolName: args.toolName, ...projectedResult(result) };
  }
  async readResource(args = {}) {
    const uri = safeUri(args.uri); if (!uri) fail('INVALID_ARGUMENT', 'Choose an exact resource URI returned by this widget.');
    const identity = await this.identity(args.expectedAccountId), state = await this.bound(args, identity);
    const descriptor = await this.findDescriptor(state, identity, args, 'resources/list', 'resources', resource => resource?.uri === uri);
    if (!descriptor) fail('RESOURCE_UNAVAILABLE', 'That resource was not listed by this widget.');
    if (state.card.productSku === 'aeon' && !state.card.sourceAction) fail('RESOURCE_UNAVAILABLE', 'This widget lacks the source action needed to bind a resource read.');
    const action = state.card.sourceAction ? actionName(state.card.sourceAction, state.card) : undefined;
    await this.bound(args, identity);
    const result = await this.invoke(state, identity, 'resources/read', { uri, _meta: { 'openai/action_name': action, 'openai/connector_id': state.card.connectorId, 'openai/link_id': state.card.linkId } }, args.signal);
    if (inputRequired(result)) return { ...state.public, uri, ...inputRequired(result) };
    if (!Array.isArray(result?.contents) || result.contents.some(item => item?.uri !== uri)) fail('INVALID_RESPONSE', 'The resource response did not match the selected widget URI.');
    if (args.output !== undefined) {
      string(args.output, 'output file');
      if (result.contents.length !== 1) fail('INVALID_RESPONSE', 'Saving a resource requires exactly one content item.');
      const item = result.contents[0]; let bytes;
      if (typeof item.text === 'string') bytes = Buffer.from(item.text, 'utf8');
      else if (typeof item.blob === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob)) bytes = Buffer.from(item.blob, 'base64');
      else fail('INVALID_RESPONSE', 'The resource contains no valid text or base64 content.');
      if (bytes.length > 10 * 1024 * 1024) fail('INVALID_RESPONSE', 'The resource exceeds the 10 MiB output limit.');
      const output = await writePrivate(args.output, bytes, { overwrite: args.overwrite === true });
      return { ...state.public, uri, output, bytes: bytes.length, mimeType: typeof item.mimeType === 'string' ? item.mimeType : null };
    }
    if (result.contents.some(item => typeof item.blob === 'string')) fail('BINARY_OUTPUT_REQUIRED', 'Use --output to save this binary resource privately.');
    return { ...state.public, uri, contents: result.contents.map(item => ({ uri, ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}), ...(typeof item.text === 'string' ? { text: item.text } : {}) })) };
  }
}
