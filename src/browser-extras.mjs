import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import QRCode from './vendor/qrcode/index.cjs';
import { DotError } from './errors.mjs';
import { resolveBrowserAuthChallenge } from './native-actions.mjs';

// Audited installed app: app-initial-90eb42395b7d (QR),
// settings-95849fbd912d (policy), cloud-browser-local-live-view-b5d40a304f4e.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const POLICIES = {
  always_ask: { approval_mode: 'always_ask', disable_auto_review: true },
  auto_approve: { approval_mode: 'always_ask', disable_auto_review: false },
  always_allow: { approval_mode: 'never_ask', disable_auto_review: true },
};
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
async function identity(client, expectedAccountId) {
  if (expectedAccountId != null) id(expectedAccountId, 'expectedAccountId');
  const auth = typeof client.transport.authLoader === 'function' ? await client.transport.authLoader({ authFile: client.transport.authFile }) : null;
  if (auth && (!auth.accountId || expectedAccountId && expectedAccountId !== auth.accountId)) throw new DotError('ACCOUNT_CHANGED', 'The selected browser account differs from the current Codex login.');
  if (auth) client.transport.assertIdentity?.(auth);
  const selected = auth?.accountId ?? expectedAccountId;
  if (!selected) throw new DotError('ACCOUNT_REQUIRED', 'Select the account used by this browser session.');
  let subject = null;
  try { const value = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); if (typeof value.sub === 'string') subject = value.sub; } catch {}
  return { accountId: selected, subject };
}
async function account(client, expectedAccountId) { return (await identity(client, expectedAccountId)).accountId; }
// Native settings form gt/k5t: only an origin, optionally with hostname
// wildcards. URL paths, credentials, query strings and fragments are not rules.
function canonicalOriginPattern(value, normalizeInput = true) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let input = normalizeInput ? value.trim().replace(/\/$/, '') : value;
  if (normalizeInput && !input.includes('://')) input = `https://${input}`;
  if (!input || input.length > 4096 || input !== input.trim() || /\s/u.test(input)) return null;
  const delimiter = input.indexOf('://');
  if (delimiter <= 0) return null;
  const authority = input.slice(delimiter + 3);
  if (!authority || /[/#\\@]/u.test(authority)) return null;
  let rawHost;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']'), rest = authority.slice(end + 1);
    if (end <= 1 || rest && !/^:\d+$/u.test(rest)) return null;
    rawHost = authority.slice(0, end + 1);
  } else {
    const colon = authority.indexOf(':');
    if (colon !== authority.lastIndexOf(':') || colon >= 0 && !/^\d+$/u.test(authority.slice(colon + 1))) return null;
    rawHost = colon < 0 ? authority : authority.slice(0, colon);
    if (!rawHost || rawHost.includes('%') || rawHost.endsWith('..') || !rawHost.replace(/\.$/u, '').split('.').every(Boolean)
      || rawHost.replace(/\.$/u, '').split('.').some(part => /[*?]/u.test(part) && /[^\p{ASCII}]/u.test(part))) return null;
  }
  try {
    const url = new URL(input.replaceAll('?', '*'));
    const sandbox = url.protocol === 'codex-sandbox:' && !url.port && ['web-sandbox.oaiusercontent.com', 'staging-web-sandbox.oaiusercontent.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (!['https:', 'http:'].includes(url.protocol) && !sandbox || url.username || url.password) return null;
    let host = rawHost.includes('?') ? rawHost.split('.').map(part => /[*?]/u.test(part) ? part : new URL(`https://${part}.invalid`).hostname.slice(0, -8)).join('.') : url.hostname.replace(/%2a/giu, '*');
    if (/[{}\\/\p{White_Space}]/u.test(host) || host === '*.' || host === '**.') return null;
    const plain = host.replace(/^\*\*?\./u, '');
    if (plain.includes('**')) return null;
    if (/[[\]]/u.test(plain)) {
      const end = plain.indexOf(']');
      if (!plain.startsWith('[') || end < 0 || !/^\.*$/u.test(plain.slice(end + 1))) return null;
      const inner = plain.slice(1, end);
      if (/[[\]]/u.test(inner) || !inner.includes(':') || !new URL(`http://[${inner}]/`).hostname) return null;
    }
    // The native hostname parser removes brackets and trailing dots, then the
    // origin parser restores IPv6 brackets in its canonical output.
    const bracketed = host.startsWith('[');
    host = (bracketed ? host.slice(1, host.indexOf(']')) : host).replace(/[A-Z]/g, part => part.toLowerCase()).replace(/\.+$/u, '');
    if (!host || host === '*.' || host === '**.') return null;
    return `${url.protocol}//${bracketed ? `[${host}]` : host}${url.port ? `:${url.port}` : ''}`;
  } catch { return null; }
}
function originPattern(value) {
  const result = canonicalOriginPattern(value);
  if (result == null) throw new DotError('INVALID_ARGUMENT', 'Use a website origin or native hostname pattern, without a path, credentials, query or fragment (maximum 4096 characters).');
  return result;
}
function safeOrigins(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new DotError('INVALID_RESPONSE', 'The browser config did not contain a valid origin rule list.');
  const seen = new Set();
  return value.map(item => {
    const canonical = canonicalOriginPattern(item?.pattern, false);
    if (!item || typeof item !== 'object' || Array.isArray(item) || canonical == null || !['allow', 'deny'].includes(item.decision) || seen.has(canonical)) throw new DotError('INVALID_RESPONSE', 'The browser config contained an invalid or duplicate origin rule.');
    seen.add(canonical);
    return { pattern: item.pattern, decision: item.decision };
  });
}
function safeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['always_ask', 'never_ask'].includes(value.approval_mode) || typeof value.disable_auto_review !== 'boolean') throw new DotError('INVALID_RESPONSE', 'The browser config did not contain a recognized approval policy.');
  const policy = Object.keys(POLICIES).find(key => POLICIES[key].approval_mode === value.approval_mode && POLICIES[key].disable_auto_review === value.disable_auto_review) ?? null;
  return { approvalMode: value.approval_mode, disableAutoReview: value.disable_auto_review, policy, ...(typeof value.webauthn_enabled === 'boolean' ? { webauthnEnabled: value.webauthn_enabled } : {}), ...(value.origins !== undefined ? { origins: safeOrigins(value.origins) } : {}) };
}
function credentialId(value, code = 'INVALID_ARGUMENT') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+\/=-]{1,4096}$/u.test(value)) throw new DotError(code, 'Use an exact credential ID returned by the browser passkey list.');
  return value;
}
function safePasskeys(value) {
  if (!value || !Array.isArray(value.passkeys) || value.passkeys.length > 10000) throw new DotError('INVALID_RESPONSE', 'The browser response did not contain a valid passkey list.');
  const seen = new Set();
  return value.passkeys.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DotError('INVALID_RESPONSE', 'The browser passkey list contained invalid metadata.');
    const key = credentialId(item.credential_id, 'INVALID_RESPONSE');
    if (seen.has(key)) throw new DotError('INVALID_RESPONSE', 'The browser passkey list contained duplicate credential IDs.');
    seen.add(key);
    const result = { credentialId: key };
    for (const [field, target] of [['relying_party_id', 'relyingPartyId'], ['user_display_name', 'userDisplayName'], ['user_name', 'userName']]) {
      if (item[field] != null && (typeof item[field] !== 'string' || item[field].length > 4096 || /[\0\r\n]/u.test(item[field]))) throw new DotError('INVALID_RESPONSE', 'The browser passkey list contained invalid metadata.');
      if (item[field] != null) result[target] = item[field];
    }
    return result;
  });
}
function safeHandoff(value) {
  if (value == null) return null;
  let url;
  try { url = new URL(value); } catch { throw new DotError('INVALID_RESPONSE', 'The browser returned an invalid legacy viewer address.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const hosted = url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com') || url.hostname === 'openai.com' || url.hostname.endsWith('.openai.com');
  if (url.username || url.password || value.length > 32768 || /[\r\n\0]/.test(value) || !(local && ['http:', 'https:'].includes(url.protocol) || hosted && url.protocol === 'https:' && !url.port)) throw new DotError('UNSUPPORTED_VIEWER_ORIGIN', 'The browser returned an unrecognized legacy viewer origin. No viewer was opened.');
  return { url: url.href, local };
}
function htmlAttribute(value) { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function clipboardPolicy(viewer) {
  const allow = viewer ? `self "${new URL(viewer.url).origin}"` : '';
  return `microphone=(), camera=(), geolocation=(), clipboard-read=(${allow}), clipboard-write=(${allow})`;
}
function visibleCard(item) {
  return item && typeof item === 'object' && item.deleted_at == null && item.deletedAt == null
    && ![item.is_hidden, item.hidden, item.is_visually_hidden_from_conversation, item.metadata?.is_hidden, item.metadata?.hidden, item.metadata?.is_visually_hidden_from_conversation].some(Boolean)
    && [item.channel, item.metadata?.channel].every(value => value == null || ['final', 'commentary'].includes(value))
    && [item.recipient, item.metadata?.recipient].every(value => value == null || value === 'all');
}
function sameQrBinding(a, b) { return ['accountId', 'subject', 'roomId', 'messageId', 'requestId', 'requestFingerprint', 'conversationId', 'challengeId', 'origin'].every(key => a[key] === b[key]); }
/** Render a QR locally; no payload is embedded as text, attributes, URLs or logs. */
export function renderBrowserQr(payload) {
  if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 2300 || /\0/.test(payload)) throw new DotError('INVALID_RESPONSE', 'The browser QR payload is missing or exceeds the supported size.');
  const qr = new QRCode(-1, 1); // L correction; UTF-8 bytes in byte mode.
  qr.addData(Buffer.from(payload, 'utf8').toString('latin1'));
  try { qr.make(); } catch { throw new DotError('INVALID_RESPONSE', 'The browser QR payload could not be encoded.'); }
  const size = qr.getModuleCount(), path = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) path.push(`M${col + 4},${row + 4}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" role="img" aria-label="Browser sign-in QR code"><path fill="white" d="M0 0h${size + 8}v${size + 8}H0z"/><path fill="black" d="${path.join('')}"/></svg>`;
}
function metadata(state) { return { available: !!state?.latest && !state.disappeared, timestampMs: state?.latest?.timestamp_ms ?? null, hasRotated: state?.hasRotated ?? false, disappeared: state?.disappeared ?? false }; }
function cookieSurface(surface = 'Orbit') { if (!['Orbit', 'ChatGPT'].includes(surface)) throw new DotError('INVALID_ARGUMENT', 'Cookie surface must be Orbit or ChatGPT.'); return surface === 'Orbit' ? { surface } : {}; }
function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) throw new DotError('INVALID_ARGUMENT', 'hostname must be an exact lowercase hostname from the cookie list.');
  return value;
}
function cookieTarget(value, surface) {
  if (surface !== 'Orbit') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0 || Object.keys(value).length > 20 || Object.entries(value).some(([key, val]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || ['surface', 'include_subdomains'].includes(key) || typeof val !== 'string' || !ID.test(val))) throw new DotError('INVALID_RESPONSE', 'The Dot cookie target is missing or invalid. Refresh the cookie list.');
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
function targetFingerprint(selectedIdentity, surface, target) { return createHash('sha256').update(JSON.stringify({ identity: selectedIdentity, surface, target })).digest('hex'); }
export function browserExtrasCapabilities() { return { browserExtras: ['approval-policy read/update', 'website origin permission list/set/remove', 'saved browser passkey metadata list/delete', 'private local QR sign-in viewer with verified request-card seed and rotation', 'legacy noVNC local viewer with origin-scoped clipboard permission delegation', 'scoped cookie listing/deletion/clear'], browserExtrasLiveTested: false }; }

export class DotBrowserExtras {
  #qr = new Map();
  #qrBindings = new Map();
  constructor(client) { if (!client?.transport?.request) throw new TypeError('DotBrowserExtras requires a Dot client.'); this.client = client; }
  async config({ expectedAccountId, signal } = {}) {
    expectedAccountId = await account(this.client, expectedAccountId);
    return safeConfig(await this.client.transport.request('GET', '/backend-api/flora/browser/config', { expectedAccountId, signal }));
  }
  async updateConfig({ policy, approvalMode, disableAutoReview, expectedAccountId, confirm, signal } = {}) {
    let body;
    if (policy != null) {
      if (!Object.hasOwn(POLICIES, policy) || approvalMode != null || disableAutoReview != null) throw new DotError('INVALID_ARGUMENT', 'Use one policy: always_ask, auto_approve or always_allow. Do not combine it with raw fields.');
      body = { ...POLICIES[policy] };
    } else {
      if (!['always_ask', 'never_ask'].includes(approvalMode) || typeof disableAutoReview !== 'boolean') throw new DotError('INVALID_ARGUMENT', 'Supply a policy or both approvalMode and disableAutoReview.');
      body = { approval_mode: approvalMode, disable_auto_review: disableAutoReview };
    }
    id(expectedAccountId, 'expectedAccountId');
    if (confirm !== expectedAccountId) throw new DotError('CONFIRMATION_REQUIRED', 'Confirm the exact account ID before changing browser approval policy.');
    expectedAccountId = await account(this.client, expectedAccountId);
    const result = await this.client.transport.request('PATCH', '/backend-api/flora/browser/config', { body, expectedAccountId, signal });
    try {
      const value = safeConfig(result);
      if (value.approvalMode !== body.approval_mode || value.disableAutoReview !== body.disable_auto_review) throw new Error();
      return value;
    } catch { throw new DotError('INVALID_RESPONSE', 'The browser policy change was not confirmed. Read the current config before retrying.', { delivery: 'unknown' }); }
  }
  async origins(options = {}) {
    const config = await this.config(options);
    if (!config.origins) throw new DotError('INVALID_RESPONSE', 'The browser config did not contain an origin rule list.');
    return { origins: config.origins };
  }
  async #mutateOrigin({ pattern, decision, expectedAccountId, confirm, signal }, remove) {
    pattern = originPattern(pattern);
    if (!remove && !['allow', 'deny'].includes(decision)) throw new DotError('INVALID_ARGUMENT', 'Origin decision must be allow or deny.');
    id(expectedAccountId, 'expectedAccountId');
    if (confirm !== expectedAccountId) throw new DotError('CONFIRMATION_REQUIRED', 'Confirm the exact account ID before changing a website permission.');
    expectedAccountId = await account(this.client, expectedAccountId);
    const current = await this.origins({ expectedAccountId, signal });
    const existing = current.origins.find(item => canonicalOriginPattern(item.pattern, false) === pattern);
    if (remove && !existing) throw new DotError('ORIGIN_NOT_FOUND', 'The selected website permission is no longer present.');
    const selectedPattern = existing?.pattern ?? pattern, selectedDecision = remove ? 'unset' : decision;
    const result = await this.client.transport.request('PATCH', '/backend-api/flora/browser/config', { body: { origin_mutation: { pattern: selectedPattern, decision: selectedDecision } }, expectedAccountId, signal });
    try {
      const next = safeConfig(result);
      if (!next.origins) throw new Error();
      const found = next.origins.find(item => canonicalOriginPattern(item.pattern, false) === pattern);
      if (remove ? !!found : found?.decision !== decision) throw new Error();
      return { pattern: selectedPattern, decision: selectedDecision, verified: true };
    } catch { throw new DotError('INVALID_RESPONSE', 'The website permission change was not confirmed. Read the current origin rules before retrying.', { delivery: 'unknown' }); }
  }
  async setOrigin(options = {}) { return this.#mutateOrigin(options, false); }
  async removeOrigin(options = {}) { return this.#mutateOrigin(options, true); }
  async passkeys({ expectedAccountId, signal } = {}) {
    expectedAccountId = await account(this.client, expectedAccountId);
    // The native settings panel mounts passkeys only when this flag is true.
    const config = await this.config({ expectedAccountId, signal });
    if (config.webauthnEnabled !== true) throw new DotError('UNSUPPORTED', 'Saved cloud-browser passkeys are not enabled for this account.');
    expectedAccountId = await account(this.client, expectedAccountId);
    return { passkeys: safePasskeys(await this.client.transport.request('GET', '/backend-api/flora/browser/passkeys', { expectedAccountId, signal })) };
  }
  async deletePasskey({ credentialId: selectedId, expectedAccountId, confirm, signal } = {}) {
    credentialId(selectedId);
    if (selectedId.includes('/')) throw new DotError('UNSUPPORTED_CREDENTIAL_ID', 'This credential ID contains a path separator unsupported by the fixed-route transport. No deletion was sent.');
    id(expectedAccountId, 'expectedAccountId');
    if (confirm !== selectedId) throw new DotError('CONFIRMATION_REQUIRED', 'Confirm the exact credential ID before deleting this saved browser passkey.');
    expectedAccountId = await account(this.client, expectedAccountId);
    const before = await this.passkeys({ expectedAccountId, signal });
    if (!before.passkeys.some(item => item.credentialId === selectedId)) throw new DotError('PASSKEY_NOT_FOUND', 'The selected saved browser passkey is no longer present.');
    await this.client.transport.request('DELETE', `/backend-api/flora/browser/passkeys/${encodeURIComponent(selectedId)}`, { expectedAccountId, signal });
    let after;
    try { after = await this.passkeys({ expectedAccountId, signal }); }
    catch { return { credentialId: selectedId, accepted: true, verified: false }; }
    return { credentialId: selectedId, accepted: true, verified: !after.passkeys.some(item => item.credentialId === selectedId) };
  }
  async #qrCard({ conversationId, challengeId, roomId, messageId, requestFingerprint, expectedAccountId, signal }, previous) {
    const explicit = roomId != null || messageId != null || requestFingerprint != null;
    if (!messageId) {
      if (typeof this.client.resolveRoom !== 'function') {
        if (explicit) throw new DotError('QR_CONTEXT_REQUIRED', 'Specify the current QR request room and message.');
        return null;
      }
      roomId = await this.client.resolveRoom(roomId, signal); id(roomId, 'roomId');
      const page = await this.client.transport.request('GET', `/backend-api/messaging/rooms/${encodeURIComponent(roomId)}/messages`, { query: { limit: 20 }, expectedAccountId, signal });
      if (!Array.isArray(page?.items)) throw new DotError('INVALID_RESPONSE', 'The QR request list was invalid.');
      const candidates = page.items.filter(item => {
        const request = item?.content?.elicitation, meta = request?.params?._meta;
        return visibleCard(item) && request?.thread_id === conversationId && request?.params?.threadId === conversationId
          && meta?.codex_approval_kind === 'browser_auth' && meta?.browser_auth_challenge_id === challengeId;
      });
      if (candidates.length > 1) throw new DotError('QR_CONTEXT_AMBIGUOUS', 'More than one matching QR request is visible. Specify its room and message.');
      if (candidates.length === 0) {
        if (explicit || previous) throw new DotError('QR_CONTEXT_UNAVAILABLE', 'The current QR request was not found. Specify its exact room and message.');
        return null;
      }
      messageId = id(candidates[0].id, 'messageId');
    }
    id(messageId, 'messageId'); if (roomId != null) id(roomId, 'roomId');
    const options = { roomId, messageId, challengeId, expectedAccountId, signal, ...(requestFingerprint ? { requestFingerprint } : {}) };
    const current = await resolveBrowserAuthChallenge(this.client, options);
    const binding = { accountId: current.accountId, subject: current.subject, roomId: current.roomId, messageId: current.messageId,
      requestId: current.requestId, requestFingerprint: current.requestFingerprint, conversationId: current.conversationId, challengeId: current.challengeId, origin: current.origin };
    if (binding.conversationId !== conversationId || binding.challengeId !== challengeId || expectedAccountId && binding.accountId !== expectedAccountId || previous && !sameQrBinding(previous, binding)) throw new DotError('STALE_QR_CHALLENGE', 'The current QR request differs from the selected challenge. Reopen it from the current request.');
    // Read only the verified card. The second fingerprint check prevents a
    // replaced card from seeding a payload after the resolver checked identity.
    const data = await this.client.transport.request('GET', `/backend-api/messaging/rooms/${encodeURIComponent(binding.roomId)}/messages/${encodeURIComponent(messageId)}/elicitation`, { query: { inspect: true }, expectedAccountId: binding.accountId, signal });
    const request = data?.elicitation, meta = request?.params?._meta;
    if (data?.request_fingerprint !== binding.requestFingerprint || request?.request_id !== binding.requestId || request?.thread_id !== conversationId || request?.params?.threadId !== conversationId
      || meta?.codex_approval_kind !== 'browser_auth' || meta?.browser_auth_challenge_id !== challengeId || meta?.origin !== binding.origin || data?.can_respond !== true || data?.runtime_status !== 'pending' || ['resolved', 'expired', 'applied'].includes(request?.status)) throw new DotError('STALE_QR_CHALLENGE', 'The QR request changed while reading it. Reopen the current request.');
    const fresh = await identity(this.client, binding.accountId);
    if (fresh.subject !== binding.subject) throw new DotError('AUTH_IDENTITY_CHANGED', 'The signed-in user changed while reading the QR request.');
    let payload = typeof meta.qrCodePayload === 'string' && meta.qrCodePayload ? meta.qrCodePayload : null;
    if (!payload && typeof meta.qrCodeUrl === 'string') {
      try { const url = new URL(meta.qrCodeUrl); if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) payload = meta.qrCodeUrl; } catch {}
    }
    if (payload) renderBrowserQr(payload);
    return { binding, payload };
  }
  #seedQr(key, card) {
    const previous = this.#qrBindings.get(key);
    if (previous && (!card || !sameQrBinding(previous, card.binding))) this.#qr.delete(key);
    if (!card) { this.#qrBindings.delete(key); return; }
    this.#qrBindings.set(key, card.binding);
    if (card.payload && !this.#qr.has(key)) this.#qr.set(key, { latest: { payload: card.payload, timestamp_ms: null }, hasRotated: false, disappeared: false });
  }
  async #poll({ conversationId, challengeId, expectedAccountId, signal, qrBinding }) {
    id(conversationId, 'conversationId'); id(challengeId, 'challengeId');
    expectedAccountId = await account(this.client, expectedAccountId);
    const key = JSON.stringify([expectedAccountId, conversationId, challengeId]);
    const previous = this.#qr.get(key);
    if (qrBinding) await this.#qrCard({ ...qrBinding, expectedAccountId, signal }, qrBinding);
    const response = await this.client.transport.request('GET', '/backend-api/flora/browser/qr-code', { query: { conversation_id: conversationId, challenge_id: challengeId }, headers: { 'Cache-Control': 'no-store' }, expectedAccountId, signal, includeResponse: true, maxBytes: 16384 });
    signal?.throwIfAborted();
    if (response.status === 204) return previous ?? null;
    const value = response.body;
    if (!value || typeof value.payload !== 'string' || !value.payload || Buffer.byteLength(value.payload) > 2300 || !Number.isSafeInteger(value.timestamp_ms) || value.timestamp_ms <= 0 || value.disappeared != null && typeof value.disappeared !== 'boolean') throw new DotError('INVALID_RESPONSE', 'The browser returned an invalid QR response.');
    if (previous?.latest && value.timestamp_ms < previous.latest.timestamp_ms) return previous;
    let state;
    if (value.disappeared === true) state = { latest: previous?.latest ?? null, hasRotated: previous?.hasRotated ?? false, disappeared: true };
    else if (value.timestamp_ms === previous?.latest?.timestamp_ms) return previous;
    else state = { latest: value, hasRotated: previous?.hasRotated === true || !!previous?.latest && previous.latest.payload !== value.payload, disappeared: false };
    this.#qr.set(key, state); return state;
  }
  async qrStatus(options = {}) {
    id(options.conversationId, 'conversationId'); id(options.challengeId, 'challengeId');
    const expectedAccountId = await account(this.client, options.expectedAccountId), card = await this.#qrCard({ ...options, expectedAccountId });
    const key = JSON.stringify([expectedAccountId, options.conversationId, options.challengeId]);
    this.#seedQr(key, card);
    return metadata(await this.#poll({ ...options, expectedAccountId, qrBinding: card?.binding }));
  }
  async #handoff({ conversationId, expectedAccountId, signal }) {
    id(conversationId, 'conversationId'); expectedAccountId = await account(this.client, expectedAccountId);
    const value = await this.client.transport.request('GET', '/backend-api/flora/browser/handoff', { query: { conversation_id: conversationId }, expectedAccountId, signal, maxBytes: 65536 });
    signal?.throwIfAborted();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_RESPONSE', 'The browser returned an invalid legacy viewer response.');
    return safeHandoff(value.novnc_url);
  }
  async handoffStatus(options = {}) { const value = await this.#handoff(options); return { available: value !== null, local: value?.local ?? null }; }
  async #cookies({ surface = 'Orbit', expectedAccountId, signal } = {}) {
    const query = cookieSurface(surface), selectedIdentity = await identity(this.client, expectedAccountId); expectedAccountId = selectedIdentity.accountId;
    const result = await this.client.transport.request('GET', '/backend-api/flora/browser/cookies', { query, expectedAccountId, signal });
    if (!result || !Array.isArray(result.hosts)) throw new DotError('INVALID_RESPONSE', 'The cookie list did not contain hosts.');
    const target = cookieTarget(result.target, surface);
    const hosts = result.hosts.map(item => {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.cookie_count) || item.cookie_count < 0) throw new DotError('INVALID_RESPONSE', 'The cookie list contained an invalid host.');
      let host; try { host = hostname(item.hostname); } catch { throw new DotError('INVALID_RESPONSE', 'The cookie list contained an invalid hostname.'); }
      let domain; if (item.registrable_domain != null) { try { domain = hostname(item.registrable_domain); } catch { throw new DotError('INVALID_RESPONSE', 'The cookie list contained an invalid registrable domain.'); } }
      return { hostname: host, cookieCount: item.cookie_count, ...(domain ? { registrableDomain: domain } : {}), ...(Number.isSafeInteger(item.size_bytes) && item.size_bytes >= 0 ? { sizeBytes: item.size_bytes } : {}) };
    });
    return { surface, expectedAccountId, target, targetFingerprint: targetFingerprint(selectedIdentity, surface, target), hosts };
  }
  async cookies(options = {}) { const { surface, targetFingerprint, hosts } = await this.#cookies(options); return { surface, targetFingerprint, hosts }; }
  async #deleteCookies({ surface = 'Orbit', expectedAccountId, targetFingerprint: expectedFingerprint, hostname: host, includeSubdomains = false, confirm, signal }, clear) {
    cookieSurface(surface); id(expectedAccountId, 'expectedAccountId');
    if (typeof includeSubdomains !== 'boolean') throw new DotError('INVALID_ARGUMENT', 'includeSubdomains must be a boolean.');
    if (!clear) hostname(host);
    if (confirm !== (clear ? expectedAccountId : host)) throw new DotError('CONFIRMATION_REQUIRED', clear ? 'Confirm the exact account ID before clearing cookies.' : 'Confirm the exact hostname before deleting cookies.');
    if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new DotError('INVALID_ARGUMENT', 'Use the targetFingerprint from a fresh cookie list.');
    const selected = await this.#cookies({ surface, expectedAccountId, signal });
    if (selected.targetFingerprint !== expectedFingerprint) throw new DotError('STALE_TARGET', 'The cookie target changed. Review a fresh cookie list before deleting.');
    if (!clear && !selected.hosts.some(item => item.hostname === host || includeSubdomains && item.registrableDomain === host)) throw new DotError('INVALID_ARGUMENT', 'The hostname or site is not present in the selected cookie store.');
    const response = await this.client.transport.request('DELETE', clear ? '/backend-api/agent/browser_context' : `/backend-api/flora/browser/cookies/${encodeURIComponent(host)}`, { query: { ...cookieSurface(surface), ...selected.target, ...(!clear ? { include_subdomains: includeSubdomains } : {}) }, expectedAccountId, signal });
    if (response?.completed === false || response?.success === false || response?.error != null || ['failed', 'error', 'rejected'].includes(response?.status)) throw new DotError('INVALID_RESPONSE', 'The cookie delete response did not confirm acceptance. Refresh the cookie list before retrying.', { delivery: 'unknown' });
    let verified = false;
    try {
      const current = await this.#cookies({ surface, expectedAccountId, signal });
      verified = current.targetFingerprint === selected.targetFingerprint && !(clear ? current.hosts.length : current.hosts.some(item => item.hostname === host || includeSubdomains && item.hostname.endsWith(`.${host}`)));
    } catch (error) {
      if (['ACCOUNT_CHANGED', 'AUTH_IDENTITY_CHANGED'].includes(error.code)) throw error;
      // A readback failure cannot justify retrying a mutation. Report acceptance
      // without claiming deletion is already visible.
    }
    return { accepted: true, verified, surface, ...(clear ? { cleared: 'all' } : { hostname: host, includeSubdomains }) };
  }
  deleteCookies(options = {}) { return this.#deleteCookies(options, false); }
  clearCookies(options = {}) { return this.#deleteCookies(options, true); }
  async viewerServer({ mode = 'qr', conversationId, challengeId, roomId, messageId, requestFingerprint, initialPayload, expectedAccountId, signal, idleTimeoutMs = 45000, startupTimeoutMs = 300000 } = {}) {
    if (!['qr', 'legacy'].includes(mode)) throw new DotError('INVALID_ARGUMENT', 'Viewer mode must be qr or legacy.');
    id(conversationId, 'conversationId'); if (mode === 'qr') id(challengeId, 'challengeId');
    for (const timeout of [idleTimeoutMs, startupTimeoutMs]) if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3600000) throw new DotError('INVALID_ARGUMENT', 'Viewer timeouts must be between 100 ms and one hour.');
    signal?.throwIfAborted(); expectedAccountId = await account(this.client, expectedAccountId);
    if (initialPayload !== undefined) throw new DotError('INVALID_ARGUMENT', 'QR seeds must come from the current verified request card, not an arbitrary payload.');
    if (mode !== 'qr' && (roomId != null || messageId != null || requestFingerprint != null)) throw new DotError('INVALID_ARGUMENT', 'QR request context requires QR viewer mode.');
    const card = mode === 'qr' ? await this.#qrCard({ conversationId, challengeId, roomId, messageId, requestFingerprint, expectedAccountId, signal }) : null;
    if (mode === 'qr') this.#seedQr(JSON.stringify([expectedAccountId, conversationId, challengeId]), card);
    const fixed = { conversationId, challengeId, expectedAccountId, qrBinding: card?.binding }, capability = randomBytes(32).toString('base64url'), nonce = randomBytes(18).toString('base64url');
    // The native legacy view fetches its URL before rendering the iframe. Do
    // the same so permission delegation names exactly that returned origin.
    const initialLegacyViewer = mode === 'legacy' ? await this.#handoff({ conversationId, expectedAccountId, signal }) : null;
    const [html, script] = await Promise.all([readFile(new URL('./browser-extras-ui.html', import.meta.url), 'utf8'), readFile(new URL('./browser-extras-browser.mjs', import.meta.url), 'utf8')]);
    const abort = new AbortController(), server = createServer(); let origin, host, timer, opened = false, closed = false, closing, pending, resolveDone, legacyViewer = initialLegacyViewer, legacyPath;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { void close(opened ? 'browser-disconnected' : 'startup-timeout'); }, opened ? idleTimeoutMs : startupTimeoutMs); timer.unref?.(); };
    const close = (reason = 'closed') => {
      if (closing) return closing;
      closed = true; legacyViewer = undefined; legacyPath = undefined; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); abort.abort(); const key = JSON.stringify([expectedAccountId, conversationId, challengeId]); this.#qr.delete(key); this.#qrBindings.delete(key);
      closing = (async () => { await pending?.catch(() => {}); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); server.closeAllConnections?.(); }); const result = { mode, reason }; resolveDone(result); return result; })(); return closing;
    };
    const onAbort = () => { void close('aborted'); };
    server.on('request', async (request, response) => {
      const documentNavigation = request.method === 'GET' && request.url === '/'
        && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if (request.headers.host !== host || request.headers.origin && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation) return json(response, 403, { error: { code: 'LOOPBACK_ORIGIN_REJECTED', message: 'Use this viewer’s exact local origin.' } });
      if (!closed && legacyPath && request.method === 'GET' && request.url === legacyPath) {
        try { await account(this.client, expectedAccountId); } catch { json(response, 403, { error: { code: 'ACCOUNT_CHANGED', message: 'The selected account changed.' } }); void close('account-changed'); return; }
        if (!legacyViewer) return json(response, 410, { error: { code: 'VIEWER_CLOSED', message: 'The viewer has closed.' } });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Permissions-Policy': clipboardPolicy(legacyViewer),
          'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; frame-src ${new URL(legacyViewer.url).origin}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` });
        response.end(`<!doctype html><html><head><meta charset="utf-8"><style nonce="${nonce}">html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe title="Legacy remote browser" referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock" src="${htmlAttribute(legacyViewer.url)}"></iframe></body></html>`); return;
      }
      if (request.method === 'GET' && ['/', '/browser-extras-browser.mjs'].includes(request.url)) {
        response.writeHead(200, { 'Content-Type': request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Permissions-Policy': clipboardPolicy(legacyViewer),
          'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        response.end(request.url === '/' ? html.replaceAll('__STYLE_NONCE__', nonce).replaceAll('__VIEWER_MODE__', mode) : script); return;
      }
      if (!['/api/poll', '/api/connect', '/api/heartbeat', '/api/stop'].includes(request.url)) return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
      if (request.method !== 'POST') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
      const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${capability}`);
      if (request.headers.origin !== origin || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return json(response, 403, { error: { code: 'LOOPBACK_AUTH_REJECTED', message: 'Use the fresh local viewer URL printed by the CLI.' } });
      if (closed) return json(response, 410, { error: { code: 'VIEWER_CLOSED', message: 'The viewer has closed.' } });
      let ownPending;
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new DotError('INVALID_ARGUMENT', 'Use application/json.');
        let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 128) throw new DotError('INVALID_ARGUMENT', 'The viewer request is too large.'); }
        let body; try { body = JSON.parse(text); } catch { throw new DotError('INVALID_ARGUMENT', 'Use an empty JSON object.'); }
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) throw new DotError('INVALID_ARGUMENT', 'Viewer targets cannot be changed by the browser.');
        await account(this.client, expectedAccountId); refresh();
        if (request.url === '/api/stop') { json(response, 200, { status: 'stopping' }); setImmediate(() => { void close('user-ended'); }); return; }
        if (request.url === '/api/heartbeat') return json(response, 200, { mode });
        if (pending) throw new DotError('VIEWER_BUSY', 'A viewer request is already in progress.');
        if (request.url === '/api/poll' && mode === 'qr') {
          opened = true; refresh(); pending = ownPending = this.#poll({ ...fixed, signal: abort.signal });
          const state = await pending; const value = metadata(state);
          json(response, 200, { ...value, ...(value.available ? { image: `data:image/svg+xml;base64,${Buffer.from(renderBrowserQr(state.latest.payload)).toString('base64')}` } : {}) }); return;
        }
        if (request.url === '/api/connect' && mode === 'legacy') {
          if (opened) throw new DotError('VIEWER_ALREADY_OPENED', 'Create a fresh viewer to reconnect.');
          opened = true; refresh(); const value = legacyViewer;
          if (value) { legacyViewer = value; legacyPath = `/legacy-frame/${randomBytes(24).toString('base64url')}`; }
          json(response, 200, { available: !!value, ...(value ? { viewer: legacyPath } : {}) }); return;
        }
        throw new DotError('INVALID_ARGUMENT', 'This operation does not match the viewer mode.');
      } catch (error) {
        const safe = error instanceof DotError ? { code: error.code, message: error.message } : { code: 'VIEWER_FAILED', message: 'The viewer request failed.' };
        json(response, error?.code === 'INVALID_ARGUMENT' ? 400 : 502, { error: safe });
        if (['ACCOUNT_CHANGED', 'AUTH_IDENTITY_CHANGED'].includes(error?.code)) setImmediate(() => { void close('account-changed'); });
      } finally { if (ownPending && pending === ownPending) pending = undefined; }
    });
    server.headersTimeout = 10000; server.requestTimeout = 30000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
    signal?.addEventListener('abort', onAbort, { once: true }); refresh(); if (signal?.aborted) void close('aborted');
    return { url: `${origin}/#${capability}`, origin, address, mode, done, close };
  }
  async #open({ noOpen, output = process.stdout, openBrowser = openDefaultBrowser, ...options }) {
    const viewer = await this.viewerServer(options);
    try {
      output.write(`Browser ${viewer.mode === 'qr' ? 'sign-in QR' : 'legacy viewer'}: ${viewer.url}\nOpen the local page and click Start. Press Ctrl-C to close it.\n`);
      if (!noOpen && openBrowser) await openBrowser(viewer.url); return await viewer.done;
    } catch (error) { await viewer.close('browser-open-failed'); throw error; }
  }
  qrOpen(options = {}) { return this.#open({ ...options, mode: 'qr' }); }
  handoffOpen(options = {}) { return this.#open({ ...options, mode: 'legacy' }); }
}
function openDefaultBrowser(url) {
  return new Promise((resolve, reject) => { const child = spawn('open', [url], { stdio: 'ignore' }); child.once('error', () => reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the local viewer.'))); child.once('exit', code => code === 0 ? resolve() : reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the local viewer.'))); });
}
