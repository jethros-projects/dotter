import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the actual browser entry point with inert browser primitives. No
// request, clipboard operation, media track, or clock here reaches the host.
const source = (await readFile(new URL('../src/remote-control-browser.mjs', import.meta.url), 'utf8'))
  .replace(/^export\s+/gm, '');
const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }
  emit(type, values = {}) {
    const event = { type, target: this, currentTarget: this, isTrusted: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    this[`on${type}`]?.(event);
    return event;
  }
}

function browser({ capability = 'a'.repeat(43), frameCallbacks = true } = {}) {
  let now = 0, timerId = 0, frameId = 0, peer, focused = true, heartbeatFailure = false;
  const timers = new Map(), requests = [], writes = [], frameQueue = new Map(), cancelledFrames = [];
  const window = new Events(), document = new Events(), replacements = [];
  const selectors = ['video', 'status', 'start', 'control', 'end', 'sound', 'send-clipboard', 'copy-clipboard', 'clipboard', 'sync-clipboard'];
  const elements = Object.fromEntries(selectors.map(id => [id, Object.assign(new Events(), { disabled: false, textContent: '', value: '', checked: false })]));
  for (const id of ['control', 'end', 'sound', 'send-clipboard', 'copy-clipboard']) elements[id].disabled = true;
  const video = elements.video;
  Object.assign(video, { videoWidth: 1280, videoHeight: 720, readyState: 2, paused: true, muted: true, srcObject: null,
    playCalls: 0, focusCalls: 0, captures: [],
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; this.emit('pause'); },
    focus() { this.focusCalls++; },
    setPointerCapture(id) { this.captures.push(id); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; },
  });
  if (frameCallbacks) {
    video.requestVideoFrameCallback = callback => { const id = ++frameId; frameQueue.set(id, callback); return id; };
    video.cancelVideoFrameCallback = id => { cancelledFrames.push(id); frameQueue.delete(id); };
  }
  document.hidden = false;
  document.hasFocus = () => focused;
  document.querySelector = selector => elements[selector.slice(1)] ?? null;
  const location = { hash: '#' + capability, pathname: '/remote', search: '' };
  const history = { replaceState(...args) { replacements.push(args); location.hash = ''; } };
  const schedule = (callback, milliseconds, interval) => {
    const id = ++timerId; timers.set(id, { callback, due: now + milliseconds, milliseconds, interval }); return id;
  };
  class Track extends Events {
    constructor(kind = 'video') { super(); this.kind = kind; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
    end() { this.readyState = 'ended'; this.emit('ended', { isTrusted: true }); }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
  }
  class Peer extends Events {
    constructor() { super(); peer = this; this.connectionState = 'new'; this.closeCalls = 0; this.transceivers = []; }
    addTransceiver(...args) { this.transceivers.push(args); }
    createDataChannel() {
      this.channel = Object.assign(new Events(), { readyState: 'connecting', sent: [], closeCalls: 0,
        send(value) { if (this.readyState !== 'open') throw Error('closed fake channel'); this.sent.push(value); },
        close() { this.closeCalls++; this.readyState = 'closed'; this.emit('close'); },
      }); return this.channel;
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\ns=offline-browser-test\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) {
      this.remoteDescription = value; this.connectionState = 'connected'; this.channel.readyState = 'open';
      this.channel.emit('open'); this.emit('connectionstatechange');
    }
    close() { this.closeCalls++; this.connectionState = 'closed'; this.emit('connectionstatechange'); }
    receive(value) { this.channel.emit('message', { data: JSON.stringify(value) }); }
    track(stream, track = stream.getTracks()[0]) { this.emit('track', { streams: stream ? [stream] : [], track }); }
  }
  window.RTCPeerConnection = Peer;
  const fetch = async (url, options) => {
    assert.match(url, /^\/api\/(connect|authorize|stop|heartbeat)$/);
    const operation = url.slice('/api/'.length);
    requests.push({ operation, options, body: JSON.parse(options.body) });
    if (operation === 'heartbeat' && heartbeatFailure) throw Error('offline heartbeat failure');
    return { ok: true, json: async () => operation === 'connect' ? { answer: 'v=0\r\ns=offline-answer\r\n' } : {} };
  };
  const context = vm.createContext({ window, document, location, history, navigator: { platform: 'MacIntel', clipboard: {
    readText: async () => 'synthetic local clipboard', writeText: async text => { writes.push(text); },
  } }, fetch, MediaStream: Stream, console,
  setTimeout: (callback, milliseconds = 0) => schedule(callback, milliseconds, false),
  clearTimeout: id => timers.delete(id),
  setInterval: (callback, milliseconds = 0) => schedule(callback, milliseconds, true),
  clearInterval: id => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: 'remote-control-browser.mjs' });
  const click = (id, isTrusted = true) => elements[id].emit('click', { isTrusted });
  return { window, document, elements, video, requests, writes, replacements, location, timers, cancelledFrames, Track, Stream,
    click, get peer() { return peer; }, setFocused(value) { focused = value; }, failHeartbeat() { heartbeatFailure = true; },
    async advance(milliseconds) {
      const target = now + milliseconds; let count = 0;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++count < 1000, 'The fake timer queue must remain bounded.');
        const [id, timer] = next; now = timer.due;
        if (timer.interval) timer.due += timer.milliseconds; else timers.delete(id);
        timer.callback(); await drain();
      }
      now = target; await drain();
    },
    frames() { const callbacks = [...frameQueue.values()]; frameQueue.clear(); for (const callback of callbacks) callback(now, {}); },
    get pendingFrames() { return frameQueue.size; },
    async start() { click('start'); await drain(); assert.ok(peer); assert.equal(peer.connectionState, 'connected'); },
    async control() { click('control'); await drain(); peer.receive({ event: 'control/locked' }); await drain(); },
    async stop() { click('end'); await drain(); },
  };
}
const jsonMessages = fixture => fixture.peer.channel.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value));
const outcomes = fixture => jsonMessages(fixture).filter(value => value.event === 'browser/client_outcome');
const binaryMessages = fixture => fixture.peer.channel.sent.filter(value => typeof value !== 'string');
const calls = (fixture, operation) => fixture.requests.filter(value => value.operation === operation);

