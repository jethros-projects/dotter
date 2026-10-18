import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DotConnections } from './connections.mjs';
import { DotError } from './errors.mjs';

// Observed personal connector contracts in ChatGPT.app, 2026-10-18:
// create-dialog-eb37aecf2961, routes-d75be4c2d3a0, queries-1fc7d07a6038,
// app-connect-queries-ec700a582b29, app-initial-90eb42395b7d.
const ROOT = '/backend-api/aip/connectors';
const HEADERS = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'plugin_management' };
const SETUP = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'connector_setup' };
const SETTINGS = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'settings' };
const SERVICE = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'workspace_agents' };
const SLACK = new Set(['connector_3f8d1a79f27c4c7ba1a897ab13bf37dc', 'asdk_app_69a1d78e929881919bba0dbda1f6436d']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const credentialField = name => /^(?:accesstoken|refreshtoken|idtoken|clientsecret|privatekey|password|apikey|authorization|cookie|uploadurl|downloadurl|secret|key)$/.test(name.replace(/[_-]/g, '').toLowerCase());
function fail(message, code = 'INVALID_ARGUMENT') { throw new DotError(code, message); }
function text(value, name, max = 8192, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${name} must be text of at most ${max} characters.`);
  return value;
}
function id(value, name = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/.test(value)) fail(`${name} must be an API-issued identifier.`);
  return value;
}
function pathId(value, name) { return encodeURIComponent(id(value, name)); }
function list(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) fail(`${name} must contain at most 100 strings.`);
  return [...new Set(value.map(item => text(item, name, 1024)))];
}
function json(value, name, max = 256 * 1024) {
  if (!object(value)) fail(`${name} must be a JSON object.`);
  let encoded; try { encoded = JSON.stringify(value); } catch { fail(`${name} must be JSON serializable.`); }
  if (encoded.length > max) fail(`${name} is too large.`);
  return JSON.parse(encoded);
}
export function connectorPublicData(value, depth = 0, schemaProperties = false, secretSchema = false) {
  if (depth > 30) return null;
  if (Array.isArray(value)) return value.map(item => connectorPublicData(item, depth + 1, false, secretSchema));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) return '[redacted credential URL]';
      if ([...parsed.searchParams.keys()].some(key => credentialField(key) || /^(?:sig|signature|x-amz-signature)$/i.test(key))) return '[redacted signed URL]';
    } catch { /* Not a URL: retain ordinary descriptive text. */ }
  }
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !(secretSchema && /^(?:default|const|enum|example|examples|value)$/i.test(key))
      && (!credentialField(key) || schemaProperties && object(item)))
    .map(([key, item]) => [key, connectorPublicData(item, depth + 1, key === 'properties', secretSchema || schemaProperties && credentialField(key))]));
}
function url(value, name, { https = false } = {}) {
  text(value, name, 8192);
  let parsed; try { parsed = new URL(value); } catch { fail(`${name} must be a valid URL.`); }
  if (!(https ? ['https:'] : ['http:', 'https:']).includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash || /[\s\\]/.test(value)) fail(`${name} must be an HTTP${https ? 'S' : '(S)'} URL without credentials or a fragment.`);
  return parsed.toString();
}
function target(value) {
  if (!object(value) || Object.keys(value).length !== 1) fail('target must contain exactly mcp_url or tunnel_id.');
  if (Object.hasOwn(value, 'mcp_url')) return { mcp_url: url(value.mcp_url, 'mcp_url') };
  if (typeof value.tunnel_id === 'string' && /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(value.tunnel_id)) return { tunnel_id: value.tunnel_id };
  fail('target must contain a valid mcp_url or API-issued tunnel_id.');
}
function privacyUser(auth, accountId) {
  if (auth?.accountId !== accountId) fail('The current account differs from the selected account.', 'ACCOUNT_CHANGED');
  let claims;
  try { claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); } catch {}
  const identity = claims?.['https://api.openai.com/auth'];
  const userId = identity?.user_id ?? identity?.chatgpt_user_id;
  if (typeof userId !== 'string' || !userId || userId.length > 1024 || /[\x00-\x1f\x7f]/.test(userId)) fail('Connection privacy requires an authenticated user identity.', 'AUTH_IDENTITY_REQUIRED');
  return userId;
}
async function privateFile(file, max, name, signal, input = process.stdin) {
  signal?.throwIfAborted();
  text(file, `${name} file`, 4096); let handle;
  if (file === '-') {
    if (!input || typeof input[Symbol.asyncIterator] !== 'function' || typeof input.destroy !== 'function') fail(`Pipe ${name} through a readable input stream.`);
    if (input.isTTY) fail(`Pipe ${name} from a private source; terminal input may echo secrets.`);
    const chunks = []; let size = 0;
    const abort = () => input.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      for await (const chunk of input) { signal?.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length; if (size > max) fail(`${name} exceeds ${max} bytes.`); chunks.push(bytes); }
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DotError) throw error;
      fail(`Cannot read ${name} from standard input.`, 'PRIVATE_INPUT_UNREADABLE');
    } finally { signal?.removeEventListener('abort', abort); }
    if (size < 1) fail(`${name} input is empty.`);
    return Buffer.concat(chunks);
  }
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > max) fail(`${name} must be a regular file containing 1 to ${max} bytes.`);
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) { signal?.throwIfAborted(); const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`${name} changed while it was read.`, 'FILE_CHANGED');
    return buffer.subarray(0, size);
  } catch (error) { if (error instanceof DotError || signal?.aborted) throw error; fail(`Cannot read ${name}; use a regular file, not a symbolic link.`, 'PRIVATE_INPUT_UNREADABLE'); }
  finally { await handle?.close(); }
}
async function logo(file, signal, input) {
  if (file === undefined) return null;
  const bytes = await privateFile(file, 10240, 'PNG logo', signal, input);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('The logo must be a PNG file.');
  let offset = 8, imageData = false, finished = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('The PNG logo is truncated.');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || offset + length + 12 > bytes.length) fail('The PNG logo has an invalid chunk.');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) fail('The PNG logo has no valid image header.');
    } else if (type === 'IHDR') fail('The PNG logo has duplicate image headers.');
    if (type === 'IDAT' && length > 0) imageData = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || !imageData || offset !== bytes.length) fail('The PNG logo has no complete image.');
      finished = true; break;
    }
  }
  if (!finished) fail('The PNG logo has no complete image.');
  return `data:image/png;base64,${bytes.toString('base64')}`;
}
async function authentication(value, clientSecretFile, signal, input) {
  const auth = json(value, 'authRequest');
  const rejectInlineSecrets = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (/^(?:client_secret|private_key|api_key|access_token|refresh_token|id_token|password)$/i.test(key)) fail('Pass credentials through a private credential file, not authRequest.');
      rejectInlineSecrets(item);
    }
  };
  rejectInlineSecrets(auth);
  const allowed = ['supported_auth', 'oauth_client_params', 'use_cimd', 'oidc_enabled', 'default_scopes'];
  if (Object.keys(auth).some(key => !allowed.includes(key))) fail('authRequest contains an unsupported field.');
  if (!Array.isArray(auth.supported_auth) || !auth.supported_auth.length || auth.supported_auth.length > 3) fail('supported_auth must describe NONE, API_KEY, or OAUTH.');
  const seen = new Set();
  for (const item of auth.supported_auth) {
    if (!object(item) || !['NONE', 'API_KEY', 'OAUTH'].includes(item.type) || seen.has(item.type)) fail('supported_auth contains an invalid or duplicate authentication type.');
    seen.add(item.type);
    if (item.type === 'NONE' && Object.keys(item).length !== 1) fail('NONE does not accept authentication fields.');
    if (item.type === 'API_KEY') {
      const scheme = item.header_scheme;
      if (!object(scheme) || !['BEARER', 'BASIC', 'CUSTOM_HEADER'].includes(scheme.type)) fail('API_KEY requires a supported header_scheme.');
      if (scheme.type === 'CUSTOM_HEADER' && (typeof scheme.header_name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(scheme.header_name))) fail('CUSTOM_HEADER requires a valid header name.');
    }
    if (item.type === 'OAUTH') {
      for (const key of ['authorization_url', 'token_url']) item[key] = url(item[key], key);
      for (const key of ['registration_url', 'authorization_server_base', 'oidc_configuration_url', 'oidc_userinfo_endpoint']) if (item[key]) item[key] = url(item[key], key);
      if (item.client_secret !== undefined) fail('Provide OAuth client secrets through clientSecretFile.');
    }
  }
  if (auth.oauth_client_params !== undefined) {
    if (!object(auth.oauth_client_params) || Object.keys(auth.oauth_client_params).some(key => !['client_id', 'token_endpoint_auth_method'].includes(key))) fail('oauth_client_params accepts client_id and token_endpoint_auth_method; use clientSecretFile for a secret.');
    text(auth.oauth_client_params.client_id, 'client_id', 8192);
    if (!['none', 'client_secret_post', 'client_secret_basic', 'private_key_jwt'].includes(auth.oauth_client_params.token_endpoint_auth_method)) fail('Unsupported token endpoint authentication method.');
  }
  if (clientSecretFile !== undefined) {
    if (!auth.oauth_client_params || !seen.has('OAUTH')) fail('clientSecretFile requires OAUTH and oauth_client_params.');
    const bytes = await privateFile(clientSecretFile, 65536, 'OAuth client secret', signal, input);
    let secret; try { secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch { fail('The OAuth secret must be UTF-8.'); }
    auth.oauth_client_params.client_secret = text(secret, 'OAuth client secret', 65536);
  }
  for (const key of ['use_cimd', 'oidc_enabled']) if (auth[key] !== undefined && typeof auth[key] !== 'boolean') fail(`${key} must be boolean.`);
  if (auth.default_scopes !== undefined) auth.default_scopes = list(auth.default_scopes, 'default_scopes');
  return auth;
}

export class DotConnectorAdmin extends DotConnections {
  async context(expectedAccountId) {
    const accountId = await this.account(expectedAccountId);
    if (!accountId) fail('An explicit authenticated account is required for connector administration.', 'AUTH_ACCOUNT_REQUIRED');
    return accountId;
  }
  servicePrincipal(serviceAccountUserId, accountId) {
    if (serviceAccountUserId.includes('__') && !serviceAccountUserId.endsWith(`__${accountId}`)) fail('The service-account identity belongs to a different account.', 'ACCOUNT_CHANGED');
    return serviceAccountUserId;
  }
  async get({ connectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); const accountId = await this.context(expectedAccountId);
    const response = await this.request('GET', `${ROOT}/${pathId(connectorId)}`, { query: { include_actions: true }, headers: HEADERS, expectedAccountId: accountId, signal });
    if (!object(response) || response.id !== connectorId) fail('The connector response did not match the requested ID.', 'INVALID_RESPONSE');
    return connectorPublicData(response);
  }
  async tos({ connectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); const accountId = await this.context(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/${pathId(connectorId)}/tos`, { headers: HEADERS, expectedAccountId: accountId, signal }));
  }
  async mfaRequirement({ connectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); const accountId = await this.context(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/${pathId(connectorId)}/mfa_requirement`, { headers: HEADERS, expectedAccountId: accountId, signal }));
  }
  async setPrivacy({ connectorId, linkId, policy, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); id(linkId, 'linkId');
    if (!['always_ask', 'ask_before_writes', 'review_important_actions', 'full_access'].includes(policy)) fail('Choose a supported apps privacy policy.');
    const accountId = await this.context(expectedAccountId);
    if (typeof this.transport.authLoader !== 'function') fail('Connection privacy requires an authenticated user identity.', 'AUTH_IDENTITY_REQUIRED');
    const loadAuth = this.transport.authLoader.bind(this.transport);
    const auth = await loadAuth({ authFile: this.transport.authFile }), userId = privacyUser(auth, accountId);
    this.transport.assertIdentity?.(auth);
    // Keep this operation's user fence local, including the transport's final auth read.
    const guarded = Object.create(this);
    guarded.transport = Object.create(this.transport);
    guarded.transport.authLoader = async options => {
      const current = await loadAuth(options);
      if (privacyUser(current, accountId) !== userId) fail('The authenticated user changed during the privacy update.', 'AUTH_IDENTITY_CHANGED');
      this.transport.assertIdentity?.(current);
      return current;
    };
    guarded.assertCurrent = async () => {
      await this.assertCurrent?.();
      await guarded.transport.authLoader({ authFile: this.transport.authFile });
    };
    const membership = (await guarded.request('GET', '/backend-api/accounts/check/v4-2023-04-27', { expectedAccountId: accountId, signal }))?.accounts?.[accountId];
    if (!object(membership?.account) || membership.account.account_id !== accountId || membership.can_access_with_session !== true) fail('The service did not confirm accessible membership in the selected account.', 'ACCOUNT_MEMBERSHIP_UNVERIFIED');
    if (membership.account.structure !== 'personal') fail('Connection privacy can only be changed in a personal account.', 'UNSUPPORTED_SCOPE');
    const connector = await guarded.connector(connectorId, signal, accountId);
    const link = await guarded.exactLink(connectorId, linkId, signal, accountId);
    if (!Array.isArray(link.owners) || !link.owners.some(owner => object(owner) && owner.type === 'USER' && owner.id === userId)) fail('Only a connection owned by the authenticated user can change privacy.', 'PERMISSION_REQUIRED');
    if (link.auth_status === 'REAUTH_REQUIRED' || connector.labels?.apps_privacy_control_available === 'false') fail('Connection privacy is unavailable for this connection.', 'PRIVACY_UNAVAILABLE');
    if (link.apps_privacy_control === policy) return { status: 'unchanged', connectorId, linkId, policy };
    await guarded.request('PATCH', `${ROOT}/links/${pathId(linkId)}`, { body: { apps_privacy_control: policy }, headers: SETTINGS, expectedAccountId: accountId, signal });
    return { status: 'updated', connectorId, linkId, policy };
  }
  async startOAuth({ connectorId, actionNames, requestedScopes, linkParams, companionConnectorIds, slackTeamId, siwcLogin, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); const actions = list(actionNames, 'actionNames'), scopes = list(requestedScopes, 'requestedScopes');
    const companions = list(companionConnectorIds, 'companionConnectorIds')?.map(item => id(item, 'companionConnectorId'));
    const params = linkParams === undefined ? undefined : json(linkParams, 'linkParams', 65536);
    if (siwcLogin !== undefined) fail('SIWC is an identity-bound sign-in flow. Start it in ChatGPT; it cannot be enabled as a generic OAuth option.', 'NATIVE_IDENTITY_FLOW_REQUIRED');
    if (slackTeamId !== undefined && (!SLACK.has(connectorId) || !/^[A-Z0-9]{1,128}$/.test(slackTeamId))) fail('slackTeamId requires a Slack connector and valid workspace ID.');
    const accountId = await this.context(expectedAccountId);
    const connector = await this.requireAuth(connectorId, 'OAUTH', params, signal, accountId);
    const requestId = randomUUID(), post = new URL('https://chatgpt.com/');
    post.hash = `settings/Connectors?${new URLSearchParams({ connector: connectorId, 'product-sku': 'CODEX', referrer: 'codex' })}`;
    const body = { connector_id: connectorId, name: connector.name, action_names: actions ?? null, callback_url: 'https://chatgpt.com/connector_platform_oauth_redirect', post_auth_url: post.toString(), install_attempt_id: requestId };
    if (scopes !== undefined) body.requested_scopes = scopes;
    if (params !== undefined) body.link_params = params;
    if (companions !== undefined) body.requested_companion_connector_ids = companions;
    if (slackTeamId !== undefined) body.slack_team_id = slackTeamId;
    const result = await this.request('POST', `${ROOT}/links/oauth`, { body, headers: SETUP, expectedAccountId: accountId, signal });
    const authorizationUrl = url(result?.redirect_url, 'OAuth authorization URL', { https: true });
    if ([...new URL(authorizationUrl).searchParams.keys()].some(key => /^(?:access_token|refresh_token|id_token|client_secret|password)$/i.test(key))) fail('Unsafe OAuth authorization URL returned.', 'INVALID_RESPONSE');
    return { status: 'authorization_required', connectorId, accountId, requestId, authorizationUrl };
  }
  async unlinkAll({ connectorId, confirmConnectorId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); if (confirmConnectorId !== connectorId) fail('confirmConnectorId must match connectorId to disconnect every linked account.');
    const accountId = await this.context(expectedAccountId); await this.connector(connectorId, signal, accountId);
    await this.request('DELETE', `${ROOT}/links`, { body: { connector_id: connectorId }, headers: SETTINGS, expectedAccountId: accountId, signal });
    return { status: 'unlinked_all', connectorId };
  }
  async tunnels({ expectedAccountId, signal } = {}) {
    const accountId = await this.context(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/mcp/tunnels`, { headers: HEADERS, expectedAccountId: accountId, signal }));
  }
  async discoverOAuth({ target: input, expectedAccountId, signal } = {}) {
    const body = target(input), accountId = await this.context(expectedAccountId);
    try {
      return connectorPublicData(await this.request('POST', `${ROOT}/mcp/oauth_config`, { body, headers: HEADERS, expectedAccountId: accountId, signal }));
    } catch (error) {
      // Native discovery treats an ordinary 404 as no OAuth configuration.
      if (error instanceof DotError && error.code === 'HTTP_ERROR' && error.details?.status === 404) return { oauth_config: null };
      throw error;
    }
  }
  async oauthClients({ service, expectedAccountId, signal } = {}) {
    service = new URL(url(service, 'service')).origin; const accountId = await this.context(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/oauth_clients`, { query: { service }, headers: HEADERS, expectedAccountId: accountId, signal }));
  }
  async oauthCallback({ target: input, expectedAccountId, signal } = {}) {
    const query = target(input), accountId = await this.context(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/oauth/callback_id`, { query, headers: HEADERS, expectedAccountId: accountId, signal }));
  }
  async createMcp({ name, description = '', target: selected, authRequest, clientSecretFile, logoFile, expectedAccountId, signal, input } = {}) {
    name = text(name, 'name', 256).trim(); description = text(description, 'description', 8192, true);
    const selectedTarget = target(selected), auth = await authentication(authRequest, clientSecretFile, signal, input), logoUrl = await logo(logoFile, signal, input);
    const accountId = await this.context(expectedAccountId);
    const result = await this.request('POST', `${ROOT}/mcp`, { body: { name, description, ...selectedTarget, logo_url: logoUrl, auth_request: auth }, headers: HEADERS, expectedAccountId: accountId, signal });
    if (!object(result?.connector) || !result.connector.id) fail('The API did not return the new connector.', 'INVALID_RESPONSE');
    return { status: 'created', connector: connectorPublicData(result.connector) };
  }
  async requireMcp(connectorId, signal, accountId) {
    const connector = await this.connector(connectorId, signal, accountId);
    if (connector.connector_type !== 'MCP') fail('This operation requires a custom MCP connector.', 'INVALID_CONNECTOR_TYPE');
    return connector;
  }
  async updateMcp({ connectorId, field, value, logoFile, expectedAccountId, signal, input } = {}) {
    id(connectorId, 'connectorId'); if (!['name', 'description', 'logo'].includes(field)) fail('field must be name, description, or logo.');
    let body;
    if (field === 'logo') { if (!logoFile || value !== undefined) fail('Choose logoFile for a logo update.'); body = { logo_url: await logo(logoFile, signal, input) }; }
    else { if (logoFile !== undefined) fail('logoFile is only valid for a logo update.'); body = { [field]: text(value, field, field === 'name' ? 256 : 8192, field === 'description') }; }
    const accountId = await this.context(expectedAccountId); await this.requireMcp(connectorId, signal, accountId);
    await this.request('PATCH', `${ROOT}/${pathId(connectorId)}/${field}`, { body, headers: SETTINGS, expectedAccountId: accountId, signal });
    return { status: 'updated', connectorId, field };
  }
  async refreshActions({ connectorId, linkId, expectedAccountId, signal } = {}) {
    id(connectorId, 'connectorId'); id(linkId, 'linkId'); const accountId = await this.context(expectedAccountId);
    await this.requireMcp(connectorId, signal, accountId); await this.exactLink(connectorId, linkId, signal, accountId);
    await this.request('POST', `${ROOT}/mcp/refresh_actions`, { body: { link_id: linkId }, headers: SETTINGS, expectedAccountId: accountId, signal });
    return { status: 'refresh_requested', connectorId, linkId };
  }
  async deleteMcp() {
    fail('Custom MCP connector deletion is unavailable in this CLI: the verified native deletion flow is blocked by its canonical app dependency.', 'UNSUPPORTED');
  }
  async serviceAccountLinks({ serviceAccountUserId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    const result = await this.request('POST', `${ROOT}/service_accounts/links/list`, { body: { service_account_account_user_id: serviceAccountUserId }, headers: SERVICE, expectedAccountId: accountId, signal });
    if (!Array.isArray(result?.links)) fail('The service-account response did not contain links.', 'INVALID_RESPONSE');
    if (result.links.some(link => !object(link) || typeof link.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/.test(link.id)
      || link.visibility !== undefined && typeof link.visibility !== 'string')) fail('The service-account response contained an invalid link.', 'INVALID_RESPONSE');
    return { links: connectorPublicData(result.links.filter(link => link.visibility?.toUpperCase() !== 'HIDDEN' && link.hidden !== true && link.is_hidden !== true)) };
  }
  async serviceAccountOAuth({ serviceAccountUserId, connectorId, actionNames, requestedScopes, linkParams, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(connectorId, 'connectorId');
    const actions = list(actionNames, 'actionNames'), scopes = list(requestedScopes, 'requestedScopes'), params = linkParams === undefined ? undefined : json(linkParams, 'linkParams', 65536);
    const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    const connector = await this.requireAuth(connectorId, 'OAUTH', params, signal, accountId);
    const body = { connector_id: connectorId, name: connector.name, action_names: actions ?? null, callback_url: 'https://chatgpt.com/connector_platform_oauth_redirect', post_auth_url: 'https://chatgpt.com/#settings/Connectors', service_account_account_user_id: serviceAccountUserId };
    if (scopes !== undefined) body.requested_scopes = scopes;
    if (params !== undefined) body.link_params = params;
    const result = await this.request('POST', `${ROOT}/service_accounts/links/oauth`, { body, headers: SETUP, expectedAccountId: accountId, signal });
    const authorizationUrl = url(result?.redirect_url, 'OAuth authorization URL', { https: true });
    if ([...new URL(authorizationUrl).searchParams.keys()].some(key => /^(?:access_token|refresh_token|id_token|client_secret|password)$/i.test(key))) fail('Unsafe OAuth authorization URL returned.', 'INVALID_RESPONSE');
    return { status: 'authorization_required', serviceAccountUserId, connectorId, authorizationUrl };
  }
  async serviceAccountApiKey({ serviceAccountUserId, connectorId, keyFile, actionNames, linkParams, expectedAccountId, signal, input } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(connectorId, 'connectorId');
    const actions = list(actionNames, 'actionNames') ?? [], params = linkParams === undefined ? undefined : json(linkParams, 'linkParams', 65536);
    const bytes = await privateFile(keyFile, 65536, 'API key', signal, input);
    let key; try { key = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch { fail('The API key must be UTF-8.'); }
    text(key, 'API key', 65536);
    if (/[\r\n]/.test(key)) fail('The API key must be a single line.');
    const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    const connector = await this.requireAuth(connectorId, 'API_KEY', params, signal, accountId);
    await this.request('POST', `${ROOT}/service_accounts/links/api_key`, { body: { connector_id: connectorId, name: connector.name, action_names: actions, key, ...(params === undefined ? {} : { link_params: params }), service_account_account_user_id: serviceAccountUserId }, headers: SETUP, expectedAccountId: accountId, signal });
    return { status: 'link_created', serviceAccountUserId, connectorId };
  }
  async serviceAccountNoAuth({ serviceAccountUserId, connectorId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(connectorId, 'connectorId');
    const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    const connector = await this.requireAuth(connectorId, 'NONE', undefined, signal, accountId);
    await this.request('POST', `${ROOT}/service_accounts/links/noauth`, { body: { connector_id: connectorId, name: connector.name, action_names: [], service_account_account_user_id: serviceAccountUserId }, headers: SETUP, expectedAccountId: accountId, signal });
    return { status: 'link_created', serviceAccountUserId, connectorId };
  }
  async serviceAccountUnlink({ serviceAccountUserId, connectorId, linkId, confirmLinkId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(connectorId, 'connectorId'); id(linkId, 'linkId');
    if (confirmLinkId !== linkId) fail('confirmLinkId must match linkId to disconnect this service-account link.');
    const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    const result = await this.serviceAccountLinks({ serviceAccountUserId, expectedAccountId: accountId, signal });
    if (!result.links.some(link => link?.id === linkId && link?.connector_id === connectorId)) fail('The selected link is not visible on this service account.', 'CONNECTION_UNAVAILABLE');
    await this.request('DELETE', `${ROOT}/service_accounts/links/${pathId(linkId)}`, { headers: SERVICE, expectedAccountId: accountId, signal });
    return { status: 'unlinked', serviceAccountUserId, connectorId, linkId };
  }
  async serviceAccountConnections({ serviceAccountUserId, teamId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(teamId, 'teamId'); const accountId = await this.context(expectedAccountId);
    this.servicePrincipal(serviceAccountUserId, accountId);
    return connectorPublicData(await this.request('GET', `/backend-api/ps/v2/service_accounts/${pathId(serviceAccountUserId)}/workspace_connections`, { query: { team_id: teamId }, headers: SERVICE, expectedAccountId: accountId, signal }));
  }
  async setServiceAccountConnection({ serviceAccountUserId, teamId, linkId, enabled, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(teamId, 'teamId'); id(linkId, 'linkId'); if (typeof enabled !== 'boolean') fail('enabled must be boolean.');
    const accountId = await this.context(expectedAccountId), current = await this.serviceAccountConnections({ serviceAccountUserId, teamId, expectedAccountId: accountId, signal });
    if (!Array.isArray(current?.links) || !current.links.some(link => link.id === linkId)) fail('The selected workspace link is not attached to this service account.', 'CONNECTION_UNAVAILABLE');
    return connectorPublicData(await this.request('PATCH', `/backend-api/ps/v2/service_accounts/${pathId(serviceAccountUserId)}/workspace_connections/${pathId(linkId)}`, { query: { team_id: teamId }, body: { enabled }, headers: SERVICE, expectedAccountId: accountId, signal }));
  }
  async setServiceAccountReadOnly({ serviceAccountUserId, linkId, readOnly, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(linkId, 'linkId'); if (typeof readOnly !== 'boolean') fail('readOnly must be boolean.');
    const accountId = await this.context(expectedAccountId), current = await this.serviceAccountLinks({ serviceAccountUserId, expectedAccountId: accountId, signal });
    if (!current.links.some(link => link.id === linkId)) fail('The selected link is not attached to this service account.', 'CONNECTION_UNAVAILABLE');
    return connectorPublicData(await this.request('PATCH', `/backend-api/ps/v2/links/${pathId(linkId)}`, { body: { is_read_only: readOnly }, headers: SERVICE, expectedAccountId: accountId, signal }));
  }
}
