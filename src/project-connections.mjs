import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DotError } from './errors.mjs';
import { AccountProjects, validateProjectId, requireProjectPermission, requireProjectCrud } from './account-projects.mjs';
import { PROJECT_CONNECTOR_PROVIDERS } from './project-sources.mjs';
import { DotConnections } from './connections.mjs';
import { writePrivate } from './store.mjs';
import { withOperationLock } from './operation-lock.mjs';

const SKU = 'CHATGPT_PROJECTS', ROOT = '/backend-api/aip/connectors';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PHASES = new Set(['prepared', 'starting', 'authorization_required', 'authorization_unbound', 'completing', 'callback_received', 'link_created', 'verified', 'cancelled']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const alias = value => typeof value === 'string' && value.startsWith('asdk_app_') ? `connector_${value.slice(9)}` : value;
function id(value, label) { if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail('INVALID_ARGUMENT', `${label} must be an API identifier.`); return value; }
function validId(value) { return typeof value === 'string' && ID.test(value) && value !== '.' && value !== '..'; }
function explicitLink(value) { id(value, 'linkId'); if (value.startsWith('implicit_link::')) fail('INVALID_ARGUMENT', 'Implicit provider links cannot be selected for this operation.'); }
function provider(value) { if (!Object.hasOwn(PROJECT_CONNECTOR_PROVIDERS, value)) fail('INVALID_ARGUMENT', 'connectorType must be google_drive, slack or linear.'); return value; }
function text(value, max = 8192, multiline = false) { return typeof value === 'string' && value.length <= max && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value); }
function strings(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !text(item, 1024) || !item.trim())) fail('INVALID_ARGUMENT', `${label} must be a bounded list of nonempty strings.`);
  return [...new Set(value)];
}
function publicUrl(value) {
  if (value == null) return null;
  try { const url = new URL(value); if (!text(value, 65536) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null; return url.href; } catch { return null; }
}
function stateToken(value) {
  try { const url = new URL(value), states = url.searchParams.getAll('state'); return states.length === 1 && states[0].trim() ? states[0].trim() : null; } catch { return null; }
}
async function statePath(value) {
  if (!text(value, 4096) || !value) fail('INVALID_ARGUMENT', 'Choose an explicit private state file.');
  const requested = resolve(value), parent = await realpath(dirname(requested)).catch(() => null);
  if (!parent) fail('INVALID_ARGUMENT', 'The state-file directory must already exist.');
  const info = await stat(parent);
  if (!info.isDirectory() || info.mode & 0o022 || process.getuid && info.uid !== process.getuid()) fail('INVALID_STATE', 'The state-file directory must be owned by this user and not writable by other users.');
  return join(parent, basename(requested));
}
async function readBytes(file, max, missing = false) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.mode & 0o077 || before.size > max || process.getuid && before.uid !== process.getuid()) fail('INVALID_STATE', 'The input must be a bounded owner-only regular file.');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INVALID_STATE', 'The private input changed while it was read.');
    return bytes.subarray(0, length);
  } catch (error) { if (missing && error.code === 'ENOENT') return null; if (error instanceof DotError) throw error; fail('INVALID_STATE', 'Cannot read the private input file.'); }
  finally { await handle?.close(); }
}
function validateState(value) {
  if (!record(value) || value.version !== 1 || value.kind !== 'project-provider-connection' || value.productSku !== SKU || !UUID.test(value.operationId ?? '')
    || !PHASES.has(value.phase) || !['oauth', 'reauthorize', 'noauth'].includes(value.operation) || !record(value.identity) || !validId(value.identity.accountId)
    || !HASH.test(value.identity.subjectSha256 ?? '') || !validId(value.identity.accountUserId) || !record(value.context)
    || !Object.hasOwn(PROJECT_CONNECTOR_PROVIDERS, value.context.connectorType) || alias(value.context.connectorId) !== alias(PROJECT_CONNECTOR_PROVIDERS[value.context.connectorType])
    || !record(value.request) || value.request.actions !== undefined && !Array.isArray(value.request.actions) || value.request.scopes !== undefined && !Array.isArray(value.request.scopes)) fail('INVALID_STATE', 'This is not a supported project-connection journal.');
  try { validateProjectId(value.context.projectId); strings(value.request.actions, 'actions'); strings(value.request.scopes, 'scopes'); } catch { fail('INVALID_STATE', 'The saved project connection context is invalid.'); }
  if (value.linkId != null && (!validId(value.linkId) || value.linkId.startsWith('implicit_link::')) || value.oauthStateSha256 != null && !HASH.test(value.oauthStateSha256)) fail('INVALID_STATE', 'The saved connection receipt is invalid.');
  if (value.phase === 'authorization_required' && (!publicUrl(value.authorizationUrl) || !HASH.test(value.oauthStateSha256 ?? '') || digest(stateToken(value.authorizationUrl) ?? '') !== value.oauthStateSha256)) fail('INVALID_STATE', 'The saved authorization handoff is invalid.');
  if (['callback_received', 'link_created', 'verified'].includes(value.phase) && typeof value.linkId !== 'string') fail('INVALID_STATE', 'The saved connection receipt has no exact link.');
  return value;
}
async function readState(file, missing = false) {
  const bytes = await readBytes(file, 131072, missing); if (bytes === null) return null;
  try { return validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof DotError) throw error; fail('INVALID_STATE', 'The project-connection journal is invalid.'); }
  finally { bytes.fill(0); }
}
async function callbackInput(file, input) {
  if (!text(file, 4096) || !file) fail('INVALID_ARGUMENT', 'Choose a private callback file or pipe it with -.');
  let bytes;
  if (file === '-') {
    if (!input || input.isTTY || typeof input[Symbol.asyncIterator] !== 'function') fail('PRIVATE_INPUT_REQUIRED', 'Pipe the callback URL from a private source.');
    const chunks = []; let length = 0;
    for await (const chunk of input) { const part = Buffer.from(chunk); length += part.length; if (length > 65536) fail('PRIVATE_INPUT_INVALID', 'The callback input exceeds 64 KiB.'); chunks.push(part); }
    bytes = Buffer.concat(chunks);
  } else bytes = await readBytes(file, 65536);
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(), url = new URL(value);
    const browser = url.protocol === 'https:' && url.host === 'chatgpt.com' && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[^/]+$/.test(url.pathname));
    const native = ['codex:', 'codex-dev:'].includes(url.protocol) && url.host === 'connector' && url.pathname === '/oauth_callback';
    if ((!browser && !native) || url.username || url.password || url.hash || !stateToken(value)) fail('PRIVATE_INPUT_INVALID', 'The input is not a supported connector OAuth callback.');
    return { value, tokenHash: digest(stateToken(value)), cancelled: url.searchParams.has('error') };
  } catch (error) { if (error instanceof DotError) throw error; fail('PRIVATE_INPUT_INVALID', 'The input is not a supported connector OAuth callback.'); }
  finally { bytes?.fill(0); }
}
function safeOutput(state, file, extra = {}) {
  return { accountId: state.identity.accountId, projectId: state.context.projectId, connectorType: state.context.connectorType, connectorId: state.context.connectorId,
    productSku: SKU, operationId: state.operationId, stateFile: file, operation: state.operation, phase: state.phase,
    status: state.phase === 'verified' ? 'connected' : state.phase === 'authorization_required' ? 'authorization_required' : state.phase === 'cancelled' ? 'cancelled'
      : ['starting', 'completing'].includes(state.phase) ? 'outcome_unknown' : state.phase === 'authorization_unbound' ? 'native_handoff_required' : 'verification_pending',
    connected: state.phase === 'verified', linkId: state.linkId ?? null, canSubmitCallback: state.phase === 'authorization_required',
    canReconcile: ['callback_received', 'link_created', 'verified'].includes(state.phase), canReplayMutation: false, ...extra };
}

