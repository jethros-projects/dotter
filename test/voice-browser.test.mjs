import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserVoiceSession } from '../src/voice-browser.mjs';
import { installClock } from './helpers/deterministic-clock.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture({ ready = true, api: handle, offer, localDescription, remoteDescription, onStatus } = {}) {
  const calls = [], statuses = [], remoteStreams = [];
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let peer;
  class Peer {
    constructor() { peer = this; this.connectionState = 'new'; this.closes = 0; }
    createDataChannel() {
      return this.channel = { readyState: 'connecting', closes: 0, close() { this.closes++; this.readyState = 'closed'; this.onclose?.(); } };
    }
    addTrack() {}
    addTransceiver() {}
    async createOffer() { await offer?.(); return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription(value) { await localDescription?.(); this.localDescription = value; }
    async setRemoteDescription() { await remoteDescription?.(); if (ready) this.connect(); }
    connect() { this.connectionState = 'connected'; this.channel.readyState = 'open'; this.onconnectionstatechange?.(); this.channel.onopen?.(); }
    state(value) { this.connectionState = value; this.onconnectionstatechange?.(); }
    close() { this.closes++; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const api = async (operation, body) => {
    calls.push({ operation, body });
    if (handle) { const result = await handle(operation, body); if (result !== undefined) return result; }
    return operation === 'allocate' ? { callId: 'rtc-test', answer: 'answer' } : {};
  };
  const voice = createBrowserVoiceSession({ api, PeerConnection: Peer, mediaDevices: { getUserMedia: async () => stream },
    onStatus: value => { statuses.push(value); onStatus?.(value); }, onRemoteStream: value => remoteStreams.push(value), readyTimeoutMs: 100 });
  return { voice, calls, statuses, remoteStreams, track, stream, Peer, get peer() { return peer; }, count: operation => calls.filter(call => call.operation === operation).length };
}
function cleaned(f) {
  assert.equal(f.voice.closed, true);
  assert.equal(f.track.stops, 1);
  assert.equal(f.peer.closes, 1);
  assert.equal(f.peer.channel.closes, 1);
  assert.equal(f.remoteStreams.at(-1), null);
  assert.equal(f.count('stop'), 1);
  assert.equal(f.statuses.at(-1).state, 'ended');
}

for (const event of ['close', 'error', 'server-error']) test(`voice ${event} releases media and requests remote cleanup exactly once`, async () => {
  const f = fixture(); await f.voice.start();
  if (event === 'close') f.peer.channel.onclose();
  else if (event === 'error') f.peer.channel.onerror(new Error('channel failure'));
  else f.peer.channel.onmessage({ data: JSON.stringify({ type: 'error' }) });
  assert.equal(f.voice.closed, true); await f.voice.stop(); await f.voice.stop();
  cleaned(f); assert.equal(f.count('allocate'), 1); assert.equal(f.count('attach'), 1);
});

test('ordinary and malformed channel messages do not end a healthy voice call', async () => {
  const f = fixture(); await f.voice.start();
  for (const data of ['not-json', '{}', 'null', '{"type":"response.done"}']) f.peer.channel.onmessage({ data });
  assert.equal(f.voice.closed, false); assert.equal(f.count('stop'), 0); assert.equal(f.track.enabled, true);
  await f.voice.stop(); cleaned(f);
});

test('voice delivers supplied and track-only remote streams, then clears the media sink', async t => {
  const original = globalThis.MediaStream;
  class Stream { constructor(tracks) { this.tracks = tracks; } }
  globalThis.MediaStream = Stream;
  t.after(() => { if (original === undefined) delete globalThis.MediaStream; else globalThis.MediaStream = original; });
  const f = fixture(); await f.voice.start();
  const supplied = {}, incoming = {};
  f.peer.ontrack({ streams: [supplied], track: incoming }); assert.equal(f.remoteStreams.at(-1), supplied);
  f.peer.ontrack({ streams: [], track: incoming }); assert.deepEqual(f.remoteStreams.at(-1).tracks, [incoming]);
  await f.voice.stop(); cleaned(f);
});

test('late remote tracks cannot repopulate the audio sink after voice stops', async () => {
  const f = fixture(); await f.voice.start(); await f.voice.stop();
  const count = f.remoteStreams.length;
  f.peer.ontrack({ streams: [{}], track: {} });
  assert.equal(f.remoteStreams.length, count); cleaned(f);
});

test('failed peer connection releases media without a second allocation or stop', async () => {
  const f = fixture(); await f.voice.start(); f.peer.state('failed');
  assert.equal(f.voice.closed, true); await f.voice.stop(); f.peer.state('failed'); await settle();
  cleaned(f); assert.match(f.statuses.at(-1).message, /failed/); assert.equal(f.count('allocate'), 1);
});

test('a transient disconnect recovers, while a sustained disconnect stops the call', async t => {
  const clock = installClock(t);
  const f = fixture(); await f.voice.start();
  f.peer.state('disconnected'); clock.tick(9999); await settle();
  assert.equal(f.voice.closed, false); assert.equal(f.count('stop'), 0);
  f.peer.connect(); clock.tick(10001); await settle();
  assert.equal(f.voice.closed, false); assert.equal(f.track.enabled, true);
  f.peer.state('disconnected'); clock.tick(10000); await settle();
  assert.equal(f.voice.closed, true); await f.voice.stop(); cleaned(f);
  assert.match(f.statuses.at(-1).message, /disconnected/);
});

test('readiness timeout rejects startup and releases the captured microphone', async t => {
  const clock = installClock(t);
  const f = fixture({ ready: false });
  const startup = assert.rejects(f.voice.start(), /timed out/); await settle();
  assert.equal(f.count('attach'), 1); assert.equal(f.track.enabled, false);
  clock.tick(100); await startup; cleaned(f);
});

test('readiness timeout also stops startup when attach never settles', async t => {
  const clock = installClock(t);
  const attach = deferred();
  const f = fixture({ ready: false, api: operation => operation === 'attach' ? attach.promise : undefined });
  let outcome;
  const startup = f.voice.start().then(() => { outcome = { resolved: true }; }, error => { outcome = { error }; });
  await settle(); assert.equal(f.count('attach'), 1); clock.tick(100); await settle();
  try { assert.equal(f.voice.closed, true); assert.equal(f.count('stop'), 1); assert.match(outcome?.error?.message ?? '', /timed out/); }
  finally { attach.resolve({}); await startup; await f.voice.stop(); }
  cleaned(f);
});

for (const phase of ['offer', 'localDescription', 'allocate', 'remoteDescription']) test(`startup timeout cleans up when ${phase} never settles`, async t => {
  const clock = installClock(t);
  const blocked = deferred();
  let entered = 0;
  const block = () => { entered++; return blocked.promise; };
  const f = fixture({ ready: false, [phase]: phase === 'allocate' ? undefined : block,
    ...(phase === 'allocate' ? { api: operation => operation === 'allocate' ? block() : undefined } : {}) });
  let outcome;
  const startup = f.voice.start().then(() => { outcome = { resolved: true }; }, error => { outcome = { error }; });
  await settle();
  try {
    assert.equal(entered, 1); clock.tick(100); await settle();
    assert.equal(f.voice.closed, true); assert.match(outcome?.error?.message ?? '', /timed out/);
    assert.equal(f.count('stop'), 1); assert.equal(f.count('attach'), 0);
  } finally { blocked.resolve(phase === 'allocate' ? { callId: 'rtc-test', answer: 'answer' } : undefined); await f.voice.stop(); await startup; }
  cleaned(f); assert.equal(f.count('allocate'), ['offer', 'localDescription'].includes(phase) ? 0 : 1);
});

test('explicit stop interrupts each pending negotiation phase and ignores its late result', async () => {
  for (const phase of ['offer', 'localDescription', 'allocate', 'remoteDescription']) {
    const blocked = deferred();
    let entered = 0;
    const block = () => { entered++; return blocked.promise; };
    const f = fixture({ ready: false, [phase]: phase === 'allocate' ? undefined : block,
      ...(phase === 'allocate' ? { api: operation => operation === 'allocate' ? block() : undefined } : {}) });
    let outcome;
    const startup = f.voice.start().then(() => { outcome = { resolved: true }; }, error => { outcome = { error }; });
    await settle();
    try { assert.equal(entered, 1); await f.voice.stop(); await settle(); assert.match(outcome?.error?.message ?? '', /ended/); assert.equal(f.count('attach'), 0); }
    finally { blocked.resolve(phase === 'allocate' ? { callId: 'rtc-test', answer: 'answer' } : undefined); await f.voice.stop(); await startup; }
    await settle(); assert.equal(f.count('attach'), 0); cleaned(f);
    assert.equal(f.count('allocate'), ['offer', 'localDescription'].includes(phase) ? 0 : 1);
  }
});

test('late connection-state events cannot allocate a new disconnect timer after cleanup', async t => {
  const clock = installClock(t);
  const f = fixture(); await f.voice.start(); await f.voice.stop();
  const timerCount = clock.createdCount, statusCount = f.statuses.length;
  assert.ok(timerCount > 0);
  f.peer.state('disconnected'); f.peer.state('connected'); f.peer.state('failed'); await settle();
  assert.equal(clock.createdCount, timerCount); assert.equal(f.statuses.length, statusCount); cleaned(f);
});

test('a cleanup status callback can reenter stop without repeating resource cleanup', async () => {
  let f, reentered = false, nested;
  f = fixture({ onStatus: ({ state }) => { if (state === 'ended' && !reentered) { reentered = true; nested = f.voice.stop(); } } });
  await f.voice.start(); await f.voice.stop(); await nested;
  assert.equal(reentered, true); cleaned(f);
});

test('stopping during remote SDP application never sends a later attach', async () => {
  const remote = deferred();
  const f = fixture({ ready: false, remoteDescription: () => remote.promise });
  const startup = f.voice.start().catch(() => {}); await settle();
  assert.equal(f.count('allocate'), 1); await f.voice.stop(); remote.resolve(); await startup;
  assert.equal(f.count('attach'), 0); cleaned(f);
});

test('stop failure keeps local media released and reports remote-cleanup uncertainty without retry', async () => {
  const f = fixture({ api: operation => { if (operation === 'stop') throw new Error('broker unavailable'); } });
  await f.voice.start(); await f.voice.stop(); await f.voice.stop();
  cleaned(f); assert.match(f.statuses.at(-1).message, /Microphone stopped.*CLI will clean up/);
});

test('microphone permission arriving after cancellation is stopped without creating a peer', async () => {
  const capture = deferred(), track = { stops: 0, stop() { this.stops++; } }, calls = [];
  const voice = createBrowserVoiceSession({ api: async operation => { calls.push(operation); }, mediaDevices: { getUserMedia: () => capture.promise },
    PeerConnection: class { constructor() { throw new Error('A cancelled call must not create a peer'); } } });
  const startup = voice.start(); await voice.stop(); capture.resolve({ getTracks: () => [track] }); await startup;
  assert.equal(track.stops, 1); assert.equal(voice.closed, true); assert.deepEqual(calls, ['stop']);
});

test('voice sessions cannot be started twice or restarted after cleanup', async () => {
  const f = fixture(); await f.voice.start();
  await assert.rejects(f.voice.start(), /already been started/); await f.voice.stop();
  await assert.rejects(f.voice.start(), /already been started/); cleaned(f); assert.equal(f.count('allocate'), 1);
});
