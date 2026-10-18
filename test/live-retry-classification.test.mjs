import test from 'node:test';
import assert from 'node:assert/strict';
import { DotLive } from '../src/live.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';
import { streamSSE } from '../src/stream-http.mjs';

const login = async () => ({ accountId: 'account', userId: 'user', accessToken: 'synthetic-token' });
const client = transport => ({ transport, resolveRoom: async () => 'room', history: async () => ({ messages: [] }) });
const response = (status, headers = {}, body = '') => new Response(body, { status, headers });
const upgrade = () => response(200, { 'content-type': 'application/json' }, JSON.stringify({ websocket_url: 'wss://ws.chatgpt.com/test' }));

function socketFactory(instances) {
  return () => {
    class Socket extends EventTarget {
      send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify([{ id: 2, reply: { type: 'subscribe', topic_id: this.topic, recovered: false } }]) }))); }
      close() { this.closed = true; }
    }
    const socket = new Socket(); socket.topic = 'calpico-chatgpt-messaging'; instances.push(socket);
    queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket;
  };
}

// Use the real HTTP/stream classification paths. Every network boundary is
// injected; a regression retries only the synthetic response, never the API.
const terminalResponses = [
  { name: '503 challenge header', status: 503, headers: { 'cf-mitigated': 'challenge' }, code: 'EDGE_CHALLENGE' },
  { name: '429 challenge header', status: 429, headers: { 'cf-mitigated': 'challenge' }, code: 'EDGE_CHALLENGE' },
  { name: '408 challenge body', status: 408, headers: { 'content-type': 'text/html' }, body: '<script src="/cdn-cgi/challenge-platform/x"></script>', code: 'EDGE_CHALLENGE' },
  { name: '503 challenge body', status: 503, headers: { 'content-type': 'text/html' }, body: 'Enable JavaScript and cookies to continue', code: 'EDGE_CHALLENGE' },
  { name: '401 rejected login', status: 401, code: 'AUTH_REJECTED' },
  { name: '403 HTML rejection', status: 403, headers: { 'content-type': 'text/html' }, code: 'FORBIDDEN_HTML' },
  { name: '403 JSON rejection', status: 403, headers: { 'content-type': 'application/json' }, body: '{}', code: 'FORBIDDEN' }
];

for (const failure of terminalResponses) {
  test(`websocket bootstrap stops after ${failure.name}`, async () => {
    let requests = 0, sleeps = 0, sockets = 0;
    const transport = new Transport({ authLoader: login, fetchImpl: async () => {
      requests++; return response(failure.status, failure.headers, failure.body);
    } });
    const live = new DotLive(client(transport), { sleep: async () => { sleeps++; }, webSocketFactory: () => { sockets++; throw new Error('must not open'); } });
    await assert.rejects(live.watch({ roomId: 'room' }), { code: failure.code });
    assert.equal(requests, 1); assert.equal(sleeps, 0); assert.equal(sockets, 0);
  });

  test(`activity SSE stops after ${failure.name}`, async () => {
    let streams = 0, sleeps = 0, followups = 0;
    const transport = new Transport({ authLoader: login, fetchImpl: async () => { followups++; throw new Error('must not read'); } });
    const live = new DotLive(client(transport), { sleep: async () => { sleeps++; }, streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options,
      streamImpl: async function* () {
        streams++;
        yield { type: 'response', status: failure.status, headers: failure.headers ?? {} };
        yield { type: 'error-body', body: Buffer.from(failure.body ?? '').toString('base64') };
      }
    }) });
    await assert.rejects(live.activity({ dotId: 'dot' }), { code: failure.code });
    assert.equal(streams, 1); assert.equal(sleeps, 0); assert.equal(followups, 0);
  });
}

test('room-live subscription stops and closes its socket on an SSE 503 challenge', async () => {
  let requests = 0, streams = 0, sleeps = 0; const sockets = [];
  const transport = new Transport({ authLoader: login, fetchImpl: async () => { requests++; return upgrade(); } });
  const baseFactory = socketFactory(sockets);
  const live = new DotLive(client(transport), {
    webSocketFactory: () => { const socket = baseFactory(); socket.topic = 'calpico-room-live:room'; return socket; },
    // A defective policy would reset its failure count after every successful
    // socket subscription, so cap the synthetic sleep path to prevent a hang.
    sleep: async () => { sleeps++; throw new Error('unexpected reconnect'); },
    streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options, streamImpl: async function* () {
      streams++; yield { type: 'response', status: 503, headers: { 'cf-mitigated': 'challenge' } };
    } })
  });
  await assert.rejects(live.roomLive({ roomId: 'room' }), { code: 'EDGE_CHALLENGE' });
  assert.equal(requests, 1); assert.equal(streams, 1); assert.equal(sleeps, 0);
  assert.equal(sockets.length, 1); assert.equal(sockets[0].closed, true);
});

