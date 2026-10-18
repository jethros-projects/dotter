import test from 'node:test';
import assert from 'node:assert/strict';
import { DotLive } from '../src/live.mjs';
import { DotAccount } from '../src/account.mjs';
import { DotError } from '../src/errors.mjs';
import { streamSSE, internalStreamCallback } from '../src/stream-http.mjs';

const auth = { accountId: 'offline-account', userId: 'offline-user', accessToken: 'offline-token' };
const retryStop = () => new DotError('OFFLINE_RETRY_STOP', 'Synthetic retry boundary reached.');
const failures = [
  ['TypeError', () => new TypeError('private consumer detail')],
  ['DotError NETWORK_ERROR', () => new DotError('NETWORK_ERROR', 'private consumer detail')]
];
const reply = topic => ({ id: 2, reply: { type: 'subscribe', topic_id: topic, recovered: false } });
const frame = (topic, payload) => ({ type: 'message', topic_id: topic, payload, offset: 'offline-offset' });
const task = () => ({ type: 'task-upsert', payload: { tbo_id: 'dot', task: {
  id: 'task', title: 'Offline fixture', description: null, status: 'running', latest_update: null,
  emoji: null, created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z'
}, update: null } });
const state = () => ({ type: 'calpico-room-live-state', version: 1, room_id: 'room',
  subscription_id: 'offline-subscription', revision: 1, threads: [] });

function fixture({ socketScript, streamItems, request, history, sleep } = {}) {
  const sockets = [], requests = [], calls = { sleeps: 0, streams: 0, history: 0, callbacks: 0, yielded: 0 };
  const controller = new AbortController();
  class Socket extends EventTarget {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const topic = JSON.parse(raw)[1].command.topic_id;
      queueMicrotask(() => {
        if (socketScript) socketScript(this, topic, sockets.length);
        else this.message([reply(topic)]);
      });
    }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    close() { this.closed = true; }
  }
  const client = {
    transport: {
      authLoader: async () => ({ ...auth }),
      request: async (method, route, options) => {
        requests.push({ method, route, options });
        if (request) return request(method, route, options);
        if (route === '/backend-api/celsius/ws/user') return { websocket_url: 'wss://ws.chatgpt.com/offline' };
        if (route === '/backend-api/tbo/dot/activity') return { data: [], next_cursor: null };
        throw new DotError('OFFLINE_ROUTE', 'Unexpected offline route.');
      }
    },
    resolveRoom: async () => 'room',
    history: async options => { calls.history++; return history ? history(options, calls.history) : { messages: [], newestItemId: null }; }
  };
  const streamRequest = async (transport, method, route, options) => {
    calls.streams++;
    return streamSSE(transport, method, route, { ...options, streamImpl: async function* (url, args) {
      for (const item of streamItems?.(args, calls.streams) ?? []) { calls.yielded++; yield item; }
      // A subscription waits for its owner to close it. No network or timers.
      if (route.endsWith('/live') && !args.signal.aborted) await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    } });
  };
  const live = new DotLive(client, {
    webSocketFactory: () => new Socket(), streamRequest,
    setTimer: () => ({}), clearTimer() {},
    sleep: async (...args) => { calls.sleeps++; if (sleep) return sleep(...args); throw retryStop(); }
  });
  return { live, client, sockets, requests, calls, controller };
}
const sseResponse = () => ({ type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } });
const sseEvent = (name, value) => ({ type: 'chunk', body: Buffer.from(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).toString('base64') });
const terminal = error => error?.code === 'LIVE_CALLBACK_ERROR' && !error.message.includes('private consumer detail');

