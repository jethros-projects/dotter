import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { DotError } from './errors.mjs';
import { readPrivateJson, writePrivate } from './store.mjs';

// continuation-1b2952b944ae.js, page-9d9f2343da1a.js and message-widget-69d4146c5277.js.
// References are opaque server-issued context capabilities, never fabricated IDs.
const ROOT = '/backend-api/messaging';
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const OUTCOMES = ['pending', 'started', 'context_delivered', 'suppressed', 'unconfirmed'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message, details) { throw new DotError(code, message, details); }
function text(value, label, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) fail('INVALID_ARGUMENT', `Use a valid ${label}.`);
  return value;
}
function reference(value) {
  text(value, 'message reference');
  if (!/^[A-Za-z0-9_.~=-]+$/.test(value) || ['.', '..'].includes(value)) fail('INVALID_ARGUMENT', 'Use an opaque URL-safe message reference returned by the app.');
  return value;
}
function id(value, label) { text(value, label, 1024); if (!/^[A-Za-z0-9][A-Za-z0-9_.:~-]*$/.test(value)) fail('INVALID_ARGUMENT', `Use a valid ${label}.`); return value; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function authorizationUrl(value) {
  let url; try { url = new URL(value); } catch { fail('INVALID_RESPONSE', 'The authentication URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state')
    || [...url.searchParams.keys()].some(name => /^(access_token|refresh_token|id_token|client_secret|password|completion_token)$/i.test(name))) fail('INVALID_RESPONSE', 'The authentication response did not contain a safe provider URL.');
  return url;
}
async function privateText(file, input, signal) {
  signal?.throwIfAborted();
  text(file, 'private input file'); let bytes;
  if (file === '-') {
    if (!input || input.isTTY || typeof input[Symbol.asyncIterator] !== 'function') fail('INVALID_ARGUMENT', 'Pipe the callback from a private source; terminal input may echo secrets.');
    const parts = []; let iterator, size = 0, finished = false, rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    interrupted.catch(() => {});
    const abort = () => { rejectAbort(signal.reason); try { input.destroy?.(); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      iterator = input[Symbol.asyncIterator]();
      while (true) {
        const next = await (signal ? Promise.race([iterator.next(), interrupted]) : iterator.next());
        signal?.throwIfAborted();
        if (next.done) { finished = true; break; }
        const buffer = Buffer.from(next.value); size += buffer.length;
        if (size > 65536) fail('INVALID_ARGUMENT', 'The private input is too large.');
        parts.push(buffer);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DotError) throw error;
      fail('PRIVATE_INPUT_UNREADABLE', 'Cannot read the private callback from standard input.');
    } finally {
      signal?.removeEventListener('abort', abort);
      // Do not let an arbitrary iterator's pending return() prevent aborting.
      if (!finished) { try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {} }
    }
    bytes = Buffer.concat(parts);
  } else {
    let fileHandle;
    try {
      // O_NONBLOCK lets regular-file validation reject FIFOs without waiting
      // for another process to open their write end.
      fileHandle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      signal?.throwIfAborted();
      const before = await fileHandle.stat({ bigint: true });
      const privateFile = value => value.isFile() && value.size <= 65536n && !(value.mode & 0o077n)
        && (typeof process.getuid !== 'function' || value.uid === BigInt(process.getuid()));
      const sameFile = (a, b) => ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
      if (!privateFile(before) || !sameFile(before, await lstat(file, { bigint: true }))) fail('PRIVATE_INPUT_UNREADABLE', 'Private callback files must be unchanged regular files owned by the current user, with owner-only permissions and no larger than 64 KiB.');
      const buffer = Buffer.alloc(65537); let size = 0;
      while (size < buffer.length) {
        signal?.throwIfAborted();
        const result = await fileHandle.read(buffer, size, buffer.length - size, size);
        signal?.throwIfAborted();
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 65536) fail('INVALID_ARGUMENT', 'The private input is too large.');
      if (before.size !== BigInt(size) || !sameFile(before, await fileHandle.stat({ bigint: true }))
        || !sameFile(before, await lstat(file, { bigint: true }))) fail('PRIVATE_INPUT_UNREADABLE', 'The private callback file changed while it was being read.');
      bytes = buffer.subarray(0, size);
    } catch (error) { if (signal?.aborted) throw signal.reason; if (error instanceof DotError) throw error; fail('PRIVATE_INPUT_UNREADABLE', 'Cannot read the selected private callback file.'); }
    finally { try { await fileHandle?.close(); } catch { if (signal?.aborted) throw signal.reason; fail('PRIVATE_INPUT_UNREADABLE', 'Cannot close the selected private callback file.'); } }
  }
  signal?.throwIfAborted();
  try { return text(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(), 'private callback', 65536); }
  catch (error) { if (error instanceof DotError) throw error; fail('INVALID_ARGUMENT', 'The callback input must be UTF-8.'); }
}
export class DotMessageWorkflows {
  constructor(client, { now = Date.now } = {}) { if (typeof client?.transport?.request !== 'function') throw new TypeError('DotMessageWorkflows requires a DotClient.'); this.transport = client.transport; this.now = now; }
  async identity(expectedAccountId) {
    if (expectedAccountId !== undefined) id(expectedAccountId, 'account ID');
    if (typeof this.transport.authLoader !== 'function') {
      if (!expectedAccountId) fail('AUTH_ACCOUNT_REQUIRED', 'Message continuations require an explicit account.');
      return { accountId: expectedAccountId, subject: expectedAccountId };
    }
    const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
    if (!auth.accountId) fail('AUTH_ACCOUNT_REQUIRED', 'Message continuations require a Codex account selector.');
    if (expectedAccountId !== undefined && expectedAccountId !== auth.accountId) fail('ACCOUNT_CHANGED', 'The current account differs from the selected message account.');
    this.transport.assertIdentity?.(auth);
    let claims; try { claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); } catch { /* opaque token: bind to its identity fingerprint */ }
    return { accountId: auth.accountId, subject: typeof claims?.sub === 'string' ? claims.sub : digest(auth.accessToken) };
  }
  async assertIdentity(identity) {
    const current = await this.identity(identity.accountId);
    if (current.subject !== identity.subject) fail('ACCOUNT_CHANGED', 'The signed-in user changed during the message continuation.');
  }
  request(method, path, accountId, options = {}) { return this.transport.request(method, ROOT + path, { ...options, expectedAccountId: accountId }); }
  async pluginSuggestions({ reference: ref, expectedAccountId, signal } = {}) {
    reference(ref); const identity = await this.identity(expectedAccountId);
    const value = await this.request('GET', `/plugin-suggestions/${encodeURIComponent(ref)}`, identity.accountId, { signal });
    if (!Array.isArray(value?.suggestions) || value.suggestions.some(item => !record(item) || typeof item.plugin_id !== 'string')) fail('INVALID_RESPONSE', 'The plugin suggestion response is invalid.');
    await this.assertIdentity(identity);
    const suggestions = value.suggestions.map(item => ({ pluginId: item.plugin_id, name: typeof item.name === 'string' ? item.name : null,
      description: typeof item.description === 'string' ? item.description : null, appIds: Array.isArray(item.app_ids) ? item.app_ids.filter(id => typeof id === 'string') : [] }));
    return { accountId: identity.accountId, reference: ref, suggestions, requestFingerprint: digest([ref, suggestions.map(item => item.pluginId).sort()]) };
  }
  async continuePlugins({ reference: ref, pluginIds, requestFingerprint, expectedAccountId, signal } = {}) {
    reference(ref); text(requestFingerprint, 'request fingerprint');
    if (!Array.isArray(pluginIds) || !pluginIds.length || pluginIds.length > 100) fail('INVALID_ARGUMENT', 'Select one or more suggested plugin IDs.');
    const selected = [...new Set(pluginIds.map(value => id(value, 'plugin ID')))];
    const identity = await this.identity(expectedAccountId);
    const current = await this.pluginSuggestions({ reference: ref, expectedAccountId: identity.accountId, signal });
    if (current.requestFingerprint !== requestFingerprint) fail('STALE_ACTION', 'The suggestions changed. Inspect this reference again.');
    if (selected.some(value => !current.suggestions.some(item => item.pluginId === value))) fail('INVALID_ARGUMENT', 'Only plugins in the current message suggestion may be continued.');
    await this.assertIdentity(identity); signal?.throwIfAborted();
    await this.request('POST', `/plugin-suggestions/${encodeURIComponent(ref)}/continue`, current.accountId, { body: { connected_plugin_ids: selected }, signal });
    return { accountId: current.accountId, reference: ref, pluginIds: selected, status: 'continuation_accepted' };
  }
  async bundle(ref, connect, identity, signal) {
    const value = await this.request('GET', `/connector-auth/${encodeURIComponent(ref)}${connect ? '/connect' : ''}`, identity.accountId, { signal });
    const request = value?.requests?.[0]; const action = connect ? 'connect' : 'reauthenticate';
    if (value?.version !== 1 || value.kind !== (connect ? 'connector_connect_no_link' : 'connector_auth') || value.requests?.length !== 1
      || request?.request_id !== ref || request.action !== action || request.resume_on_success !== true || !request.connector_id
      || (connect ? request.auth_reason !== 'missing_link' || request.link_id !== undefined : request.auth_reason !== 'reauthentication_required' || !request.link_id)) fail('ACTION_UNAVAILABLE', 'This authentication reference is not a current, supported message request.');
    id(request.connector_id, 'connector ID'); if (!connect) id(request.link_id, 'link ID');
    await this.assertIdentity(identity);
    return { accountId: identity.accountId, reference: ref, action, connectorId: request.connector_id, ...(connect ? {} : { linkId: request.link_id }),
      requestFingerprint: digest([ref, action, request.connector_id, request.link_id ?? null, request.auth_reason, request.requested_scopes ?? null]),
      requestedScopes: Array.isArray(request.requested_scopes) ? request.requested_scopes.filter(item => typeof item === 'string') : [] };
  }
  async connectorAuth({ reference: ref, connect = false, expectedAccountId, signal } = {}) {
    reference(ref); if (typeof connect !== 'boolean') fail('INVALID_ARGUMENT', 'connect must be a boolean.');
    return this.bundle(ref, connect, await this.identity(expectedAccountId), signal);
  }
  async startConnectorAuth({ reference: ref, connect = false, requestFingerprint, sessionFile, expectedAccountId, signal } = {}) {
    reference(ref); text(requestFingerprint, 'request fingerprint'); text(sessionFile, 'private session file');
    if (typeof connect !== 'boolean') fail('INVALID_ARGUMENT', 'connect must be a boolean.');
    const identity = await this.identity(expectedAccountId), current = await this.bundle(ref, connect, identity, signal);
    if (current.requestFingerprint !== requestFingerprint) fail('STALE_ACTION', 'The authentication request changed. Inspect it again.');
    const attemptId = randomUUID(), expiresAt = this.now() + 1800000;
    const session = { version: 1, ...current, subject: identity.subject, attemptId, expiresAt, phase: 'starting' };
    // Reserve before the mutation. An uncertain start must not be replayed silently.
    await writePrivate(sessionFile, JSON.stringify(session));
    const params = new URLSearchParams({ request: ref, attempt: attemptId, no_universal_links: '1', ...(connect ? { action: 'connect' } : {}) });
    signal?.throwIfAborted();
    const response = await this.request('POST', `/connector-auth/${encodeURIComponent(ref)}/start`, identity.accountId, {
      body: { callback_url: CALLBACK, post_auth_url: `/connector-auth?${params}` }, signal
    });
    const url = authorizationUrl(response?.redirect_url);
    text(response?.oauth_state_id, 'OAuth state ID'); text(response?.completion_token, 'completion token', 65536);
    await this.assertIdentity(identity);
    await writePrivate(sessionFile, JSON.stringify({ ...session, phase: 'redirected', oauthState: url.searchParams.get('state'), oauthStateId: response.oauth_state_id, completionToken: response.completion_token }), { overwrite: true });
    return { ...current, status: 'authorization_required', sessionFile, authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }
  async completeConnectorAuth(args = {}) {
    text(args.sessionFile, 'private session file');
    const lockPath = `${args.sessionFile}.lock`; let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { fail('STATE_BUSY', 'This authentication session is already in use or has an unresolved lock.'); }
    try { return await this.#completeConnectorAuth(args); }
    finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
  async #completeConnectorAuth({ reference: ref, sessionFile, callbackFile, resume = false, input = process.stdin, expectedAccountId, signal } = {}) {
    reference(ref); text(sessionFile, 'private session file');
    if (typeof resume !== 'boolean' || !resume && callbackFile === undefined) fail('INVALID_ARGUMENT', 'Provide a private callback file, or explicitly resume an interrupted completion.');
    // State contains a bearer-like completion capability; enforce owner-only mode.
    let handle; try { handle = await open(sessionFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat(); if (!stat.isFile() || stat.mode & 0o077) fail('INVALID_STATE', 'The authentication session must be an owner-only regular file.'); } catch (error) { if (error instanceof DotError) throw error; fail('INVALID_STATE', 'Cannot read the private authentication session.'); } finally { await handle?.close(); }
    const session = await readPrivateJson(sessionFile);
    if (!record(session) || session.version !== 1 || session.reference !== ref || !Number.isFinite(session.expiresAt) || session.expiresAt <= this.now() || session.expiresAt > this.now() + 1800000 || !(resume ? ['completing', 'completion_pending'] : ['redirected']).includes(session.phase)) fail('INVALID_STATE', 'The authentication session is expired, mismatched, or already attempted.');
    const identity = await this.identity(expectedAccountId ?? session.accountId);
    if (session.subject !== identity.subject || session.accountId !== identity.accountId) fail('ACCOUNT_CHANGED', 'The authentication session belongs to a different signed-in identity.');
    const current = await this.bundle(ref, session.action === 'connect', identity, signal);
    if (current.requestFingerprint !== session.requestFingerprint) fail('STALE_ACTION', 'The message authentication request changed.');
    if (resume) return this.#finishCompletion(sessionFile, session, identity, signal);
    const callback = await privateText(callbackFile, input, signal); let url;
    try { url = new URL(callback); } catch { fail('INVALID_ARGUMENT', 'The private callback is not a URL.'); }
    if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/connector_platform_oauth_redirect' || url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== session.oauthState) fail('INVALID_ARGUMENT', 'The callback does not match this authentication attempt.');
    if (url.searchParams.has('error')) fail('OAUTH_CANCELLED', 'The provider did not authorize this connection.');
    signal?.throwIfAborted();
    await writePrivate(sessionFile, JSON.stringify({ ...session, phase: 'callback_pending' }), { overwrite: true });
    signal?.throwIfAborted();
    const value = await this.transport.request('POST', '/backend-api/aip/connectors/links/oauth/callback', { body: { full_redirect_url: callback }, expectedAccountId: identity.accountId, signal });
    const link = value?.link;
    if (link?.connector_id !== current.connectorId || link.auth_status !== 'ACTIVE' || !link.id || (session.action === 'reauthenticate' ? link.id !== session.linkId : link.auth_type !== 'OAUTH')) fail('ACTION_UNCONFIRMED', 'The provider callback did not confirm the selected connection.');
    return this.#finishCompletion(sessionFile, session, identity, signal);
  }
  async #finishCompletion(sessionFile, session, identity, signal) {
    await this.assertIdentity(identity); signal?.throwIfAborted();
    const calls = (session.completionCalls ?? 0) + 1;
    if (!Number.isSafeInteger(calls) || calls > 6) fail('ACTION_UNCONFIRMED', 'This authentication session has exhausted its bounded completion attempts. Request a fresh sign-in link.');
    text(session.completionToken, 'completion token', 65536);
    const next = { ...session, phase: 'completing', completionCalls: calls };
    await writePrivate(sessionFile, JSON.stringify(next), { overwrite: true });
    const result = await this.request('POST', `/connector-auth/${encodeURIComponent(session.reference)}/complete`, identity.accountId, { body: { completion_token: session.completionToken }, signal });
    if (!OUTCOMES.includes(result?.outcome)) fail('ACTION_UNCONFIRMED', 'The server did not acknowledge the continuation outcome.');
    const pending = result.outcome === 'pending';
    await writePrivate(sessionFile, JSON.stringify(pending ? { ...next, phase: 'completion_pending' } : { version: 1, accountId: identity.accountId, reference: session.reference, phase: 'terminal', outcome: result.outcome }), { overwrite: true });
    return { accountId: identity.accountId, reference: session.reference, outcome: result.outcome, completed: ['started', 'context_delivered', 'suppressed'].includes(result.outcome), ...(pending ? { resumeRequired: true } : {}) };
  }
}
