import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DotError } from './errors.mjs';

const MAX_SDP_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const CALL_ID = /^rtc_[A-Za-z0-9_.~-]{1,240}$/;
function id(value, label = 'Dot ID') {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function callId(value) {
  if (typeof value !== 'string' || !CALL_ID.test(value)) throw new DotError('INVALID_ARGUMENT', 'Call ID must be a voice call ID returned by the API.');
  return value;
}
function sdp(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SDP_BYTES || !/^v=0(?:\r?\n)/.test(value) || /\0/.test(value)) throw new DotError('INVALID_ARGUMENT', 'Supply a valid SDP offer of at most 256 KiB.');
  return value;
}
async function bindAccount(client, expectedAccountId) {
  if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !expectedAccountId)) throw new DotError('INVALID_ARGUMENT', 'Expected account ID must be a nonempty account ID.');
  if (typeof client.transport?.authLoader !== 'function') return expectedAccountId;
  const auth = await client.transport.authLoader({ authFile: client.transport.authFile });
  if (typeof auth.accountId !== 'string' || !auth.accountId) throw new DotError('ACCOUNT_REQUIRED', 'Voice requires a Codex login with an account selector.');
  if (expectedAccountId !== undefined && auth.accountId !== expectedAccountId) throw new DotError('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
  client.transport.assertIdentity?.(auth);
  return auth.accountId;
}
async function target(client, { dotId, rootThreadId, expectedAccountId, signal } = {}) {
  if (!dotId) { const primary = await client.primary({ signal, expectedAccountId }); dotId = primary.id; rootThreadId ??= primary.threadId; }
  await bindAccount(client, expectedAccountId);
  return { dotId: id(dotId), ...(rootThreadId ? { rootThreadId: id(rootThreadId, 'Root thread ID') } : {}) };
}
function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}
function parseCallLocation(value, dotId) {
  if (typeof value !== 'string') throw new DotError('INVALID_RESPONSE', 'Voice allocation did not return a call Location.');
  let url;
  try { url = new URL(value, 'https://chatgpt.com'); } catch { throw new DotError('INVALID_RESPONSE', 'Voice allocation returned an invalid call Location.'); }
  // Location is an identifier source only; it is never fetched or followed. Realtime
  // services may use their own absolute origin while TBO attach/stop remain fixed-origin.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new DotError('INVALID_RESPONSE', 'Voice allocation returned an unexpected call Location.');
  const pieces = url.pathname.split('/');
  let valueId;
  try { valueId = decodeURIComponent(pieces.at(-1)); } catch { throw new DotError('INVALID_RESPONSE', 'Voice allocation returned an invalid call ID.'); }
  try { callId(valueId); } catch { throw new DotError('INVALID_RESPONSE', 'Voice allocation returned an invalid call ID.'); }
  // The deployed service may return either a voice resource path or a fully qualified TBO path.
  const tboIndex = pieces.indexOf('tbo');
  if (tboIndex >= 0) {
    let identity;
    try { identity = decodeURIComponent(pieces[tboIndex + 1] ?? ''); } catch { throw new DotError('INVALID_RESPONSE', 'Voice allocation returned an invalid Dot identity.'); }
    if (identity !== dotId) throw new DotError('INVALID_RESPONSE', 'Voice allocation returned a different Dot identity.');
  }
  return valueId;
}

export function voiceCapabilities() {
  return { voice: ['WebRTC microphone chat', 'listen-only WebRTC', 'SDP allocation', 'attach', 'stop'], voiceLiveTested: false };
}

