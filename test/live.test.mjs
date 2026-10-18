import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DotLive, normalizeActivity, normalizeRoomLive, validateWebSocketURL } from '../src/live.mjs';
import { SSEParser, streamSSE, pythonStream } from '../src/stream-http.mjs';

const visible = { id: 'm1', role: 'assistant', text: 'Visible', createdAt: null, updatedAt: null, inProgress: false, attachments: [] };
const reply = (topic = 'calpico-chatgpt-messaging', extra = {}) => ({ id: 2, reply: { type: 'subscribe', topic_id: topic, recovered: false, ...extra } });
const frame = (payload, topic = 'calpico-chatgpt-messaging', offset = 'next') => ({ type: 'message', topic_id: topic, payload, offset });
function sockets(script) {
  const sent = [], instances = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.index = instances.push(this) - 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(value) { const data = JSON.parse(value); sent.push(data); queueMicrotask(() => script(this, data)); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
    end() { this.dispatchEvent(new Event('close')); }
    close() { this.closed = true; }
  }
  return { factory: url => new Socket(url), sent, instances };
}
function client(overrides = {}) {
  return { transport: { authLoader: async () => ({ accessToken: 'secret', accountId: 'account' }), request: async () => ({ websocket_url: 'wss://ws.chatgpt.com/user?signature=secret' }) },
    resolveRoom: async room => room || 'room', primary: async () => ({ id: 'dot', roomId: 'room' }), listDots: async () => [{ roomId: 'room' }],
    history: async () => ({ messages: [visible], newestItemId: 'm1' }), ...overrides };
}

