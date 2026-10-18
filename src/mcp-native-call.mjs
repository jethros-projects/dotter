import { randomUUID, createHash } from 'node:crypto';
import { DotError } from './errors.mjs';
import { nativeToolBinding } from './mcp-catalog.mjs';
import { validateActionForm } from './action-forms.mjs';

// Native D7o uses the original qualified name, routing descriptor and UI source
// discriminator without requiring a turn or conversation. C7o supplies these
// exact protocol capabilities and continuation fields.
const PROTOCOL = '2026-07-28';
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
export async function nativeToolIdentityGuard(transport, expectedAccountId) {
  if (typeof transport.authLoader !== 'function') return Object.assign(async () => {}, { accountId: expectedAccountId });
  const read = async () => {
    const auth = await transport.authLoader({ authFile: transport.authFile });
    if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken || typeof auth.accountId !== 'string' || !auth.accountId) fail('AUTH_ACCOUNT_REQUIRED', 'Native tool calls require an authenticated account.');
    if (expectedAccountId !== undefined && expectedAccountId !== auth.accountId) fail('ACCOUNT_CHANGED', 'The native tool account changed.');
    transport.assertIdentity?.(auth);
    let subject; try { subject = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub; } catch {}
    return { accountId: auth.accountId, subject: typeof subject === 'string' ? subject : createHash('sha256').update(auth.accessToken).digest('hex') };
  };
  const first = await read();
  return Object.assign(async () => { const current = await read(); if (current.accountId !== first.accountId || current.subject !== first.subject) fail('AUTH_IDENTITY_CHANGED', 'The authenticated native tool identity changed.'); }, { accountId: first.accountId });
}
export function hasNativeWidgetTemplate(descriptor) {
  const meta = descriptor?._meta;
  return typeof meta?.ui?.resourceUri === 'string' && meta.ui.resourceUri.trim().length > 0
    || typeof meta?.['openai/outputTemplate'] === 'string' && meta['openai/outputTemplate'].trim().length > 0;
}
function responseResult(response, id) {
  if (!record(response) || response.jsonrpc !== '2.0' || response.id !== id || Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) fail('INVALID_RESPONSE', 'The native tool response did not match its JSON-RPC request.');
  if (Object.hasOwn(response, 'error')) {
    if (!record(response.error) || !Number.isInteger(response.error.code) || typeof response.error.message !== 'string') fail('INVALID_RESPONSE', 'The native tool error response was invalid.');
    fail('MCP_ERROR', 'The native tool request failed.', { jsonRpcCode: response.error.code });
  }
  if (!record(response.result)) fail('INVALID_RESPONSE', 'The native tool result was invalid.');
  return response.result;
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
function protocolMetadata(turnMetadata) {
  return {
    'x-codex-turn-metadata': turnMetadata,
    'io.modelcontextprotocol/protocolVersion': PROTOCOL,
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} }, extensions: { 'openai/elicitation': { form: {} } } },
  };
}
async function nativeRequest(transport, { method, params, productSku, expectedAccountId, signal, assertCurrent, beforeRequest }) {
  let requestState;
  for (let round = 0; round < 32; round++) {
    signal?.throwIfAborted(); await assertCurrent(); await beforeRequest?.();
    const id = randomUUID();
    const response = await transport.request('POST', '/backend-api/ps/mcp', {
      expectedAccountId, signal, headers: { 'OAI-Product-Sku': productSku },
      body: { jsonrpc: '2.0', id, method, params,
        ...(requestState === undefined ? {} : { requestState, inputResponses: {} }) },
    });
    signal?.throwIfAborted(); await assertCurrent();
    const result = responseResult(response, id);
    if (result.resultType !== 'input_required') {
      const { requestState: _state, inputRequests: _requests, inputResponses: _responses, ...completed } = result;
      return completed;
    }
    if (result.inputRequests != null && (!record(result.inputRequests) || Object.keys(result.inputRequests).some(key => RESERVED.has(key)))) fail('INVALID_RESPONSE', 'The native request input requirement was invalid.');
    if (Object.keys(result.inputRequests ?? {}).length) return { resultType: 'input_required', requiresNativeContinuation: true,
      message: 'This request requires interactive input. No input was guessed and the request was not restarted.' };
    if (typeof result.requestState !== 'string' || !result.requestState || result.requestState.length > 65536) fail('INVALID_RESPONSE', 'The native request returned an invalid continuation state.');
    requestState = result.requestState;
    if (round === 31) fail('CONTINUATION_LIMIT', 'The native request exceeded 32 continuation responses. No request was restarted.');
    await pause(signal);
  }
}
export async function callNativeTool(transport, { descriptor, connectorId, linkId, arguments: input = {}, productSku = 'CODEX', expectedAccountId, signal, assertCurrent } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Native tools require a Dot transport.');
  if (!['CODEX', 'TPP'].includes(productSku)) fail('INVALID_ARGUMENT', 'The native tool product scope must be CODEX or TPP.');
  const binding = nativeToolBinding(descriptor), routing = descriptor?._meta?._codex_apps;
  if (!binding || binding.connectorId !== connectorId || !record(routing) || routing.resource_uri !== binding.resourceUri
    || ![Object.prototype, null].includes(Object.getPrototypeOf(routing)) || Object.keys(routing).some(key => RESERVED.has(key))
    || ['requires_explicit_link_id', 'contains_mcp_source'].some(key => Object.hasOwn(routing, key) !== Object.hasOwn(binding.routingMetadata, key) || routing[key] !== binding.routingMetadata[key])
    || descriptor.name !== binding.actionName || descriptor._meta?.resource_name != null && descriptor._meta.resource_name !== binding.nativeName) fail('INVALID_ARGUMENT', 'Use an unchanged tool descriptor from this connector’s native catalog.');
  const selected = linkId ?? binding.linkId;
  if (!binding.linkIds.includes(selected)) fail('CONNECTION_UNAVAILABLE', 'The selected connection was not offered by this native tool.');
  if (!binding.syntheticSelection && selected !== binding.resourceUri.split('/')[2]) fail('CONNECTION_UNAVAILABLE', 'This native tool does not support selecting a different account connection.');
  if (!record(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('INVALID_ARGUMENT', 'Native tool arguments must be an ordinary JSON object.');
  const current = assertCurrent ?? await nativeToolIdentityGuard(transport, expectedAccountId);
  expectedAccountId ??= current.accountId;
  let args = input;
  if (binding.syntheticSelection) {
    if (Object.hasOwn(input, 'link_id') && input.link_id !== selected) fail('INVALID_ARGUMENT', 'Tool arguments select a different account connection.');
    args = { ...input, link_id: selected };
  }
  args = await validateActionForm(args, descriptor.inputSchema, { signal });
  const params = { name: binding.nativeName, arguments: args, _meta: {
    _codex_apps: { ...binding.routingMetadata },
    ...protocolMetadata({ source: 'mcp_app' }),
  } };
  return nativeRequest(transport, { method: 'tools/call', params, productSku, expectedAccountId, signal, assertCurrent: current });
}

// Native K7o constructs a resource client from an explicit connector/link and
// accepts its URI without a conversation, message, or tool-catalog dependency.
export async function readNativeResource(transport, { connectorId, linkId, uri, expectedAccountId, signal, assertCurrent } = {}) {
  if (typeof transport?.request !== 'function') throw new TypeError('Native resources require a Dot transport.');
  if (![connectorId, linkId].every(value => typeof value === 'string' && ID.test(value) && !['.', '..'].includes(value))) fail('INVALID_ARGUMENT', 'Native resource reads require an explicit connector and account connection.');
  let parsed;
  try { parsed = new URL(uri); } catch {}
  if (typeof uri !== 'string' || uri.length > 8192 || /[\x00-\x20\x7f]/.test(uri) || /%(?![0-9a-f]{2})/i.test(uri)
    || !uri.startsWith('ui://') || parsed?.protocol !== 'ui:' || !parsed.hostname || parsed.username || parsed.password) fail('INVALID_ARGUMENT', 'Use a valid ui:// resource URI.');
  const current = assertCurrent ?? await nativeToolIdentityGuard(transport, expectedAccountId);
  expectedAccountId ??= current.accountId;
  const verifyConnection = async () => {
    const data = await transport.request('POST', '/backend-api/aip/connectors/links/list_accessible', {
      expectedAccountId, signal, headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' },
      body: { principals: [], link_refresh_strategy: 'NONE' },
    });
    await current();
    if (!record(data) || !Array.isArray(data.links)) fail('INVALID_RESPONSE', 'The resource connection list was invalid.');
    const matches = data.links.filter(link => link?.id === linkId && link?.connector_id === connectorId);
    if (matches.length > 1) fail('INVALID_RESPONSE', 'The resource connection list was ambiguous.');
    const link = matches[0];
    if (!link || link.auth_status !== 'ACTIVE' || ['HIDDEN', 'hidden'].includes(link.visibility) || link.hidden === true || link.is_hidden === true
      || ['DISABLED', 'DISABLED_BY_ADMIN'].includes(link.connector_status) || link.unavailable_reason != null) fail('CONNECTION_UNAVAILABLE', 'The selected resource connection is not active and accessible.');
  };
  const result = await nativeRequest(transport, { method: 'resources/read', productSku: 'CODEX', expectedAccountId, signal, assertCurrent: current,
    beforeRequest: verifyConnection, params: { uri, _meta: { connector_id: connectorId, link_id: linkId, ...protocolMetadata({}) } } });
  if (result.resultType === 'input_required') return result;
  if (!Array.isArray(result.contents) || result.contents.some(content => {
    if (!record(content) || content.uri !== uri || Object.hasOwn(content, 'mimeType') && typeof content.mimeType !== 'string') return true;
    const text = Object.hasOwn(content, 'text'), blob = Object.hasOwn(content, 'blob');
    if (text === blob) return true;
    if (text) return typeof content.text !== 'string';
    return typeof content.blob !== 'string' || !BASE64.test(content.blob) || Buffer.from(content.blob, 'base64').toString('base64') !== content.blob;
  })) fail('INVALID_RESPONSE', 'The native resource contents did not match the requested URI or resource format.');
  return result;
}
