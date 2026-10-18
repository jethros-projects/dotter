import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { allocateVoiceCall, attachVoiceCall, stopVoiceCall, createVoiceSessionServer, runVoiceChat } from '../src/voice.mjs';
import { createBrowserVoiceSession } from '../src/voice-browser.mjs';
import { Transport } from '../src/transport.mjs';

const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
function fixture(impl) {
  const requests = [];
  const client = { primary: async () => ({ id: 'user~dot', threadId: 'thread-1' }), transport: { request: async (...args) => {
    requests.push(args); if (impl) return impl(...args);
    return args[1].endsWith('/voice/calls') ? { status: 201, headers: new Headers({ Location: '/backend-api/tbo/user~dot/voice/calls/rtc_test', 'OpenAI-Root-Thread-ID': 'thread-1' }), body: SDP } : { completed: true };
  } } };
  return { client, requests };
}
async function post(session, path, body = {}, headers = {}) {
  return fetch(`${session.origin}/api/${path}`, { method: 'POST', headers: { Origin: session.origin, Authorization: `Bearer ${new URL(session.url).hash.slice(1)}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('voice allocation sends observed JSON contract and returns SDP with safe identifiers', async () => {
  const { client, requests } = fixture();
  assert.deepEqual(await allocateVoiceCall(client, { sdp: SDP, instantConnect: true }), { dotId: 'user~dot', callId: 'rtc_test', answer: SDP, rootThreadId: 'thread-1' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1], '/backend-api/tbo/user~dot/voice/calls');
  assert.deepEqual(requests[0][2].body, { sdp: SDP, instant_connect: true });
  assert.equal(requests[0][2].responseType, 'text'); assert.equal(requests[0][2].includeResponse, true);
});
test('voice explicit attach and stop make one no-body request each', async () => {
  const { client, requests } = fixture();
  await attachVoiceCall(client, { dotId: 'dot1', callId: 'rtc_call' }); await stopVoiceCall(client, { dotId: 'dot1', callId: 'rtc_call' });
  assert.deepEqual(requests.map(([method, path]) => [method, path]), [['POST', '/backend-api/tbo/dot1/voice/calls/rtc_call/attach'], ['POST', '/backend-api/tbo/dot1/voice/calls/rtc_call/stop']]);
  assert.equal(requests[0][2].body, undefined);
});
test('invalid SDP and IDs fail before API calls', async () => {
  const { client, requests } = fixture();
  for (const value of ['', 'secret', 'v=0\n\0', `v=0\n${'x'.repeat(262144)}`]) await assert.rejects(allocateVoiceCall(client, { sdp: value }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(attachVoiceCall(client, { dotId: 'dot', callId: '../bad' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(stopVoiceCall(client, { dotId: '../bad', callId: 'rtc_good' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(requests.length, 0);
});
test('root-thread mismatch stops the allocated call once before failing', async () => {
  const { client, requests } = fixture((method, path) => path.endsWith('/voice/calls') ? { headers: new Headers({ Location: '/voice/calls/rtc_test', 'OpenAI-Root-Thread-ID': 'wrong-thread' }), body: SDP } : {});
  await assert.rejects(allocateVoiceCall(client, { sdp: SDP }), { code: 'VOICE_IDENTITY_MISMATCH' });
  assert.equal(requests.length, 2); assert.match(requests[1][1], /\/rtc_test\/stop$/);
});
test('invalid answer stops known allocation and reports cleanup uncertainty without retry', async () => {
  const { client, requests } = fixture((method, path) => {
    if (path.endsWith('/voice/calls')) return { headers: new Headers({ Location: '/voice/calls/rtc_test' }), body: 'not sdp' };
    throw Error('not exposed');
  });
  await assert.rejects(allocateVoiceCall(client, { sdp: SDP }), error => error.code === 'INVALID_RESPONSE' && error.details.cleanup === 'unconfirmed' && error.details.callId === 'rtc_test');
  assert.equal(requests.length, 2);
});
test('voice response refuses unsafe or different-Dot Location', async () => {
  for (const location of ['http://example.test/rtc_test', '/backend-api/tbo/wrong/voice/calls/rtc_test', '/voice/calls/not-a-call']) {
    const { client, requests } = fixture(() => ({ headers: new Headers({ Location: location }), body: SDP }));
    await assert.rejects(allocateVoiceCall(client, { sdp: SDP }), { code: 'INVALID_RESPONSE' }); assert.equal(requests.length, 1);
  }
});
test('loopback server serves static UI with no account credential in page', async t => {
  const { client } = fixture(); const session = await createVoiceSessionServer(client); t.after(() => session.close());
  const response = await fetch(session.origin); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Start voice/); assert.doesNotMatch(html, new RegExp(new URL(session.url).hash.slice(1)));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(session.address.address, '127.0.0.1');
});
test('listen-only voice page denies microphone permission and clearly describes its mode', async t => {
  const { client } = fixture(); const session = await createVoiceSessionServer(client, { listenOnly: true }); t.after(() => session.close());
  const response = await fetch(session.origin), html = await response.text();
  assert.match(response.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.match(html, /data-listen-only="true"/); assert.match(html, /Listen to your Dot/);
  assert.match(html, /without requesting microphone access or sending audio/);
  assert.doesNotMatch(html, /__VOICE_|__LISTEN_ONLY__/);
});
test('invalid listen-only options fail before reading authentication', async () => {
  let reads = 0;
  const client = { transport: { authLoader: async () => { reads++; throw Error('must not run'); } } };
  await assert.rejects(createVoiceSessionServer(client, { listenOnly: 'true' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(reads, 0);
  assert.throws(() => createBrowserVoiceSession({ listenOnly: 'true' }), /listenOnly must be boolean/);
});
test('loopback mutation endpoints require exact Origin and capability', async t => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client); t.after(() => session.close());
  for (const headers of [{ Origin: 'http://evil.test' }, { Authorization: 'Bearer wrong' }, { Origin: '' }]) {
    assert.equal((await post(session, 'allocate', { sdp: SDP }, headers)).status, 403);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(session.origin, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${session.origin}/api/allocate`)).status, 405);
  assert.equal(requests.length, 0);
});
test('voice UI permits only the fresh top-level browser navigation from another site', async t => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client); t.after(() => session.close());
  const rawGet = (path, headers) => new Promise((resolve, reject) => {
    const req = request(`${session.origin}${path}`, { headers }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await rawGet('/', navigation), 200);
  for (const path of ['/', '/voice-browser.mjs', '/api/allocate']) {
    const headers = { ...navigation, ...(path === '/' ? { 'Sec-Fetch-Dest': 'iframe' } : {}) };
    assert.equal(await rawGet(path, headers), 403);
  }
  assert.equal(await rawGet('/', { ...navigation, Origin: 'https://other.example' }), 403);
  assert.equal((await post(session, 'allocate', { sdp: SDP }, navigation)).status, 403);
  assert.equal(requests.length, 0);
});
test('voice close settles when a browser leaves an unused preconnect socket open', async () => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client);
  const socket = createConnection(session.address.port, '127.0.0.1');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  try {
    const result = await Promise.race([session.close('test-ended'), delay(1000).then(() => { throw Error('Voice shutdown hung on preconnect.'); })]);
    assert.equal(result.reason, 'test-ended'); assert.equal(requests.length, 0);
  } finally { socket.destroy(); await session.close(); }
});
test('loopback accepts one allocation, pins attachment identity, and stops exactly once', async () => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client);
  try {
    assert.equal((await post(session, 'allocate', { sdp: SDP })).status, 200);
    assert.equal((await post(session, 'allocate', { sdp: SDP })).status, 502);
    assert.equal((await post(session, 'attach', { callId: 'rtc_other' })).status, 502);
    assert.equal((await post(session, 'attach', { callId: 'rtc_test' })).status, 200);
    assert.equal((await post(session, 'attach', { callId: 'rtc_test' })).status, 200);
    assert.equal((await post(session, 'stop')).status, 200);
    const result = await session.done; assert.equal(result.reason, 'user-ended'); assert.equal(result.callId, 'rtc_test');
    assert.deepEqual(requests.map(([, path]) => path.split('/').at(-1)), ['calls', 'attach', 'stop']);
    await session.close(); assert.equal(requests.length, 3);
  } finally { await session.close(); }
});
test('loopback rejects unexpected fields and unsupported content types', async t => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client); t.after(() => session.close());
  assert.equal((await post(session, 'allocate', { sdp: SDP, dotId: 'other' })).status, 400);
  assert.equal((await post(session, 'allocate', { sdp: SDP }, { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal(requests.length, 0);
});
test('close waits for in-flight allocation then stops it without attach', async () => {
  let resolveAllocation;
  const { client, requests } = fixture((method, path) => path.endsWith('/voice/calls') ? new Promise(resolve => { resolveAllocation = resolve; }) : {});
  const session = await createVoiceSessionServer(client);
  const response = post(session, 'allocate', { sdp: SDP });
  for (let i = 0; !resolveAllocation && i < 100; i++) await delay(2);
  const close = session.close('aborted');
  resolveAllocation({ headers: new Headers({ Location: '/voice/calls/rtc_test' }), body: SDP });
  await response; assert.equal((await close).reason, 'aborted'); assert.equal(requests.length, 2); assert.match(requests[1][1], /stop$/);
});
test('idle browser cleanup disposes of an allocated call', async () => {
  const { client, requests } = fixture(); const session = await createVoiceSessionServer(client, { idleTimeoutMs: 100 });
  try { await post(session, 'allocate', { sdp: SDP }); assert.equal((await session.done).reason, 'browser-disconnected'); assert.equal(requests.length, 2); }
  finally { await session.close(); }
});
test('abort and browser-open failure close local server without API mutation', async () => {
  const { client, requests } = fixture(); const controller = new AbortController();
  const session = await createVoiceSessionServer(client, { signal: controller.signal }); controller.abort();
  assert.equal((await session.done).reason, 'aborted');
  await assert.rejects(runVoiceChat(client, { output: { write() {} }, openBrowser: async () => { throw Error('open failed'); } }), /open failed/);
  assert.equal(requests.length, 0);
});
function browserFixture() {
  const calls = [], track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let peer;
  class Peer {
    constructor() { peer = this; this.connectionState = 'new'; }
    createDataChannel(name) { calls.push(['channel', name]); return this.channel = { readyState: 'connecting', close() {} }; }
    addTransceiver(kind, options) { calls.push(['transceiver', kind, options]); return { sender: { track: null } }; }
    addTrack() { calls.push(['track', track.enabled]); }
    async createOffer() { return { type: 'offer', sdp: SDP }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { calls.push(['answer', value]); this.connectionState = 'connected'; this.channel.readyState = 'open'; this.channel.onopen(); this.onconnectionstatechange(); }
    close() { this.connectionState = 'closed'; }
  }
  const api = async (method, body) => { calls.push([method, body]); return method === 'allocate' ? { callId: 'rtc_test', answer: SDP } : {}; };
  return { calls, track, stream, Peer, api, get peer() { return peer; } };
}
test('browser negotiates WebRTC, holds mic until attached, supports mute and stop', async () => {
  const f = browserFixture(); const states = [];
  const voice = createBrowserVoiceSession({ api: f.api, mediaDevices: { getUserMedia: async () => f.stream }, PeerConnection: f.Peer, onStatus: value => states.push(value.state) });
  await voice.start(); assert.equal(f.track.enabled, true); assert.deepEqual(f.calls.find(([name]) => name === 'track'), ['track', false]);
  assert.deepEqual(f.calls.filter(([name]) => ['allocate', 'attach'].includes(name)).map(([name]) => name), ['allocate', 'attach']);
  assert.ok(states.includes('active')); voice.setMuted(true); assert.equal(f.track.enabled, false);
  await voice.stop(); await voice.stop(); assert.equal(f.track.stopped, true); assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1); assert.equal(f.peer.connectionState, 'closed');
});
test('listen-only browser negotiates native media without obtaining or sending a microphone track', async () => {
  const f = browserFixture(); const states = []; let captures = 0;
  const voice = createBrowserVoiceSession({ api: f.api, listenOnly: true,
    mediaDevices: { getUserMedia: async () => { captures++; throw Error('Microphone capture must never run.'); } },
    PeerConnection: f.Peer, onStatus: value => states.push(value) });
  await voice.start(); voice.setMuted(false);
  assert.equal(captures, 0); assert.equal(f.calls.some(([name]) => name === 'track'), false);
  assert.deepEqual(f.calls.find(([name]) => name === 'transceiver'), ['transceiver', 'audio', { direction: 'sendrecv' }]);
  assert.deepEqual(f.calls.filter(([name]) => ['allocate', 'attach'].includes(name)).map(([name]) => name), ['allocate', 'attach']);
  assert.match(states.at(-1).message, /microphone disabled/);
  await voice.stop(); assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1);
});
test('listen-only browser works when mediaDevices is absent', async () => {
  const f = browserFixture(); const voice = createBrowserVoiceSession({ api: f.api, listenOnly: true, PeerConnection: f.Peer });
  await voice.start(); await voice.stop();
  assert.equal(f.calls.filter(([name]) => name === 'attach').length, 1);
});
test('browser permission or attach failure stops tracks and asks broker to clean up', async () => {
  const f = browserFixture();
  const voice = createBrowserVoiceSession({ api: async (method, body) => { if (method === 'attach') throw Error('attach failed'); return f.api(method, body); }, mediaDevices: { getUserMedia: async () => f.stream }, PeerConnection: f.Peer });
  await assert.rejects(voice.start(), /attach failed/); assert.equal(f.track.stopped, true); assert.equal(f.calls.filter(([name]) => name === 'stop').length, 1);
  const denied = createBrowserVoiceSession({ api: f.api, mediaDevices: { getUserMedia: async () => { throw Object.assign(Error('denied'), { name: 'NotAllowedError' }); } }, PeerConnection: f.Peer });
  await assert.rejects(denied.start(), /denied/); assert.equal(denied.closed, true);
});
test('browser source never receives or queries account authorization material', async () => {
  const source = await readFile(new URL('../src/voice-browser.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /auth\.json|access_token|refresh_token|chatgpt\.com|localStorage/);
  assert.match(source, /credentials: 'omit'/); assert.match(source, /getUserMedia/);
});

test('absolute realtime Location is parsed as an ID without following it', async () => {
  const { client, requests } = fixture(() => ({ headers: new Headers({ Location: 'https://api.openai.com/v1/realtime/calls/rtc_test' }), body: SDP }));
  assert.equal((await allocateVoiceCall(client, { sdp: SDP })).callId, 'rtc_test');
  assert.equal(requests.length, 1); assert.match(requests[0][1], /^\/backend-api\/tbo\//);
});

test('voice broker pins account before resolving primary and rejects a changed selection', async () => {
  const { client, requests } = fixture(); let accountId = 'account-a', captured;
  client.transport.authLoader = async () => ({ accountId, accessToken: 'test-token' });
  client.primary = async options => { captured = options.expectedAccountId; accountId = 'account-b'; return { id: 'other-dot' }; };
  await assert.rejects(createVoiceSessionServer(client), { code: 'ACCOUNT_CHANGED' });
  assert.equal(captured, 'account-a'); assert.equal(requests.length, 0);
});
test('voice broker rejects account switch before allocation without contacting API', async () => {
  const { client, requests } = fixture(); let accountId = 'account-a';
  client.transport.authLoader = async () => ({ accountId, accessToken: 'test-token' });
  const session = await createVoiceSessionServer(client, { dotId: 'dot1' });
  try {
    accountId = 'account-b';
    const response = await post(session, 'allocate', { sdp: SDP });
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'ACCOUNT_CHANGED');
    assert.equal(requests.length, 0);
  } finally { await session.close(); }
});
test('voice broker pins the signed-in user before its first API request', async () => {
  const token = sub => `test.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.test`;
  let subject = 'user-a', fetches = 0;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-a', accessToken: token(subject) }),
    fetchImpl: async () => { fetches++; throw Error('No network request should occur.'); } });
  const session = await createVoiceSessionServer({ transport }, { dotId: 'dot1' });
  try {
    subject = 'user-b';
    const response = await post(session, 'allocate', { sdp: SDP });
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'AUTH_IDENTITY_CHANGED');
    assert.equal(fetches, 0);
  } finally { await session.close(); }
});
test('voice attach and cleanup never use a different account from allocation', async () => {
  const { client, requests } = fixture(); let accountId = 'account-a';
  client.transport.authLoader = async () => ({ accountId, accessToken: 'test-token' });
  const session = await createVoiceSessionServer(client);
  await post(session, 'allocate', { sdp: SDP });
  assert.equal(requests[0][2].expectedAccountId, 'account-a');
  accountId = 'account-b';
  const response = await post(session, 'attach', { callId: 'rtc_test' });
  assert.equal((await response.json()).error.code, 'ACCOUNT_CHANGED');
  const result = await session.close();
  assert.equal(result.stopError.code, 'ACCOUNT_CHANGED'); assert.equal(requests.length, 1);
});
test('standalone voice functions honor explicit account identity and require account selector', async () => {
  const { client, requests } = fixture(); let accountId = 'account-b';
  client.transport.authLoader = async () => ({ accountId, accessToken: 'test-token' });
  for (const operation of [
    () => allocateVoiceCall(client, { dotId: 'dot1', sdp: SDP, expectedAccountId: 'account-a' }),
    () => attachVoiceCall(client, { dotId: 'dot1', callId: 'rtc_test', expectedAccountId: 'account-a' }),
    () => stopVoiceCall(client, { dotId: 'dot1', callId: 'rtc_test', expectedAccountId: 'account-a' }),
  ]) await assert.rejects(operation(), { code: 'ACCOUNT_CHANGED' });
  accountId = null;
  await assert.rejects(createVoiceSessionServer(client, { dotId: 'dot1' }), { code: 'ACCOUNT_REQUIRED' });
  assert.equal(requests.length, 0);
});
