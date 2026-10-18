import test from 'node:test';
import assert from 'node:assert/strict';
import { installClock } from './helpers/deterministic-clock.mjs';

const TOKEN = 'a'.repeat(43);
const KEYS = ['window', 'document', 'navigator', 'fetch', 'MediaStream'];
let importSequence = 0;
async function flush() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) { const handlers = this.listeners.get(type) ?? []; handlers.push(handler); this.listeners.set(type, handlers); }
  emit(type, fields = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ type, isTrusted: true, ...fields }); }
}

async function browser(t, { listenOnly = false, token = TOKEN } = {}) {
  const saved = new Map(KEYS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const clock = installClock(t, { intervals: true });
  const document = new Events(), window = new Events(), requests = [], histories = [];
  document.body = { dataset: { listenOnly: String(listenOnly) } };
  const elements = Object.fromEntries(['status', 'start', 'mute', 'end', 'audio'].map(id => {
    const element = new Events(); Object.assign(element, { id, disabled: ['mute', 'end'].includes(id), hidden: false, textContent: id === 'status' ? 'Ready.' : id === 'start' ? 'Start call' : '', srcObject: null });
    element.click = () => { if (!element.disabled) { element.emit('click'); document.emit('click', { target: element }); } };
    return [id, element];
  }));
  let playCalls = 0, playFailures = 0, permissionCalls = 0, peer, heartbeatFails = false;
  elements.audio.play = () => { playCalls++; return playFailures-- > 0 ? Promise.reject(new Error('Autoplay blocked')) : Promise.resolve(); };
  document.querySelector = selector => elements[selector.slice(1)] ?? null;
  window.location = { hash: `#${token}`, pathname: '/voice' };
  window.history = { replaceState(state, title, url) { histories.push({ state, title, url }); window.location.hash = ''; window.location.pathname = url; } };
  const track = { enabled: true, stopCalls: 0, stop() { this.stopCalls++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const remoteStream = { name: 'remote-fixture-stream' };
  class Peer {
    constructor() { peer = this; this.connectionState = 'new'; this.closeCalls = 0; this.transceivers = []; this.sentTracks = []; }
    createDataChannel(name) {
      this.channelName = name;
      this.channel = { readyState: 'connecting', closeCalls: 0, close() { this.closeCalls++; this.readyState = 'closed'; this.onclose?.(); } };
      return this.channel;
    }
    addTrack(value, valueStream) { this.sentTracks.push({ track: value, stream: valueStream, enabledWhenAdded: value.enabled }); }
    addTransceiver(kind, options) { this.transceivers.push({ kind, options }); }
    async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.connectionState = 'connected'; this.channel.readyState = 'open'; this.onconnectionstatechange?.(); this.channel.onopen?.(); }
    close() { this.closeCalls++; this.connectionState = 'closed'; }
  }
  window.RTCPeerConnection = Peer;
  const navigator = { mediaDevices: { async getUserMedia(options) { permissionCalls++; assert.equal(options.video, false); return stream; } } };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    if (url === '/api/heartbeat' && heartbeatFails) return Response.json({ error: { message: 'Fixture heartbeat failure.' } }, { status: 503 });
    if (url === '/api/allocate') return Response.json({ answer: 'fixture-answer', callId: 'fixture-call' });
    if (['/api/attach', '/api/stop', '/api/heartbeat'].includes(url)) return Response.json({});
    throw new Error('Unexpected fake browser request');
  };
  for (const [key, value] of Object.entries({ window, document, navigator, fetch, MediaStream: class { constructor(tracks) { this.tracks = tracks; } } })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(async () => {
    window.emit('pagehide'); await flush(); clock.restore();
    for (const key of KEYS) { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  await import(`../src/voice-browser.mjs?dom-test=${++importSequence}`);
  return { window, document, elements, requests, histories, track, stream, remoteStream, clock,
    get peer() { return peer; }, get permissionCalls() { return permissionCalls; }, get playCalls() { return playCalls; },
    blockNextPlayback() { playFailures++; }, failHeartbeat() { heartbeatFails = true; },
    async start() { elements.start.click(); await flush(); },
    deliverRemoteStream() { peer.ontrack({ streams: [remoteStream], track: {} }); },
    count(path) { return requests.filter(request => request.url === path).length; } };
}

test('voice page removes its capability from the URL and waits for an explicit start', async t => {
  const h = await browser(t);
  assert.equal(h.window.location.hash, ''); assert.deepEqual(h.histories, [{ state: null, title: '', url: '/voice' }]);
  assert.equal(h.permissionCalls, 0); assert.equal(h.requests.length, 0);
  h.clock.tick(10000); await flush();
  assert.equal(h.count('/api/heartbeat'), 1);
  const request = h.requests[0];
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.redirect, 'error');
  assert.equal(h.permissionCalls, 0);
});

test('voice page start, mute and end drive media and control state with one cleanup', async t => {
  const h = await browser(t); await h.start();
  assert.equal(h.permissionCalls, 1); assert.equal(h.count('/api/allocate'), 1); assert.equal(h.count('/api/attach'), 1);
  assert.equal(h.peer.sentTracks[0].enabledWhenAdded, false); assert.equal(h.track.enabled, true);
  assert.equal(h.elements.start.disabled, true); assert.equal(h.elements.mute.disabled, false); assert.equal(h.elements.end.disabled, false);
  assert.match(h.elements.status.textContent, /Speak naturally/);
  h.elements.mute.click(); assert.equal(h.track.enabled, false); assert.equal(h.elements.mute.textContent, 'Unmute microphone');
  h.elements.mute.click(); assert.equal(h.track.enabled, true); assert.equal(h.elements.mute.textContent, 'Mute microphone');
  h.deliverRemoteStream(); await flush(); assert.equal(h.elements.audio.srcObject, h.remoteStream);
  h.elements.end.click(); await flush(); h.window.emit('pagehide'); await flush();
  assert.equal(h.count('/api/stop'), 1); assert.equal(h.track.stopCalls, 1); assert.equal(h.peer.closeCalls, 1); assert.equal(h.peer.channel.closeCalls, 1);
  assert.equal(h.elements.audio.srcObject, null); assert.equal(h.elements.mute.disabled, true); assert.equal(h.elements.end.disabled, true);
  h.clock.tick(30000); await flush(); assert.equal(h.count('/api/heartbeat'), 0);
});

test('listen-only page changes controls and never requests microphone access', async t => {
  const h = await browser(t, { listenOnly: true });
  assert.equal(h.elements.start.textContent, 'Start listening'); assert.equal(h.elements.mute.hidden, true);
  await h.start();
  assert.equal(h.permissionCalls, 0); assert.equal(h.peer.sentTracks.length, 0);
  assert.deepEqual(h.peer.transceivers, [{ kind: 'audio', options: { direction: 'sendrecv' } }]);
  assert.match(h.elements.status.textContent, /Listening only; microphone disabled/);
  h.elements.end.click(); await flush(); assert.equal(h.count('/api/stop'), 1); assert.equal(h.track.stopCalls, 0);
});

test('failed page heartbeat stops an active call once and clears future heartbeat work', async t => {
  const h = await browser(t); await h.start(); h.failHeartbeat();
  h.clock.tick(10000); await flush();
  assert.equal(h.count('/api/heartbeat'), 1); assert.equal(h.count('/api/stop'), 1); assert.equal(h.track.stopCalls, 1);
  assert.match(h.elements.status.textContent, /CLI disconnected/); assert.equal(h.elements.end.disabled, true);
  h.clock.tick(30000); await flush(); h.window.emit('pagehide'); await flush();
  assert.equal(h.count('/api/heartbeat'), 1); assert.equal(h.count('/api/stop'), 1);
});

test('pagehide stops the browser call and cancels heartbeat even when repeated', async t => {
  const h = await browser(t); await h.start();
  h.window.emit('pagehide'); h.window.emit('pagehide'); await flush();
  assert.equal(h.count('/api/stop'), 1); assert.equal(h.track.stopCalls, 1); assert.equal(h.elements.audio.srcObject, null);
  h.clock.tick(30000); await flush(); assert.equal(h.count('/api/heartbeat'), 0);
});

test('an invalid capability is scrubbed and cannot start or schedule heartbeat', async t => {
  const h = await browser(t, { token: 'invalid-token' });
  assert.equal(h.window.location.hash, ''); assert.equal(h.elements.start.disabled, true);
  assert.match(h.elements.status.textContent, /fresh voice URL/);
  h.elements.start.click(); h.clock.tick(30000); await flush();
  assert.equal(h.permissionCalls, 0); assert.equal(h.requests.length, 0);
});

test('blocked autoplay gives a visible retry cue and a page click retries playback', async t => {
  const h = await browser(t); await h.start(); h.blockNextPlayback(); h.deliverRemoteStream(); await flush();
  assert.equal(h.elements.audio.srcObject, h.remoteStream); assert.equal(h.playCalls, 1);
  assert.match(h.elements.status.textContent, /Click the page to allow speaker audio/);
  h.document.emit('click'); await flush(); assert.equal(h.playCalls, 2);
  assert.equal(h.count('/api/stop'), 0); assert.equal(h.track.enabled, true);
  h.elements.end.click(); await flush();
  h.document.emit('click'); await flush(); assert.equal(h.elements.audio.srcObject, null); assert.equal(h.playCalls, 2);
});

test('a rejected manual autoplay retry leaves the call active and the retry cue visible', async t => {
  const h = await browser(t); await h.start(); h.blockNextPlayback(); h.deliverRemoteStream(); await flush();
  h.blockNextPlayback(); h.document.emit('click'); await flush();
  assert.equal(h.playCalls, 2); assert.match(h.elements.status.textContent, /Click the page to allow speaker audio/);
  assert.equal(h.track.enabled, true); assert.equal(h.elements.end.disabled, false); assert.equal(h.count('/api/stop'), 0);
});

test('an autoplay rejection arriving after end cannot overwrite the ended status', async t => {
  const h = await browser(t); await h.start();
  let rejectPlayback;
  h.elements.audio.play = () => new Promise((_resolve, reject) => { rejectPlayback = reject; });
  h.deliverRemoteStream(); await flush();
  h.elements.end.click(); await flush(); assert.equal(h.elements.status.textContent, 'Call ended.');
  rejectPlayback(new Error('Late autoplay rejection')); await flush();
  assert.equal(h.elements.status.textContent, 'Call ended.');
  assert.equal(h.elements.audio.srcObject, null); assert.equal(h.count('/api/stop'), 1);
});

test('an obsolete stream autoplay rejection cannot change the current stream status', async t => {
  const h = await browser(t); await h.start();
  let rejectPlayback;
  h.elements.audio.play = () => new Promise((_resolve, reject) => { rejectPlayback = reject; });
  h.deliverRemoteStream(); await flush();
  const currentStream = { name: 'replacement-remote-stream' };
  h.elements.audio.play = () => Promise.resolve();
  h.peer.ontrack({ streams: [currentStream], track: {} }); await flush();
  rejectPlayback(new Error('Obsolete autoplay rejection')); await flush();
  assert.equal(h.elements.audio.srcObject, currentStream);
  assert.match(h.elements.status.textContent, /Speak naturally/);
  assert.equal(h.count('/api/stop'), 0);
});