test('SSE parser handles fragmented UTF8, CRLF, comments and multi-line data', async () => {
  const found = []; const parser = new SSEParser({ onEvent: event => found.push(event) });
  const bytes = Buffer.from(': ping\r\nid: abc\r\nevent: update\r\nretry: 100\r\ndata: 🍌\r\ndata: second\r\n\r\n');
  for (let i = 0; i < bytes.length; i += 2) await parser.push(bytes.subarray(i, i + 2));
  assert.deepEqual(found, [{ event: 'update', data: '🍌\nsecond', id: 'abc', retry: 100 }]);
});
test('SSE parser drops incomplete tail and rejects an oversized event', async () => {
  const found = []; const parser = new SSEParser({ maxEventBytes: 20, onEvent: event => found.push(event) });
  await parser.push(Buffer.from('data: unfinished')); await parser.end(); assert.equal(found.length, 0);
  await assert.rejects(new SSEParser({ maxEventBytes: 20 }).push(Buffer.from(`data: ${'x'.repeat(30)}`)), error => error.code === 'STREAM_TOO_LARGE');
});
test('SSE request keeps authentication in transport arguments and classifies edge challenge', async () => {
  let called;
  await assert.rejects(streamSSE(client().transport, 'GET', '/backend-api/tbo/dot/activity/stream', { streamImpl: async function* (url, options) {
    called = { url, options }; yield { type: 'response', status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } };
    yield { type: 'error-body', body: Buffer.from('challenge').toString('base64') };
  } }), error => error.code === 'EDGE_CHALLENGE' && !error.message.includes('secret'));
  assert.equal(called.options.headers.Authorization, 'Bearer secret'); assert.equal(called.url.origin, 'https://chatgpt.com');
});
test('SSE request requires content type and valid origin before loading auth', async () => {
  await assert.rejects(streamSSE(client().transport, 'GET', '/backend-api/tbo/dot/activity/stream', { streamImpl: async function* () { yield { type: 'response', status: 200, headers: { 'content-type': 'application/json' } }; } }), error => error.code === 'INVALID_STREAM');
  await assert.rejects(streamSSE({ authLoader: () => { throw Error('must not run'); } }, 'GET', 'https://evil.test/backend-api/x'), error => error.code === 'INVALID_ROUTE');
});
test('SSE request streams complete events without exposing partial data', async () => {
  const events = []; let ready = false;
  await streamSSE(client().transport, 'GET', '/backend-api/tbo/dot/activity/stream', { onReady: () => { ready = true; }, onEvent: e => events.push(e), streamImpl: async function* () {
    yield { type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } };
    yield { type: 'chunk', body: Buffer.from('event: snapshot\ndata: {}\n\ndata: unfinished').toString('base64') };
  } });
  assert.equal(ready, true); assert.deepEqual(events, [{ event: 'snapshot', data: '{}' }]);
});
test('private Python stream passes secrets through stdin, never argv, and kills cancellation', async () => {
  const calls = [], controller = new AbortController(); let input = '', killed = false;
  const fakeSpawn = (...args) => {
    calls.push(args); const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on('data', value => { input += value; });
    child.kill = () => { killed = true; child.stdout.end(); child.emit('close', 0); };
    queueMicrotask(() => child.stdout.write('{"type":"response","status":200}\n')); return child;
  };
  const records = [];
  await assert.rejects(async () => {
    for await (const record of pythonStream('https://chatgpt.com/backend-api/x', { method: 'GET', headers: { Authorization: 'Bearer secret' }, signal: controller.signal }, { spawnImpl: fakeSpawn })) {
      records.push(record); controller.abort();
    }
  }, error => error.name === 'AbortError');
  assert.equal(killed, true); assert.equal(JSON.stringify(calls).includes('secret'), false); assert.match(input, /Bearer secret/); assert.equal(records.length, 1);
});
test('signed WebSocket URLs require first-party TLS and never appear in errors', () => {
  assert.equal(validateWebSocketURL('wss://ws.chatgpt.com/ws?token=secret'), 'wss://ws.chatgpt.com/ws?token=secret');
  for (const url of ['ws://ws.chatgpt.com/?secret', 'wss://chatgpt.com.evil.test/?secret', 'wss://u:p@chatgpt.com/?secret', 'wss://ws.chatgpt.com:888/?secret']) {
    assert.throws(() => validateWebSocketURL(url), error => error.code === 'INVALID_STREAM_URL' && !error.message.includes('secret'));
  }
});
test('live subscription matches installed app command protocol and emits safe visible history', async () => {
  const seen = []; const network = sockets(socket => { socket.message([reply()]); socket.message([frame({ type: 'calpico-message-add', payload: { room_id: 'room', message: { id: 'm1', secret: 'raw-should-not-escape' } } })]); socket.end(); });
  const live = new DotLive(client(), { webSocketFactory: network.factory });
  await live.watch({ reconnect: false, onEvent: value => seen.push(value) });
  assert.deepEqual(network.sent[0], [{ id: 1, command: { type: 'connect', presence: { type: 'presence', state: 'background' } } }, { id: 2, command: { type: 'subscribe', topic_id: 'calpico-chatgpt-messaging' } }]);
  assert.equal(seen.filter(value => value.type === 'message').length, 1); assert.equal(JSON.stringify(seen).includes('raw-should-not-escape'), false);
});
test('live presence/read events are projected and other rooms filtered', async () => {
  const seen = []; const network = sockets(socket => { socket.message([reply(),
    frame({ type: 'calpico-is-responding-heartbeat', payload: { room_id: 'room', source: { role: 'user', account_user_id: 'u' }, typing: true, hidden: 'secret' } }),
    frame({ type: 'calpico-room-read-receipt', payload: { room_id: 'room', account_user_id: 'u', last_read_at: 'now', secret: 'hidden' } }),
    frame({ type: 'calpico-room-read', payload: { room_id: 'other', last_read_at: 'now' } })]); socket.end(); });
  await new DotLive(client(), { webSocketFactory: network.factory }).watch({ reconnect: false, onEvent: event => seen.push(event) });
  assert.equal(seen.find(event => event.type === 'typing').accountUserId, 'u'); assert.equal(seen.find(event => event.type === 'read-receipt').lastReadAt, 'now');
  assert.equal(seen.some(event => event.roomId === 'other'), false); assert.equal(JSON.stringify(seen).includes('secret'), false);
});
test('live reconnect supplies last offset and replays recovered events', async () => {
  let rounds = 0; const seen = [];
  const network = sockets(socket => { if (rounds++ === 0) { socket.message([reply('calpico-chatgpt-messaging', { last_offset: 'saved' })]); socket.end(); }
    else { socket.message([reply('calpico-chatgpt-messaging', { recovered: true, last_offset: 'new', catchups: [frame({ type: 'calpico-room-read', payload: { room_id: 'room', last_read_at: 'now' } })] })]); } });
  const controller = new AbortController();
  await new DotLive(client(), { webSocketFactory: network.factory, sleep: async () => {} }).watch({ signal: controller.signal, onEvent: event => { seen.push(event); if (event.type === 'read') controller.abort(); } });
  assert.equal(network.sent[1][1].command.offset, 'saved'); assert.equal(seen.filter(event => event.type === 'resync').length, 1);
});
test('live rejects malformed JSON without logging the raw frame', async () => {
  const network = sockets(socket => socket.message('secret invalid JSON'));
  await assert.rejects(new DotLive(client(), { webSocketFactory: network.factory }).watch({ reconnect: false }), error => error.code === 'INVALID_STREAM' && !error.message.includes('secret'));
  assert.equal(network.instances[0].closed, true);
});
test('live all-room recovery deduplicates rooms and uses all-topic', async () => {
  const rooms = []; const network = sockets(socket => { socket.message([reply('calpico-chatgpt-messaging-all')]); socket.end(); });
  await new DotLive(client({ listDots: async () => [{ roomId: 'a' }, { roomId: 'a' }, { roomId: 'b' }], history: async options => { rooms.push(options.roomId); return { messages: [] }; } }), { webSocketFactory: network.factory }).watch({ all: true, reconnect: false });
  assert.deepEqual(rooms, ['a', 'b']);
});
test('activity projection omits hidden content, raw summaries and signed image URLs', () => {
  const item = { thread_id: 'thread', title: 'Task', preview: { turn_id: 'turn', text: 'Visible', image: { url: 'secret-signed' } }, summary: 'private reasoning' };
  const normalized = normalizeActivity(item); assert.equal(normalized.preview.text, 'Visible'); assert.equal(JSON.stringify(normalized).includes('secret'), false); assert.equal(JSON.stringify(normalized).includes('reasoning'), false);
  assert.equal(normalizeActivity({ ...item, is_user_visible: false }), null);
  assert.equal(normalizeActivity({ ...item, preview: { text: 'hidden', hidden: true } }).preview, null);
});
test('activity streams use GET snapshot refresh, safe upserts and removes', async () => {
  const events = []; let path, method;
  const c = client(); c.transport.request = async (m, p) => { path = p; return { data: [{ thread_id: 'task', title: 'Safe' }], next_cursor: null }; };
  const live = new DotLive(c, { streamRequest: async (_t, m, p, { onEvent }) => { method = m; assert.match(p, /activity\/stream$/); await onEvent({ event: 'snapshot', data: '{"data":[]}' }); await onEvent({ event: 'upsert', data: '{"thread_id":"task","title":"Updated"}' }); await onEvent({ event: 'remove', data: '{"thread_id":"task"}' }); } });
  await live.activity({ dotId: 'dot', reconnect: false, onEvent: event => events.push(event) });
  assert.equal(method, 'GET'); assert.equal(path, '/backend-api/tbo/dot/activity'); assert.deepEqual(events.map(event => event.type), ['activity-snapshot', 'activity-upsert', 'activity-remove']);
});
test('activity rejects updates before snapshot', async () => {
  await assert.rejects(new DotLive(client(), { streamRequest: async (_t, _m, _p, { onEvent }) => onEvent({ event: 'upsert', data: '{}' }) }).activity({ dotId: 'dot', reconnect: false }), error => error.code === 'INVALID_STREAM');
});
test('room live projection omits model summaries and supports only known metadata', () => {
  const state = normalizeRoomLive({ type: 'calpico-room-live-state', version: 1, room_id: 'room', subscription_id: 's', revision: 1,
    threads: [{ thread_id: 'thread', stream_state: 'attached', summary: ['private reasoning'], activity_status: { status_type: 'Working', status_label: 'Working' }, computer_status: 'using_computer' }] });
  assert.equal(state.threads[0].activity.label, 'Working'); assert.equal(JSON.stringify(state).includes('reasoning'), false); assert.equal('subscriptionId' in state, false);
});
test('room live pairs SSE subscription and websocket state, ignores old revisions', async () => {
  const controller = new AbortController(), states = []; let connected;
  const network = sockets(socket => { connected = socket; socket.message([reply('calpico-room-live:room')]); });
  const live = new DotLive(client(), { webSocketFactory: network.factory, streamRequest: async (_t, method, route, { signal, onEvent }) => {
    assert.equal(method, 'POST'); assert.equal(route, '/backend-api/messaging/rooms/room/live');
    await onEvent({ event: 'message', data: JSON.stringify({ type: 'calpico-room-live-ready', version: 1, room_id: 'room', subscription_id: 'sub' }) });
    const payload = { type: 'calpico-room-live-state', version: 1, room_id: 'room', subscription_id: 'sub', revision: 2, threads: [] };
    connected.message([frame({ type: 'calpico-room-live', payload }, 'calpico-room-live:room'), frame({ type: 'calpico-room-live', payload: { ...payload, revision: 1 } }, 'calpico-room-live:room')]);
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  await live.roomLive({ roomId: 'room', signal: controller.signal, onEvent: event => { states.push(event); controller.abort(); } });
  assert.equal(states.length, 1); assert.equal(states[0].revision, 2);
});

test('unrecovered live reconnect drains paginated history from the prior anchor', async () => {
  const calls = [], seen = [], controller = new AbortController(); let round = 0;
  const network = sockets(socket => { round++; socket.message([reply()]); socket.end(); });
  const c = client({ history: async options => {
    calls.push(options.after ?? null);
    if (options.after === 'm1') return { messages: [{ ...visible, id: 'm2' }], newestItemId: 'm2', nextCursor: 'page2' };
    if (options.after === 'page2') return { messages: [{ ...visible, id: 'm3' }], newestItemId: 'm3' };
    return { messages: [{ ...visible, id: round > 1 ? 'm3' : 'm1' }], newestItemId: round > 1 ? 'm3' : 'm1' };
  } });
  await new DotLive(c, { webSocketFactory: network.factory, sleep: async () => { if (round >= 2) controller.abort(); } }).watch({ signal: controller.signal, onEvent: event => { if (event.type === 'message') seen.push(event.message.id); } });
  assert.deepEqual(calls, [null, 'm1', 'page2', null]); assert.deepEqual(seen, ['m1', 'm2', 'm3']);
});
test('live message updates fetch only visible normalized history', async () => {
  const { DotClient } = await import('../src/client.mjs');
  const transport = { authLoader: async () => ({ accountId: 'account', accessToken: 'secret' }), request: async (_method, route) => {
    if (route.endsWith('/ws/user')) return { websocket_url: 'wss://ws.chatgpt.com/secret' };
    return { items: [
      { id: 'visible', account_user_id: 'u', content: { text: 'Allowed' } },
      { id: 'hidden', raw_messages: [{ author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['Private chain'] } }] },
      { id: 'hidden2', hidden: true, content: { text: 'Private' } }
    ] };
  } };
  const network = sockets(socket => { socket.message([reply()]); socket.end(); }); const events = [];
  await new DotLive(new DotClient({ transport }), { webSocketFactory: network.factory }).watch({ roomId: 'room', reconnect: false, onEvent: event => events.push(event) });
  assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.message.text), ['Allowed']);
  assert.equal(JSON.stringify(events).includes('Private'), false);
});
test('cancelling live on subscription prevents a subsequent history request', async () => {
  const controller = new AbortController(); let reads = 0;
  const network = sockets(socket => socket.message([reply()]));
  await new DotLive(client({ history: async () => { reads++; return { messages: [] }; } }), { webSocketFactory: network.factory }).watch({ signal: controller.signal, onReady: () => controller.abort() });
  assert.equal(reads, 0); assert.equal(network.instances[0].closed, true);
});

