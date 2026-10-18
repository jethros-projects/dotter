import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { DotBrowserExtras, renderBrowserQr } from '../src/browser-extras.mjs';
import { Transport, apiUrl } from '../src/transport.mjs';
import { commands } from '../src/command-sets/browser-extras.mjs';
import { run } from '../src/cli.mjs';

function fixture() {
  const calls = []; let subject = 'user-1', accountId = 'account-1', response = { approval_mode: 'always_ask', disable_auto_review: true };
  const transport = { authLoader: async () => ({ accountId, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.sig` }), assertIdentity: Transport.prototype.assertIdentity,
    request: async (method, route, options) => { calls.push([method, route, options]); return typeof response === 'function' ? response(method, route, options) : response; } };
  const client = { transport };
  return { client, extras: new DotBrowserExtras(client), calls, setResponse(value) { response = value; }, setSubject(value) { subject = value; }, setAccount(value) { accountId = value; } };
}
const qr = { conversationId: 'conversation-1', challengeId: 'challenge-1' };
function qrResponse(payload, timestamp_ms, disappeared) { return { status: 200, body: { payload, timestamp_ms, ...(disappeared == null ? {} : { disappeared }) } }; }
async function post(session, path, body = {}, headers = {}) {
  return fetch(`${session.origin}/api/${path}`, { method: 'POST', headers: { Origin: session.origin, Authorization: `Bearer ${new URL(session.url).hash.slice(1)}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('browser config returns only known policy fields', async () => {
  const f = fixture(); f.setResponse({ approval_mode: 'always_ask', disable_auto_review: false, webauthn_enabled: true, secret: 'hidden' });
  assert.deepEqual(await f.extras.config(), { approvalMode: 'always_ask', disableAutoReview: false, policy: 'auto_approve', webauthnEnabled: true });
  assert.deepEqual(f.calls[0].slice(0, 2), ['GET', '/backend-api/flora/browser/config']); assert.equal(f.calls[0][2].expectedAccountId, 'account-1');
});
test('all native policy choices use their verified PATCH body', async () => {
  for (const [policy, approval_mode, disable_auto_review] of [['always_ask', 'always_ask', true], ['auto_approve', 'always_ask', false], ['always_allow', 'never_ask', true]]) {
    const f = fixture(); f.setResponse({ approval_mode, disable_auto_review });
    const value = await f.extras.updateConfig({ policy, expectedAccountId: 'account-1', confirm: 'account-1' });
    assert.equal(value.policy, policy); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'PATCH'); assert.deepEqual(f.calls[0][2].body, { approval_mode, disable_auto_review });
  }
});
test('raw policy fields preserve false and reject invalid or ambiguous input before network', async () => {
  const f = fixture(); f.setResponse({ approval_mode: 'always_ask', disable_auto_review: false });
  await f.extras.updateConfig({ approvalMode: 'always_ask', disableAutoReview: false, expectedAccountId: 'account-1', confirm: 'account-1' });
  assert.equal(f.calls[0][2].body.disable_auto_review, false);
  for (const change of [{ policy: 'invalid' }, { policy: 'always_ask', approvalMode: 'always_ask' }, { approvalMode: 'bad', disableAutoReview: true }, { approvalMode: 'always_ask' }]) {
    const g = fixture(); await assert.rejects(g.extras.updateConfig({ ...change, expectedAccountId: 'account-1', confirm: 'account-1' }), { code: 'INVALID_ARGUMENT' }); assert.equal(g.calls.length, 0);
  }
});
test('policy changes require exact account confirmation and acknowledge uncertain responses', async () => {
  const f = fixture(); await assert.rejects(f.extras.updateConfig({ policy: 'auto_approve', expectedAccountId: 'account-1', confirm: 'other' }), { code: 'CONFIRMATION_REQUIRED' }); assert.equal(f.calls.length, 0);
  f.setResponse({ unexpected: true }); await assert.rejects(f.extras.updateConfig({ policy: 'auto_approve', expectedAccountId: 'account-1', confirm: 'account-1' }), e => e.code === 'INVALID_RESPONSE' && e.details.delivery === 'unknown'); assert.equal(f.calls.length, 1);
});
test('QR metadata tracks no-content, repeated, stale, rotated and disappeared responses', async () => {
  const f = fixture(); f.setResponse({ status: 204, body: { completed: true } });
  assert.deepEqual(await f.extras.qrStatus(qr), { available: false, timestampMs: null, hasRotated: false, disappeared: false });
  f.setResponse(qrResponse('PRIVATE-PAYLOAD-A', 100)); assert.deepEqual(await f.extras.qrStatus(qr), { available: true, timestampMs: 100, hasRotated: false, disappeared: false });
  for (const result of [{ status: 204, body: {} }, qrResponse('WRONG-STALE', 99), qrResponse('WRONG-SAME-TIMESTAMP', 100)]) { f.setResponse(result); assert.equal((await f.extras.qrStatus(qr)).timestampMs, 100); }
  f.setResponse(qrResponse('PRIVATE-PAYLOAD-B', 101)); assert.equal((await f.extras.qrStatus(qr)).hasRotated, true);
  f.setResponse(qrResponse('PRIVATE-PAYLOAD-B', 102, true)); assert.deepEqual(await f.extras.qrStatus(qr), { available: false, timestampMs: 101, hasRotated: true, disappeared: true });
  assert.equal(f.calls[0][2].headers['Cache-Control'], 'no-store'); assert.deepEqual(f.calls[0][2].query, { conversation_id: qr.conversationId, challenge_id: qr.challengeId });
});
test('QR state is isolated by challenge and account identity', async () => {
  const f = fixture(); f.setResponse(qrResponse('PRIVATE', 100)); await f.extras.qrStatus(qr); f.setResponse({ status: 204 });
  assert.equal((await f.extras.qrStatus({ ...qr, challengeId: 'other' })).available, false);
  f.setSubject('user-2'); await assert.rejects(f.extras.qrStatus(qr), { code: 'AUTH_IDENTITY_CHANGED' });
});
test('QR responses reject malformed payloads without disclosing them', async () => {
  for (const body of [{ payload: 'secret', timestamp_ms: -1 }, { payload: 'secret', timestamp_ms: 1.2 }, { payload: '', timestamp_ms: 1 }, { payload: 'x'.repeat(2400), timestamp_ms: 1 }, { payload: 'secret', timestamp_ms: 1, disappeared: 'yes' }]) {
    const f = fixture(); f.setResponse({ status: 200, body }); await assert.rejects(f.extras.qrStatus(qr), e => e.code === 'INVALID_RESPONSE' && !e.message.includes('secret'));
  }
  const f = fixture(); await assert.rejects(f.extras.qrStatus({ ...qr, challengeId: '../bad' }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
});
test('QR renderer produces bounded vector geometry without embedding private text', () => {
  for (const value of ['https://example.test/private?token=PRIVATE-ABC', '日本語🔐']) {
    const svg = renderBrowserQr(value); assert.match(svg, /^<svg /); assert.match(svg, /viewBox="0 0 \d+ \d+"/); assert.doesNotMatch(svg, /PRIVATE-ABC|日本語|script|href/); assert.ok(svg.length < 200000);
  }
  for (const value of ['', 'x'.repeat(2301), 'bad\0']) assert.throws(() => renderBrowserQr(value), { code: 'INVALID_RESPONSE' });
});
test('legacy viewer status never exposes authenticated URL or tokens', async () => {
  for (const url of ['http://127.0.0.1:54321/vnc?token=PRIVATE', 'https://browser.chatgpt.com/vnc?token=PRIVATE', null]) {
    const f = fixture(); f.setResponse({ novnc_url: url }); const result = await f.extras.handoffStatus({ conversationId: 'c' });
    assert.deepEqual(result, { available: url !== null, local: url === null ? null : url.startsWith('http:') }); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|vnc/);
  }
});
test('legacy viewer rejects unsupported or credential-bearing origins', async () => {
  for (const url of ['javascript:alert(1)', 'https://evil.test/vnc', 'http://chatgpt.com/vnc', 'https://user:secret@chatgpt.com/vnc', 'http://192.168.1.2/vnc', 'https://chatgpt.com.evil.test/vnc']) {
    const f = fixture(); f.setResponse({ novnc_url: url }); await assert.rejects(f.extras.handoffStatus({ conversationId: 'c' }), e => ['UNSUPPORTED_VIEWER_ORIGIN', 'INVALID_RESPONSE'].includes(e.code) && !e.message.includes('secret'));
  }
});
test('local QR viewer has no credentials or payload before a human starts it', async t => {
  const f = fixture(), viewer = await f.extras.viewerServer(qr); t.after(() => viewer.close());
  const response = await fetch(viewer.origin), html = await response.text(); assert.equal(response.status, 200); assert.doesNotMatch(html, /header\.|PRIVATE/); assert.ok(!html.includes(new URL(viewer.url).hash.slice(1))); assert.equal(f.calls.length, 0);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(viewer.address.address, '127.0.0.1');
  f.setResponse(qrResponse('PRIVATE-QR', 10)); const value = await (await post(viewer, 'poll')).json(); assert.equal(value.available, true); assert.match(value.image, /^data:image\/svg\+xml;base64,/); assert.doesNotMatch(JSON.stringify(value), /PRIVATE-QR/);
  assert.equal((await post(viewer, 'stop')).status, 200); assert.equal((await viewer.done).reason, 'user-ended');
});
test('local viewer rejects missing capability, cross-origin, changed target and malicious host', async t => {
  const f = fixture(), viewer = await f.extras.viewerServer(qr); t.after(() => viewer.close());
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { Authorization: 'Bearer wrong' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(viewer, 'poll', {}, headers)).status, 403);
  assert.equal((await post(viewer, 'poll', { conversationId: 'other' })).status, 400);
  assert.equal((await fetch(`${viewer.origin}/api/poll`)).status, 405);
  const badHost = await new Promise((resolve, reject) => { const req = request(viewer.origin, { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(badHost, 403); assert.equal(f.calls.length, 0);
});
const nativeQr = { conversationId: 'thread-1', challengeId: 'Q'.repeat(43), roomId: 'room-1', messageId: 'message-1' };
function nativeQrFixture() {
  const f = fixture();
  const state = { fingerprint: 'fingerprint-1', hidden: false, runtimeStatus: 'pending', payload: 'INITIAL-PRIVATE-CODE', url: undefined, duplicate: false, qrResponse: { status: 204 }, onRequest: null };
  f.client.resolveRoom = async value => value ?? nativeQr.roomId;
  f.setResponse((method, route, options) => {
    state.onRequest?.(method, route, options);
    const request = { request_id: 'request-1', thread_id: nativeQr.conversationId, status: 'pending', params: { threadId: nativeQr.conversationId, mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'browser_auth', browser_auth_challenge_id: nativeQr.challengeId, origin: 'https://example.test', reason: 'Sign in', fields: [], qrCode: true, qrCodePayload: state.payload, qrCodeUrl: state.url } } };
    if (route.endsWith('/messages')) { const item = { id: nativeQr.messageId, hidden: state.hidden, content: { elicitation: request } }; return { items: state.duplicate ? [item, { ...item, id: 'other-message' }] : [item] }; }
    if (route.endsWith('/elicitation')) return { elicitation: request, can_respond: state.runtimeStatus === 'pending', runtime_status: state.runtimeStatus, request_fingerprint: state.fingerprint };
    if (route.endsWith('/qr-code')) return state.qrResponse;
    throw new Error('Unexpected request');
  });
  return { ...f, state };
}
test('verified current card seeds the initial QR and survives a no-content poll', async t => {
  const f = nativeQrFixture(), viewer = await f.extras.viewerServer(nativeQr); t.after(() => viewer.close());
  const first = await (await post(viewer, 'poll')).json(); assert.equal(first.available, true); assert.equal(first.timestampMs, null); assert.doesNotMatch(JSON.stringify(first), /INITIAL-PRIVATE/);
  f.state.qrResponse = qrResponse('NEW-PRIVATE-CODE', 1); assert.equal((await (await post(viewer, 'poll')).json()).hasRotated, true);
});
test('QR viewer automatically discovers an exact current card in the default room', async t => {
  const f = nativeQrFixture(), viewer = await f.extras.viewerServer({ conversationId: nativeQr.conversationId, challengeId: nativeQr.challengeId }); t.after(() => viewer.close());
  assert.equal((await (await post(viewer, 'poll')).json()).available, true);
  assert.ok(f.calls.some(call => call[1] === '/backend-api/messaging/rooms/room-1/messages'));
});
test('automatic QR discovery rejects multiple matching visible cards', async () => {
  const f = nativeQrFixture(); f.state.duplicate = true;
  await assert.rejects(f.extras.viewerServer({ conversationId: nativeQr.conversationId, challengeId: nativeQr.challengeId }), { code: 'QR_CONTEXT_AMBIGUOUS' });
  assert.ok(!f.calls.some(call => call[1].endsWith('/qr-code')));
});
test('verified card QR URL fallback accepts HTTPS without embedded credentials only', async () => {
  for (const [url, available] of [['https://example.test/sign-in?token=PRIVATE', true], ['http://example.test/sign-in', false], ['https://user:pass@example.test/sign-in', false]]) {
    const f = nativeQrFixture(); f.state.payload = null; f.state.url = url;
    const result = await f.extras.qrStatus(nativeQr); assert.equal(result.available, available); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|user:pass/);
  }
});
test('arbitrary caller-provided QR payloads are rejected before any API request', async () => {
  const f = fixture(); await assert.rejects(f.extras.viewerServer({ ...qr, initialPayload: 'ARBITRARY' }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
});
test('QR card binding rejects wrong conversations, fingerprints, hidden or resolved messages', async () => {
  for (const change of [{ options: { conversationId: 'other' } }, { options: { requestFingerprint: 'stale' } }, { hidden: true }, { runtimeStatus: 'expired' }]) {
    const f = nativeQrFixture(); Object.assign(f.state, change); await assert.rejects(f.extras.viewerServer({ ...nativeQr, ...(change.options ?? {}) })); assert.ok(!f.calls.some(call => call[1].endsWith('/qr-code')));
  }
});
test('QR card fingerprint changes between resolver and seed read fail closed', async () => {
  const f = nativeQrFixture(); let inspections = 0;
  f.state.onRequest = (_method, route) => { if (route.endsWith('/elicitation') && ++inspections === 2) f.state.fingerprint = 'changed'; };
  await assert.rejects(f.extras.viewerServer(nativeQr), { code: 'STALE_QR_CHALLENGE' });
});
test('a pending QR viewer stops showing its seed when the current request changes', async t => {
  const f = nativeQrFixture(), viewer = await f.extras.viewerServer(nativeQr); t.after(() => viewer.close());
  f.state.fingerprint = 'changed'; const response = await post(viewer, 'poll'); assert.equal(response.status, 502); const result = await response.json(); assert.equal(result.error.code, 'STALE_ACTION'); assert.doesNotMatch(JSON.stringify(result), /INITIAL-PRIVATE/);
});
test('repeated QR status reads preserve a newer rotated payload rather than reseeding the original', async () => {
  const f = nativeQrFixture(); f.state.qrResponse = qrResponse('NEW-PRIVATE', 100); assert.equal((await f.extras.qrStatus(nativeQr)).hasRotated, true);
  f.state.qrResponse = { status: 204 }; assert.equal((await f.extras.qrStatus(nativeQr)).timestampMs, 100);
});
test('local legacy viewer resolves a URL once and only within the authenticated session', async () => {
  const f = fixture(); f.setResponse({ novnc_url: 'http://127.0.0.1:9999/vnc?token=PRIVATE' }); const viewer = await f.extras.viewerServer({ mode: 'legacy', conversationId: 'c' });
  try {
    const result = await (await post(viewer, 'connect')).json(); assert.equal(result.available, true); assert.match(result.viewer, /^\/legacy-frame\/[A-Za-z0-9_-]+$/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    const page = await fetch(viewer.origin); assert.match(page.headers.get('permissions-policy'), /clipboard-read=\(self "http:\/\/127\.0\.0\.1:9999"\)/); assert.match(await page.text(), /allow="clipboard-read; clipboard-write"/);
    const embedded = await fetch(`${viewer.origin}${result.viewer}`); assert.equal(embedded.status, 200); assert.match(embedded.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:9999;/); assert.doesNotMatch(embedded.headers.get('content-security-policy'), /\*/); assert.match(embedded.headers.get('permissions-policy'), /clipboard-write=\(self "http:\/\/127\.0\.0\.1:9999"\)/); assert.match(await embedded.text(), /allow="clipboard-read; clipboard-write"/);
    assert.equal((await post(viewer, 'connect')).status, 502); assert.equal(f.calls.length, 1);
  } finally { await viewer.close(); }
});
test('QR and unavailable legacy viewers do not delegate clipboard permissions', async t => {
  for (const mode of ['qr', 'legacy']) {
    const f = fixture(); f.setResponse({ novnc_url: null }); const viewer = await f.extras.viewerServer({ ...qr, mode }); t.after(() => viewer.close());
    const response = await fetch(viewer.origin); assert.match(response.headers.get('permissions-policy'), /clipboard-read=\(\), clipboard-write=\(\)/);
  }
});
test('viewer heartbeats pin the JWT subject, not only workspace ID', async () => {
  const f = fixture(), viewer = await f.extras.viewerServer(qr); f.setSubject('different-user');
  assert.equal((await post(viewer, 'heartbeat')).status, 502); assert.equal((await viewer.done).reason, 'account-changed');
});
test('viewer concurrent polling cannot clear or replace an in-flight request', async () => {
  const f = fixture(), viewer = await f.extras.viewerServer(qr); let resolve;
  f.setResponse(() => new Promise(done => { resolve = done; }));
  try {
    const first = post(viewer, 'poll'); while (!resolve) await delay(1);
    assert.equal((await post(viewer, 'poll')).status, 502); assert.equal((await post(viewer, 'poll')).status, 502); assert.equal(f.calls.length, 1);
    resolve(qrResponse('PRIVATE', 1)); assert.equal((await first).status, 200);
  } finally { await viewer.close(); }
});
test('viewer timeouts, abort and open failures clean up without querying the API', async () => {
  const f = fixture(), viewer = await f.extras.viewerServer({ ...qr, startupTimeoutMs: 100 }); assert.equal((await viewer.done).reason, 'startup-timeout');
  const abort = new AbortController(), second = await f.extras.viewerServer({ ...qr, signal: abort.signal }); abort.abort(); assert.equal((await second.done).reason, 'aborted');
  await assert.rejects(f.extras.qrOpen({ ...qr, output: { write() {} }, openBrowser: async () => { throw new Error('open failed'); } }), /open failed/); assert.equal(f.calls.length, 0);
});
const cookies = { target: { aeon_id: 'user~dot', thread_id: 'thread-1' }, hosts: [{ hostname: 'example.com', cookie_count: 3, private: 'COOKIE-VALUE' }, { hostname: 'sub.example.com', cookie_count: 1 }] };
test('Dot cookie listing exposes host counts and a fingerprint without cookie values', async () => {
  const f = fixture(); f.setResponse(cookies); const result = await f.extras.cookies();
  assert.deepEqual(result.hosts, [{ hostname: 'example.com', cookieCount: 3 }, { hostname: 'sub.example.com', cookieCount: 1 }]); assert.match(result.targetFingerprint, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(result), /COOKIE-VALUE|thread-1/); assert.deepEqual(f.calls[0][2].query, { surface: 'Orbit' });
});
test('Dot cookie deletion uses only the freshly returned target and exact confirmation', async () => {
  const f = fixture(); let deleted = false; f.setResponse((method) => { if (method === 'DELETE') { deleted = true; return { completed: true }; } return deleted ? { ...cookies, hosts: [] } : cookies; }); const { targetFingerprint } = await f.extras.cookies();
  const result = await f.extras.deleteCookies({ expectedAccountId: 'account-1', targetFingerprint, hostname: 'example.com', includeSubdomains: true, confirm: 'example.com' });
  assert.equal(result.accepted, true); assert.equal(result.verified, true); const deletion = f.calls.find(call => call[0] === 'DELETE'); assert.deepEqual(deletion.slice(0, 2), ['DELETE', '/backend-api/flora/browser/cookies/example.com']);
  assert.deepEqual(deletion[2].query, { surface: 'Orbit', aeon_id: 'user~dot', thread_id: 'thread-1', include_subdomains: true });
});
test('clear cookies has its own scoped contract and cannot use a stale target', async () => {
  const f = fixture(); f.setResponse(cookies); const { targetFingerprint } = await f.extras.cookies();
  f.setResponse({ ...cookies, target: { ...cookies.target, thread_id: 'thread-2' } });
  await assert.rejects(f.extras.clearCookies({ expectedAccountId: 'account-1', targetFingerprint, confirm: 'account-1' }), { code: 'STALE_TARGET' }); assert.ok(f.calls.every(c => c[0] === 'GET'));
  f.setResponse((method) => method === 'GET' ? cookies : { completed: true });
  const result = await f.extras.clearCookies({ expectedAccountId: 'account-1', targetFingerprint, confirm: 'account-1' }); assert.equal(result.verified, false); const deletion = f.calls.find(call => call[0] === 'DELETE'); assert.equal(deletion[1], '/backend-api/agent/browser_context'); assert.deepEqual(deletion[2].query, { surface: 'Orbit', aeon_id: 'user~dot', thread_id: 'thread-1' });
});
test('cookie writes reject missing confirmations, fingerprints and arbitrary hosts', async () => {
  for (const change of [{ confirm: 'other' }, { targetFingerprint: 'bad' }, { hostname: '../bad' }, { includeSubdomains: 'yes' }]) {
    const f = fixture(); await assert.rejects(f.extras.deleteCookies({ expectedAccountId: 'account-1', targetFingerprint: 'a'.repeat(64), hostname: 'example.com', confirm: 'example.com', ...change })); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.setResponse(cookies); const { targetFingerprint } = await f.extras.cookies(); await assert.rejects(f.extras.deleteCookies({ expectedAccountId: 'account-1', targetFingerprint, hostname: 'other.test', confirm: 'other.test' }), { code: 'INVALID_ARGUMENT' }); assert.ok(f.calls.every(c => c[0] === 'GET'));
});
test('ordinary ChatGPT cookie store omits Orbit selectors and still requires fingerprint', async () => {
  const f = fixture(); f.setResponse((method) => method === 'GET' ? { hosts: cookies.hosts } : { completed: true }); const { targetFingerprint } = await f.extras.cookies({ surface: 'ChatGPT' });
  await f.extras.clearCookies({ surface: 'ChatGPT', expectedAccountId: 'account-1', targetFingerprint, confirm: 'account-1' }); assert.deepEqual(f.calls.at(-1)[2].query, {});
});
test('cookie review fingerprints cannot be transferred between users sharing a workspace', async () => {
  const f = fixture(); f.setResponse({ hosts: cookies.hosts }); const { targetFingerprint } = await f.extras.cookies({ surface: 'ChatGPT' });
  const g = fixture(); g.setSubject('other-user'); g.setResponse({ hosts: cookies.hosts });
  await assert.rejects(g.extras.clearCookies({ surface: 'ChatGPT', expectedAccountId: 'account-1', targetFingerprint, confirm: 'account-1' }), { code: 'STALE_TARGET' }); assert.ok(g.calls.every(call => call[0] === 'GET'));
});
test('a cookie deletion with a failed result does not falsely claim completion', async () => {
  const f = fixture(); f.setResponse((method) => method === 'GET' ? cookies : { completed: false, status: 'failed' }); const { targetFingerprint } = await f.extras.cookies();
  await assert.rejects(f.extras.clearCookies({ expectedAccountId: 'account-1', targetFingerprint, confirm: 'account-1' }), e => e.code === 'INVALID_RESPONSE' && e.details.delivery === 'unknown'); assert.equal(f.calls.filter(call => call[0] === 'DELETE').length, 1);
});
test('browser extras command descriptors map to concrete methods and confirmation pairs', () => {
  const f = fixture(); for (const definition of Object.values(commands)) { assert.equal(typeof f.extras[definition.method], 'function'); for (const pair of definition.confirmMatch ?? []) assert.equal(pair.length, 2); }
  assert.equal(Object.keys(commands).length, 14);
});

const originConfig = origins => ({ approval_mode: 'always_ask', disable_auto_review: false, webauthn_enabled: true, origins });
function passkeyFixture() {
  const f = fixture(); let config = originConfig([]), response = { passkeys: [] };
  f.setResponse((method, route, options) => {
    if (route === '/backend-api/flora/browser/config') return typeof config === 'function' ? config(method, route, options) : config;
    if (route === '/backend-api/flora/browser/passkeys' || route.startsWith('/backend-api/flora/browser/passkeys/')) return typeof response === 'function' ? response(method, route, options) : response;
    throw new Error('Unexpected passkey fixture route');
  });
  return { ...f, setResponse(value) { response = value; }, setConfig(value) { config = value; } };
}

test('browser config retains only the native origin permission projection', async () => {
  const f = fixture(); f.setResponse(originConfig([{ pattern: 'https://example.com', decision: 'deny', secret: 'hidden' }]));
  assert.deepEqual((await f.extras.config()).origins, [{ pattern: 'https://example.com', decision: 'deny' }]);
  assert.deepEqual(await f.extras.origins(), { origins: [{ pattern: 'https://example.com', decision: 'deny' }] });
});
test('origin lists reject missing, malformed, unsafe and ambiguous native patterns', async () => {
  for (const origins of [undefined, null, {}, [{ pattern: 'https://example.com/path', decision: 'allow' }], [{ pattern: 'https://example.com', decision: 'unset' }], [{ pattern: 'https://user:pass@example.com', decision: 'allow' }], [{ pattern: 'https://example.com', decision: 'allow' }, { pattern: 'https://EXAMPLE.COM:443', decision: 'deny' }]]) {
    const f = fixture(); f.setResponse(originConfig(origins)); await assert.rejects(f.extras.origins(), { code: 'INVALID_RESPONSE' });
  }
});
test('origin changes use native canonical patterns and the narrow mutation body', async () => {
  for (const [input, pattern] of [[' example.com/ ', 'https://example.com'], ['HTTPS://EXAMPLE.COM:443', 'https://example.com'], ['http://example.com:80', 'http://example.com'], ['https://*.example.com', 'https://*.example.com'], ['https://**.example.com', 'https://**.example.com'], ['https://api?.example.com:8443', 'https://api?.example.com:8443'], ['https://bücher.example', 'https://xn--bcher-kva.example'], ['https://[2001:0db8::1]:443', 'https://[2001:db8::1]'], ['codex-sandbox://web-sandbox.oaiusercontent.com', 'codex-sandbox://web-sandbox.oaiusercontent.com']]) {
    const f = fixture(); f.setResponse(method => originConfig(method === 'GET' ? [] : [{ pattern, decision: 'deny' }]));
    assert.deepEqual(await f.extras.setOrigin({ pattern: input, decision: 'deny', expectedAccountId: 'account-1', confirm: 'account-1' }), { pattern, decision: 'deny', verified: true });
    assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config'], ['PATCH', '/backend-api/flora/browser/config']]);
    assert.deepEqual(f.calls[1][2].body, { origin_mutation: { pattern, decision: 'deny' } }); assert.equal(f.calls[1][2].expectedAccountId, 'account-1');
  }
});
test('origin input rejects paths, credentials, malformed hosts, ports and unsupported schemes before any request', async () => {
  for (const pattern of ['', 'https://example.com/a', 'https://example.com/?q=x', 'https://example.com#x', 'https://a@b.com', 'https://example..com', 'https://%65xample.com', 'https://exa mple.com', 'https://é*.example.com', 'https://example.com:abc', 'https://example.com:99999', 'https://[bad]', 'https://*.','https://**.', 'file://example.com', 'ftp://example.com', 'codex-sandbox://other.example', 'codex-sandbox://web-sandbox.oaiusercontent.com:12', 'x'.repeat(4097)]) {
    const f = fixture(); await assert.rejects(f.extras.setOrigin({ pattern, decision: 'allow', expectedAccountId: 'account-1', confirm: 'account-1' }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0, pattern);
  }
});
test('origin writes require a valid decision and exact account confirmation before reads', async () => {
  for (const change of [{ decision: 'unset' }, { decision: 'ALLOW' }, { confirm: 'other' }, { expectedAccountId: 'wrong', confirm: 'wrong' }]) {
    const f = fixture(); await assert.rejects(f.extras.setOrigin({ pattern: 'https://example.com', decision: 'allow', expectedAccountId: 'account-1', confirm: 'account-1', ...change })); assert.equal(f.calls.length, 0);
  }
});
test('origin removal selects only a freshly listed rule and sends native unset', async () => {
  const f = fixture(); f.setResponse(method => originConfig(method === 'GET' ? [{ pattern: 'https://example.com', decision: 'allow' }, { pattern: 'https://keep.example', decision: 'deny' }] : [{ pattern: 'https://keep.example', decision: 'deny' }]));
  assert.deepEqual(await f.extras.removeOrigin({ pattern: 'EXAMPLE.com', expectedAccountId: 'account-1', confirm: 'account-1' }), { pattern: 'https://example.com', decision: 'unset', verified: true });
  assert.deepEqual(f.calls[1][2].body, { origin_mutation: { pattern: 'https://example.com', decision: 'unset' } });
  const missing = fixture(); missing.setResponse(originConfig([])); await assert.rejects(missing.extras.removeOrigin({ pattern: 'example.com', expectedAccountId: 'account-1', confirm: 'account-1' }), { code: 'ORIGIN_NOT_FOUND' }); assert.equal(missing.calls.length, 1);
});
test('origin mutations never call a failed or mismatched acknowledgement verified', async () => {
  for (const ack of [undefined, {}, originConfig([]), originConfig([{ pattern: 'https://example.com', decision: 'deny' }]), originConfig([{ pattern: 'https://other.example', decision: 'allow' }])]) {
    const f = fixture(); f.setResponse(method => method === 'GET' ? originConfig([]) : ack);
    await assert.rejects(f.extras.setOrigin({ pattern: 'example.com', decision: 'allow', expectedAccountId: 'account-1', confirm: 'account-1' }), e => e.code === 'INVALID_RESPONSE' && e.details.delivery === 'unknown'); assert.equal(f.calls.filter(call => call[0] === 'PATCH').length, 1);
  }
  const f = fixture(); f.setResponse(originConfig([{ pattern: 'https://example.com', decision: 'allow' }]));
  await assert.rejects(f.extras.removeOrigin({ pattern: 'example.com', expectedAccountId: 'account-1', confirm: 'account-1' }), e => e.code === 'INVALID_RESPONSE' && e.details.delivery === 'unknown');
});
test('origin and passkey writes cannot switch signed-in users during preflight', async () => {
  for (const feature of ['origin', 'passkey']) {
    const f = fixture(); f.setResponse((_method, route) => { f.setSubject('changed'); return route === '/backend-api/flora/browser/config' ? originConfig([]) : { passkeys: [{ credential_id: 'key-1' }] }; });
    const transportRequest = f.client.transport.request;
    f.client.transport.request = async (...args) => { f.client.transport.assertIdentity(await f.client.transport.authLoader()); return transportRequest(...args); };
    const result = feature === 'origin' ? f.extras.setOrigin({ pattern: 'example.com', decision: 'allow', expectedAccountId: 'account-1', confirm: 'account-1' }) : f.extras.deletePasskey({ credentialId: 'key-1', expectedAccountId: 'account-1', confirm: 'key-1' });
    await assert.rejects(result, { code: 'AUTH_IDENTITY_CHANGED' }); assert.equal(f.calls.length, 1);
  }
});
test('saved passkey listing projects only the four native display fields', async () => {
  const f = passkeyFixture(); f.setResponse({ passkeys: [{ credential_id: 'key-1', relying_party_id: 'example.com', user_name: 'user@example.com', user_display_name: 'Example user', private_key: 'SECRET', raw: 'SECRET' }] });
  assert.deepEqual(await f.extras.passkeys(), { passkeys: [{ credentialId: 'key-1', relyingPartyId: 'example.com', userDisplayName: 'Example user', userName: 'user@example.com' }] });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config'], ['GET', '/backend-api/flora/browser/passkeys']]); assert.ok(f.calls.every(call => call[2].expectedAccountId === 'account-1'));
});
test('saved passkey lists reject malformed metadata and duplicate IDs without exposing raw data', async () => {
  for (const passkeys of [null, {}, [{ credential_id: '../bad' }], [{ credential_id: 'key', user_name: { secret: 'SECRET' } }], [{ credential_id: 'key', user_name: 'bad\nvalue' }], [{ credential_id: 'key' }, { credential_id: 'key' }]]) {
    const f = passkeyFixture(); f.setResponse({ passkeys }); await assert.rejects(f.extras.passkeys(), e => e.code === 'INVALID_RESPONSE' && !e.message.includes('SECRET'));
  }
});
test('saved passkey deletion uses fresh exact membership, encoded ID and absence verification', async () => {
  const f = passkeyFixture(); const key = 'ab+cd=='; let deleted = false;
  f.setResponse(method => { if (method === 'DELETE') { deleted = true; return { completed: true }; } return { passkeys: deleted ? [{ credential_id: 'keep' }] : [{ credential_id: key }, { credential_id: 'keep' }] }; });
  assert.deepEqual(await f.extras.deletePasskey({ credentialId: key, expectedAccountId: 'account-1', confirm: key }), { credentialId: key, accepted: true, verified: true });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config'], ['GET', '/backend-api/flora/browser/passkeys'], ['DELETE', '/backend-api/flora/browser/passkeys/ab%2Bcd%3D%3D'], ['GET', '/backend-api/flora/browser/config'], ['GET', '/backend-api/flora/browser/passkeys']]); assert.equal(f.calls[2][2].body, undefined); assert.equal(apiUrl(f.calls[2][1]).pathname, '/backend-api/flora/browser/passkeys/ab%2Bcd%3D%3D');
});
test('saved passkey deletion rejects missing confirmation, invalid ID and vanished membership', async () => {
  for (const change of [{ confirm: 'other' }, { credentialId: '../bad', confirm: '../bad' }, { expectedAccountId: 'wrong' }]) {
    const f = passkeyFixture(); await assert.rejects(f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key', ...change })); assert.equal(f.calls.length, 0);
  }
  const f = passkeyFixture(); f.setResponse({ passkeys: [] }); await assert.rejects(f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key' }), { code: 'PASSKEY_NOT_FOUND' }); assert.equal(f.calls.length, 2);
});
test('saved passkey deletion never claims absence when verification fails or key remains', async () => {
  for (const postFailure of [false, true]) {
    const f = passkeyFixture(); let deleted = false;
    f.setResponse(method => { if (method === 'DELETE') { deleted = true; return { completed: true }; } if (deleted && postFailure) throw new Error('failed read'); return { passkeys: [{ credential_id: 'key' }] }; });
    assert.deepEqual(await f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key' }), { credentialId: 'key', accepted: true, verified: false }); assert.equal(f.calls.filter(call => call[0] === 'DELETE').length, 1);
  }
});
test('saved passkey deletion propagates uncertain failures without replay', async () => {
  const f = passkeyFixture(); f.setResponse(method => { if (method === 'DELETE') throw Object.assign(new Error('unknown'), { code: 'HTTP_ERROR' }); return { passkeys: [{ credential_id: 'key' }] }; });
  await assert.rejects(f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key' }), { code: 'HTTP_ERROR' }); assert.equal(f.calls.filter(call => call[0] === 'DELETE').length, 1);
});

test('browser permission and passkey commands dispatch through the actual CLI', async () => {
  const f = fixture(); let saved = null;
  f.setResponse((method, route, options) => {
    if (route.endsWith('/passkeys')) return { passkeys: [] };
    if (method === 'PATCH') saved = options.body.origin_mutation.decision === 'unset' ? null : options.body.origin_mutation;
    return originConfig(saved ? [saved] : []);
  });
  const deps = { createClient: async () => f.client, stdout: { write() {} }, stderr: { write() {} } };
  assert.deepEqual(await run(['remote', 'origins', 'list', '--json'], deps), { origins: [] });
  assert.deepEqual(await run(['remote', 'origins', 'set', 'example.com', '--decision', 'deny', '--account', 'account-1', '--confirm', 'account-1', '--json'], deps), { pattern: 'https://example.com', decision: 'deny', verified: true });
  assert.deepEqual(await run(['remote', 'origins', 'remove', 'example.com', '--account', 'account-1', '--confirm', 'account-1', '--json'], deps), { pattern: 'https://example.com', decision: 'unset', verified: true });
  assert.deepEqual(await run(['remote', 'passkeys', 'list', '--json'], deps), { passkeys: [] });
});
test('actual CLI rejects passkey or origin confirmation mismatch before creating a client', async () => {
  const deps = { createClient: async () => { throw new Error('Must not create client'); }, stdout: { write() {} }, stderr: { write() {} } };
  for (const args of [['remote', 'origins', 'set', 'example.com', '--decision', 'deny', '--account', 'account-1', '--confirm', 'wrong'], ['remote', 'origins', 'remove', 'example.com', '--account', 'account-1', '--confirm', 'wrong'], ['remote', 'passkeys', 'delete', 'key', '--account', 'account-1', '--confirm', 'wrong']]) await assert.rejects(run(args, deps), /Confirmation/);
});

test('slash-bearing passkey IDs remain visible but cannot bypass fixed-route guards', async () => {
  const f = passkeyFixture(); f.setResponse({ passkeys: [{ credential_id: 'ab/cd==' }] });
  assert.equal((await f.extras.passkeys()).passkeys[0].credentialId, 'ab/cd=='); const readCount = f.calls.length;
  await assert.rejects(f.extras.deletePasskey({ credentialId: 'ab/cd==', expectedAccountId: 'account-1', confirm: 'ab/cd==' }), { code: 'UNSUPPORTED_CREDENTIAL_ID' }); assert.equal(f.calls.length, readCount);
});


test('passkey listing stops on disabled or missing native WebAuthn availability', async () => {
  for (const flag of [false, undefined]) {
    const f = passkeyFixture(); f.setConfig({ approval_mode: 'always_ask', disable_auto_review: false, ...(flag === undefined ? {} : { webauthn_enabled: flag }) });
    await assert.rejects(f.extras.passkeys(), { code: 'UNSUPPORTED' });
    assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config']]);
  }
});
test('disabled native WebAuthn prevents passkey deletion before list or mutation', async () => {
  const f = passkeyFixture(); f.setConfig({ approval_mode: 'always_ask', disable_auto_review: false, webauthn_enabled: false });
  await assert.rejects(f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key' }), { code: 'UNSUPPORTED' });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config']]);
});
test('passkey preflight uses the existing strict config parser', async () => {
  const f = passkeyFixture(); f.setConfig({ webauthn_enabled: true });
  await assert.rejects(f.extras.passkeys(), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 1);
});
test('failed config lookup never probes the passkey endpoint', async () => {
  const f = passkeyFixture(); f.setConfig(() => { throw Object.assign(new Error('blocked'), { code: 'EDGE_CHALLENGE' }); });
  await assert.rejects(f.extras.passkeys(), { code: 'EDGE_CHALLENGE' }); assert.equal(f.calls.length, 1);
});
test('account identity cannot change between enabled config and passkey lookup', async () => {
  const f = passkeyFixture(); f.setConfig(() => { f.setSubject('changed'); return originConfig([]); });
  await assert.rejects(f.extras.passkeys(), { code: 'AUTH_IDENTITY_CHANGED' }); assert.equal(f.calls.length, 1);
});
test('post-delete disabled availability preserves accepted but unverified outcome', async () => {
  const f = passkeyFixture(); let deleted = false;
  f.setConfig(() => ({ ...originConfig([]), webauthn_enabled: !deleted }));
  f.setResponse(method => { if (method === 'DELETE') { deleted = true; return { completed: true }; } return { passkeys: [{ credential_id: 'key' }] }; });
  assert.deepEqual(await f.extras.deletePasskey({ credentialId: 'key', expectedAccountId: 'account-1', confirm: 'key' }), { credentialId: 'key', accepted: true, verified: false });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['GET', '/backend-api/flora/browser/config'], ['GET', '/backend-api/flora/browser/passkeys'], ['DELETE', '/backend-api/flora/browser/passkeys/key'], ['GET', '/backend-api/flora/browser/config']]);
});
test('actual CLI reports disabled passkeys without a passkey request', async () => {
  const f = passkeyFixture(); f.setConfig({ ...originConfig([]), webauthn_enabled: false });
  await assert.rejects(run(['remote', 'passkeys', 'list', '--json'], { createClient: async () => f.client, stdout: { write() {} }, stderr: { write() {} } }), { code: 'UNSUPPORTED' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], '/backend-api/flora/browser/config');
});