test('browser bootstrap removes an invalid capability from the URL and never starts a heartbeat', async () => {
  const f = browser({ capability: 'invalid' });
  assert.equal(f.location.hash, ''); assert.equal(f.replacements.length, 1);
  assert.equal(f.replacements[0][2], '/remote');
  assert.equal(f.elements.start.disabled, true);
  assert.match(f.elements.status.textContent, /fresh remote-session URL/);
  await f.advance(60000); assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
});

test('browser heartbeat failure ends once, clears its timer and clears displayed clipboard data', async () => {
  const f = browser(); await f.start(); await f.control();
  f.peer.receive({ event: 'control/clipboard', text: 'synthetic remote text' });
  f.elements.clipboard.value = 'synthetic pending transfer';
  assert.equal(f.elements['copy-clipboard'].disabled, false);
  f.failHeartbeat(); await f.advance(10000);
  assert.equal(calls(f, 'heartbeat').length, 1); assert.equal(calls(f, 'stop').length, 1);
  assert.equal(f.peer.connectionState, 'closed'); assert.equal(f.elements.end.disabled, true);
  assert.equal(f.elements.control.disabled, true); assert.equal(f.elements.sound.disabled, true);
  assert.equal(f.elements['copy-clipboard'].disabled, true); assert.equal(f.elements.clipboard.value, '');
  assert.equal(f.video.srcObject, null); assert.equal(f.timers.size, 0);
  f.window.emit('pagehide'); await f.advance(30000);
  assert.equal(calls(f, 'heartbeat').length, 1); assert.equal(calls(f, 'stop').length, 1);
  const request = calls(f, 'heartbeat')[0];
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + 'a'.repeat(43));
});

test('browser controls require trusted actions and acknowledged control before sending input', async () => {
  const f = browser(); f.click('start', false); await drain(); assert.equal(f.requests.length, 0);
  await f.start(); assert.equal(f.elements.control.disabled, false);
  f.click('control', false); await drain(); assert.equal(calls(f, 'authorize').length, 0);
  f.click('control'); await drain(); assert.equal(calls(f, 'authorize').length, 1);
  assert.equal(f.elements.control.disabled, true);
  const early = f.video.emit('keydown', { isTrusted: true, key: 'a', code: 'KeyA' });
  assert.equal(early.defaultPrevented, false); assert.equal(binaryMessages(f).length, 0);
  f.peer.receive({ event: 'control/locked' });
  assert.equal(f.elements.control.textContent, 'Return control'); assert.equal(f.elements['send-clipboard'].disabled, false);
  const synthetic = f.video.emit('keydown', { key: 'a', code: 'KeyA' });
  assert.equal(synthetic.defaultPrevented, false); assert.equal(binaryMessages(f).length, 0);
  const trusted = f.video.emit('keydown', { isTrusted: true, key: 'a', code: 'KeyA' });
  assert.equal(trusted.defaultPrevented, true); assert.equal(binaryMessages(f).length, 1);
  f.click('end', false); await drain(); assert.equal(calls(f, 'stop').length, 0);
  await f.stop(); assert.equal(calls(f, 'stop').length, 1); assert.equal(f.peer.closeCalls, 1);
  assert.equal(f.elements.control.disabled, true); assert.equal(f.elements['send-clipboard'].disabled, true);
});