for (const [errorName, makeError] of failures) {
  for (const phase of ['ready', 'resync', 'message', 'typing']) {
    test(`watch ${phase} consumer ${errorName} stops the actual socket without reconnect`, { timeout: 2000 }, async () => {
      const f = fixture({
        socketScript: (socket, topic) => socket.message([reply(topic), frame(topic, {
          type: 'calpico-is-responding-heartbeat', payload: { room_id: 'room', source: { role: 'user', account_user_id: 'person' } }
        })]),
        history: async () => ({ messages: [{ id: 'message', text: 'visible offline fixture' }], newestItemId: 'message' })
      });
      await assert.rejects(f.live.watch({ roomId: 'room', signal: f.controller.signal,
        onReady: () => { if (phase === 'ready') { f.calls.callbacks++; throw makeError(); } },
        onEvent: value => {
          if (value.type === phase) { f.calls.callbacks++; throw makeError(); }
        }
      }), terminal);
      assert.equal(f.calls.callbacks, 1); assert.equal(f.sockets.length, 1); assert.equal(f.calls.sleeps, 0);
      assert.equal(f.sockets[0].closed, true);
    });
  }
  for (const phase of ['ready', 'task-resync', 'task-upsert']) {
    test(`taskEvents ${phase} consumer ${errorName} stops the actual socket without reconnect`, { timeout: 2000 }, async () => {
      const f = fixture({ socketScript: (socket, topic) => socket.message([reply(topic), frame(topic, task())]) });
      await assert.rejects(f.live.taskEvents({ dotId: 'dot', signal: f.controller.signal,
        onReady: () => { if (phase === 'ready') { f.calls.callbacks++; throw makeError(); } },
        onEvent: value => { if (value.type === phase) { f.calls.callbacks++; throw makeError(); } }
      }), terminal);
      assert.equal(f.calls.callbacks, 1); assert.equal(f.sockets.length, 1); assert.equal(f.calls.sleeps, 0);
      assert.equal(f.sockets[0].closed, true);
    });
  }
  for (const phase of ['connected', 'snapshot-ready', 'snapshot-event', 'upsert-event', 'remove-event']) {
    test(`activity ${phase} consumer ${errorName} stops real SSE without another stream`, { timeout: 2000 }, async () => {
      const f = fixture({ streamItems: () => [sseResponse(), sseEvent('snapshot', { data: [] }),
        sseEvent('upsert', { thread_id: 'thread', title: 'Offline thread' }), sseEvent('remove', { thread_id: 'thread' })] });
      await assert.rejects(f.live.activity({ dotId: 'dot', signal: f.controller.signal,
        onReady: value => {
          if (phase === 'connected' && value.phase === 'connected' || phase === 'snapshot-ready' && value.phase === 'snapshot') {
            f.calls.callbacks++; throw makeError();
          }
        },
        onEvent: value => {
          if (phase === 'snapshot-event' && value.type === 'activity-snapshot' || phase === 'upsert-event' && value.type === 'activity-upsert'
              || phase === 'remove-event' && value.type === 'activity-remove') { f.calls.callbacks++; throw makeError(); }
        }
      }), terminal);
      assert.equal(f.calls.callbacks, 1); assert.equal(f.calls.streams, 1); assert.equal(f.calls.sleeps, 0);
    });
  }
  for (const phase of ['subscribed', 'state-ready', 'state-event']) {
    test(`roomLive ${phase} consumer ${errorName} closes SSE and socket without reconnect`, { timeout: 2000 }, async () => {
      const f = fixture({
        socketScript: (socket, topic) => socket.message([reply(topic), frame(topic, { type: 'calpico-room-live', payload: state() })]),
        streamItems: () => [sseResponse(), sseEvent('message', { type: 'calpico-room-live-ready', version: 1,
          room_id: 'room', subscription_id: 'offline-subscription' })]
      });
      await assert.rejects(f.live.roomLive({ roomId: 'room', signal: f.controller.signal,
        onReady: value => {
          if (phase === 'subscribed' && value.phase === 'subscribed' || phase === 'state-ready' && value.phase === 'state') {
            f.calls.callbacks++; throw makeError();
          }
        },
        onEvent: () => { if (phase === 'state-event') { f.calls.callbacks++; throw makeError(); } }
      }), terminal);
      assert.equal(f.calls.callbacks, 1); assert.equal(f.calls.streams, 1); assert.equal(f.sockets.length, 1);
      assert.equal(f.calls.sleeps, 0); assert.equal(f.sockets[0].closed, true);
    });
  }
  for (const phase of ['onReady', 'onEvent']) {
    test(`direct streamSSE ${phase} consumer ${errorName} is terminal and closes its iterator`, async () => {
      let closed = false, yielded = 0;
      const options = { streamImpl: async function* () {
        try { yielded++; yield sseResponse(); yielded++; yield sseEvent('message', { value: 'offline' }); yielded++; yield sseEvent('message', { value: 'must not emit' }); }
        finally { closed = true; }
      }, [phase]: () => { throw makeError(); } };
      await assert.rejects(streamSSE({ authLoader: async () => auth }, 'GET', '/backend-api/offline', options), error =>
        error.code === 'STREAM_CALLBACK_ERROR' && !error.message.includes('private consumer detail'));
      assert.equal(closed, true); assert.equal(yielded, phase === 'onReady' ? 1 : 2);
    });
  }
  for (const phase of ['onReady', 'onEvent']) {
    test(`marked internal streamSSE ${phase} classifies ${errorName} without hiding typed errors`, async () => {
      const expected = makeError(); let closed = false;
      await assert.rejects(streamSSE({ authLoader: async () => auth }, 'GET', '/backend-api/offline', {
        streamImpl: async function* () { try { yield sseResponse(); yield sseEvent('message', {}); } finally { closed = true; } },
        [phase]: internalStreamCallback(() => { throw expected; })
      }), error => expected instanceof DotError ? error === expected : error.code === 'STREAM_CALLBACK_ERROR');
      assert.equal(closed, true);
    });
  }
}