test('healthy live sessions advance contiguous anchors before a large reconnect gap', async () => {
  let current = 0, forwardReads = 0, maxGap = 0; const seen = [];
  const c = client({ history: async options => {
    if (options.around) return { messages: [{ ...visible, id: options.around }], newestItemId: options.around };
    if (!options.after) return { messages: [{ ...visible, id: `m${current}` }], newestItemId: `m${current}` };
    forwardReads++;
    const first = Number(options.after.slice(1)); maxGap = Math.max(maxGap, current - first);
    const end = Math.min(current, first + 20);
    return { messages: Array.from({ length: end - first }, (_, index) => ({ ...visible, id: `m${first + index + 1}` })),
      newestItemId: end > first ? `m${end}` : null, nextCursor: end < current ? `m${end}` : null };
  } });
  const live = new DotLive(c);
  live.subscribe = async ({ onResync, onPayload }) => {
    await onResync();
    for (current = 1; current <= 2100; current++) await onPayload({ type: 'calpico-message-add', payload: { room_id: 'room', message: { id: `m${current}` } } });
    current = 2100;
    await onResync();
  };
  await live.watch({ roomId: 'room', onEvent: event => { if (event.type === 'message') seen.push(event.message.id); } });
  assert.equal(seen.length, 2101); assert.equal(seen.at(-1), 'm2100');
  assert.equal(maxGap, 1); assert.equal(forwardReads, 2101);
});