test('clipboard transfer and copying require trusted clicks and synchronization stays opt-in', async () => {
  const f = browser(); await f.start(); await f.control();
  f.elements.clipboard.value = 'synthetic transfer';
  f.click('send-clipboard', false); assert.equal(jsonMessages(f).filter(value => value.event === 'control/clipboard').length, 0);
  f.click('send-clipboard'); assert.equal(jsonMessages(f).find(value => value.event === 'control/clipboard').text, 'synthetic transfer');
  f.peer.receive({ event: 'control/clipboard', text: 'synthetic remote copy' }); await drain(); assert.deepEqual(f.writes, []);
  f.click('copy-clipboard', false); await drain(); assert.deepEqual(f.writes, []);
  f.click('copy-clipboard'); await drain(); assert.deepEqual(f.writes, ['synthetic remote copy']);
  f.elements['sync-clipboard'].checked = true; f.elements['sync-clipboard'].emit('change');
  assert.equal(f.elements['sync-clipboard'].checked, false);
  f.elements['sync-clipboard'].checked = true; f.elements['sync-clipboard'].emit('change', { isTrusted: true });
  f.peer.receive({ event: 'control/clipboard', text: 'synthetic synced copy' }); await drain();
  assert.deepEqual(f.writes, ['synthetic remote copy', 'synthetic synced copy']);
  f.setFocused(false); f.peer.receive({ event: 'control/clipboard', text: 'must not sync while unfocused' }); await drain();
  assert.equal(f.writes.length, 2); await f.stop();
});

test('blur and document hiding release held input and disable clipboard transfer', async () => {
  const f = browser(); await f.start(); await f.control();
  f.video.emit('keydown', { isTrusted: true, key: 'Shift', code: 'ShiftLeft' });
  f.window.emit('blur');
  assert.equal(f.elements.control.textContent, 'Take control'); assert.equal(f.elements['send-clipboard'].disabled, true);
  assert.equal(new DataView(binaryMessages(f).at(-1)).getUint8(0), 4);
  await f.control();
  f.video.emit('pointerdown', { isTrusted: true, pointerId: 7, button: 0, clientX: 100, clientY: 100 });
  assert.deepEqual(f.video.captures, [7]);
  f.document.hidden = true; f.document.emit('visibilitychange');
  assert.equal(f.elements.control.textContent, 'Take control');
  assert.equal(new DataView(binaryMessages(f).at(-1)).getUint8(0), 4);
  const before = binaryMessages(f).length;
  f.video.emit('keydown', { isTrusted: true, key: 'a', code: 'KeyA' }); assert.equal(binaryMessages(f).length, before);
  await f.stop();
});

test('remote track playback reports success only after playing and a presented frame', async () => {
  const f = browser(); await f.start();
  const track = new f.Track(), stream = new f.Stream([track]); f.peer.track(stream);
  assert.equal(f.video.srcObject, stream); assert.equal(f.video.playCalls, 1); assert.equal(outcomes(f).length, 0);
  f.video.emit('playing'); assert.equal(outcomes(f).length, 0); assert.equal(f.pendingFrames, 1);
  f.frames(); assert.equal(outcomes(f).length, 1); assert.equal(outcomes(f)[0].outcome, 'success');
  f.video.emit('playing'); f.frames(); assert.equal(outcomes(f).length, 1);
  track.end(); await drain();
  assert.equal(f.video.srcObject, null); assert.equal(f.elements.control.disabled, true);
  assert.equal(outcomes(f).at(-1).reason, 'video_error');
  f.peer.receive({ event: 'browser/client_outcome/ack' }); await drain();
  assert.equal(calls(f, 'stop').length, 1); assert.equal(f.peer.connectionState, 'closed'); assert.equal(f.timers.size, 0);
});

test('pausing playback clears presentation readiness until video resumes', async () => {
  const f = browser(); await f.start(); f.peer.track(new f.Stream([new f.Track()]));
  f.video.emit('playing'); f.video.pause(); f.frames();
  assert.equal(outcomes(f).length, 0);
  f.video.paused = false; f.video.emit('playing'); assert.equal(outcomes(f).length, 0);
  f.frames(); assert.equal(outcomes(f).length, 1); await f.stop();
});

test('replacing a remote stream cancels its pending frame and ending clears playback', async () => {
  const f = browser(); await f.start();
  f.peer.track(new f.Stream([new f.Track()])); f.video.emit('playing'); assert.equal(f.pendingFrames, 1);
  const replacement = new f.Stream([new f.Track()]); f.peer.track(replacement);
  assert.equal(f.video.srcObject, replacement); assert.equal(f.cancelledFrames.length, 1); assert.equal(f.pendingFrames, 0);
  f.frames(); assert.equal(outcomes(f).length, 0);
  f.video.emit('playing'); assert.equal(f.pendingFrames, 1);
  await f.stop(); assert.equal(f.video.srcObject, null); assert.equal(f.pendingFrames, 0);
  f.frames(); assert.equal(outcomes(f).length, 0); assert.equal(calls(f, 'stop').length, 1);
});

test('playback fallback waits for a visible renderable video when frame callbacks are unavailable', async () => {
  const f = browser({ frameCallbacks: false }); await f.start(); f.peer.track(new f.Stream([new f.Track()]));
  f.document.hidden = true; f.video.emit('playing'); assert.equal(outcomes(f).length, 0);
  f.document.hidden = false; f.video.videoWidth = 0; f.video.emit('playing'); assert.equal(outcomes(f).length, 0);
  f.video.videoWidth = 1280; f.video.emit('playing'); assert.equal(outcomes(f).length, 1); await f.stop();
});
