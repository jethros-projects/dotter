import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// Native D7o/jfr/C7o: scope tools/list by selected_connector_ids. Unlike the
// ecosystem catalog, this does not repeat the full connector on every tool.
export const MCP_CATALOG_MAX_BYTES = 32 * 1024 * 1024;
const bindings = new WeakMap();
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const ACTION = /^[A-Za-z0-9_.:-]{1,256}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new DotError(code, message); };
export const nativeToolBinding = descriptor => bindings.get(descriptor);

export function normalizeNativeTools(result, { connectorId, linkId } = {}) {
  if (!object(result) || !Array.isArray(result.tools)) fail('INVALID_RESPONSE', 'The native tool catalog is invalid.');
  if (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 8192 || /[\0\r\n]/.test(result.nextCursor))) fail('INVALID_RESPONSE', 'The native tool cursor is invalid.');
  const names = new Set();
  const tools = result.tools.map(tool => {
    const meta = tool?._meta, routing = meta?._codex_apps;
    const match = typeof routing?.resource_uri === 'string' && /^\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(routing.resource_uri);
    if (!object(tool) || typeof tool.name !== 'string' || tool.name.length > 2048 || /[\0\r\n]/.test(tool.name) || !object(tool.inputSchema) || !match || !ID.test(match[1]) || !ID.test(match[2]) || !ACTION.test(match[3])
        || match[1] !== connectorId || meta.connector_id != null && meta.connector_id !== connectorId
        || meta.link_id != null && meta.link_id !== match[2] || meta.resource_name != null && meta.resource_name !== tool.name
        || ['requires_explicit_link_id', 'contains_mcp_source'].some(key => Object.hasOwn(routing, key) && typeof routing[key] !== 'boolean')
        || !(tool.name === match[3] || tool.name === routing.resource_uri || tool.name.endsWith(`.${match[3]}`))) fail('INVALID_RESPONSE', 'A native tool descriptor does not match the selected connector.');
    const syntheticSelection = routing.requires_explicit_link_id === true;
    if (meta.link_accounts != null && !Array.isArray(meta.link_accounts)) fail('INVALID_RESPONSE', 'The native tool account list is invalid.');
    if (linkId !== undefined && linkId !== match[2] && !(Array.isArray(meta.link_accounts) && meta.link_accounts.some(link => link?.link_id === linkId))) fail('CONNECTION_UNAVAILABLE', 'The native tool catalog does not include the selected link.');
    if (syntheticSelection && !object(tool.inputSchema.properties?.link_id)) fail('INVALID_RESPONSE', 'The native tool lacks its declared link selector.');
    if (names.has(match[3])) fail('INVALID_RESPONSE', 'The native tool catalog contains ambiguous action names.');
    names.add(match[3]);
    const normalized = { ...tool, name: match[3] };
    const linkIds = Object.freeze([...new Set([match[2], ...(meta.link_accounts ?? []).map(link => link?.link_id).filter(link => typeof link === 'string' && ID.test(link))])]);
    const routingMetadata = Object.freeze({ resource_uri: routing.resource_uri,
      ...Object.hasOwn(routing, 'requires_explicit_link_id') ? { requires_explicit_link_id: routing.requires_explicit_link_id } : {},
      ...Object.hasOwn(routing, 'contains_mcp_source') ? { contains_mcp_source: routing.contains_mcp_source } : {} });
    bindings.set(normalized, Object.freeze({ connectorId, linkId: linkId ?? match[2], linkIds, actionName: match[3], nativeName: tool.name, resourceUri: routing.resource_uri, routingMetadata, syntheticSelection }));
    return normalized;
  });
  return { ...result, tools };
}

function pause(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error === undefined ? resolve() : reject(error); };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(), 1000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

export async function readNativeToolCatalog(transport, { connectorId, linkId, cursor, threadId, conversationId, productSku = 'CODEX', expectedAccountId, signal, assertCurrent, beforeContinue } = {}) {
  if (typeof connectorId !== 'string' || !ID.test(connectorId) || linkId !== undefined && (typeof linkId !== 'string' || !ID.test(linkId)) || !['CODEX', 'TPP'].includes(productSku)) fail('INVALID_ARGUMENT', 'Select a valid native catalog connection.');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\0\r\n]/.test(cursor))) fail('INVALID_ARGUMENT', 'Use a valid native catalog cursor.');
  if ([threadId, conversationId].some(value => value != null && (typeof value !== 'string' || !ID.test(value)))) fail('INVALID_ARGUMENT', 'Use a valid native catalog context.');
  let requestState;
  for (let round = 0; round < 32; round++) {
    await assertCurrent?.(); signal?.throwIfAborted();
    const id = randomUUID(), response = await transport.request('POST', '/backend-api/ps/mcp', {
      expectedAccountId, signal, maxBytes: MCP_CATALOG_MAX_BYTES, headers: { 'OAI-Product-Sku': productSku },
      body: { jsonrpc: '2.0', id, method: 'tools/list', params: { ...(cursor === undefined ? {} : { cursor }), _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } },
        'x-codex-turn-metadata': { mcp_request_meta: { selected_connector_ids: [connectorId] }, ...(threadId == null ? {} : { thread_id: threadId }), ...(conversationId == null ? {} : { chatgpt_conversation_id: conversationId }) }
      } }, ...(requestState === undefined ? {} : { requestState, inputResponses: {} }) }
    });
    await assertCurrent?.(); signal?.throwIfAborted();
    if (!object(response) || response.jsonrpc !== '2.0' || response.id !== id || Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) fail('INVALID_RESPONSE', 'The native catalog response did not match its request.');
    if (Object.hasOwn(response, 'error')) {
      if (!object(response.error) || !Number.isInteger(response.error.code) || typeof response.error.message !== 'string') fail('INVALID_RESPONSE', 'The native catalog error is invalid.');
      throw new DotError('MCP_ERROR', 'The native tool catalog failed.', { jsonRpcCode: response.error.code });
    }
    const result = response.result;
    if (!object(result)) fail('INVALID_RESPONSE', 'The native tool catalog result is invalid.');
    if (result.resultType !== 'input_required') return normalizeNativeTools(result, { connectorId, linkId });
    if (result.inputRequests != null && (!object(result.inputRequests) || Object.keys(result.inputRequests).some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))) fail('INVALID_RESPONSE', 'The native catalog input request is invalid.');
    if (Object.keys(result.inputRequests ?? {}).length) return { resultType: 'input_required' };
    if (typeof result.requestState !== 'string' || result.requestState.length > 65536) fail('INVALID_RESPONSE', 'The native catalog continuation is invalid.');
    requestState = result.requestState;
    if (round === 31) fail('CONTINUATION_LIMIT', 'The native catalog exceeded 32 continuation responses.');
    await pause(signal);
    await beforeContinue?.();
  }
}
