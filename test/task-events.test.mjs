import test from 'node:test';
import assert from 'node:assert/strict';
import { DotLive, normalizeTaskEvent } from '../src/live.mjs';
import { DotOperations } from '../src/operations.mjs';
import { Transport } from '../src/transport.mjs';
import { parseArgs, run } from '../src/cli.mjs';

const instant = '2026-10-18T01:02:03.123456+01:00';
const event = () => ({ type: 'task-upsert', payload: { tbo_id: 'dot', task: {
  id: 'task', title: 'Read public README', description: null, status: 'running', latest_update: 'Started',
  emoji: '📚', created_at: instant, updated_at: instant
}, update: { id: 'update', task_id: 'task', text: 'Visible update\nsecond line', created_at: instant } } });
const scope = { dotId: 'dot' };
const reply = (extra = {}) => ({ id: 2, reply: { type: 'subscribe', topic_id: 'tbo-tasks', recovered: false, ...extra } });
const frame = (value = event(), extra = {}) => ({ type: 'message', topic_id: 'tbo-tasks', payload: value, offset: 'offset', ...extra });
function fixture(script) {
  const sent = [], instances = [], requests = [], auth = { accountId: 'account', userId: 'user', accessToken: 'secret' };
  class Socket extends EventTarget {
    constructor() { super(); instances.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(value) { const commands = JSON.parse(value); sent.push(commands); queueMicrotask(() => script(this, commands)); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
    end() { this.dispatchEvent(new Event('close')); }
    close() { this.closed = true; }
  }
  let primaryReads = 0;
  const client = { primary: async () => { primaryReads++; return { id: 'dot' }; }, transport: {
    authLoader: async () => ({ ...auth }), request: async (method, route, options) => {
      requests.push({ method, route, options }); return { websocket_url: 'wss://ws.chatgpt.com/user?signed=secret' };
    }
  } };
  const live = new DotLive(client, { webSocketFactory: () => new Socket(), sleep: async () => {} });
  return { live, client, auth, sent, instances, requests, primaryReads: () => primaryReads };
}

test('native task-state projection retains only the verified visible schema', () => {
  const value = event();
  value.payload.task.raw_messages = ['private reasoning']; value.payload.task.provider_token = 'secret';
  value.payload.update.tool_payload = { secret: 'provider credentials' }; value.payload.private = 'private';
  assert.deepEqual(normalizeTaskEvent(value, scope), { type: 'task-upsert', dotId: 'dot', task: {
    id: 'task', title: 'Read public README', description: null, status: 'running', latestUpdate: 'Started',
    emoji: '📚', createdAt: instant, updatedAt: instant
  }, update: { id: 'update', taskId: 'task', text: 'Visible update\nsecond line', createdAt: instant } });
  value.payload.task.status = 'future-native-status'; value.payload.update = null;
  assert.equal(normalizeTaskEvent(value, scope).task.status, 'future-native-status');
  assert.equal(normalizeTaskEvent(value, scope).update, null);
});

test('task-state projection requires exact Dot and optional task identity', () => {
  assert.equal(normalizeTaskEvent(event(), { dotId: 'other' }), null);
  assert.equal(normalizeTaskEvent(event(), { ...scope, taskId: 'other' }), null);
  assert.equal(normalizeTaskEvent(event(), { ...scope, taskId: 'task' }).task.id, 'task');
  const wrong = event(); wrong.payload.update.task_id = 'other';
  assert.equal(normalizeTaskEvent(wrong, scope), null);
});

test('malformed native task records and invalid calendar times cannot reach output', () => {
  const edits = [v => { v.type = 'other'; }, v => { v.payload = []; }, v => { v.payload.task = null; },
    v => { v.payload.task.title = 1; }, v => { delete v.payload.task.description; },
    v => { v.payload.task.description = {}; }, v => { v.payload.task.latest_update = []; },
    v => { v.payload.task.emoji = false; }, v => { v.payload.task.status = ''; },
    v => { v.payload.task.id = '..'; }, v => { v.payload.tbo_id = '.'; },
    v => { v.payload.task.id = 'x'.repeat(1025); }, v => { v.payload.task.title = 'x'.repeat(1025); },
    v => { v.payload.task.description = 'x'.repeat(64001); }, v => { v.payload.task.status = 'x'.repeat(129); },
    v => { v.payload.task.title = 'unsafe\x1b[31m'; }, v => { v.payload.task.latest_update = 'unsafe\0'; },
    v => { delete v.payload.update; }, v => { v.payload.update = []; },
    v => { v.payload.update.id = '.'; }, v => { v.payload.update.text = 'x'.repeat(64001); },
    v => { v.payload.update.text = '\x7f'; }, v => { v.payload.update.created_at = 3; }];
  for (const badTime of ['now', '2026-02-30T01:00:00Z', '2026-13-01T01:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T01:61:00Z', '2026-01-01T01:00:61Z', '2026-01-01T01:00:00', '2026-01-01']) edits.push(v => { v.payload.task.created_at = badTime; });
  for (const edit of edits) { const value = event(); edit(value); assert.equal(normalizeTaskEvent(value, scope), null); }
  for (const value of [null, [], '', 2, true]) assert.equal(normalizeTaskEvent(value, scope), null);
});

test('task state hides private outer records, tasks and updates including duplicated latest text', () => {
  const hidden = [{ hidden: true }, { is_hidden: true }, { is_user_visible: false }, { deleted_at: instant },
    { is_visually_hidden_from_conversation: true }, { channel: 'analysis' }, { recipient: 'tool' },
    { metadata: { channel: 'analysis' } }, { metadata: { recipient: 'tool' } }, { metadata: { hidden: true } },
    { metadata: { deleted_at: instant } }, { metadata: { is_user_visible: false } }];
  for (const path of [[], ['payload'], ['payload', 'task'], ['payload', 'update']]) {
    for (const patch of hidden) { const value = event(); let target = value; for (const key of path) target = target[key]; Object.assign(target, patch); assert.equal(normalizeTaskEvent(value, scope), null); }
  }
  for (const key of ['title', 'description', 'latest_update']) { const value = event(); value.payload.task[key] = ' ::SKIP_COMPLETION:: '; assert.equal(normalizeTaskEvent(value, scope), null); }
  const value = event(); value.payload.update.text = '::SKIP_COMPLETION::'; assert.equal(normalizeTaskEvent(value, scope), null);
});

test('native global task feed uses its own topic, scoped output and no message-history reads', async () => {
  const seen = [], ready = [];
  const f = fixture(socket => { const other = event(); other.payload.tbo_id = 'other'; socket.message([reply(), frame(other), frame(), frame()]); socket.end(); });
  await f.live.taskEvents({ reconnect: false, onReady: x => ready.push(x), onEvent: x => seen.push(x) });
  assert.equal(f.primaryReads(), 1); assert.equal(f.sent[0][1].command.topic_id, 'tbo-tasks');
  assert.deepEqual(f.requests.map(x => x.route), ['/backend-api/celsius/ws/user']);
  assert.equal(f.requests[0].options.expectedAccountId, 'account');
  assert.deepEqual(seen.map(x => x.type), ['task-resync', 'task-upsert']);
  assert.equal(ready[0].feed, 'task-state'); assert.equal(ready[0].dotId, 'dot');
  assert.equal(JSON.stringify([...seen, ...ready]).includes('secret'), false);
  assert.equal(f.instances[0].closed, true);
});

test('task filter retains only its exact native task ID and duplicate key preserves distinct updates', async () => {
  const seen = [], value = event(), other = event(), next = event();
  other.payload.task.id = other.payload.update.task_id = 'other'; next.payload.update.id = 'second-update';
  const f = fixture(socket => { socket.message([reply(), frame(other), frame(value), frame(value), frame(next)]); socket.end(); });
  await f.live.taskEvents({ dotId: 'dot', taskId: 'task', reconnect: false, onEvent: x => seen.push(x) });
  assert.equal(f.primaryReads(), 0); assert.deepEqual(seen.filter(x => x.type === 'task-upsert').map(x => x.update.id), ['update', 'second-update']);
  assert.ok(seen.every(x => x.taskId === 'task' || x.task?.id === 'task'));
});

test('task feed resumes its opaque offset and filters recovered catchups', async () => {
  const seen = []; let round = 0;
  const f = fixture(socket => {
    if (++round === 1) { socket.message([reply({ last_offset: 'saved-offset' }), frame()]); socket.end(); }
    else { const other = event(), next = event(); other.payload.tbo_id = 'other'; next.payload.update.id = 'next';
      socket.message([reply({ recovered: true, catchups: [frame(other), frame(), frame(next)] })]); socket.end(); }
  });
  const controller = new AbortController();
  await f.live.taskEvents({ dotId: 'dot', signal: controller.signal, onEvent: x => { seen.push(x); if (x.update?.id === 'next') controller.abort(); } });
  assert.equal(f.sent[1][1].command.offset, 'offset');
  assert.deepEqual(seen.map(x => x.type), ['task-resync', 'task-upsert', 'task-upsert']);
  assert.ok(f.instances.every(x => x.closed));
});

test('task feed rejects invalid scope and absent account or user before opening a socket', async () => {
  for (const options of [{ dotId: '..' }, { dotId: 'dot/other' }, { taskId: '.' }, { taskId: 'x'.repeat(1025) }]) {
    const f = fixture(() => {}); let authReads = 0; f.client.transport.authLoader = async () => { authReads++; return f.auth; };
    await assert.rejects(f.live.taskEvents(options), { code: 'INVALID_ARGUMENT' }); assert.equal(authReads, 0); assert.equal(f.requests.length, 0);
  }
  for (const missing of ['accountId', 'userId']) {
    const f = fixture(() => {}); delete f.auth[missing];
    await assert.rejects(f.live.taskEvents({ dotId: 'dot' }), { code: missing === 'accountId' ? 'AUTH_ACCOUNT_MISSING' : 'AUTH_USER_MISSING' });
    assert.equal(f.requests.length, 0); assert.equal(f.instances.length, 0);
  }
});

test('task feed pins account and same-account subject through ready and queued events', async () => {
  for (const field of ['accountId', 'userId']) {
    const seen = []; const f = fixture(socket => { socket.message([reply(), frame()]); });
    await assert.rejects(f.live.taskEvents({ dotId: 'dot', reconnect: false,
      onReady: () => { f.auth[field] = 'other'; }, onEvent: x => seen.push(x) }), { code: 'ACCOUNT_CHANGED' });
    assert.deepEqual(seen, []); assert.equal(f.instances[0].closed, true);
  }
});

test('task feed rejects identity switch before ready callback and accepts refreshed same-subject JWT', async () => {
  const f = fixture(socket => { f.auth.userId = 'other'; socket.message([reply(), frame()]); }); let ready = 0;
  await assert.rejects(f.live.taskEvents({ dotId: 'dot', reconnect: false, onReady: () => ready++ }), { code: 'ACCOUNT_CHANGED' }); assert.equal(ready, 0);
  const jwt = suffix => `header.${Buffer.from(JSON.stringify({ sub: 'stable-user', suffix })).toString('base64url')}.signature`;
  const g = fixture(socket => { g.auth.accessToken = jwt('refreshed'); socket.message([reply(), frame()]); socket.end(); }); delete g.auth.userId; g.auth.accessToken = jwt('initial');
  const seen = []; await g.live.taskEvents({ dotId: 'dot', reconnect: false, onEvent: x => seen.push(x) });
  assert.equal(seen.filter(x => x.type === 'task-upsert').length, 1);
});

test('real transport identity remains pinned across stream preflight and first request', async () => {
  const auth = sub => ({ accountId: 'account', accessToken: `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature` });
  let reads = 0, network = 0;
  const transport = new Transport({ authLoader: async () => auth(++reads <= 2 ? 'first' : 'switched'), fetchImpl: async () => { network++; return new Response('{}'); } });
  const pinned = await new DotLive({ transport }).pinAccount({ requireSubject: true });
  await assert.rejects(pinned.transport.request('GET', '/backend-api/celsius/ws/user'), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(network, 0);
  const alreadyPinned = new Transport({ authLoader: async () => auth('switched') }); alreadyPinned.assertIdentity(auth('first'));
  await assert.rejects(new DotLive({ transport: alreadyPinned }).pinAccount({ requireSubject: true }), { code: 'AUTH_IDENTITY_CHANGED' });
});

test('task feed cancellation before authentication or from ready emits no later data', async () => {
  const aborted = new AbortController(); aborted.abort(); const first = fixture(() => {});
  await assert.rejects(first.live.taskEvents({ signal: aborted.signal }), { name: 'AbortError' }); assert.equal(first.requests.length, 0);
  const controller = new AbortController(), seen = [], second = fixture(socket => socket.message([reply(), frame()]));
  await second.live.taskEvents({ dotId: 'dot', signal: controller.signal, onReady: () => controller.abort(), onEvent: x => seen.push(x) });
  assert.deepEqual(seen, []); assert.equal(second.instances[0].closed, true);
});

test('task feed rejects malformed or oversized transport frames without exposing raw bytes', async () => {
  for (const [payload, code] of [['private malformed JSON', 'INVALID_STREAM'], ['x'.repeat(1024 * 1024 + 1), 'INVALID_STREAM']]) {
    const f = fixture(socket => socket.message(payload));
    await assert.rejects(f.live.taskEvents({ dotId: 'dot', reconnect: false }), error => error.code === code && !error.message.includes('private'));
    assert.equal(f.instances[0].closed, true);
  }
});

test('task detail refuses a mismatched returned ID while preserving visible summaries', async () => {
  for (const response of [{ id: 'other', title: 'Wrong' }, { title: 'Missing identity' }]) {
    const ops = new DotOperations({ transport: { request: async () => response } });
    await assert.rejects(ops.getTask({ dotId: 'dot', taskId: 'task' }), { code: 'IDENTITY_MISMATCH' });
  }
  const hidden = new DotOperations({ transport: { request: async () => ({ id: 'task', hidden: true }) } });
  await assert.rejects(hidden.getTask({ dotId: 'dot', taskId: 'task' }), { code: 'NOT_VISIBLE' });
});

test('global task-state CLI path is distinct from per-task message events and preserves base tasks', async () => {
  assert.equal(parseArgs(['task-events', 'watch', '--dot', 'dot', '--task', 'task']).action, 'task-events watch');
  assert.equal(parseArgs(['tasks', '--dot', 'dot']).command, 'tasks');
  assert.equal(parseArgs(['events', 'watch', '--task', 'task']).action, 'events watch');
  assert.throws(() => parseArgs(['task-events', 'watch', '--all']));
  let got; const output = [];
  await run(['task-events', 'watch', '--dot', 'dot', '--no-reconnect'], { stdout: { write: x => output.push(x) }, stderr: { write() {} },
    createClient: async () => ({}), v3Invoke: async (module, method, options) => { got = { module, method, options }; await options.onEvent({ type: 'task-upsert' }); } });
  assert.equal(got.module, 'live'); assert.equal(got.method, 'taskEvents'); assert.equal(got.options.dotId, 'dot'); assert.equal(got.options.reconnect, false);
  assert.deepEqual(output.map(x => JSON.parse(x)), [{ type: 'task-upsert' }]);
});