for (const status of [408, 429, 500, 503, 599]) {
  test(`websocket bootstrap still reconnects after ordinary HTTP ${status}`, async () => {
    let requests = 0; const sleeps = [], sockets = [], controller = new AbortController();
    const transport = new Transport({ authLoader: login, fetchImpl: async () => ++requests === 1 ? response(status) : upgrade() });
    await new DotLive(client(transport), { sleep: async ms => { sleeps.push(ms); }, webSocketFactory: socketFactory(sockets) }).watch({
      roomId: 'room', signal: controller.signal, onReady: () => controller.abort()
    });
    assert.equal(requests, 2); assert.deepEqual(sleeps, [1000]); assert.equal(sockets.length, 1); assert.equal(sockets[0].closed, true);
  });

  test(`activity SSE still reconnects after ordinary HTTP ${status}`, async () => {
    let streams = 0, followups = 0; const sleeps = [], controller = new AbortController();
    const transport = new Transport({ authLoader: login, fetchImpl: async () => {
      followups++; return response(200, { 'content-type': 'application/json' }, '{"data":[],"next_cursor":null}');
    } });
    const live = new DotLive(client(transport), { sleep: async ms => { sleeps.push(ms); },
      streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options, streamImpl: async function* () {
        if (++streams === 1) { yield { type: 'response', status, headers: {} }; return; }
        yield { type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } };
        yield { type: 'chunk', body: Buffer.from('event: snapshot\ndata: {"data":[]}\n\n').toString('base64') };
      } })
    });
    await live.activity({ dotId: 'dot', signal: controller.signal, onEvent: () => controller.abort() });
    assert.equal(streams, 2); assert.equal(followups, 1); assert.deepEqual(sleeps, [1000]);
  });
}

for (const code of ['EDGE_CHALLENGE', 'AUTH_REQUIRED', 'AUTH_REJECTED', 'AUTH_ACCOUNT_MISSING', 'AUTH_USER_MISSING', 'AUTH_IDENTITY_CHANGED', 'ACCOUNT_CHANGED', 'IDENTITY_MISMATCH']) {
  test(`${code} remains terminal when accompanied by transient-looking status metadata`, async () => {
    for (const status of [408, 429, 503]) {
      const failure = new DotError(code, 'synthetic failure', { status }); let attempts = 0, sleeps = 0;
      const transport = { authLoader: login, request: async () => { attempts++; throw failure; } };
      await assert.rejects(new DotLive(client(transport), { sleep: async () => { sleeps++; } }).watch({ roomId: 'room' }), error => error === failure);
      assert.equal(attempts, 1); assert.equal(sleeps, 0);
    }
  });
}

for (const failure of [new DotError('NETWORK_ERROR', 'network'), new DotError('LIVE_DISCONNECTED', 'socket'), new DotError('STREAM_TIMEOUT', 'timeout'), new DotError('TASK_SUBSCRIPTION_CHANGED', 'topic')]) {
  test(`websocket bootstrap preserves reconnect for ${failure.code ?? 'unclassified transport failure'}`, async () => {
    let attempts = 0; const sleeps = [], controller = new AbortController(), sockets = [];
    const transport = { authLoader: login, request: async () => {
      if (++attempts === 1) throw failure;
      return { websocket_url: 'wss://ws.chatgpt.com/test' };
    } };
    await new DotLive(client(transport), { sleep: async ms => { sleeps.push(ms); }, webSocketFactory: socketFactory(sockets) }).watch({
      roomId: 'room', signal: controller.signal, onReady: () => controller.abort()
    });
    assert.equal(attempts, 2); assert.deepEqual(sleeps, [1000]); assert.equal(sockets[0].closed, true);
  });
}


test('an unclassified transport failure is terminal without reconnect', async () => {
  const failure = new TypeError('custom transport failed'); let attempts = 0, sleeps = 0;
  const transport = { authLoader: login, request: async () => { attempts++; throw failure; } };
  await assert.rejects(new DotLive(client(transport), { sleep: async () => { sleeps++; } }).watch({ roomId: 'room' }), error => error === failure);
  assert.equal(attempts, 1); assert.equal(sleeps, 0);
});