function manualTimers() {
  const jobs = [];
  return { jobs,
    setTimer(callback, ms) { const job = { callback, ms, active: true }; jobs.push(job); return job; },
    clearTimer(job) { if (job) job.active = false; },
    fire(ms) { const job = jobs.findLast(value => value.active && value.ms === ms); assert.ok(job, `missing ${ms}ms watchdog`); job.active = false; job.callback(); }
  };
}

test('activity watchdog aborts a successful SSE connection with no snapshot after 60 seconds', async () => {
  const timers = manualTimers(); let streamSignal;
  const live = new DotLive(client(), { ...timers, streamRequest: async (_t, _m, _r, options) => {
    streamSignal = options.signal; await options.onReady({ connected: true });
    queueMicrotask(() => timers.fire(60000));
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  } });
  await assert.rejects(live.activity({ dotId: 'dot', reconnect: false }), error => error.code === 'STREAM_TIMEOUT');
  assert.equal(streamSignal.aborted, true); assert.equal(timers.jobs.some(job => job.active), false);
});

test('activity watchdog reconnects once and clears after a valid snapshot', async () => {
  const timers = manualTimers(), controller = new AbortController(); let connections = 0, snapshots = 0;
  const c = client(); c.transport.request = async () => ({ data: [], next_cursor: null });
  const live = new DotLive(c, { ...timers, sleep: async () => {}, streamRequest: async (_t, _m, _r, options) => {
    if (++connections === 1) {
      queueMicrotask(() => timers.fire(60000));
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    } else await options.onEvent({ event: 'snapshot', data: '{"data":[]}' });
  } });
  await live.activity({ dotId: 'dot', signal: controller.signal, onEvent: () => { snapshots++; controller.abort(); } });
  assert.equal(connections, 2); assert.equal(snapshots, 1); assert.equal(timers.jobs.some(job => job.active), false);
});