test('watch retries a genuine internal history NETWORK_ERROR and stops when the caller aborts the second socket', { timeout: 2000 }, async () => {
  const f = fixture({ history: async () => { throw new DotError('NETWORK_ERROR', 'Offline history transport failure.'); }, sleep: async () => {} });
  await f.live.watch({ roomId: 'room', signal: f.controller.signal,
    onReady: () => { if (f.sockets.length === 2) f.controller.abort(); }
  });
  assert.equal(f.calls.history, 1); assert.equal(f.sockets.length, 2); assert.equal(f.calls.sleeps, 1);
  assert.ok(f.sockets.every(socket => socket.closed));
});

test('activity treats an unknown custom stream transport TypeError as terminal', { timeout: 2000 }, async () => {
  const f = fixture({ sleep: async () => {} }); let streams = 0;
  const expected = new TypeError('offline custom transport failure');
  f.live.streamRequest = async () => { streams++; throw expected; };
  await assert.rejects(f.live.activity({ dotId: 'dot', signal: f.controller.signal }), error => error === expected);
  assert.equal(streams, 1); assert.equal(f.calls.sleeps, 0);
});

test('activity retries an internal read failure propagated through actual SSE and succeeds at the next snapshot', { timeout: 2000 }, async () => {
  let reads = 0;
  const f = fixture({
    streamItems: () => [sseResponse(), sseEvent('snapshot', { data: [] })], sleep: async () => {},
    request: async (method, route) => {
      assert.equal(route, '/backend-api/tbo/dot/activity');
      if (++reads === 1) throw new DotError('NETWORK_ERROR', 'Offline activity read failed.');
      return { data: [], next_cursor: null };
    }
  });
  await f.live.activity({ dotId: 'dot', signal: f.controller.signal, onEvent: value => {
    if (value.type === 'activity-snapshot') f.controller.abort();
  } });
  assert.equal(reads, 2); assert.equal(f.calls.streams, 2); assert.equal(f.calls.sleeps, 1);
});

function accountFixture(items) {
  const counters = { streams: 0, reads: 0, yielded: 0, closed: 0 };
  const current = { sections: [], generatedAtIso: '2026-10-18T00:00:00Z', sourceChecksum: 'offline-checksum' };
  const api = new DotAccount({ transport: {
    authLoader: async () => ({ ...auth }),
    request: async (method, route) => {
      counters.reads++; assert.equal(method, 'POST'); assert.equal(route, '/backend-api/memories/about_you/summary'); return current;
    }
  } }, { streamImpl: (transport, method, route, options) => {
    counters.streams++;
    return streamSSE(transport, method, route, { ...options, streamImpl: async function* () {
      try { for (const item of items) { counters.yielded++; yield item; } }
      finally { counters.closed++; }
    } });
  } });
  return { api, counters, current };
}

for (const method of ['summaryStream', 'summaryRegenerate', 'summaryCorrect', 'summaryForget']) {
  for (const [errorName, makeError] of failures) {
    for (const phase of ['onReady', 'onEvent']) {
      test(`account ${method} asynchronous ${phase} ${errorName} terminates actual SSE after one stream`, async () => {
        const correcting = method === 'summaryCorrect' || method === 'summaryForget';
        const result = correcting ? { ok: true, updatedSections: [], deletedSectionIds: [] }
          : { sections: [], generatedAtIso: '2026-10-18T00:00:00Z', sourceChecksum: 'offline-checksum' };
        const f = accountFixture([sseResponse(), sseEvent('done', result), sseEvent('done', result)]);
        let callbackCalls = 0;
        await assert.rejects(f.api[method]({ accountId: auth.accountId, correction: 'Offline synthetic correction', confirm: auth.accountId,
          [phase]: async () => { callbackCalls++; await Promise.resolve(); throw makeError(); }
        }), error => error.code === 'STREAM_CALLBACK_ERROR' && !error.message.includes('private consumer detail'));
        assert.equal(callbackCalls, 1); assert.equal(f.counters.streams, 1); assert.equal(f.counters.closed, 1);
        assert.equal(f.counters.reads, correcting ? 1 : 0); assert.equal(f.counters.yielded, phase === 'onReady' ? 1 : 2);
      });
    }
  }
}

