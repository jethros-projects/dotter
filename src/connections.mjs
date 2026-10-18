import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// Observed in ChatGPT.app app-initial-90eb42395b7d.js (connector auth,
// OAuth callback) and skills-a364ed93ac4b.js (account unlink), 2026-10-17.
// Browser authorization remains interactive; starting it is not connecting.
const ROOT = '/backend-api/aip/connectors';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const HEADERS = Object.freeze({ 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'connector_setup' });
const SETTINGS_HEADERS = Object.freeze({ 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'settings' });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const MAX_SECRET = 64 * 1024;
const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const APP_PASSWORD_CONNECTORS = new Set(['connector_6a99cb6846448190875813bf1e8e5504', 'connector_6a99cb684648819088fe4d6a0e373614']);

export function normalizeConnectorId(value) {
  return typeof value === 'string' && value.startsWith('asdk_app_') ? `connector_${value.slice(9)}` : value;
}
function sameConnector(actual, expected, aliases = false) {
  return typeof actual === 'string' && (aliases ? normalizeConnectorId(actual) === normalizeConnectorId(expected) : actual === expected);
}

function fail(code, message) { throw new DotError(code, message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ARGUMENT', `${name} must be an ID returned by the API.`);
  return value;
}
function text(value, name, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    fail('INVALID_ARGUMENT', `${name} must be a nonempty single-line string of at most ${max} characters.`);
  }
  return value;
}
function strings(value, name, max = 100) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max) fail('INVALID_ARGUMENT', `${name} must be an array of at most ${max} strings.`);
  return [...new Set(value.map(item => text(item, name, 1024)))];
}
function linkParams(value) {
  if (value === undefined) return undefined;
  if (!record(value)) fail('INVALID_ARGUMENT', 'linkParams must be a JSON object.');
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('INVALID_ARGUMENT', 'linkParams must be JSON serializable.'); }
  if (serialized.length > MAX_SECRET) fail('INVALID_ARGUMENT', 'linkParams exceeds the size limit.');
  return JSON.parse(serialized);
}
function routeId(value, name) { return encodeURIComponent(id(value, name)); }
function scalarFields(value, fields) {
  return Object.fromEntries(fields.filter(key => OWN(value, key)
    && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])))
    .map(key => [key, value[key]]));
}
function publicConnector(value, expectedId, aliases = false) {
  if (!record(value) || !sameConnector(value.id, expectedId, aliases) || typeof value.name !== 'string' || !value.name.trim() || !Array.isArray(value.supported_auth)) {
    fail('INVALID_RESPONSE', 'The connector response did not match the requested connector.');
  }
  return { ...scalarFields(value, ['id', 'name', 'description', 'status', 'service', 'template_id', 'connector_type']),
    supportedAuth: value.supported_auth.filter(item => record(item) && typeof item.type === 'string').map(item => item.type),
    requiredLinkParams: record(value.link_params_schema) && Array.isArray(value.link_params_schema.required)
      ? value.link_params_schema.required.filter(item => typeof item === 'string') : [] };
}
function publicLink(value, expectedConnectorId, aliases = false) {
  if (!record(value) || typeof value.id !== 'string' || !sameConnector(value.connector_id, expectedConnectorId, aliases)) {
    fail('INVALID_RESPONSE', 'The connection response did not match the requested connector.');
  }
  id(value.id, 'linkId');
  return scalarFields(value, ['id', 'connector_id', 'name', 'auth_type', 'auth_status', 'connector_status', 'unavailable_reason', 'created_at']);
}
function accessibleLink(value, connectorId, linkId, aliases = false) {
  return record(value) && sameConnector(value.connector_id, connectorId, aliases) && value.id === linkId
    && value.visibility !== 'HIDDEN' && value.visibility !== 'hidden' && value.hidden !== true && value.is_hidden !== true
    && !value.id.startsWith('implicit_link::');
}
function authorizationUrl(value) {
  let url;
  try { url = new URL(text(value, 'authorization URL', MAX_SECRET)); } catch { fail('INVALID_RESPONSE', 'The authorization response did not contain a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => /^(?:access_token|id_token|refresh_token|client_secret|password)$/i.test(key))) {
    fail('INVALID_RESPONSE', 'The authorization response did not contain a safe HTTPS authorization URL.');
  }
  return url.toString();
}
function postAuthUrl(connectorId) {
  const url = new URL('https://chatgpt.com/');
  url.hash = `settings/Connectors?${new URLSearchParams({ connector: connectorId, 'product-sku': 'CODEX', referrer: 'codex' })}`;
  return url.toString();
}
async function privateInput(file, input, name) {
  if (typeof file !== 'string' || !file.trim()) fail('INVALID_ARGUMENT', `Choose a ${name} file, or '-' to read it from standard input.`);
  let bytes;
  if (file === '-') {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function') fail('INVALID_ARGUMENT', `A readable stream is required for ${name} standard input.`);
    if (input.isTTY) fail('INVALID_ARGUMENT', `Pipe ${name} from a private source; interactive terminal input may echo secrets.`);
    const chunks = []; let size = 0;
    for await (const chunk of input) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_SECRET) fail('INVALID_ARGUMENT', `${name} input exceeds the size limit.`);
      chunks.push(part);
    }
    bytes = Buffer.concat(chunks);
  } else {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SECRET) fail('INVALID_ARGUMENT', `${name} must be a regular file of at most 64 KiB.`);
      const chunks = []; let size = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(8192, MAX_SECRET + 1 - size));
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) break;
        chunks.push(buffer.subarray(0, result.bytesRead));
        size += result.bytesRead;
        if (size > MAX_SECRET) fail('INVALID_ARGUMENT', `${name} input exceeds the size limit.`);
      }
      bytes = Buffer.concat(chunks);
      if (bytes.length > MAX_SECRET) fail('INVALID_ARGUMENT', `${name} input exceeds the size limit.`);
    } catch (error) {
      if (error instanceof DotError) throw error;
      fail('PRIVATE_INPUT_UNREADABLE', `Cannot read the selected ${name} file. Use a regular file, not a symbolic link.`);
    } finally { await handle?.close(); }
  }
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { fail('INVALID_ARGUMENT', `${name} input must be UTF-8 text.`); }
  return text(value, name, MAX_SECRET);
}