/** Create a native Dot voice resource. The caller must apply answer SDP, attach, then stop it. */
export async function allocateVoiceCall(client, { dotId, rootThreadId, sdp: offer, instantConnect = false, expectedAccountId, signal } = {}) {
  sdp(offer);
  if (typeof instantConnect !== 'boolean') throw new DotError('INVALID_ARGUMENT', 'instantConnect must be boolean.');
  expectedAccountId = await bindAccount(client, expectedAccountId);
  const resolved = await target(client, { dotId, rootThreadId, expectedAccountId, signal }); dotId = resolved.dotId; rootThreadId = resolved.rootThreadId;
  const result = await client.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/voice/calls`, {
    body: { sdp: offer, ...(instantConnect ? { instant_connect: true } : {}) }, responseType: 'text', includeResponse: true,
    expectedAccountId, signal, maxBytes: MAX_SDP_BYTES,
  });
  let allocatedId;
  try { allocatedId = parseCallLocation(header(result?.headers, 'location'), dotId); }
  catch (error) { error.details = { ...error.details, delivery: 'unknown', cleanup: 'unconfirmed' }; throw error; }
  const actualRoot = header(result?.headers, 'openai-root-thread-id');
  try {
    if (rootThreadId && actualRoot && actualRoot !== rootThreadId) throw new DotError('VOICE_IDENTITY_MISMATCH', 'Voice allocation belongs to a different root thread.');
    try { sdp(result?.body); } catch { throw new DotError('INVALID_RESPONSE', 'Voice allocation did not return a valid SDP answer.'); }
  } catch (error) {
    // Allocation succeeded. Dispose of it even if answer validation fails; do not retry creation.
    try { await stopVoiceCall(client, { dotId, callId: allocatedId, expectedAccountId }); } catch { error.details = { ...error.details, callId: allocatedId, cleanup: 'unconfirmed' }; }
    throw error;
  }
  return { dotId, callId: allocatedId, answer: result.body, rootThreadId: actualRoot || rootThreadId || null };
}
export async function attachVoiceCall(client, { dotId, callId: value, expectedAccountId, signal } = {}) {
  callId(value); expectedAccountId = await bindAccount(client, expectedAccountId);
  ({ dotId } = await target(client, { dotId, expectedAccountId, signal }));
  await client.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/voice/calls/${encodeURIComponent(value)}/attach`, { expectedAccountId, signal });
  return { dotId, callId: value, status: 'attached' };
}
export async function stopVoiceCall(client, { dotId, callId: value, expectedAccountId, signal } = {}) {
  callId(value); expectedAccountId = await bindAccount(client, expectedAccountId);
  ({ dotId } = await target(client, { dotId, expectedAccountId, signal }));
  await client.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(dotId)}/voice/calls/${encodeURIComponent(value)}/stop`, { expectedAccountId, signal });
  return { dotId, callId: value, status: 'stopped' };
}
function safeError(error) {
  return { code: error instanceof DotError ? error.code : 'VOICE_FAILED', message: error instanceof DotError ? error.message : 'The voice operation failed.' };
}
function secureEqual(actual, expected) {
  const a = Buffer.from(actual ?? ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new DotError('INVALID_ARGUMENT', 'Use application/json.');
  if (Number(request.headers['content-length'] ?? 0) > MAX_SDP_BYTES + 1024) throw new DotError('INVALID_ARGUMENT', 'Request is too large.');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_SDP_BYTES + 1024) throw new DotError('INVALID_ARGUMENT', 'Request is too large.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DotError('INVALID_ARGUMENT', 'Use a JSON object.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DotError('INVALID_ARGUMENT', 'Use a JSON object.');
  return body;
}
function ownKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new DotError('INVALID_ARGUMENT', 'Unexpected voice request fields.');
}

/** An ephemeral loopback broker. Only the browser receives its random capability, never account credentials. */
export async function createVoiceSessionServer(client, {
  dotId, rootThreadId, instantConnect = false, listenOnly = false, expectedAccountId, signal, idleTimeoutMs = 45000, startupTimeoutMs = 300000,
} = {}) {
  if (typeof listenOnly !== 'boolean') throw new DotError('INVALID_ARGUMENT', 'listenOnly must be boolean.');
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 3600000
    || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 3600000) throw new DotError('INVALID_ARGUMENT', 'Voice timeout must be between 100 ms and one hour.');
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  expectedAccountId = await bindAccount(client, expectedAccountId);
  ({ dotId, rootThreadId } = await target(client, { dotId, rootThreadId, expectedAccountId, signal }));
  const token = randomBytes(32).toString('base64url');
  const nonce = randomBytes(18).toString('base64url');
  const [html, browserScript] = await Promise.all([
    readFile(new URL('./voice-ui.html', import.meta.url), 'utf8'), readFile(new URL('./voice-browser.mjs', import.meta.url), 'utf8'),
  ]);
  let allocated, allocating, attaching, closing, finished = false, timer, origin, host, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const server = createServer();
  function refreshTimer() { clearTimeout(timer); timer = setTimeout(() => { void close(allocated || allocating ? 'browser-disconnected' : 'startup-timeout'); }, allocated || allocating ? idleTimeoutMs : startupTimeoutMs); timer.unref?.(); }
  function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); }
  async function close(reason = 'closed') {
    if (closing) return closing;
    finished = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      await allocating?.catch(() => {}); await attaching?.catch(() => {});
      let stopError;
      if (allocated) { try { await stopVoiceCall(client, { dotId, callId: allocated.callId, expectedAccountId }); } catch (error) { stopError = safeError(error); } }
      // Browsers can leave unused preconnect sockets open. They have no HTTP
      // request for closeIdleConnections to find, but still prevent close from
      // settling after the remote call has already been disposed of.
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); server.closeAllConnections?.(); });
      const result = { dotId, callId: allocated?.callId ?? null, reason, ...(stopError ? { stopError } : {}) };
      resolveDone(result); return result;
    })();
    return closing;
  }
  const onAbort = () => { void close('aborted'); };
  server.on('request', async (request, response) => {
    // Pin Host to the actual bound address, preventing DNS-rebinding and proxy-origin access.
    const documentNavigation = request.method === 'GET' && request.url === '/'
      && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation) { json(response, 403, { error: { code: 'LOOPBACK_ORIGIN_REJECTED', message: 'This voice session accepts its own loopback origin only.' } }); return; }
    const path = request.url;
    if (request.method === 'GET' && (path === '/' || path === '/voice-browser.mjs')) {
      response.writeHead(200, { 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': `microphone=${listenOnly ? '()' : '(self)'}, camera=(), geolocation=()`,
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      }); response.end(path === '/' ? html.replaceAll('__STYLE_NONCE__', nonce)
        .replaceAll('__LISTEN_ONLY__', String(listenOnly))
        .replaceAll('__VOICE_TITLE__', listenOnly ? 'Listen to your Dot.' : 'Talk to your Dot.')
        .replaceAll('__VOICE_DESCRIPTION__', listenOnly ? 'Listen-only connects without requesting microphone access or sending audio. This local page keeps your account login in the CLI.' : 'Your microphone connects directly to the voice service using WebRTC. This local page keeps your account login in the CLI.')
        .replaceAll('__VOICE_READY__', listenOnly ? 'Ready. Start a listen-only connection; your microphone stays disabled.' : 'Ready. Start when you want to share your microphone.')
        .replaceAll('__VOICE_CLOSE__', listenOnly ? 'Closing this page ends your listen-only connection. The CLI closes the remote call when the page disconnects.' : 'Closing this page stops your microphone immediately. The CLI closes the remote call when the page disconnects.') : browserScript); return;
    }
    if (!path?.startsWith('/api/')) { json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }); return; }
    if (request.method !== 'POST') { json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }); return; }
    if (request.headers.origin !== origin || !secureEqual(request.headers.authorization, `Bearer ${token}`)) {
      json(response, 403, { error: { code: 'LOOPBACK_AUTH_REJECTED', message: 'This voice session requires its local browser capability.' } }); return;
    }
    if (finished) { json(response, 410, { error: { code: 'VOICE_CLOSED', message: 'This voice session has closed.' } }); return; }
    try {
      const body = await readJson(request);
      if (finished) { json(response, 410, { error: { code: 'VOICE_CLOSED', message: 'This voice session has closed.' } }); return; }
      if (path === '/api/allocate') {
        ownKeys(body, ['sdp']); sdp(body.sdp);
        if (allocated || allocating) throw new DotError('VOICE_ALREADY_ALLOCATED', 'This voice session has already attempted allocation.');
        allocating = allocateVoiceCall(client, { dotId, rootThreadId, sdp: body.sdp, instantConnect, expectedAccountId });
        allocating.catch(() => {}); refreshTimer();
        allocated = await allocating;
        json(response, 200, allocated); return;
      }
      if (path === '/api/attach') {
        ownKeys(body, ['callId']);
        if (!allocated || body.callId !== allocated.callId) throw new DotError('VOICE_IDENTITY_MISMATCH', 'Only this session’s allocated call may be attached.');
        attaching ??= attachVoiceCall(client, { dotId, callId: allocated.callId, expectedAccountId });
        await attaching; refreshTimer(); json(response, 200, { status: 'attached' }); return;
      }
      if (path === '/api/heartbeat') { ownKeys(body, []); refreshTimer(); json(response, 200, { status: allocated ? 'allocated' : 'ready' }); return; }
      if (path === '/api/stop') { ownKeys(body, []); json(response, 200, { status: 'stopping' }); setImmediate(() => { void close('user-ended'); }); return; }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    } catch (error) { json(response, error?.code === 'INVALID_ARGUMENT' ? 400 : 502, { error: safeError(error) }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  signal?.addEventListener('abort', onAbort, { once: true }); refreshTimer();
  if (signal?.aborted) void close('aborted');
  return { url: `${origin}/#${token}`, origin, address, done, close };
}

function openDefaultBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = spawn('open', [url], { stdio: 'ignore' });
    child.once('error', () => reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the browser. Use the printed local URL.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the browser. Use the printed local URL.')));
  });
}
export async function runVoiceChat(client, { output = process.stdout, openBrowser = openDefaultBrowser, ...options } = {}) {
  const session = await createVoiceSessionServer(client, options);
  try {
    output.write(`Voice chat: ${session.url}\n${options.listenOnly ? 'Click Start listening in the browser. Microphone access is disabled.' : 'Click Start voice in the browser and allow microphone access.'} End the call there, or press Ctrl-C here.\n`);
    if (openBrowser) await openBrowser(session.url);
    return await session.done;
  } catch (error) { await session.close('browser-open-failed'); throw error; }
}