for (const [name, event, expected] of [
  ['malformed JSON', { type: 'chunk', body: Buffer.from('event: section\ndata: malformed\n\n').toString('base64') }, 'INVALID_RESPONSE'],
  ['invalid section', sseEvent('section', { section: null }), 'INVALID_RESPONSE'],
  ['summary error', sseEvent('error', { secret: 'offline parser detail' }), 'SUMMARY_STREAM_FAILED'],
  ['missing completion timestamp', sseEvent('done', { sections: [] }), 'INVALID_RESPONSE']
]) {
  test(`account internal ${name} keeps typed ${expected} through real SSE`, async () => {
    const f = accountFixture([sseResponse(), event]); let callbacks = 0;
    await assert.rejects(f.api.summaryStream({ accountId: auth.accountId, onEvent: () => { callbacks++; } }), error =>
      error.code === expected && !error.message.includes('offline parser detail'));
    assert.equal(callbacks, 0); assert.equal(f.counters.streams, 1); assert.equal(f.counters.closed, 1);
  });
}

for (const [errorName, makeError] of failures) {
  for (const phase of ['beforeSubscribe', 'onReady', 'onPayload', 'onResync', 'onDisconnect']) {
    test(`direct subscribe ${phase} asynchronous ${errorName} is terminal with one socket`, { timeout: 2000 }, async () => {
      const f = fixture({ socketScript: (socket, topic) => {
        socket.message([reply(topic), frame(topic, { visible: 'offline payload' })]);
        if (phase === 'onDisconnect') socket.dispatchEvent(new Event('close'));
      } });
      let callbackCalls = 0;
      await assert.rejects(f.live.subscribe({ topic: 'offline-topic', signal: f.controller.signal,
        [phase]: async () => { callbackCalls++; await Promise.resolve(); throw makeError(); }
      }), terminal);
      assert.equal(callbackCalls, 1); assert.equal(f.sockets.length, 1); assert.equal(f.calls.sleeps, 0);
      assert.equal(f.sockets[0].closed, true);
      assert.equal(f.requests.filter(request => request.route === '/backend-api/celsius/ws/user').length, 1);
    });
  }
  test(`direct subscribe resolveTopic asynchronous ${errorName} fails before opening a transport`, { timeout: 2000 }, async () => {
    const f = fixture(); let callbackCalls = 0;
    await assert.rejects(f.live.subscribe({ signal: f.controller.signal,
      resolveTopic: async () => { callbackCalls++; await Promise.resolve(); throw makeError(); }
    }), terminal);
    assert.equal(callbackCalls, 1); assert.equal(f.sockets.length, 0); assert.equal(f.calls.sleeps, 0); assert.equal(f.requests.length, 0);
  });
  for (const phase of ['beforeSubscribe', 'onReady', 'onPayload', 'onResync', 'onOffset', 'onOffsetReply']) {
    test(`direct socketSession ${phase} asynchronous ${errorName} closes its only socket`, { timeout: 2000 }, async () => {
      const f = fixture({ socketScript: (socket, topic) => {
        const subscribed = reply(topic);
        if (phase === 'onOffsetReply') subscribed.reply.last_offset = 'offline-reply-offset';
        socket.message([subscribed, frame(topic, { visible: 'offline payload' })]);
      } });
      let callbackCalls = 0;
      await assert.rejects(f.live.socketSession('wss://ws.chatgpt.com/offline', {
        topic: 'offline-topic', signal: f.controller.signal,
        beforeSubscribe() {}, onReady() {}, onPayload() {}, onResync() {}, onOffset() {},
        [phase === 'onOffsetReply' ? 'onOffset' : phase]: async () => { callbackCalls++; await Promise.resolve(); throw makeError(); }
      }), terminal);
      assert.equal(callbackCalls, 1); assert.equal(f.sockets.length, 1); assert.equal(f.calls.sleeps, 0);
      assert.equal(f.sockets[0].closed, true); assert.equal(f.requests.length, 0);
    });
  }
}