export class DotConnections {
  constructor(client, { productSku = 'CODEX', assertCurrent } = {}) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotConnections requires a DotClient.');
    if (!['CODEX', 'CHATGPT_PROJECTS'].includes(productSku)) fail('INVALID_ARGUMENT', 'Choose a supported connector product scope.');
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new TypeError('assertCurrent must be a function.');
    this.transport = client.transport;
    this.productSku = productSku;
    this.aliases = productSku === 'CHATGPT_PROJECTS';
    this.assertCurrent = assertCurrent;
  }
  headers(surface = 'connector_setup') {
    if (this.productSku === 'CODEX' && surface === 'connector_setup') return HEADERS;
    if (this.productSku === 'CODEX' && surface === 'settings') return SETTINGS_HEADERS;
    return { 'OAI-Product-Sku': this.productSku, 'X-Codex-Surface': surface };
  }
  async request(method, route, options = {}) {
    await this.assertCurrent?.();
    const value = await this.transport.request(method, route, options);
    try { await this.assertCurrent?.(); }
    catch (error) {
      if (method !== 'GET' && error instanceof DotError) error.details = { ...error.details, delivery: 'unknown' };
      throw error;
    }
    return value;
  }
  async account(expectedAccountId) {
    await this.assertCurrent?.();
    if (expectedAccountId !== undefined) text(expectedAccountId, 'expectedAccountId', 1024);
    if (typeof this.transport.authLoader !== 'function') return expectedAccountId;
    const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
    if (typeof auth.accountId !== 'string' || !auth.accountId) fail('AUTH_ACCOUNT_REQUIRED', 'Connector changes require a Codex login with an explicit account selector.');
    if (expectedAccountId !== undefined && expectedAccountId !== auth.accountId) fail('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
    this.transport.assertIdentity?.(auth);
    return auth.accountId;
  }
  async connector(connectorId, signal, expectedAccountId) {
    id(connectorId, 'connectorId');
    const value = await this.request('GET', `${ROOT}/${routeId(connectorId, 'connectorId')}`, {
      query: { include_actions: false }, headers: this.headers(), expectedAccountId, signal
    });
    publicConnector(value, connectorId, this.aliases);
    return value;
  }
  async get({ connectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    const accountId = await this.account(expectedAccountId);
    return publicConnector(await this.connector(connectorId, signal, accountId), connectorId, this.aliases);
  }
  async exactLink(connectorId, linkId, signal, expectedAccountId) {
    id(connectorId, 'connectorId'); id(linkId, 'linkId');
    if (linkId.startsWith('implicit_link::')) fail('INVALID_ARGUMENT', 'Implicit links cannot be changed with the CLI.');
    const response = await this.request('POST', `${ROOT}/links/list_accessible`, {
      body: { principals: [], link_refresh_strategy: this.productSku === 'CHATGPT_PROJECTS' ? 'BLOCKING' : 'NONE' },
      headers: this.headers('other'), expectedAccountId, signal
    });
    if (!Array.isArray(response?.links)) fail('INVALID_RESPONSE', 'The accessible connection response did not contain links.');
    const link = response.links.find(item => accessibleLink(item, connectorId, linkId, this.aliases));
    if (!link) fail('CONNECTION_UNAVAILABLE', 'That account connection is not accessible for the requested connector.');
    return link;
  }
  async status({ connectorId, linkId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    if (linkId !== undefined) id(linkId, 'linkId');
    const accountId = await this.account(expectedAccountId);
    const connector = publicConnector(await this.connector(connectorId, signal, accountId), connectorId, this.aliases);
    let link;
    if (linkId !== undefined) link = await this.exactLink(connectorId, linkId, signal, accountId);
    else {
      const result = await this.request('GET', `${ROOT}/${routeId(connectorId, 'connectorId')}/link`, { headers: this.headers(), expectedAccountId: accountId, signal });
      if (!record(result) || !OWN(result, 'link')) fail('INVALID_RESPONSE', 'The connection response did not contain a link field.');
      link = result.link;
    }
    const publicValue = link == null ? null : publicLink(link, connectorId, this.aliases);
    return { ...(accountId === undefined ? {} : { accountId }), connector, link: publicValue,
      connected: connector.status !== 'DISABLED_BY_ADMIN' && publicValue?.auth_status === 'ACTIVE' && link.unavailable_reason == null
        && publicValue.connector_status !== 'DISABLED_BY_ADMIN' && accessibleLink(link, connectorId, publicValue.id, this.aliases) };
  }
  async requireAuth(connectorId, authType, params, signal, expectedAccountId, validateCreationParams = true) {
    const connector = await this.connector(connectorId, signal, expectedAccountId);
    if (connector.status === 'DISABLED_BY_ADMIN') fail('CONNECTION_UNAVAILABLE', 'This connector is disabled by the workspace administrator.');
    if (APP_PASSWORD_CONNECTORS.has(connectorId)) fail('UNSUPPORTED_AUTH', 'This connector requires the app-specific password setup flow, not generic connector authentication.');
    if (!connector.supported_auth.some(item => item?.type === authType)) fail('UNSUPPORTED_AUTH', `This connector does not advertise ${authType} authentication.`);
    const required = connector.link_params_schema?.required;
    if (validateCreationParams && Array.isArray(required) && required.some(key => typeof key === 'string' && !OWN(params ?? {}, key))) {
      fail('INVALID_ARGUMENT', 'This connector requires linkParams. Inspect the connector configuration before linking.');
    }
    return connector;
  }
  async startOAuth({ connectorId, actionNames, requestedScopes, linkParams: inputParams, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    const actions = strings(actionNames, 'actionNames'), scopes = strings(requestedScopes, 'requestedScopes');
    const params = linkParams(inputParams);
    const accountId = await this.account(expectedAccountId);
    const connector = await this.requireAuth(connectorId, 'OAUTH', params, signal, accountId);
    const requestId = randomUUID();
    const body = { connector_id: connector.id, name: connector.name, action_names: actions ?? null,
      callback_url: CALLBACK, post_auth_url: postAuthUrl(connector.id), install_attempt_id: requestId };
    if (scopes !== undefined) body.requested_scopes = scopes;
    if (params !== undefined) body.link_params = params;
    const result = await this.request('POST', `${ROOT}/links/oauth`, { body, headers: this.headers(), expectedAccountId: accountId, signal });
    return { status: 'authorization_required', connectorId, requestId, ...(accountId === undefined ? {} : { accountId }),
      authorizationUrl: authorizationUrl(result?.redirect_url),
      instruction: 'Open this authorization URL in your browser and complete the provider authorization. Then check connection status.' };
  }
  async reauthorize({ connectorId, linkId, requestedScopes, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); id(linkId, 'linkId');
    const scopes = strings(requestedScopes, 'requestedScopes');
    const accountId = await this.account(expectedAccountId);
    // Existing-link reauthorization reuses its stored configuration; its
    // request contract does not accept creation-only link parameters.
    const connector = await this.requireAuth(connectorId, 'OAUTH', undefined, signal, accountId, false);
    const link = await this.exactLink(connectorId, linkId, signal, accountId);
    if (link.auth_type !== 'OAUTH') fail('UNSUPPORTED_AUTH', 'Only OAuth account connections can be reauthorized.');
    const body = { callback_url: CALLBACK, link_id: linkId, post_auth_url: postAuthUrl(connector.id) };
    if (scopes !== undefined) body.requested_scopes = scopes;
    const result = await this.request('POST', `${ROOT}/links/oauth/reauth`, { body, headers: this.headers(), expectedAccountId: accountId, signal });
    return { status: 'authorization_required', connectorId, linkId, ...(accountId === undefined ? {} : { accountId }),
      authorizationUrl: authorizationUrl(result?.redirect_url),
      instruction: 'Open this authorization URL in your browser and complete the provider authorization. Then check connection status.' };
  }
  async completeOAuth({ connectorId, redirectFile, input = process.stdin, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    const accountId = await this.account(expectedAccountId);
    const redirect = await privateInput(redirectFile, input, 'OAuth callback');
    let url;
    try { url = new URL(redirect); } catch { fail('INVALID_ARGUMENT', 'The OAuth callback input must contain one full callback URL.'); }
    const browserCallback = url.protocol === 'https:' && url.host === 'chatgpt.com'
      && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[^/]+$/.test(url.pathname));
    const nativeCallback = ['codex:', 'codex-dev:'].includes(url.protocol) && url.host === 'connector' && url.pathname === '/oauth_callback';
    if ((!browserCallback && !nativeCallback) || url.username || url.password || url.hash
        || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')) {
      fail('INVALID_ARGUMENT', 'The input must be a ChatGPT connector OAuth callback with exactly one nonempty state parameter.');
    }
    if (url.searchParams.has('error')) fail('OAUTH_CANCELLED', 'The provider returned an OAuth error. Start authorization again.');
    // The API verifies its signed OAuth state. Never print the callback URL/code.
    const result = await this.request('POST', `${ROOT}/links/oauth/callback`, {
      body: { full_redirect_url: redirect }, headers: this.headers(), expectedAccountId: accountId, signal
    });
    const link = publicLink(result?.link, connectorId, this.aliases);
    return { status: 'callback_accepted', connectorId, link };
  }
  async linkApiKey({ connectorId, keyFile, input = process.stdin, actionNames, linkParams: inputParams, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    const actions = strings(actionNames, 'actionNames') ?? [], params = linkParams(inputParams);
    const accountId = await this.account(expectedAccountId);
    const key = await privateInput(keyFile, input, 'API key');
    const connector = await this.requireAuth(connectorId, 'API_KEY', params, signal, accountId);
    const body = { connector_id: connector.id, name: connector.name, action_names: actions, key, install_attempt_id: randomUUID() };
    if (params !== undefined) body.link_params = params;
    const result = await this.request('POST', `${ROOT}/links/api_key`, { body, headers: this.headers(), expectedAccountId: accountId, signal });
    id(result?.id, 'returned linkId');
    return { status: 'link_created', connectorId, linkId: result.id };
  }
  async linkNoAuth({ connectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId');
    const accountId = await this.account(expectedAccountId);
    const connector = await this.requireAuth(connectorId, 'NONE', undefined, signal, accountId);
    const result = await this.request('POST', `${ROOT}/links/noauth`, {
      body: { connector_id: connector.id, name: connector.name, action_names: [], install_attempt_id: randomUUID() }, headers: this.headers(), expectedAccountId: accountId, signal
    });
    id(result?.id, 'returned linkId');
    return { status: 'link_created', connectorId, linkId: result.id };
  }
  async unlink({ connectorId, linkId, expectedAccountId, signal } = {}) {
    if (this.productSku !== 'CODEX') fail('UNSUPPORTED_SCOPE', 'Use the explicit account connection unlink command; source removal does not unlink provider credentials.');
    id(connectorId, 'connectorId'); id(linkId, 'linkId');
    const accountId = await this.account(expectedAccountId);
    await this.exactLink(connectorId, linkId, signal, accountId);
    await this.request('DELETE', `${ROOT}/links/${routeId(linkId, 'linkId')}`, { headers: this.headers('settings'), expectedAccountId: accountId, signal });
    return { status: 'unlinked', connectorId, linkId };
  }
}
