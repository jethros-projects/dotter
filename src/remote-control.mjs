import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DotError } from './errors.mjs';

// Installed client: panel-77a7049c0701, cloud-browser-side-panel-84ea719cd78e,
// session-ae8b156ca14f and src-30df4959c626 (2026-10-18).
const MAX_SDP = 256 * 1024;
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function sdp(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SDP || !/^v=0\r?\n/.test(value) || /\0/.test(value)) throw new DotError('INVALID_ARGUMENT', 'Supply a valid SDP offer of at most 256 KiB.');
  return value;
}
async function account(client, expectedAccountId) {
  if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !expectedAccountId)) throw new DotError('INVALID_ARGUMENT', 'expectedAccountId must be a nonempty account ID.');
  const auth = typeof client.transport?.authLoader === 'function' ? await client.transport.authLoader({ authFile: client.transport.authFile }) : null;
  if (auth && (!auth.accountId || (expectedAccountId && auth.accountId !== expectedAccountId))) throw new DotError('ACCOUNT_CHANGED', 'The current Codex account differs from the selected remote session account.');
  if (auth) client.transport.assertIdentity?.(auth);
  const selected = auth?.accountId ?? expectedAccountId;
  if (!selected) throw new DotError('ACCOUNT_REQUIRED', 'Remote sessions require an account selector from the Codex login.');
  return selected;
}
async function target(client, options) {
  const source = options.source ?? 'aeon';
  if (!['aeon', 'flora'].includes(source)) throw new DotError('INVALID_ARGUMENT', 'source must be aeon (Dot computer) or flora (cloud browser).');
  if (source === 'flora') {
    if (options.dotId != null || options.aeonId != null || options.threadId != null) throw new DotError('INVALID_ARGUMENT', 'Cloud browser sessions use conversationId only.');
    return { source, conversationId: id(options.conversationId, 'conversationId') };
  }
  if (options.conversationId != null) throw new DotError('INVALID_ARGUMENT', 'Dot computer sessions use dotId and threadId.');
  if (options.dotId != null && options.aeonId != null && options.dotId !== options.aeonId) throw new DotError('INVALID_ARGUMENT', 'dotId and aeonId must refer to the same Dot.');
  let dotId = options.dotId ?? options.aeonId;
  let threadId = options.threadId;
  if (dotId != null) id(dotId, 'dotId');
  if (threadId != null) id(threadId, 'threadId');
  if (!dotId) {
    const primary = await client.primary({ signal: options.signal, expectedAccountId: options.expectedAccountId });
    dotId = primary?.id; threadId ??= primary?.threadId;
  }
  // Resolve the current thread afresh; never silently connect a stale cached
  // thread to another Dot or invent a computer environment.
  const profile = await client.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(id(dotId, 'dotId'))}`, { signal: options.signal, expectedAccountId: options.expectedAccountId });
  if (profile?.id !== dotId) throw new DotError('REMOTE_IDENTITY_MISMATCH', 'The current Dot profile does not match the requested remote computer.');
  const currentThread = profile.active_root_thread_id ?? profile.root_thread_id;
  if (threadId && currentThread !== threadId) throw new DotError('STALE_TARGET', 'The requested root thread is no longer active for this Dot.');
  return { source, aeonId: dotId, threadId: id(currentThread, 'active root thread') };
}
function handoff(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['conversationId', 'tabId'].includes(key))) throw new DotError('INVALID_ARGUMENT', 'handoff requires conversationId and tabId.');
  return { conversationId: id(value.conversationId, 'handoff conversationId'), tabId: id(value.tabId, 'handoff tabId') };
}
export function remoteControlCapabilities() {
  return { remoteControl: ['Dot computer WebRTC', 'cloud browser WebRTC', 'explicit control request/release', 'mouse and keyboard', 'explicit clipboard transfer', 'optional user-enabled clipboard synchronization', 'browser tab handoff', 'native playback outcome/ack'], remoteControlLiveTested: false };
}

/** Opens only the audited SDP endpoint. The caller owns the peer connection. */
export async function negotiateRemoteControl(client, { sdp: offer, ...options } = {}) {
  sdp(offer);
  const expectedAccountId = await account(client, options.expectedAccountId);
  const resolved = await target(client, { ...options, expectedAccountId });
  if (typeof client.transport.requestRealtimeSdp !== 'function') throw new DotError('REMOTE_TRANSPORT_UNAVAILABLE', 'This transport does not support the fixed realtime SDP endpoint.');
  const result = await client.transport.requestRealtimeSdp({ ...resolved, sdp: offer, expectedAccountId, signal: options.signal });
  const answer = typeof result === 'string' ? result : result?.body;
  try { sdp(answer); } catch { throw new DotError('INVALID_RESPONSE', 'The remote computer did not return a valid SDP answer.', { delivery: 'unknown' }); }
  return { target: resolved, answer };
}
function equal(a, b) { const x = Buffer.from(a ?? ''), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function safeError(error) { return error instanceof DotError ? { code: error.code, message: error.message } : { code: 'REMOTE_FAILED', message: 'The remote connection failed.' }; }
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') || Number(request.headers['content-length'] ?? 0) > MAX_SDP + 2048) throw new DotError('INVALID_ARGUMENT', 'Use a bounded application/json request.');
  const chunks = []; let total = 0;
  for await (const chunk of request) { total += chunk.length; if (total > MAX_SDP + 2048) throw new DotError('INVALID_ARGUMENT', 'The local request is too large.'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DotError('INVALID_ARGUMENT', 'Use a JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_ARGUMENT', 'Use a JSON object.');
  return value;
}
function keys(value, allowed) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new DotError('INVALID_ARGUMENT', 'Unexpected remote-session fields.'); }

/** Account credentials stay server-side. Browser gets one ephemeral loopback capability. */
export async function createRemoteControlServer(client, options = {}) {
  const { signal, idleTimeoutMs = 45000, startupTimeoutMs = 300000 } = options;
  for (const value of [idleTimeoutMs, startupTimeoutMs]) if (!Number.isInteger(value) || value < 100 || value > 3600000) throw new DotError('INVALID_ARGUMENT', 'Timeouts must be between 100 ms and one hour.');
  signal?.throwIfAborted();
  const expectedAccountId = await account(client, options.expectedAccountId);
  const resolved = await target(client, { ...options, expectedAccountId });
  const selectedHandoff = handoff(options.handoff);
  if (selectedHandoff && resolved.source !== 'aeon') throw new DotError('INVALID_ARGUMENT', 'Browser tab handoff requires a Dot computer session.');
  const capability = randomBytes(32).toString('base64url'), nonce = randomBytes(18).toString('base64url');
  const [html, script] = await Promise.all([readFile(new URL('./remote-control-ui.html', import.meta.url), 'utf8'), readFile(new URL('./remote-control-browser.mjs', import.meta.url), 'utf8')]);
  let host, origin, timer, attempted = false, pending, closed = false, closing, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const abort = new AbortController();
  const server = createServer();
  function refresh() { clearTimeout(timer); timer = setTimeout(() => { void close(attempted ? 'browser-disconnected' : 'startup-timeout'); }, attempted ? idleTimeoutMs : startupTimeoutMs); timer.unref?.(); }
  function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
  async function close(reason = 'closed') {
    if (closing) return closing;
    closed = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); abort.abort();
    closing = (async () => {
      await pending?.catch(() => {});
      await new Promise(resolve => {
        server.close(resolve); server.closeIdleConnections?.();
        // Browsers may preconnect a TCP socket without issuing an HTTP request;
        // closeIdleConnections does not reliably reap those on shutdown.
        server.closeAllConnections?.();
      });
      const result = { target: resolved, reason }; resolveDone(result); return result;
    })();
    return closing;
  }
  const onAbort = () => { void close('aborted'); };
  server.on('request', async (request, response) => {
    // Browser extensions and external launchers can classify a top-level URL
    // navigation as cross-site. Only that static document may cross origins;
    // scripts, iframes, fetches and API requests retain the strict origin gate.
    const documentNavigation = request.method === 'GET' && request.url === '/'
      && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation) { json(response, 403, { error: { code: 'LOOPBACK_ORIGIN_REJECTED', message: 'Use this session’s exact local browser origin.' } }); return; }
    if (request.method === 'GET' && ['/', '/remote-control-browser.mjs'].includes(request.url)) {
      response.writeHead(200, { 'Content-Type': request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'microphone=(), camera=(), geolocation=(), clipboard-read=(self), clipboard-write=(self)',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      response.end(request.url === '/' ? html.replaceAll('__STYLE_NONCE__', nonce) : script); return;
    }
    if (!request.url?.startsWith('/api/')) { json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }); return; }
    if (request.method !== 'POST') { json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }); return; }
    if (request.headers.origin !== origin || !equal(request.headers.authorization, `Bearer ${capability}`)) { json(response, 403, { error: { code: 'LOOPBACK_AUTH_REJECTED', message: 'Use the fresh remote-session URL printed by the CLI.' } }); return; }
    if (closed) { json(response, 410, { error: { code: 'REMOTE_CLOSED', message: 'The remote session has closed.' } }); return; }
    try {
      const body = await jsonBody(request);
      if (closed) throw new DotError('REMOTE_CLOSED', 'The remote session has closed.');
      if (request.url === '/api/connect') {
        keys(body, ['sdp']); sdp(body.sdp);
        if (attempted) throw new DotError('REMOTE_ALREADY_ATTEMPTED', 'This session has already attempted connection. Create a fresh session to reconnect.');
        attempted = true; refresh();
        // Account and active root are checked again immediately before the POST.
        pending = negotiateRemoteControl(client, { ...resolved, sdp: body.sdp, expectedAccountId, signal: abort.signal });
        const result = await pending; json(response, 200, { ...result, handoff: selectedHandoff }); return;
      }
      if (request.url === '/api/heartbeat') { keys(body, []); await account(client, expectedAccountId); refresh(); json(response, 200, { status: attempted ? 'connected' : 'ready' }); return; }
      if (request.url === '/api/authorize') { keys(body, []); await account(client, expectedAccountId); if (!attempted) throw new DotError('REMOTE_NOT_CONNECTED', 'Connect before requesting control.'); refresh(); json(response, 200, { status: 'authorized' }); return; }
      if (request.url === '/api/stop') { keys(body, []); json(response, 200, { status: 'stopping' }); setImmediate(() => { void close('user-ended'); }); return; }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    } catch (error) { json(response, error?.code === 'INVALID_ARGUMENT' ? 400 : 502, { error: safeError(error) }); if (['ACCOUNT_CHANGED', 'AUTH_IDENTITY_CHANGED'].includes(error?.code)) setImmediate(() => { void close('account-changed'); }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  signal?.addEventListener('abort', onAbort, { once: true }); refresh(); if (signal?.aborted) void close('aborted');
  return { url: `${origin}/#${capability}`, origin, address, target: resolved, done, close };
}
function openDefaultBrowser(url) {
  return new Promise((resolve, reject) => {
    const process = spawn('open', [url], { stdio: 'ignore' });
    process.once('error', () => reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the browser. Use the printed local URL.')));
    process.once('exit', code => code === 0 ? resolve() : reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the browser. Use the printed local URL.')));
  });
}
export async function runRemoteControl(client, { output = process.stdout, openBrowser = openDefaultBrowser, ...options } = {}) {
  const session = await createRemoteControlServer(client, options);
  try {
    output.write(`Remote computer: ${session.url}\nClick Connect to view. Take control enables mouse and keyboard; Return control releases them. Close the page or press Ctrl-C to end.\n`);
    if (openBrowser) await openBrowser(session.url); return await session.done;
  }
  catch (error) { await session.close('browser-open-failed'); throw error; }
}
export class DotRemoteControl {
  constructor(client) { this.client = client; }
  negotiate(options) { return negotiateRemoteControl(this.client, options); }
  server(options) { return createRemoteControlServer(this.client, options); }
  open({ noOpen, handoffConversationId, handoffTabId, ...options } = {}) {
    if (handoffConversationId != null || handoffTabId != null) options.handoff = { conversationId: handoffConversationId, tabId: handoffTabId };
    if (noOpen) options.openBrowser = false;
    return runRemoteControl(this.client, options);
  }
}