export function projectConnectionCapabilities() {
  return { scope: 'Account provider connections used by native projects; source removal and account unlink remain separate.', productSku: SKU,
    supported: ['get', 'status', 'tos', 'oauth', 'reauthorize', 'complete', 'no-auth', 'operation'], connectorTypes: Object.keys(PROJECT_CONNECTOR_PROVIDERS), liveVerified: false,
    limitations: ['OAuth remains an interactive provider authorization.', 'A private journal pins account, user, project, connector and opaque OAuth state across the handoff.',
      'Starting authorization never means connected; callback and no-auth receipts require exact active-link verification.', 'New form-dependent, API-key and app-password setup are not offered for project providers; existing OAuth links retain their stored configuration on reauthorization.',
      'No mutation is automatically replayed after an uncertain outcome.', 'Connections are account-wide, not private project credentials; this wrapper provides no unlink operation.'] };
}

export class ProjectConnections extends AccountProjects {
  capabilities() { return projectConnectionCapabilities(); }
  async _connectionContext({ projectId, connectorType, accountId, signal }, write = false) {
    validateProjectId(projectId); provider(connectorType);
    const c = await this._context(accountId, signal), raw = await this._get(c, projectId);
    if (raw.gizmo.gizmo_snorlax_type != null) fail('PROJECT_SCOPE_UNSUPPORTED', 'Provider setup requires an ordinary account project.');
    if (write) { requireProjectPermission(raw, c, 'can_write'); await requireProjectCrud(c); }
    return { ...c, projectId, connectorType, connectorId: PROJECT_CONNECTOR_PROVIDERS[connectorType], signal };
  }
  _identity(c) { return { accountId: c.accountId, subjectSha256: digest(c.subject), accountUserId: c.account.account_user_id }; }
  async _checkState(state, accountId, signal, write = false) {
    if (accountId !== state.identity.accountId) fail('ACCOUNT_CHANGED', 'The connection journal belongs to another selected account.');
    const c = await this._connectionContext({ ...state.context, accountId, signal }, write);
    if (!same(this._identity(c), state.identity)) fail('AUTH_IDENTITY_CHANGED', 'The connection journal belongs to another authenticated user or membership.');
    c.connectorId = state.context.connectorId; return c;
  }
  async _writeGuard(c) {
    const raw = await this._get(c, c.projectId);
    requireProjectPermission(raw, c, 'can_write');
    if (raw.gizmo.gizmo_snorlax_type != null) fail('PROJECT_SCOPE_UNSUPPORTED', 'Provider setup requires an ordinary account project.');
    await requireProjectCrud(c);
  }
  _connections(c, beforeMutation) {
    const base = this.transport, proxy = Object.create(base);
    proxy.request = async (method, path, options = {}) => {
      await c.assert();
      if (options.expectedAccountId !== c.accountId) fail('ACCOUNT_CHANGED', 'Provider requests must retain the selected account.');
      const mutation = method !== 'GET' && path !== `${ROOT}/links/list_accessible`;
      if (mutation) { await this._writeGuard(c); if (!beforeMutation) fail('UNSUPPORTED', 'This project connection operation has no mutation journal.'); await beforeMutation(method, path, options); }
      const result = await base.request(method, path, { ...options, signal: c.signal });
      try { await c.assert(); }
      catch (error) {
        if (!mutation) throw error;
        if (error instanceof DotError) { error.details = { ...error.details, delivery: 'unknown', operation: 'project provider auth', canReplayMutation: false }; throw error; }
        fail('MUTATION_UNCONFIRMED', 'The auth request returned, but its pinned identity could no longer be verified. Inspect the saved operation before continuing.',
          { delivery: 'unknown', operation: 'project provider auth', canReplayMutation: false });
      }
      return result;
    };
    return new DotConnections({ transport: proxy }, { productSku: SKU });
  }
  async _metadata(c, authType, { creation = true } = {}) {
    const api = this._connections(c), raw = await api.connector(c.connectorId, c.signal, c.accountId);
    if (authType) {
      if (raw.status === 'DISABLED_BY_ADMIN') fail('CONNECTION_UNAVAILABLE', 'This provider is disabled by the account administrator.');
      if (!raw.supported_auth.some(item => item?.type === authType)) fail('UNSUPPORTED_AUTH', 'This provider does not offer the requested authentication method.');
      const schema = raw.link_params_schema;
      if (creation && schema != null && (!record(schema) || schema.properties != null && (!record(schema.properties) || Object.keys(schema.properties).length > 0)
        || schema.required != null && (!Array.isArray(schema.required) || schema.required.length > 0))) fail('NATIVE_HANDOFF_REQUIRED', 'This provider requires a native setup form; no form fields were guessed.');
    }
    return raw;
  }
  async connectionGet(options = {}) {
    const c = await this._connectionContext(options), raw = await this._metadata(c);
    const api = this._connections(c), value = await api.get({ connectorId: raw.id, expectedAccountId: c.accountId, signal: c.signal });
    return { accountId: c.accountId, projectId: c.projectId, connectorType: c.connectorType, productSku: SKU, connector: value };
  }
  async connectionStatus(options = {}) {
    if (options.linkId !== undefined) explicitLink(options.linkId);
    const c = await this._connectionContext(options), api = this._connections(c);
    let result = await api.status({ connectorId: c.connectorId, linkId: options.linkId, expectedAccountId: c.accountId, signal: c.signal });
    if (result.link != null && options.linkId === undefined) result = await api.status({ connectorId: c.connectorId, linkId: result.link.id, expectedAccountId: c.accountId, signal: c.signal });
    return { accountId: c.accountId, projectId: c.projectId, connectorType: c.connectorType, productSku: SKU, ...result };
  }
  async connectionTos(options = {}) {
    const c = await this._connectionContext(options);
    const raw = await this._metadata(c), data = await c.request('GET', `/aip/connectors/${encodeURIComponent(raw.id)}/tos`, { headers: { 'OAI-Product-Sku': SKU, 'X-Codex-Surface': 'connector_setup' } });
    if (!record(data) || !Array.isArray(data.blurbs) || data.blurbs.length > 100 || data.blurbs.some(item => !record(item) || !text(item.title, 4096, true) || !text(item.description, 32768, true))) fail('INVALID_RESPONSE', 'The provider terms response was invalid.');
    return { accountId: c.accountId, projectId: c.projectId, connectorType: c.connectorType, productSku: SKU,
      blurbs: data.blurbs.map(({ title, description }) => ({ title, description })), privacyPolicy: publicUrl(raw.branding?.privacy_policy), termsOfService: publicUrl(raw.branding?.terms_of_service) };
  }
  async _save(file, state) { await writePrivate(file, `${JSON.stringify(state)}\n`, { overwrite: true }); }
  async _saveReceipt(file, state) {
    try { await this._save(file, state); }
    catch {
      let recoveryStateFile;
      try { recoveryStateFile = await writePrivate(`${file}.recovery-${randomUUID()}`, `${JSON.stringify(state)}\n`); } catch { /* A lost receipt must never cause a replay or print OAuth material. */ }
      fail('CONNECTION_RECEIPT_NOT_SAVED', 'The provider replied, but the private receipt could not be saved. Inspect the original operation or use the recovery file; do not repeat the auth request.',
        { stateFile: file, operationId: state.operationId, phase: state.phase, delivery: 'received', canReplayMutation: false,
          ...(state.linkId ? { linkId: state.linkId } : {}), ...(recoveryStateFile ? { recoveryStateFile } : {}) });
    }
  }
  async _verify(file, state, c) {
    const api = this._connections(c), result = await api.status({ connectorId: state.context.connectorId, linkId: state.linkId, expectedAccountId: c.accountId, signal: c.signal });
    if (!result.connected || result.link?.id !== state.linkId) return safeOutput(state, file, { connected: false, status: 'verification_pending' });
    state.phase = 'verified'; await this._saveReceipt(file, state);
    return safeOutput(state, file, { link: result.link });
  }
  async _initiate(operation, options) {
    const actions = strings(options.actionNames, 'actionNames'), scopes = strings(options.requestedScopes, 'requestedScopes');
    if (operation === 'reauthorize') { explicitLink(options.linkId); if (actions !== undefined) fail('INVALID_ARGUMENT', 'Reauthorization does not accept creation-only action selection.'); }
    if (operation === 'noauth' && (actions !== undefined || scopes !== undefined)) fail('INVALID_ARGUMENT', 'No-auth setup does not accept OAuth action or scope selection.');
    const file = await statePath(options.stateFile);
    return withOperationLock(file, async () => {
      let state = await readState(file, true), c;
      const request = { ...(actions === undefined ? {} : { actions }), ...(scopes === undefined ? {} : { scopes }) };
      if (state) {
        if (state.operation !== operation || state.context.projectId !== options.projectId || state.context.connectorType !== options.connectorType || !same(state.request, request)
          || operation === 'reauthorize' && state.linkId !== options.linkId) fail('INVALID_STATE', 'This journal belongs to a different provider setup operation.');
        c = await this._checkState(state, options.accountId, options.signal, true);
        if (['link_created', 'callback_received', 'verified'].includes(state.phase)) return this._verify(file, state, c);
        if (state.phase !== 'prepared') return safeOutput(state, file, state.phase === 'authorization_required' ? { authorizationUrl: state.authorizationUrl } : {});
      } else {
        c = await this._connectionContext(options, true);
        const raw = await this._metadata(c, operation === 'noauth' ? 'NONE' : 'OAUTH', { creation: operation !== 'reauthorize' }); c.connectorId = raw.id;
        state = { version: 1, kind: 'project-provider-connection', productSku: SKU, operationId: randomUUID(), operation, phase: 'prepared',
          identity: this._identity(c), context: { projectId: c.projectId, connectorType: c.connectorType, connectorId: c.connectorId }, request,
          ...(operation === 'reauthorize' ? { linkId: options.linkId } : {}) };
        await writePrivate(file, `${JSON.stringify(state)}\n`);
      }
      await this._metadata(c, operation === 'noauth' ? 'NONE' : 'OAUTH', { creation: operation !== 'reauthorize' });
      const api = this._connections(c, async (_method, path, params) => {
        const expected = operation === 'oauth' ? `${ROOT}/links/oauth` : operation === 'reauthorize' ? `${ROOT}/links/oauth/reauth` : `${ROOT}/links/noauth`;
        if (path !== expected || state.phase !== 'prepared') fail('INVALID_STATE', 'This provider mutation is not allowed by the journal phase.');
        await this._metadata(c, operation === 'noauth' ? 'NONE' : 'OAUTH', { creation: operation !== 'reauthorize' });
        state.phase = 'starting';
        if (params.body?.install_attempt_id) state.installAttemptId = params.body.install_attempt_id;
        await this._save(file, state);
      });
      const result = operation === 'oauth' ? await api.startOAuth({ connectorId: c.connectorId, actionNames: actions, requestedScopes: scopes, expectedAccountId: c.accountId, signal: c.signal })
        : operation === 'reauthorize' ? await api.reauthorize({ connectorId: c.connectorId, linkId: options.linkId, requestedScopes: scopes, expectedAccountId: c.accountId, signal: c.signal })
          : await api.linkNoAuth({ connectorId: c.connectorId, expectedAccountId: c.accountId, signal: c.signal });
      if (operation === 'noauth') {
        state.linkId = id(result.linkId, 'returned linkId'); state.phase = 'link_created'; await this._saveReceipt(file, state);
        return this._verify(file, state, c);
      }
      const token = stateToken(result.authorizationUrl);
      state.phase = token ? 'authorization_required' : 'authorization_unbound'; state.authorizationUrl = result.authorizationUrl;
      if (token) state.oauthStateSha256 = digest(token);
      await this._saveReceipt(file, state);
      return safeOutput(state, file, { authorizationUrl: result.authorizationUrl });
    }, { label: 'project connection' });
  }
  connectionStart(options = {}) { return this._initiate('oauth', options); }
  connectionReauthorize(options = {}) { return this._initiate('reauthorize', options); }
  connectionNoAuth(options = {}) { return this._initiate('noauth', options); }
  async connectionComplete({ stateFile, accountId, redirectFile, input = process.stdin, signal } = {}) {
    const file = await statePath(stateFile);
    return withOperationLock(file, async () => {
      const state = await readState(file), c = await this._checkState(state, accountId, signal, true);
      if (['callback_received', 'verified'].includes(state.phase)) return this._verify(file, state, c);
      if (state.phase !== 'authorization_required') fail('OAUTH_SUBMISSION_UNAVAILABLE', 'This journal does not permit a callback submission; inspect its operation status without replaying a mutation.');
      const callback = await callbackInput(redirectFile, input);
      if (callback.tokenHash !== state.oauthStateSha256) fail('OAUTH_STATE_MISMATCH', 'This callback belongs to a different authorization handoff.');
      if (callback.cancelled) { state.phase = 'cancelled'; await this._save(file, state); return safeOutput(state, file); }
      const api = this._connections(c, async (_method, path) => {
        if (path !== `${ROOT}/links/oauth/callback` || state.phase !== 'authorization_required') fail('INVALID_STATE', 'This callback is not permitted by the journal phase.');
        state.phase = 'completing'; await this._save(file, state);
      });
      const result = await api.completeOAuth({ connectorId: c.connectorId, redirectFile: '-', input: Readable.from([callback.value]), expectedAccountId: c.accountId, signal });
      const linkId = id(result.link?.id, 'returned linkId');
      if (state.operation === 'reauthorize' && linkId !== state.linkId) fail('IDENTITY_MISMATCH', 'Reauthorization returned a different account link.');
      state.linkId = linkId; state.phase = 'callback_received'; delete state.authorizationUrl; await this._saveReceipt(file, state);
      return this._verify(file, state, c);
    }, { label: 'project connection' });
  }
  async connectionOperation({ stateFile, accountId, signal } = {}) {
    const file = await statePath(stateFile);
    return withOperationLock(file, async () => {
      const state = await readState(file), c = await this._checkState(state, accountId, signal);
      return ['link_created', 'callback_received', 'verified'].includes(state.phase) ? this._verify(file, state, c) : safeOutput(state, file);
    }, { label: 'project connection' });
  }
}
