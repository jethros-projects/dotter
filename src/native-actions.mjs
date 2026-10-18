import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DotError } from './errors.mjs';
import { validateRoom } from './client.mjs';

// The installed client's card-25996ba7d872.js validates native requests and
// mcp-plugin-logo-48e6f17f721d.js constructs this first-party review page. Native
// device proofs and wallet enrollment remain in that page; no proof is accepted
// from a CLI flag, file, or callback URL.
const MAX_STATE = 16384;
const TTL = 15 * 60 * 1000;
const FIELD_ID = /^[A-Za-z0-9_-]{1,48}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{32,128}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const run = promisify(execFile);
const fail = (code, message) => { throw new DotError(code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail('INVALID_ARGUMENT', `${name} must be a bounded nonempty string.`);
  return value;
}
function id(value, name) { text(value, name, 1024); if (!/^[A-Za-z0-9][A-Za-z0-9_.:~-]*$/.test(value)) fail('INVALID_ARGUMENT', `${name} must be an ID returned by Dot.`); return value; }
function fieldId(value) { if (typeof value !== 'string' || !FIELD_ID.test(value) || RESERVED.has(value)) fail('INVALID_RESPONSE', 'The browser request contains an invalid field identity.'); return value; }
function safeText(value, max = 8192) { return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : null; }
function webOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('INVALID_RESPONSE', 'The browser request origin is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value !== url.origin) fail('INVALID_RESPONSE', 'The browser request does not contain a canonical web origin.');
  return url.origin;
}
function visible(item) {
  return record(item) && item.deleted_at == null && item.deletedAt == null && item.is_hidden !== true && item.hidden !== true && item.is_visually_hidden_from_conversation !== true
    && item.metadata?.is_hidden !== true && item.metadata?.hidden !== true && item.metadata?.is_visually_hidden_from_conversation !== true
    && [item.channel, item.metadata?.channel].every(channel => channel == null || ['final', 'commentary'].includes(channel))
    && [item.recipient, item.metadata?.recipient].every(recipient => recipient == null || recipient === 'all') && item.content?.type !== 'message_error';
}
function subject(auth) {
  try { const value = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url')).sub; if (typeof value === 'string' && value) return value; } catch {}
  fail('AUTH_IDENTITY_REQUIRED', 'A Codex login with a verifiable user identity is required for native approvals.');
}
async function identity(transport, expectedAccountId) {
  if (expectedAccountId !== undefined) text(expectedAccountId, 'account ID');
  if (typeof transport.authLoader !== 'function') fail('AUTH_IDENTITY_REQUIRED', 'The native approval transport must expose the current Codex login.');
  const auth = await transport.authLoader({ authFile: transport.authFile });
  if (!auth?.accountId || expectedAccountId && auth.accountId !== expectedAccountId) fail('ACCOUNT_CHANGED', 'The native approval belongs to another signed-in account.');
  transport.assertIdentity?.(auth);
  return { accountId: auth.accountId, subject: subject(auth) };
}
function stable(value, depth = 0) {
  if (depth > 32) fail('INVALID_RESPONSE', 'The native request is nested too deeply.');
  if (Array.isArray(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(request) {
  const serialized = stable({ request_id: request.request_id, thread_id: request.thread_id, turn_id: request.turn_id ?? null, params: request.params });
  if (Buffer.byteLength(serialized) > 512 * 1024) fail('INVALID_RESPONSE', 'The native request is too large.');
  return createHash('sha256').update(serialized).digest('hex');
}
function browserDetails(params) {
  const meta = params._meta;
  if (params.mode !== 'form' || params.requestedSchema?.type !== 'object' || !record(meta) || meta.codex_approval_kind !== 'browser_auth' || !CHALLENGE.test(meta.browser_auth_challenge_id ?? '') || !Array.isArray(meta.fields) || meta.fields.length > 6 || typeof meta.reason !== 'string') fail('INVALID_RESPONSE', 'The browser-auth request is not in the verified native format.');
  const fields = meta.fields.map(field => {
    if (!record(field) || !['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(field.type) || typeof field.required !== 'boolean' || typeof field.label !== 'string' || field.label.length > 8192 || field.autocomplete != null && typeof field.autocomplete !== 'string') fail('INVALID_RESPONSE', 'The browser request contains an invalid field.');
    return { id: fieldId(field.id), label: field.label, type: field.type, required: field.required, ...(field.autocomplete == null ? {} : { autocomplete: safeText(field.autocomplete, 2048) }) };
  });
  if (new Set(fields.map(field => field.id)).size !== fields.length) fail('INVALID_RESPONSE', 'The browser request contains duplicate field identities.');
  if (meta.options !== undefined && (!Array.isArray(meta.options) || meta.options.length > 10)) fail('INVALID_RESPONSE', 'The browser request contains invalid choices.');
  const options = (meta.options ?? []).map(option => {
    if (!record(option) || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 120 || !Array.isArray(option.field_ids) || option.field_ids.length > 6) fail('INVALID_RESPONSE', 'The browser request contains an invalid choice.');
    const fieldIds = option.field_ids.map(fieldId);
    if (new Set(fieldIds).size !== fieldIds.length || fieldIds.some(value => !fields.some(field => field.id === value))) fail('INVALID_RESPONSE', 'The browser request choice refers to unknown fields.');
    return { id: fieldId(option.id), label: option.label.trim(), fieldIds };
  });
  if (new Set(options.map(option => option.id)).size !== options.length) fail('INVALID_RESPONSE', 'The browser request contains duplicate choices.');
  for (const key of ['qrCode', 'qrCodeRequiresApp']) if (meta[key] !== undefined && typeof meta[key] !== 'boolean') fail('INVALID_RESPONSE', 'The browser request has invalid QR metadata.');
  const tab = meta.screenshot?.tabId;
  return { challengeId: meta.browser_auth_challenge_id, origin: webOrigin(meta.origin), fields, options, reason: safeText(meta.reason),
    targetTabId: typeof tab === 'string' && /^[1-9]\d*$/.test(tab) && Number.isSafeInteger(Number(tab)) ? tab : null,
    qrCode: meta.qrCode === true, qrCodeRequiresApp: meta.qrCodeRequiresApp === true, hasWebauthn: meta.webauthn != null };
}
function requestKind(params) {
  const meta = params._meta ?? {};
  if (Object.hasOwn(meta, 'openai/location')) {
    if (!record(meta['openai/location']) || Object.keys(meta['openai/location']).length || params.mode !== 'form' || params.requestedSchema?.type !== 'object') fail('INVALID_RESPONSE', 'The location request is not in the verified native format.');
    return 'location';
  }
  if (params.mode === 'openai/userVerification') {
    const challenge = params.challenge;
    if (params.serverName !== 'codex_apps' || typeof params.title !== 'string' || !params.title.trim() || typeof params.description !== 'string' || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]+$/.test(challenge) || Buffer.from(challenge, 'base64url').toString('base64url') !== challenge || Buffer.from(challenge, 'base64url').length < 1 || Buffer.from(challenge, 'base64url').length > 4096) fail('INVALID_RESPONSE', 'The identity request is not in the verified native format.');
    return 'userVerification';
  }
  if (meta.codex_approval_kind === 'wallet_enrollment') {
    const schema = params.requestedSchema;
    if (params.mode !== 'form' || params.serverName !== 'codex_apps' || schema?.type !== 'object' || !record(schema?.properties) || Object.keys(schema.properties).length !== 1 || schema.properties.registration_id?.type !== 'string' || schema.required?.length !== 1 || schema.required[0] !== 'registration_id') fail('INVALID_RESPONSE', 'The wallet request is not in the verified native format.');
    return 'walletEnrollment';
  }
  if (meta.codex_approval_kind === 'browser_auth') { browserDetails(params); return 'browserAuth'; }
  if (meta.codex_approval_kind === 'browser_email_otp') {
    const schema = params.requestedSchema;
    if (params.mode !== 'form' || !['node_repl', 'cua_repl'].includes(params.serverName) || meta.connector_id !== 'browser-use' || !CHALLENGE.test(meta.browser_auth_challenge_id ?? '') || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(meta.otp_handle ?? '') || webOrigin(meta.origin) !== meta.frame_origin || !meta.origin.startsWith('https://') || schema?.type !== 'object' || !record(schema?.properties) || Object.keys(schema.properties).length !== 1 || schema.properties.approved?.type !== 'boolean' || schema.required?.length !== 1 || schema.required[0] !== 'approved') fail('INVALID_RESPONSE', 'The email-code request is not in the verified native format.');
    return 'browserEmailOtp';
  }
  if (params.mode === 'url') return 'urlAction';
  fail('UNSUPPORTED_ACTION', 'This is not a supported native approval request. Use the ordinary form commands for forms.');
}
async function inspect(client, options, { pending = true } = {}) {
  id(options.messageId, 'message ID');
  const owner = await identity(client.transport, options.expectedAccountId);
  const roomId = validateRoom(await client.resolveRoom(options.roomId, options.signal));
  const base = `/backend-api/messaging/rooms/${roomId}/messages/${encodeURIComponent(options.messageId)}`;
  const page = await client.transport.request('GET', `/backend-api/messaging/rooms/${roomId}/messages`, { query: { around: options.messageId, limit: 20 }, expectedAccountId: owner.accountId, signal: options.signal });
  if (!Array.isArray(page?.items) || !page.items.some(item => item.id === options.messageId && visible(item))) fail('MESSAGE_UNAVAILABLE', 'The visible message is no longer available.');
  const data = await client.transport.request('GET', `${base}/elicitation`, { query: { inspect: true }, expectedAccountId: owner.accountId, signal: options.signal });
  const request = data?.elicitation;
  if (!record(request) || !record(request.params) || typeof request.request_id !== 'string' || !request.request_id.trim() || typeof request.thread_id !== 'string' || !request.thread_id || request.params.threadId !== request.thread_id || request.params.turnId != null && request.params.turnId !== request.turn_id || typeof data.request_fingerprint !== 'string' || !data.request_fingerprint) fail('INVALID_RESPONSE', 'The native request identity is invalid.');
  if (options.requestId !== undefined && options.requestId !== request.request_id || options.requestFingerprint !== undefined && options.requestFingerprint !== data.request_fingerprint) fail('STALE_ACTION', 'The native request changed. Inspect it again before continuing.');
  if (pending && (data.can_respond !== true || data.runtime_status !== 'pending' || ['resolved', 'expired', 'applied'].includes(request.status))) fail('ACTION_UNAVAILABLE', 'This native request is no longer pending and answerable.');
  const kind = requestKind(request.params);
  const fresh = await identity(client.transport, owner.accountId);
  if (fresh.subject !== owner.subject) fail('ACCOUNT_CHANGED', 'The signed-in user changed while inspecting the native request.');
  return { owner, base, request, data, kind, roomId, messageId: options.messageId, bindingHash: digest(request) };
}
function summary(value) {
  return { accountId: value.owner.accountId, roomId: value.roomId, messageId: value.messageId, requestId: value.request.request_id, threadId: value.request.thread_id, turnId: value.request.turn_id ?? null, requestFingerprint: value.data.request_fingerprint,
    kind: value.kind, canRespond: value.data.can_respond === true, runtimeStatus: safeText(value.data.runtime_status, 80), status: safeText(value.request.status, 80),
    title: safeText(value.request.params.title), message: safeText(value.request.params.message), serverName: safeText(value.request.params.serverName, 200), requiresHumanReview: true,
    ...(value.kind === 'browserAuth' ? { browser: browserDetails(value.request.params) } : {}),
    ...(value.kind === 'browserEmailOtp' ? { origin: value.request.params._meta.origin } : {}) };
}
export async function resolveBrowserAuthChallenge(client, options = {}) {
  const value = await inspect(client, options);
  if (value.kind !== 'browserAuth') fail('ACTION_UNAVAILABLE', 'The selected message is not a browser-auth request.');
  const details = browserDetails(value.request.params);
  if (options.challengeId !== undefined && options.challengeId !== details.challengeId) fail('STALE_ACTION', 'The browser-auth challenge changed.');
  return { ...summary(value), ...details, conversationId: value.request.thread_id, subject: value.owner.subject,
    metadata: { webauthn: details.hasWebauthn, qrCodeRequiresApp: details.qrCodeRequiresApp } };
}
export const inspectBrowserChallenge = resolveBrowserAuthChallenge;
async function stateRead(file) {
  let handle;
  try {
    handle = await open(text(file, 'session file', 4096), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_STATE || before.mode & 0o077) fail('INVALID_STATE', 'The session must be a private regular file.');
    const bytes = Buffer.alloc(before.size + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const after = await handle.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INVALID_STATE', 'The session changed while being read.');
    let value; try { value = JSON.parse(bytes.subarray(0, bytesRead)); } catch { fail('INVALID_STATE', 'The session is not valid JSON.'); }
    return value;
  } catch (error) { if (error instanceof DotError) throw error; fail('INVALID_STATE', 'Could not read a private native approval session.'); }
  finally { await handle?.close(); }
}
async function stateCreate(file, state) {
  let handle;
  try { handle = await open(text(file, 'session file', 4096), 'wx', 0o600); await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
  catch (error) { if (error instanceof DotError) throw error; if (error.code === 'EEXIST') fail('OUTPUT_EXISTS', 'The native approval session file already exists.'); fail('STATE_WRITE_FAILED', 'Could not save the private native approval session.'); }
  finally { await handle?.close(); }
}
function reviewUrl(value) {
  const url = new URL('https://chatgpt.com/elicitation');
  for (const [key, entry] of Object.entries({ thread_id: value.request.thread_id, request_id: value.request.request_id, room_id: value.roomId, message_id: value.messageId })) url.searchParams.set(key, entry);
  return url.href;
}
async function openReview(url, { signal } = {}) {
  signal?.throwIfAborted();
  try {
    await run(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open', process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { timeout: 10000, windowsHide: true, signal });
    signal?.throwIfAborted();
  } catch { signal?.throwIfAborted(); fail('BROWSER_OPEN_FAILED', 'Could not open the first-party review page. Open the returned review URL manually.'); }
}
export function nativeActionCapabilities() {
  return { nativeApprovals: ['request inspection', 'first-party human review handoff', 'bound status and completion checks', 'explicit email-code approval'], nativeDeviceWork: 'Biometrics, location permission and wallet enrollment run in the first-party review UI.', nativeApprovalLiveTested: false };
}
export class DotNativeActions {
  constructor(client, { now = Date.now, openBrowser = openReview } = {}) { if (typeof client?.transport?.request !== 'function') throw new TypeError('DotNativeActions requires a Dot client.'); this.client = client; this.now = now; this.openBrowser = openBrowser; }
  async inspect(options = {}) { return summary(await inspect(this.client, options, { pending: false })); }
  async start(options = {}) {
    if (typeof options.noOpen !== 'undefined' && typeof options.noOpen !== 'boolean') fail('INVALID_ARGUMENT', 'noOpen must be a boolean.');
    if (options.openBrowser !== undefined && typeof options.openBrowser !== 'boolean') fail('INVALID_ARGUMENT', 'openBrowser must be a boolean.');
    text(options.requestId, 'request ID'); text(options.requestFingerprint, 'request fingerprint'); text(options.sessionFile, 'session file', 4096);
    options.signal?.throwIfAborted();
    const value = await inspect(this.client, options);
    options.signal?.throwIfAborted();
    const url = reviewUrl(value); const createdAt = this.now();
    try {
      await stateCreate(options.sessionFile, { version: 1, ...value.owner, roomId: value.roomId, messageId: value.messageId, requestId: value.request.request_id, threadId: value.request.thread_id, requestFingerprint: value.data.request_fingerprint, bindingHash: value.bindingHash, kind: value.kind, createdAt, expiresAt: createdAt + TTL });
    } catch (error) { options.signal?.throwIfAborted(); throw error; }
    options.signal?.throwIfAborted();
    let opened = false;
    if (!options.noOpen && options.openBrowser !== false) {
      try { await this.openBrowser(url, { signal: options.signal }); options.signal?.throwIfAborted(); opened = true; }
      catch { options.signal?.throwIfAborted(); }
    }
    return { ...summary(value), reviewUrl: url, sessionFile: options.sessionFile, opened, expiresAt: new Date(createdAt + TTL).toISOString() };
  }
  async status(options = {}) {
    const session = await stateRead(options.sessionFile);
    if (!record(session) || session.version !== 1 || !Number.isFinite(session.expiresAt) || !Number.isFinite(session.createdAt) || session.expiresAt <= this.now() || session.createdAt > this.now() || session.expiresAt - session.createdAt !== TTL || session.expiresAt > this.now() + TTL) fail('INVALID_STATE', 'The native approval session is expired or invalid. Start a new review.');
    const owner = await identity(this.client.transport, options.expectedAccountId ?? session.accountId);
    if (owner.accountId !== session.accountId || owner.subject !== session.subject) fail('ACCOUNT_CHANGED', 'The native approval session belongs to another signed-in user.');
    const value = await inspect(this.client, { roomId: session.roomId, messageId: session.messageId, requestId: session.requestId, expectedAccountId: owner.accountId, signal: options.signal }, { pending: false });
    if (value.owner.subject !== owner.subject || value.bindingHash !== session.bindingHash || value.request.thread_id !== session.threadId || value.kind !== session.kind || value.data.request_fingerprint !== session.requestFingerprint) fail('STALE_ACTION', 'The native request changed since human review started.');
    const status = value.data.runtime_status; const requestStatus = value.request.status;
    const expired = status === 'expired' || requestStatus === 'expired';
    return { ...summary(value), resolved: !expired && (status === 'resolved' || requestStatus === 'resolved' || status === 'applied' || requestStatus === 'applied'), expired, approvalOutcome: 'not_exposed' };
  }
  async complete(options = {}) {
    const result = await this.status(options);
    if (!result.resolved) fail(result.expired ? 'ACTION_EXPIRED' : 'ACTION_PENDING', result.expired ? 'The native request expired without a confirmed resolution.' : 'The native request is still pending. Complete the first-party review first.');
    return { ...result, completionVerified: true };
  }
  async approveEmailOtp(options = {}) {
    text(options.requestId, 'request ID'); text(options.requestFingerprint, 'request fingerprint');
    if (options.confirm !== options.requestId) fail('CONFIRMATION_REQUIRED', 'Confirm the exact request ID to allow the browser to retrieve and use the email code.');
    const value = await inspect(this.client, options);
    if (value.kind !== 'browserEmailOtp') fail('ACTION_UNAVAILABLE', 'The selected request is not an email-code approval.');
    options.signal?.throwIfAborted();
    const result = await this.client.transport.request('POST', `${value.base}/elicitation/response`, { body: { request_fingerprint: value.data.request_fingerprint, result: { action: 'accept', content: { approved: true }, _meta: null } }, expectedAccountId: value.owner.accountId, signal: options.signal });
    if (result?.status !== 'applied') throw new DotError('ACTION_UNCONFIRMED', 'The server did not confirm the email-code approval. Inspect its status before trying again.', { delivery: 'unknown' });
    return { accountId: value.owner.accountId, roomId: value.roomId, messageId: value.messageId, requestId: value.request.request_id, kind: value.kind, applied: true };
  }
}