test('room-live watchdog requires matching state even after the SSE ready event', async () => {
  const timers = manualTimers(); let streamSignal, ready = 0;
  const network = sockets(socket => socket.message([reply('calpico-room-live:room')]));
  const live = new DotLive(client(), { ...timers, webSocketFactory: network.factory,
    streamRequest: async (_t, _m, _r, options) => {
      streamSignal = options.signal;
      await options.onEvent({ event: 'message', data: JSON.stringify({ type: 'calpico-room-live-ready', version: 1, room_id: 'room', subscription_id: 'sub' }) });
      queueMicrotask(() => timers.fire(30000));
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    } });
  await assert.rejects(live.roomLive({ roomId: 'room', reconnect: false, onReady: () => { ready++; } }), error => error.code === 'STREAM_TIMEOUT');
  assert.equal(ready, 1); assert.equal(streamSignal.aborted, true); assert.equal(network.instances[0].closed, true); assert.equal(timers.jobs.some(job => job.active), false);
});

test('account switch after websocket subscribe stops recovery before reading a new account', async () => {
  let accountId = 'original', histories = 0;
  const c = client({ history: async () => { histories++; return { messages: [] }; } });
  c.transport.authLoader = async () => ({ accountId, accessToken: 'opaque-secret' });
  const network = sockets(socket => { accountId = 'changed'; socket.message([reply()]); });
  await assert.rejects(new DotLive(c, { webSocketFactory: network.factory }).watch({ roomId: 'room', reconnect: false }), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(histories, 0); assert.equal(network.instances[0].closed, true);
});

test('stream account pin is forwarded to requests and permits token renewal in the same account', async () => {
  const selectors = []; let token = 'first';
  const c = client(); c.transport.authLoader = async () => ({ accountId: 'original', accessToken: token });
  c.transport.request = async (_method, _route, options) => { selectors.push(options.expectedAccountId); token = 'renewed'; return { data: [], next_cursor: null }; };
  const page = await new DotLive(c).listActivity({ dotId: 'dot' });
  assert.equal(page.items.length, 0); assert.deepEqual(selectors, ['original']);
});

test('SSE auth loader rejects account changes before any bytes are sent', async () => {
  let accountId = 'original', streamCalls = 0;
  const c = client(); c.transport.authLoader = async () => ({ accountId, accessToken: 'secret' });
  const live = new DotLive(c); const context = await live.pinAccount(); accountId = 'changed';
  await assert.rejects(streamSSE(context.transport, 'GET', '/backend-api/tbo/dot/activity/stream', { streamImpl: async function* () { streamCalls++; } }), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(streamCalls, 0);
});

test('activity distinguishes an HTTP connection from a validated data snapshot', async () => {
  const ready = [], requests = [];
  const c = client(); c.transport.request = async (_m, path, options) => { requests.push({ path, limit: options.query.limit }); return { data: [], next_cursor: null }; };
  const live = new DotLive(c, { streamRequest: async (_t, _m, _r, options) => {
    await options.onReady({ connected: true });
    await options.onEvent({ event: 'ping', data: 'keep alive' });
    await options.onEvent({ event: 'snapshot', data: '{"data":[]}' });
  } });
  await live.activity({ dotId: 'dot', reconnect: false, onReady: value => ready.push(value) });
  assert.deepEqual(ready.map(value => [value.phase, value.ready]), [['connected', false], ['snapshot', true]]);
  assert.equal(requests[0].limit, 5);
});

test('activity rejects a snapshot with the wrong server shape', async () => {
  let reads = 0; const c = client(); c.transport.request = async () => { reads++; return { data: [] }; };
  await assert.rejects(new DotLive(c, { streamRequest: async (_t, _m, _r, options) => options.onEvent({ event: 'snapshot', data: '{}' }) }).activity({ dotId: 'dot', reconnect: false }), error => error.code === 'INVALID_STREAM');
  assert.equal(reads, 0);
});

test('task watch resolves its native topic twice and retains ordinary room/read feed', async () => {
  const topics = [], requests = [], reads = [], seen = [], ready = [];
  const c = client({ history: async options => { reads.push(options); return { messages: [visible], newestItemId: 'm1' }; } });
  c.transport.request = async (method, route) => { requests.push(route); return route.endsWith('/subscription') ? { topic_id: 'task:room:t1', room_id: 'room', task_id: 't1' } : { websocket_url: 'wss://ws.chatgpt.com/user' }; };
  const network = sockets((socket, sent) => {
    const topic = sent[1].command.topic_id; topics.push(topic); socket.message([reply(topic)]);
    if (topic === 'calpico-chatgpt-messaging') socket.message([
      frame({ type: 'calpico-is-responding-heartbeat', payload: { room_id: 'room', source: { role: 'user', account_user_id: 'u' } } }, topic),
      frame({ type: 'calpico-message-add', payload: { room_id: 'room', message: { id: 'wrong', task_id: 'other' } } }, topic),
      frame({ type: 'calpico-room-read', payload: { room_id: 'room', last_read_at: 'now' } }, topic)]);
    else socket.message([frame({ type: 'calpico-message-update', payload: { room_id: 'room', message_id: 'm1' } }, topic)]);
    socket.end();
  });
  await new DotLive(c, { webSocketFactory: network.factory }).watch({ roomId: 'room', taskId: 't1', reconnect: false, onEvent: event => seen.push(event), onReady: event => ready.push(event) });
  assert.deepEqual(topics.sort(), ['calpico-chatgpt-messaging', 'task:room:t1']);
  assert.equal(requests.filter(route => route.endsWith('/subscription')).length, 2);
  assert.ok(reads.every(value => value.taskId === 't1')); assert.equal(reads.some(value => value.around === 'wrong'), false);
  assert.equal(seen.filter(event => event.type === 'message').length, 1);
  assert.equal(seen.filter(event => event.type === 'read').length, 1);
  assert.equal(seen.some(event => event.type === 'typing'), false);
  assert.equal(ready.length, 1); assert.equal(ready[0].feed, 'task');
});

test('task topic rotation discards old topic offsets and reconnects to the new topic', async () => {
  const topics = [], subscriptions = []; let lookup = 0;
  const c = client();
  c.transport.request = async (_method, route) => route.endsWith('/subscription') ? { topic_id: ++lookup <= 2 ? 'task:old' : 'task:new' } : { websocket_url: 'wss://ws.chatgpt.com/user' };
  const controller = new AbortController();
  const network = sockets((socket, sent) => {
    const command = sent[1].command; topics.push(command.topic_id);
    if (command.topic_id === 'calpico-chatgpt-messaging') { socket.message([reply(command.topic_id)]); return; }
    subscriptions.push(command);
    socket.message([reply(command.topic_id, { last_offset: command.topic_id === 'task:old' ? 'old-offset' : 'new-offset' })]);
    if (command.topic_id === 'task:old') socket.end(); else queueMicrotask(() => controller.abort());
  });
  await new DotLive(c, { webSocketFactory: network.factory, sleep: async () => {} }).watch({ roomId: 'room', taskId: 'task', signal: controller.signal });
  assert.deepEqual(subscriptions.map(value => value.topic_id), ['task:old', 'task:new']);
  assert.equal('offset' in subscriptions[1], false);
  assert.ok(network.instances.every(socket => socket.closed));
});

test('task topic changed immediately before subscribe never sends stale subscribe', async () => {
  let lookup = 0; const controller = new AbortController(), sent = [];
  const c = client(); c.transport.request = async (_method, route) => route.endsWith('/subscription') ? { topic_id: ++lookup === 1 ? 'task:stale' : 'task:current' } : { websocket_url: 'wss://ws.chatgpt.com/user' };
  const network = sockets((socket, commands) => {
    const topic = commands[1].command.topic_id; sent.push(topic); socket.message([reply(topic)]);
    if (topic === 'task:current') queueMicrotask(() => controller.abort());
  });
  await new DotLive(c, { webSocketFactory: network.factory, sleep: async () => {} }).watch({ roomId: 'room', taskId: 'task', signal: controller.signal });
  assert.equal(sent.includes('task:stale'), false); assert.ok(sent.includes('task:current')); assert.ok(lookup >= 4);
});

test('task subscription identity failure closes the parallel ordinary feed', async () => {
  const c = client(); c.transport.request = async (_method, route) => route.endsWith('/subscription') ? { topic_id: 'task:wrong', task_id: 'other' } : { websocket_url: 'wss://ws.chatgpt.com/user' };
  const network = sockets((socket, sent) => socket.message([reply(sent[1].command.topic_id)]));
  await assert.rejects(new DotLive(c, { webSocketFactory: network.factory }).watch({ roomId: 'room', taskId: 'task', reconnect: false }), error => error.code === 'IDENTITY_MISMATCH');
  assert.ok(network.instances.every(socket => socket.closed));
});

test('all-room task watch is rejected before authentication', async () => {
  const c = client(); c.transport.authLoader = () => { throw Error('must not authenticate'); };
  await assert.rejects(new DotLive(c).watch({ taskId: 'task', all: true }), error => error.code === 'INVALID_ARGUMENT');
});

test('same-account login subject switch is rejected before subscription', async () => {
  const jwt = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
  let sub = 'user-one'; const c = client(); c.transport.authLoader = async () => ({ accountId: 'account', accessToken: jwt(sub) });
  const pinned = await new DotLive(c).pinAccount(); sub = 'user-two';
  await assert.rejects(pinned.assert(), error => error.code === 'ACCOUNT_CHANGED');
});
