import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Transport } from '../src/transport.mjs';
import { streamSSE, pythonStream } from '../src/stream-http.mjs';
import { DotLive } from '../src/live.mjs';

const authLoader = async () => ({ accountId: 'account', userId: 'user', accessToken: 'synthetic-token' });
const client = transport => ({ transport, resolveRoom: async () => 'room' });
const edge = status => error => error.code === 'EDGE_CHALLENGE' && error.details.status === status;

for (const status of [200, 503]) {
  test(`HTTP ${status} challenge headers terminate before reading a broken body`, async () => {
    let reads = 0, cancellations = 0;
    const body = new ReadableStream({
      pull(controller) { reads++; controller.error(new Error('broken body')); },
      cancel() { cancellations++; }
    }, { highWaterMark: 0 });
    const transport = new Transport({ authLoader, fetchImpl: async () => new Response(body, {
      status, headers: { 'cf-mitigated': 'challenge', 'content-type': 'application/json' }
    }) });
    await assert.rejects(transport.request('GET', '/backend-api/celsius/ws/user'), edge(status));
    assert.equal(reads, 0); assert.equal(cancellations, 1);
  });

  test(`SSE ${status} challenge headers close the iterator before a broken tail or readiness`, async () => {
    let resumed = 0, closed = 0, ready = 0, events = 0;
    await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/tbo/dot/activity/stream', {
      onReady: () => { ready++; }, onEvent: () => { events++; },
      streamImpl: async function* () {
        try {
          yield { type: 'response', status, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/event-stream' } };
          resumed++; throw new Error('broken body');
        } finally { closed++; }
      }
    }), edge(status));
    assert.equal(resumed, 0); assert.equal(closed, 1); assert.equal(ready, 0); assert.equal(events, 0);
  });
}

test('a failing body cancellation cannot replace the HTTP challenge classification', async () => {
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations++; throw new Error('cleanup failed'); } }, { highWaterMark: 0 });
  const transport = new Transport({ authLoader, fetchImpl: async () => new Response(body, { status: 503, headers: { 'cf-mitigated': 'challenge' } }) });
  await assert.rejects(transport.request('GET', '/backend-api/celsius/ws/user'), edge(503));
  assert.equal(cancellations, 1);
});

test('an unfinished body cancellation does not delay a definitive challenge', { timeout: 1000 }, async () => {
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const transport = new Transport({ authLoader, fetchImpl: async () => new Response(body, { status: 503, headers: { 'cf-mitigated': 'challenge' } }) });
  await assert.rejects(transport.request('GET', '/backend-api/celsius/ws/user'), edge(503));
  assert.equal(cancellations, 1);
});

test('an already broken HTTP body retains the known edge classification', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('broken before read')); } });
  const transport = new Transport({ authLoader, fetchImpl: async () => new Response(body, { status: 503, headers: { 'cf-mitigated': 'challenge' } }) });
  await assert.rejects(transport.request('GET', '/backend-api/celsius/ws/user'), edge(503));
});

test('HTTP challenge at a write retains unknown delivery metadata and performs one request', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return new Response('', { status: 503, headers: { 'cf-mitigated': 'challenge' } }); } });
  await assert.rejects(transport.request('POST', '/backend-api/tbo/dot/test', { body: {} }), error => {
    assert.equal(error.code, 'EDGE_CHALLENGE'); assert.equal(error.details.status, 503); assert.equal(error.details.delivery, 'unknown');
    assert.equal(JSON.stringify(error).includes('synthetic-token'), false); return true;
  });
  assert.equal(calls, 1);
});

test('explicit HTTP cancellation still takes precedence over challenge classification', async () => {
  const controller = new AbortController(), reason = new Error('explicit cancellation');
  const transport = new Transport({ authLoader, fetchImpl: async () => {
    controller.abort(reason); return new Response('', { status: 503, headers: { 'cf-mitigated': 'challenge' } });
  } });
  await assert.rejects(transport.request('GET', '/backend-api/celsius/ws/user', { signal: controller.signal }), error => error === reason);
});

test('websocket bootstrap never retries a challenge with a broken response body', async () => {
  let requests = 0, sleeps = 0, sockets = 0;
  const transport = new Transport({ authLoader, fetchImpl: async () => {
    requests++;
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('broken body')); } }, { highWaterMark: 0 }), {
      status: 503, headers: { 'cf-mitigated': 'challenge' }
    });
  } });
  await assert.rejects(new DotLive(client(transport), {
    sleep: async () => { sleeps++; }, webSocketFactory: () => { sockets++; throw new Error('must not open'); }
  }).watch({ roomId: 'room' }), edge(503));
  assert.equal(requests, 1); assert.equal(sleeps, 0); assert.equal(sockets, 0);
});

test('activity never reconnects a challenge stream with an unread broken tail', async () => {
  let streams = 0, sleeps = 0, resumed = 0, closed = 0;
  const transport = { authLoader };
  await assert.rejects(new DotLive(client(transport), {
    sleep: async () => { sleeps++; },
    streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options, streamImpl: async function* () {
      streams++;
      try { yield { type: 'response', status: 503, headers: { 'cf-mitigated': 'challenge' } }; resumed++; yield { type: 'error' }; }
      finally { closed++; }
    } })
  }).activity({ dotId: 'dot' }), edge(503));
  assert.equal(streams, 1); assert.equal(sleeps, 0); assert.equal(resumed, 0); assert.equal(closed, 1);
});

test('a challenge response closes the Python stream bridge without waiting for its body', async () => {
  let killed = 0;
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { killed++; child.emit('close', 0); };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'response', status: 503, headers: { 'cf-mitigated': 'challenge' } }) + '\n'));
    return child;
  };
  await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/tbo/dot/activity/stream', {
    streamImpl: (url, options) => pythonStream(url, options, { spawnImpl })
  }), edge(503));
  assert.equal(killed, 1);
});
