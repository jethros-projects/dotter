import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/remote-control-browser.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let now = 0, nextId = 0, peer;
  const timers = new Map(), messages = [], calls = [], states = [], streams = [], clipboard = [];
  const setTimeout = (fn, delay = 0) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const sandbox = { setTimeout, clearTimeout, ArrayBuffer, DataView };
  runInNewContext(source + '\nglobalThis.createRemote = createBrowserRemoteSession;', sandbox, { filename: new URL('../src/remote-control-browser.mjs', import.meta.url).pathname });
  class Peer {
    constructor() { peer = this; this.connectionState = 'new'; this.closeCount = 0; }
    addTransceiver(kind, config) { calls.push(['transceiver', kind, config.direction]); }
    createDataChannel() {
      const channel = { readyState: 'connecting', closeCount: 0,
        send(value) {
          if (options.sendFailure?.(value)) throw new Error('simulated send failure');
          messages.push(value);
          if (options.autoAck !== false && typeof value === 'string' && JSON.parse(value).event === 'browser/client_outcome') {
            Promise.resolve().then(() => channel.onmessage?.({ data: JSON.stringify({ event: 'browser/client_outcome/ack' }) }));
          }
        },
        close() { this.closeCount++; this.readyState = 'closed'; this.onclose?.(); },
      };
      return this.channel = channel;
    }
    createOffer() { calls.push(['offer']); return options.offer?.() ?? Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    async setLocalDescription(value) { calls.push(['local-description']); this.localDescription = value; }
    async setRemoteDescription() { calls.push(['remote-description']); this.connectionState = 'connected'; this.channel.readyState = 'open'; this.channel.onopen(); this.onconnectionstatechange(); }
    close() { this.closeCount++; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  const api = async (operation, body) => { calls.push([operation, body]); if (operation === 'connect') return options.connect?.() ?? { answer: 'answer' }; if (operation === 'authorize') return options.authorize?.() ?? {}; if (operation === 'stop' && options.stopError) throw new Error('simulated broker stop failure'); return {}; };
  const remote = sandbox.createRemote({ api, PeerConnection: Peer, readyTimeoutMs: 30, controlTimeoutMs: 20, outcomeTimeoutMs: 10, clipboardTimeoutMs: 5,
    createStream: tracks => ({ tracks }), onStatus: value => states.push(value), onRemoteStream: value => streams.push(value), onClipboard: value => clipboard.push(value),
    ...options.session });
  return { remote, messages, calls, states, streams, clipboard, timers, get peer() { return peer; },
    receive(value) { peer.channel.onmessage({ data: JSON.stringify(value) }); },
    connection(state) { peer.connectionState = state; peer.onconnectionstatechange(); },
    track(track = {}) { peer.ontrack({ track, streams: [] }); return track; },
    async control() { assert.equal(await remote.requestControl(), true); this.receive({ event: 'control/locked' }); assert.equal(remote.mode, 'controlling'); },
    async tick(ms) { const end = now + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush(); } now = end; await flush(); },
  };
}
const key = type => ({ isTrusted: true, type, key: 'a', code: 'KeyA' });
const paste = type => ({ isTrusted: true, type, key: 'v', code: 'KeyV', ctrlKey: true });
const binary = f => f.messages.filter(v => v instanceof ArrayBuffer);
const events = f => f.messages.filter(v => typeof v === 'string').map(JSON.parse);
const stopCount = f => f.calls.filter(c => c[0] === 'stop').length;

test('channel closure tears down once, clears UI data and prevents further input', async () => {
  const f = fixture(); await f.remote.start(); await f.control(); f.remote.sendKey(key('keydown'));
  f.peer.channel.readyState = 'closed'; f.peer.channel.onclose(); await flush();
  f.peer.channel.onclose(); f.connection('failed'); await f.remote.stop();
  assert.equal(f.remote.closed, true); assert.equal(f.remote.sendKey(key('keyup')), false);
  assert.equal(stopCount(f), 1); assert.equal(f.peer.closeCount, 1); assert.equal(f.peer.channel.closeCount, 1);
  assert.equal(f.streams.at(-1), null); assert.equal(f.clipboard.at(-1), ''); assert.equal(f.states.at(-1).state, 'ended'); assert.equal(f.timers.size, 0);
});

test('channel errors and track endings report one error then close every local resource', async () => {
  for (const trigger of ['channel', 'track']) {
    const f = fixture({ stopError: true }); await f.remote.start();
    if (trigger === 'channel') f.peer.channel.onerror(); else f.track().onended();
    await flush(); await f.remote.stop();
    assert.equal(f.remote.closed, true); assert.equal(stopCount(f), 1); assert.equal(f.peer.closeCount, 1); assert.equal(f.peer.channel.closeCount, 1);
    assert.equal(events(f).filter(e => e.outcome === 'error').length, 1); assert.equal(f.timers.size, 0);
  }
});

test('temporary disconnect releases held input and reconnect requires a fresh control grant', async () => {
  const f = fixture(); await f.remote.start(); await f.control(); f.remote.sendKey(key('keydown'));
  f.connection('disconnected');
  assert.equal(f.remote.sendKey(key('keyup')), false); assert.equal(await f.remote.requestControl(), false); assert.equal(f.remote.mode, 'observing');
  assert.equal(new DataView(binary(f).at(-1)).getUint8(0), 4);
  await f.tick(9999); assert.equal(f.remote.closed, false);
  f.connection('connected'); await f.tick(10001); assert.equal(stopCount(f), 0); assert.equal(f.remote.mode, 'observing');
  await f.control(); assert.equal(f.remote.sendKey(key('keydown')), true); await f.remote.stop();
});

test('sustained disconnect closes once and late state changes schedule no new timers', async () => {
  const f = fixture(); await f.remote.start(); f.connection('disconnected'); f.connection('disconnected');
  await f.tick(9999); assert.equal(f.remote.closed, false); await f.tick(1); await flush();
  assert.equal(f.remote.closed, true); assert.equal(stopCount(f), 1); assert.equal(f.timers.size, 0);
  f.connection('disconnected'); f.connection('connected'); assert.equal(f.timers.size, 0); assert.equal(f.states.at(-1).state, 'ended');
});

test('disconnect events after an ordinary stop cannot create a new grace timer', async () => {
  const f = fixture(); await f.remote.start(); await f.remote.stop();
  f.connection('disconnected'); assert.equal(f.timers.size, 0);
  await f.tick(20000); assert.equal(stopCount(f), 1); assert.equal(f.states.at(-1).state, 'ended');
});

test('readiness deadline closes a hung offer and ignores its late completion', async () => {
  const offer = deferred(), f = fixture({ offer: () => offer.promise });
  let error; const started = f.remote.start().catch(e => { error = e; }); await flush();
  await f.tick(30); await flush(); assert.equal(f.remote.closed, true); assert.match(error?.message ?? '', /timed out/); assert.equal(stopCount(f), 1);
  offer.resolve({ type: 'offer', sdp: 'late' }); await started; await flush();
  assert.equal(f.calls.filter(c => c[0] === 'connect').length, 0); assert.equal(f.calls.filter(c => c[0] === 'local-description').length, 0);
});

test('readiness deadline closes a hung connect and ignores its late answer', async () => {
  const connect = deferred(), f = fixture({ connect: () => connect.promise });
  let error; const started = f.remote.start().catch(e => { error = e; }); await flush();
  assert.equal(f.calls.filter(c => c[0] === 'connect').length, 1); await f.tick(30);
  assert.equal(f.remote.closed, true); assert.match(error?.message ?? '', /timed out/);
  connect.resolve({ answer: 'late' }); await started; await flush();
  assert.equal(f.calls.filter(c => c[0] === 'remote-description').length, 0); assert.equal(stopCount(f), 1); assert.equal(f.timers.size, 0);
});

test('channel closure interrupts pending negotiation without a late connect request', async () => {
  const offer = deferred(), f = fixture({ offer: () => offer.promise });
  let rejected = false; const started = f.remote.start().catch(() => { rejected = true; }); await flush();
  f.peer.channel.readyState = 'closed'; f.peer.channel.onclose(); await flush();
  assert.equal(rejected, true); assert.equal(f.remote.closed, true);
  offer.resolve({ type: 'offer', sdp: 'late' }); await started; await flush();
  assert.equal(f.calls.filter(c => c[0] === 'connect').length, 0); assert.equal(stopCount(f), 1);
});

test('new track delivery resets playback evidence before success can be reported', async () => {
  const f = fixture(); await f.remote.start(); f.remote.videoPlaying(); const track = f.track();
  assert.equal(f.streams[0].tracks[0], track); f.remote.videoFrame();
  assert.equal(events(f).filter(e => e.outcome === 'success').length, 0); f.remote.videoPlaying();
  assert.equal(events(f).filter(e => e.outcome === 'success').length, 1); f.remote.videoPaused(); f.remote.videoPlaying(); f.remote.videoFrame();
  assert.equal(events(f).filter(e => e.outcome === 'success').length, 1); await f.remote.stop();
});

test('synchronous clipboard denial is contained and leaves active control usable', async () => {
  const f = fixture({ session: { writeClipboard() { throw new Error('denied'); } } }); await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  assert.doesNotThrow(() => f.receive({ event: 'control/clipboard', text: 'test text' })); await flush();
  assert.match(f.states.at(-1).message, /did not allow clipboard synchronization/); assert.equal(f.remote.mode, 'controlling'); await f.remote.stop();
});

test('late clipboard write rejection cannot reactivate an ended UI', async () => {
  const write = deferred(), f = fixture({ session: { writeClipboard: () => write.promise } }); await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  f.receive({ event: 'control/clipboard', text: 'test text' }); await f.remote.stop(); const count = f.states.length;
  write.reject(new Error('late denial')); await flush(); assert.equal(f.states.length, count); assert.equal(f.states.at(-1).state, 'ended');
});

test('late clipboard read rejection cannot report or paste into a later control grant', async () => {
  const read = deferred(), f = fixture({ session: { readClipboard: () => read.promise } }); await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  f.remote.sendKey(paste('keydown')); await flush(); f.remote.releaseControl(); await f.control(); const before = f.states.length, sent = f.messages.length;
  read.reject(new Error('late denial')); await flush(); assert.equal(f.states.length, before); assert.equal(f.messages.length, sent); await f.remote.stop();
});

test('a hung clipboard read cannot block keys after control is released and reacquired', async () => {
  const f = fixture({ session: { readClipboard: () => new Promise(() => {}) } });
  await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  f.remote.sendKey(paste('keydown')); await flush(); f.remote.releaseControl(); await f.control();
  const before = binary(f).length; f.remote.sendKey(key('keydown')); await flush();
  assert.equal(binary(f).length, before + 1); assert.equal(new DataView(binary(f).at(-1)).getBigUint64(3, true), 97n);
  await f.remote.stop();
});

test('queued key transmission failure closes the session instead of silently keeping control', async () => {
  let fail = true; const f = fixture({ sendFailure: value => value instanceof ArrayBuffer && fail && (fail = false, true) });
  await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  f.remote.sendKey(key('keydown')); f.remote.sendKey(key('keyup')); await flush();
  assert.equal(f.remote.closed, true); assert.equal(f.remote.mode, 'observing'); assert.equal(stopCount(f), 1); assert.equal(binary(f).length, 0); assert.equal(f.states.at(-1).state, 'ended');
});

test('direct key transmission failure returns false and tears down once', async () => {
  const f = fixture({ sendFailure: value => value instanceof ArrayBuffer }); await f.remote.start(); await f.control();
  assert.equal(f.remote.sendKey(key('keydown')), false); await flush();
  assert.equal(f.remote.closed, true); assert.equal(stopCount(f), 1); assert.equal(f.remote.sendKey(key('keyup')), false);
});

test('stop is reentrancy-safe before invoking any teardown observer', async () => {
  for (const callback of ['onStatus', 'onRemoteStream', 'onClipboard']) {
    let f, armed = false, reentered;
    const observe = () => { if (armed) { armed = false; reentered = f.remote.stop(); } };
    f = fixture({ session: { [callback]: observe } }); await f.remote.start(); await f.control(); armed = true;
    await f.remote.stop(); await reentered;
    assert.equal(stopCount(f), 1); assert.equal(f.peer.closeCount, 1); assert.equal(f.peer.channel.closeCount, 1); assert.equal(f.remote.closed, true);
  }
});

test('pointer send failures return false and terminate control without escaping', async () => {
  const f = fixture({ sendFailure: value => value instanceof ArrayBuffer }); await f.remote.start(); await f.control();
  const video = { videoWidth: 800, videoHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  assert.equal(f.remote.sendPointer({ isTrusted: true, type: 'pointerdown', button: 0, clientX: 20, clientY: 20 }, video), false);
  await flush(); assert.equal(f.remote.closed, true); assert.equal(stopCount(f), 1); assert.equal(f.remote.mode, 'observing');
});

test('clipboard transfer send failures return false and terminate control', async () => {
  const f = fixture({ sendFailure: value => typeof value === 'string' && JSON.parse(value).event === 'control/clipboard' });
  await f.remote.start(); await f.control();
  assert.equal(f.remote.sendClipboard('synthetic transfer', { isTrusted: true }), false);
  await flush(); assert.equal(f.remote.closed, true); assert.equal(stopCount(f), 1);
});

test('authorization completed after a disconnect cannot send a control request', async () => {
  const authorization = deferred(), f = fixture({ authorize: () => authorization.promise }); await f.remote.start();
  const requested = f.remote.requestControl(); await flush(); f.connection('disconnected'); authorization.resolve({});
  assert.equal(await requested, false); assert.equal(events(f).filter(e => e.event === 'control/request').length, 0);
  assert.equal(f.remote.mode, 'observing'); await f.remote.stop();
});

test('superseded authorization cannot satisfy or cancel a newer control request', async () => {
  for (const rejectOld of [false, true]) {
    const old = deferred(), current = deferred(); let count = 0;
    const f = fixture({ authorize: () => ++count === 1 ? old.promise : current.promise }); await f.remote.start();
    const first = f.remote.requestControl(); await flush(); f.connection('disconnected'); f.connection('connected');
    const second = f.remote.requestControl(); await flush();
    if (rejectOld) old.reject(new Error('old denial')); else old.resolve({});
    assert.equal(await first, false); assert.equal(f.remote.closed, false); assert.equal(f.remote.mode, 'requesting');
    assert.equal(events(f).filter(e => e.event === 'control/request').length, 0);
    current.resolve({}); assert.equal(await second, true); assert.equal(events(f).filter(e => e.event === 'control/request').length, 1); await f.remote.stop();
  }
});

test('automatic clipboard transmission failure does not paste stale remote text', async () => {
  const f = fixture({ sendFailure: value => typeof value === 'string' && JSON.parse(value).event === 'control/clipboard', session: { readClipboard: async () => 'synthetic new clipboard' } });
  await f.remote.start(); await f.control(); f.remote.setClipboardSync(true, { isTrusted: true });
  f.remote.sendKey(paste('keydown')); f.remote.sendKey(paste('keyup')); await flush();
  assert.equal(f.remote.closed, true); assert.equal(binary(f).length, 0); assert.equal(stopCount(f), 1);
  assert.equal(f.states.some(s => /did not allow clipboard reading/.test(s.message)), false);
});
