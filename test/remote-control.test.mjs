import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { negotiateRemoteControl, createRemoteControlServer, runRemoteControl, DotRemoteControl } from '../src/remote-control.mjs';
import { createBrowserRemoteSession, encodeRemoteInput, keysymForEvent, remoteCoordinates } from '../src/remote-control-browser.mjs';
import { Transport } from '../src/transport.mjs';

const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
function fixture() {
  const calls = []; let accountId = 'account-1', currentThread = 'thread-1';
  const client = { primary: async () => ({ id: 'user~dot', threadId: currentThread }), transport: {
    authLoader: async () => ({ accessToken: 'DO-NOT-EXPOSE', accountId }),
    request: async (...args) => { calls.push(args); return { id: 'user~dot', active_root_thread_id: currentThread }; },
    requestRealtimeSdp: async options => { calls.push(['SDP', options]); return { body: SDP }; },
  } };
  return { client, calls, setAccount(value) { accountId = value; }, setThread(value) { currentThread = value; } };
}
async function post(session, operation, body = {}, headers = {}) {
  return fetch(`${session.origin}/api/${operation}`, { method: 'POST', headers: { Origin: session.origin, Authorization: `Bearer ${new URL(session.url).hash.slice(1)}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
test('remote SDP pins active Dot and account using the exact transport contract', async () => {
  const f = fixture(); const result = await negotiateRemoteControl(f.client, { sdp: SDP });
  assert.deepEqual(result, { target: { source: 'aeon', aeonId: 'user~dot', threadId: 'thread-1' }, answer: SDP });
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1][1], { source: 'aeon', aeonId: 'user~dot', threadId: 'thread-1', sdp: SDP, expectedAccountId: 'account-1', signal: undefined });
});
test('cloud browser negotiates source flora without a Dot profile', async () => {
  const f = fixture(); await negotiateRemoteControl(f.client, { source: 'flora', conversationId: 'conversation-1', sdp: SDP });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].source, 'flora'); assert.equal(f.calls[0][1].conversationId, 'conversation-1');
});
test('invalid and stale remote targets cannot reach SDP allocation', async () => {
  for (const options of [{ sdp: 'secret' }, { source: 'other', sdp: SDP }, { source: 'flora', sdp: SDP }, { source: 'flora', conversationId: 'c', dotId: 'dot', sdp: SDP }, { dotId: '../bad', sdp: SDP }, { dotId: 'user~dot', aeonId: 'other', sdp: SDP }]) {
    const f = fixture(); await assert.rejects(negotiateRemoteControl(f.client, options), { code: 'INVALID_ARGUMENT' }); assert.ok(!f.calls.some(call => call[0] === 'SDP'));
  }
  const f = fixture(); await assert.rejects(negotiateRemoteControl(f.client, { dotId: 'user~dot', threadId: 'stale', sdp: SDP }), { code: 'STALE_TARGET' }); assert.equal(f.calls.length, 1);
});
test('remote identity mismatch and account change fail closed', async () => {
  const f = fixture(); await assert.rejects(negotiateRemoteControl(f.client, { expectedAccountId: 'other', sdp: SDP }), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.calls.length, 0);
  f.client.transport.request = async () => ({ id: 'wrong', active_root_thread_id: 'thread-1' });
  await assert.rejects(negotiateRemoteControl(f.client, { sdp: SDP }), { code: 'REMOTE_IDENTITY_MISMATCH' });
});
test('remote SDP errors do not retry or expose invalid answers', async () => {
  const f = fixture(); f.client.transport.requestRealtimeSdp = async value => { f.calls.push(['SDP', value]); return { body: 'SECRET' }; };
  await assert.rejects(negotiateRemoteControl(f.client, { sdp: SDP }), error => error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown' && !error.message.includes('SECRET'));
  assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 1);
});
test('remote local page keeps credentials and capability out of HTML', async t => {
  const f = fixture(), session = await createRemoteControlServer(f.client); t.after(() => session.close());
  const response = await fetch(session.origin), html = await response.text(); assert.equal(response.status, 200); assert.match(html, /Take control/);
  assert.doesNotMatch(html, /DO-NOT-EXPOSE/); assert.ok(!html.includes(new URL(session.url).hash.slice(1)));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(response.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.equal(session.address.address, '127.0.0.1'); assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
});
test('remote page accepts external top-level navigation while rejecting cross-site resources and APIs', async t => {
  const f = fixture(), session = await createRemoteControlServer(f.client); t.after(() => session.close());
  const get = (path, headers) => new Promise((resolve, reject) => {
    const req = request(session.origin + path, { headers }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end();
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await get('/', navigation), 200);
  assert.equal(await get('/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await get('/', { ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }), 403);
  assert.equal(await get('/remote-control-browser.mjs', navigation), 403);
  assert.equal(await get('/api/connect', navigation), 403);
  assert.equal((await post(session, 'connect', { sdp: SDP }, navigation)).status, 403);
  assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
});
test('remote broker rejects foreign origins, hosts, missing capability and browser target overrides', async t => {
  const f = fixture(), session = await createRemoteControlServer(f.client); t.after(() => session.close());
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { Authorization: 'Bearer wrong' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await post(session, 'connect', { sdp: SDP }, headers)).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = request(session.origin, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(badHost, 403); assert.equal((await post(session, 'connect', { sdp: SDP, aeonId: 'other' })).status, 400);
  assert.equal((await post(session, 'connect', { sdp: SDP }, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await fetch(`${session.origin}/api/connect`)).status, 405); assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
});
test('remote broker permits only one SDP attempt and fixed handoff', async () => {
  const f = fixture(), session = await createRemoteControlServer(f.client, { handoff: { conversationId: 'browser-1', tabId: 'tab-1' } });
  try {
    const response = await post(session, 'connect', { sdp: SDP }); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).handoff, { conversationId: 'browser-1', tabId: 'tab-1' });
    assert.equal((await post(session, 'connect', { sdp: SDP })).status, 502);
    assert.equal((await post(session, 'stop')).status, 200); assert.equal((await session.done).reason, 'user-ended'); assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 1);
  } finally { await session.close(); }
});
test('remote broker rechecks root before connecting and account on heartbeat', async () => {
  const f = fixture(), session = await createRemoteControlServer(f.client);
  try {
    f.setThread('thread-2'); assert.equal((await post(session, 'connect', { sdp: SDP })).status, 502); assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
    f.setAccount('account-2'); assert.equal((await post(session, 'heartbeat')).status, 502); assert.equal((await session.done).reason, 'account-changed');
  } finally { await session.close(); }
});
test('remote broker pins JWT user identity for heartbeat and every control takeover', async () => {
  for (const endpoint of ['heartbeat', 'authorize']) {
    const f = fixture(); let subject = 'user-1';
    f.client.transport.assertIdentity = Transport.prototype.assertIdentity;
    f.client.transport.authLoader = async () => ({ accountId: 'shared-workspace', accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
    const session = await createRemoteControlServer(f.client);
    try {
      assert.equal((await post(session, 'connect', { sdp: SDP })).status, 200);
      assert.equal((await post(session, 'authorize')).status, 200);
      subject = 'user-2'; const response = await post(session, endpoint);
      assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'AUTH_IDENTITY_CHANGED');
      assert.equal((await session.done).reason, 'account-changed');
    } finally { await session.close(); }
  }
});
test('remote broker times out and aborts without creating sessions', async () => {
  const f = fixture(), session = await createRemoteControlServer(f.client, { startupTimeoutMs: 100 });
  assert.equal((await session.done).reason, 'startup-timeout');
  const abort = new AbortController(), second = await createRemoteControlServer(f.client, { signal: abort.signal }); abort.abort();
  assert.equal((await second.done).reason, 'aborted'); assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
});
test('remote shutdown closes browser preconnect sockets without an HTTP request', async () => {
  const f = fixture(), session = await createRemoteControlServer(f.client);
  const socket = createConnection({ host: '127.0.0.1', port: session.address.port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await Promise.race([session.close('test-ended'), delay(1000).then(() => { throw new Error('Broker shutdown hung on a preconnect'); })]);
  await closed; assert.equal(socket.destroyed, true); assert.equal((await session.done).reason, 'test-ended');
});
test('browser open failure closes local server without SDP mutation', async () => {
  const f = fixture(); await assert.rejects(runRemoteControl(f.client, { output: { write() {} }, openBrowser: async () => { throw new Error('open failure'); } }), /open failure/);
  assert.equal(f.calls.filter(call => call[0] === 'SDP').length, 0);
});
test('remote browser rejects invalid handoff and timeout configuration', async () => {
  const f = fixture();
  await assert.rejects(createRemoteControlServer(f.client, { idleTimeoutMs: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(createRemoteControlServer(f.client, { handoff: { conversationId: 'c' } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(createRemoteControlServer(f.client, { source: 'flora', conversationId: 'c', handoff: { conversationId: 'c', tabId: 't' } }), { code: 'INVALID_ARGUMENT' });
});
test('input binary framing matches little-endian mouse, scroll and key contracts', () => {
  assert.deepEqual([...new Uint8Array(encodeRemoteInput('move', { x: 300, y: 500 }))], [1, 4, 0, 44, 1, 244, 1]);
  assert.deepEqual([...new Uint8Array(encodeRemoteInput('scroll', { x: -1, y: 10 }))], [2, 4, 0, 255, 255, 10, 0]);
  const value = new DataView(encodeRemoteInput('down', { key: 65293 })); assert.equal(value.getUint8(0), 3); assert.equal(value.getUint16(1, true), 8); assert.equal(value.getBigUint64(3, true), 65293n);
  assert.equal(new DataView(encodeRemoteInput('up', { key: 65293 })).getUint8(0), 4);
  for (const [kind, data] of [['move', { x: -1, y: 1 }], ['scroll', { x: NaN, y: 0 }], ['down', { key: -1 }], ['bad', { key: 1 }]]) assert.throws(() => encodeRemoteInput(kind, data));
});
test('keysym conversion supports Unicode, function keys, side modifiers and Mac remapping', () => {
  assert.equal(keysymForEvent({ key: 'Enter' }), 65293); assert.equal(keysymForEvent({ key: '😀' }), 0x0101f600);
  assert.equal(keysymForEvent({ key: 'F24' }), 65493); assert.equal(keysymForEvent({ key: 'Shift', location: 2 }), 65506);
  assert.equal(keysymForEvent({ key: 'Meta' }, 'MacIntel'), 65507); assert.equal(keysymForEvent({ key: 'Alt', location: 2 }, 'MacIntel'), 65027); assert.equal(keysymForEvent({ key: 'Unidentified' }), null);
});
const video = { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) };
test('pointer coordinates account for letterboxing and reject invisible dimensions', () => {
  assert.deepEqual(remoteCoordinates({ clientX: 410, clientY: 320 }, video), { x: 960, y: 540 });
  assert.equal(remoteCoordinates({ clientX: 410, clientY: 25 }, video), null);
  assert.equal(remoteCoordinates({ clientX: 10, clientY: 20 }, { ...video, videoWidth: 0 }), null);
});
function browserFixture({ handoff = null, readyTimeoutMs = 30000, controlTimeoutMs = 15000, authorizeImpl, ...options } = {}) {
  const calls = [], messages = [], states = []; let peer;
  class Peer {
    constructor() { peer = this; this.connectionState = 'new'; }
    addTransceiver(...args) { calls.push(['transceiver', ...args]); }
    createDataChannel(name) { calls.push(['channel', name]); return this.channel = { readyState: 'connecting', send(value) { messages.push(value); }, close() { this.readyState = 'closed'; } }; }
    async createOffer() { return { type: 'offer', sdp: SDP }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { calls.push(['answer', value]); this.connectionState = 'connected'; this.channel.readyState = 'open'; this.channel.onopen(); this.onconnectionstatechange(); }
    close() { this.connectionState = 'closed'; }
  }
  const api = async (operation, body) => { calls.push([operation, body]); if (operation === 'authorize' && authorizeImpl) return authorizeImpl(); return operation === 'connect' ? { answer: SDP, handoff } : {}; };
  const remote = createBrowserRemoteSession({ api, PeerConnection: Peer, onStatus: value => states.push(value), readyTimeoutMs, controlTimeoutMs, ...options });
  return { calls, messages, states, remote, get peer() { return peer; }, receive(value) { peer.channel.onmessage({ data: JSON.stringify(value) }); } };
}
test('browser connects receive-only and waits for explicit acknowledged control', async () => {
  const f = browserFixture(); await f.remote.start();
  assert.deepEqual(f.calls.filter(call => call[0] === 'transceiver'), [['transceiver', 'audio', { direction: 'recvonly' }], ['transceiver', 'video', { direction: 'recvonly' }]]);
  assert.deepEqual(f.calls.find(call => call[0] === 'channel'), ['channel', '']); assert.equal(f.remote.mode, 'observing'); assert.equal(f.messages.length, 0);
  assert.equal(f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'a' }), false);
  assert.equal(await f.remote.requestControl(), true); assert.equal(f.remote.mode, 'requesting'); assert.equal(f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'a' }), false);
  f.receive({ event: 'control/locked' }); assert.equal(f.remote.mode, 'controlling'); assert.equal(f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'a' }), true);
  await f.remote.stop(); assert.equal(f.remote.closed, true); assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
});
test('browser ignores unsolicited grants and untrusted synthetic input', async () => {
  const f = browserFixture(); await f.remote.start(); f.receive({ event: 'control/locked' }); assert.equal(f.remote.mode, 'observing'); assert.deepEqual(JSON.parse(f.messages[0]), { event: 'control/release' });
  await f.remote.requestControl(); f.receive({ event: 'control/locked' }); const before = f.messages.length;
  assert.equal(f.remote.sendKey({ isTrusted: false, type: 'keydown', key: 'a' }), false);
  assert.equal(f.remote.sendClipboard('private', { isTrusted: false }), false);
  assert.equal(f.remote.sendPointer({ isTrusted: false, type: 'pointerdown', clientX: 100, clientY: 100, button: 0 }, video), false); assert.equal(f.messages.length, before);
  await f.remote.stop();
});
test('browser control waits for local identity authorization and rejects early grants', async () => {
  let resolveAuthorization;
  const f = browserFixture({ authorizeImpl: () => new Promise(resolve => { resolveAuthorization = resolve; }) });
  await f.remote.start(); const control = f.remote.requestControl();
  assert.equal(f.remote.mode, 'requesting'); assert.ok(!f.messages.some(message => typeof message === 'string' && JSON.parse(message).event === 'control/request'));
  f.receive({ event: 'control/locked' }); assert.equal(f.remote.mode, 'requesting');
  resolveAuthorization({}); assert.equal(await control, true);
  f.receive({ event: 'control/locked' }); assert.equal(f.remote.mode, 'controlling'); await f.remote.stop();
});
test('browser identity authorization failure closes connection without requesting control', async () => {
  const f = browserFixture({ authorizeImpl: async () => { throw new Error('user changed'); } });
  await f.remote.start(); assert.equal(await f.remote.requestControl(), false); assert.equal(f.remote.closed, true);
  assert.ok(!f.messages.some(message => typeof message === 'string' && JSON.parse(message).event === 'control/request'));
});
test('browser handoff waits for acknowledgement before enabling control', async () => {
  const f = browserFixture({ handoff: { conversationId: 'c', tabId: 't' } }); let ready = false;
  const started = f.remote.start().then(() => { ready = true; });
  for (let i = 0; !f.messages.length && i < 30; i++) await delay(1);
  assert.deepEqual(JSON.parse(f.messages[0]), { event: 'browser/handoff', conversation_id: 'c', tab_id: 't' }); assert.equal(ready, false); assert.equal(await f.remote.requestControl(), false);
  f.receive({ event: 'browser/handoff/ready' }); await started; assert.equal(ready, true); await f.remote.stop();
});
test('browser rejects a failed handoff and does not enable control', async () => {
  const f = browserFixture({ handoff: { conversationId: 'c', tabId: 't' } }); const start = f.remote.start();
  for (let i = 0; !f.messages.length && i < 30; i++) await delay(1);
  f.receive({ event: 'browser/handoff/error' }); await assert.rejects(start); assert.equal(f.remote.closed, true); assert.equal(await f.remote.requestControl(), false);
});
test('browser timeout releases a pending control request and late grants', async () => {
  const f = browserFixture({ controlTimeoutMs: 10 }); await f.remote.start(); await f.remote.requestControl(); await delay(20); assert.equal(f.remote.mode, 'observing');
  f.receive({ event: 'control/locked' }); assert.equal(f.remote.mode, 'observing'); await f.remote.stop();
});
test('browser key releases preserve original keysym after modifier changes', async () => {
  const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'A', code: 'KeyA' }); f.remote.sendKey({ isTrusted: true, type: 'keyup', key: 'a', code: 'KeyA' });
  const binary = f.messages.filter(value => value instanceof ArrayBuffer); assert.equal(new DataView(binary[0]).getBigUint64(3, true), 65n); assert.equal(new DataView(binary[1]).getBigUint64(3, true), 65n); await f.remote.stop();
});
test('browser release flushes pressed keys and does not echo server release forever', async () => {
  const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'Enter' }); f.remote.releaseControl(); assert.equal(f.remote.mode, 'observing');
  const binary = f.messages.filter(value => value instanceof ArrayBuffer); assert.equal(new DataView(binary.at(-1)).getUint8(0), 4);
  const before = f.messages.length; f.receive({ event: 'control/release' }); assert.equal(f.messages.length, before); await f.remote.stop();
});
test('browser clipboard uses explicit text only; unknown and malformed events do not execute', async () => {
  const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  assert.equal(f.remote.sendClipboard('user supplied', { isTrusted: true }), true); assert.deepEqual(JSON.parse(f.messages.at(-1)), { event: 'control/clipboard', text: 'user supplied' });
  const before = f.messages.length; f.receive({ event: 'evil', script: 'globalThis.pwned=true' }); f.peer.channel.onmessage({ data: '{' }); assert.equal(f.messages.length, before);
  f.receive({ event: 'browser/webauthn/request', request: { request_id: 'request-1' } }); assert.deepEqual(JSON.parse(f.messages.at(-1)), { event: 'browser/webauthn/response', request_id: 'request-1', approved: false }); await f.remote.stop();
});
test('browser mouse and scroll events respect viewport and protocol bounds', async () => {
  const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  assert.equal(f.remote.sendPointer({ isTrusted: true, type: 'pointerdown', clientX: 410, clientY: 320, button: 0 }, video), true);
  assert.equal(f.remote.sendPointer({ isTrusted: true, type: 'wheel', clientX: 410, clientY: 320, deltaX: 3, deltaY: 100, deltaMode: 0 }, video), true);
  const binary = f.messages.filter(value => value instanceof ArrayBuffer); assert.equal(new DataView(binary[1]).getBigUint64(3, true), 1n); assert.equal(new DataView(binary.at(-1)).getInt16(5, true), -10);
  await f.remote.stop();
});
test('browser releases a dragged mouse button outside the video without an invalid move', async () => {
  const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  const down = { isTrusted: true, type: 'pointerdown', clientX: 410, clientY: 320, button: 0 };
  assert.equal(f.remote.sendPointer(down, video), true);
  const before = f.messages.length;
  const outside = { ...down, type: 'pointerup', clientX: -100, clientY: -100 };
  assert.equal(f.remote.sendPointer(outside, video), true); assert.equal(f.messages.length, before + 1);
  const release = new DataView(f.messages.at(-1)); assert.equal(release.getUint8(0), 4); assert.equal(release.getBigUint64(3, true), 1n);
  assert.equal(f.remote.sendPointer(outside, video), false); assert.equal(f.messages.length, before + 1);
  await f.remote.stop();
});
test('browser releases captured mouse buttons when a pointer is cancelled or capture is lost', async () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const f = browserFixture(); await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
    f.remote.sendPointer({ isTrusted: true, type: 'pointerdown', clientX: 410, clientY: 320, button: 2 }, video);
    const before = f.messages.length;
    assert.equal(f.remote.sendPointer({ isTrusted: true, type }, video), true); assert.equal(f.messages.length, before + 1);
    const release = new DataView(f.messages.at(-1)); assert.equal(release.getUint8(0), 4); assert.equal(release.getBigUint64(3, true), 3n);
    assert.equal(f.remote.sendPointer({ isTrusted: true, type }, video), false); await f.remote.stop();
  }
});
test('remote class exposes explicit high-level workflows', () => { const instance = new DotRemoteControl(fixture().client); assert.equal(typeof instance.negotiate, 'function'); assert.equal(typeof instance.server, 'function'); assert.equal(typeof instance.open, 'function'); });

test('native success outcome requires actual playback and a presented frame exactly once', async () => {
  const f = browserFixture(); await f.remote.start();
  assert.equal(f.messages.length, 0); f.remote.videoPlaying(); assert.equal(f.messages.length, 0);
  f.remote.videoFrame(); assert.deepEqual(JSON.parse(f.messages[0]), { client: 'codex', event: 'browser/client_outcome', outcome: 'success', reason: 'video_playing' });
  f.remote.videoFrame(); f.remote.videoPlaying(); assert.equal(f.messages.length, 1); await f.remote.stop();
});
test('native playback success also waits for pending tab handoff acknowledgement', async () => {
  const f = browserFixture({ handoff: { conversationId: 'c', tabId: 't' } }); const start = f.remote.start();
  while (!f.messages.length) await delay(1);
  f.remote.videoPlaying(); f.remote.videoFrame(); assert.equal(f.messages.length, 1);
  f.receive({ event: 'browser/handoff/ready' }); await start;
  assert.equal(JSON.parse(f.messages.at(-1)).outcome, 'success'); await f.remote.stop();
});
test('error outcome waits for server acknowledgement before disconnecting', async () => {
  const f = browserFixture(); await f.remote.start(); const stopped = f.remote.videoError();
  assert.equal(f.remote.closed, true); assert.notEqual(f.peer.connectionState, 'closed');
  assert.deepEqual(JSON.parse(f.messages.at(-1)), { client: 'codex', event: 'browser/client_outcome', outcome: 'error', reason: 'video_error' });
  f.receive({ event: 'browser/client_outcome/ack' }); await stopped; assert.equal(f.peer.connectionState, 'closed');
});
test('missing native error acknowledgement still disconnects within the bounded timeout', async () => {
  const f = browserFixture({ outcomeTimeoutMs: 10 }); await f.remote.start(); await f.remote.videoError(); assert.equal(f.peer.connectionState, 'closed');
});
test('clipboard synchronization defaults off and needs a trusted opt-in', async () => {
  let reads = 0; const writes = [], f = browserFixture({ readClipboard: async () => { reads++; return 'private'; }, writeClipboard: async text => writes.push(text) });
  await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  const paste = { isTrusted: true, type: 'keydown', key: 'v', code: 'KeyV', metaKey: true };
  f.remote.sendKey(paste); f.receive({ event: 'control/clipboard', text: 'remote-private' }); await delay(1);
  assert.equal(reads, 0); assert.equal(writes.length, 0); assert.equal(f.remote.setClipboardSync(true, { isTrusted: false }), false);
  assert.equal(f.remote.setClipboardSync(true, { isTrusted: true }), true); await f.remote.stop();
});
test('enabled clipboard sync sends text before paste keys and waits for remote acknowledgement', async () => {
  let reads = 0; const f = browserFixture({ readClipboard: async () => { reads++; return 'local-private'; } });
  await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' }); f.remote.setClipboardSync(true, { isTrusted: true });
  const before = f.messages.length; f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true }); f.remote.sendKey({ isTrusted: true, type: 'keyup', key: 'v', code: 'KeyV', ctrlKey: true });
  await delay(1); assert.equal(reads, 1); assert.equal(f.messages.length, before + 1); assert.deepEqual(JSON.parse(f.messages.at(-1)), { event: 'control/clipboard', text: 'local-private' });
  f.receive({ event: 'control/clipboard', text: 'local-private' }); await delay(1);
  assert.equal(f.messages.length, before + 3); assert.equal(new DataView(f.messages.at(-2)).getUint8(0), 3); assert.equal(new DataView(f.messages.at(-1)).getUint8(0), 4); await f.remote.stop();
});
test('clipboard sync timeout flushes keys and remote writes require focused active control', async () => {
  const writes = []; let focused = true;
  const f = browserFixture({ clipboardTimeoutMs: 10, readClipboard: async () => 'local', writeClipboard: async value => writes.push(value), hasFocus: () => focused });
  await f.remote.start(); f.remote.setClipboardSync(true, { isTrusted: true }); f.receive({ event: 'control/clipboard', text: 'observe' });
  assert.equal(writes.length, 0); await f.remote.requestControl(); f.receive({ event: 'control/locked' });
  f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true }); await delay(20); assert.ok(f.messages.at(-1) instanceof ArrayBuffer);
  f.receive({ event: 'control/clipboard', text: 'control' }); await delay(1); assert.deepEqual(writes, ['control']);
  focused = false; f.receive({ event: 'control/clipboard', text: 'hidden' }); await delay(1); assert.deepEqual(writes, ['control']); await f.remote.stop();
});
test('pending clipboard read cannot send into a later control grant', async () => {
  let resolve; const f = browserFixture({ readClipboard: () => new Promise(done => { resolve = done; }) });
  await f.remote.start(); await f.remote.requestControl(); f.receive({ event: 'control/locked' }); f.remote.setClipboardSync(true, { isTrusted: true });
  f.remote.sendKey({ isTrusted: true, type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true }); await delay(1);
  f.remote.releaseControl(); await f.remote.requestControl(); f.receive({ event: 'control/locked' }); const before = f.messages.length;
  resolve('private'); await delay(1); assert.equal(f.messages.length, before); await f.remote.stop();
});
