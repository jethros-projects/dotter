import test from 'node:test';
import assert from 'node:assert/strict';
import { DotClient } from '../src/client.mjs';
import { DotLive } from '../src/live.mjs';
import { run } from '../src/cli.mjs';

const at = '2026-10-18T00:00:00Z';
const row = (id, taskId) => ({ id, content: { text: `Visible ${id}` }, created_at: at,
  ...(taskId === undefined ? {} : { task_id: taskId }) });
function client(items) {
  const calls = [];
  const transport = {
    authLoader: async () => ({ accessToken: 'synthetic', accountId: 'account' }),
    request: async (method, path, options = {}) => {
      calls.push({ method, path, options });
      assert.equal(method, 'GET');
      if (path.endsWith('/subscription')) return { topic_id: 'task-topic', room_id: 'room', task_id: 'task' };
      if (path.endsWith('/celsius/ws/user')) return { websocket_url: 'wss://ws.chatgpt.com/user' };
      assert.equal(path, '/backend-api/messaging/rooms/room/messages');
      return { items };
    }
  };
  return { value: new DotClient({ transport }), calls };
}

for (const items of [[row('foreign', 'other')], [row('own', 'task'), row('foreign', 'other')]]) {
  test(`task-filtered history rejects ${items.length === 1 ? 'a foreign' : 'a mixed'} visible result`, async () => {
    const f = client(items);
    await assert.rejects(f.value.history({ roomId: 'room', taskId: 'task' }), { code: 'IDENTITY_MISMATCH' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.query.task_id, 'task');
  });
}

test('task-filtered around and reply reads retain the same identity fence', async () => {
  for (const extra of [{ around: 'message' }, { replyRootMessageId: 'reply' }, { after: 'cursor' }, { before: 'cursor' }]) {
    const f = client([row('foreign', 'other')]);
    await assert.rejects(f.value.history({ roomId: 'room', taskId: 'task', ...extra }), { code: 'IDENTITY_MISMATCH' });
    assert.equal(f.calls.length, 1);
  }
});

test('task-filtered history preserves matching and absent task identity context', async () => {
  const f = client([row('own', 'task'), row('context-absent'), row('context-null', null)]);
  const result = await f.value.history({ roomId: 'room', taskId: 'task' });
  assert.deepEqual(result.messages.map(item => item.id).sort(), ['context-absent', 'context-null', 'own']);
  assert.equal(result.messages.find(item => item.id === 'own').taskId, 'task');
});

test('hidden foreign task rows remain hidden without rejecting visible owned history', async () => {
  const f = client([row('own', 'task'), { ...row('hidden', 'other'), hidden: true }]);
  const result = await f.value.history({ roomId: 'room', taskId: 'task' });
  assert.deepEqual(result.messages.map(item => item.id), ['own']);
});

test('unfiltered room history still permits messages from multiple tasks', async () => {
  const f = client([row('one', 'task'), row('two', 'other')]);
  assert.equal((await f.value.history({ roomId: 'room' })).messages.length, 2);
  assert.equal(f.calls[0].options.query.task_id, undefined);
});

test('CLI task history emits no partial output for foreign task messages', async () => {
  const f = client([row('own', 'task'), row('foreign', 'other')]);
  const output = [];
  await assert.rejects(run(['history', '--room', 'room', '--task', 'task', '--json'], {
    createClient: async () => f.value,
    stdout: { write: value => output.push(value) }, stderr: { write() {} }
  }), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(output, []);
});


test('task-filtered history rejects malformed explicit task identities before projection can omit them', async () => {
  for (const taskId of [false, true, 0, 1, {}, [], ['task']]) {
    const f = client([row('own', 'task'), row('malformed', taskId)]);
    await assert.rejects(f.value.history({ roomId: 'room', taskId: 'task' }), { code: 'IDENTITY_MISMATCH' });
    assert.equal(f.calls.length, 1);
  }
});

test('hidden malformed task identities cannot invalidate visible task context', async () => {
  for (const hidden of [{ hidden: true }, { deleted_at: at }, { channel: 'analysis' }, { metadata: { hidden: true } }]) {
    const f = client([row('own', 'task'), { ...row('malformed-hidden', { other: 'task' }), ...hidden }]);
    const result = await f.value.history({ roomId: 'room', taskId: 'task' });
    assert.deepEqual(result.messages.map(item => item.id), ['own']);
  }
});

test('unfiltered history keeps malformed task identity projection unchanged', async () => {
  const f = client([row('context', { other: 'task' })]);
  const result = await f.value.history({ roomId: 'room' });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].taskId, undefined);
});

test('CLI task history emits no partial output for a malformed explicit task identity', async () => {
  const f = client([row('own', 'task'), row('malformed', { other: 'task' })]);
  const output = [];
  await assert.rejects(run(['history', '--room', 'room', '--task', 'task', '--json'], {
    createClient: async () => f.value,
    stdout: { write: value => output.push(value) }, stderr: { write() {} }
  }), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(output, []);
});

async function assertLiveRejectsTaskIdentity(taskIdentity) {
  const f = client([row('invalid', taskIdentity)]);
  const seen = [], instances = [];
  class Socket extends EventTarget {
    constructor() { super(); instances.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(value) {
      const commands = JSON.parse(value), topic = commands.find(item => item.command?.type === 'subscribe')?.command.topic_id;
      if (!topic) return;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify([
        { id: 2, reply: { type: 'subscribe', topic_id: topic, recovered: false } }
      ]) })));
    }
    close() { this.closed = true; }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    await assert.rejects(new DotLive(f.value, { webSocketFactory: () => new Socket() }).watch({
      roomId: 'room', taskId: 'task', reconnect: false, signal: controller.signal, onEvent: event => seen.push(event)
    }), { code: 'IDENTITY_MISMATCH' });
  } finally { clearTimeout(timeout); }
  assert.equal(seen.filter(event => event.type === 'message').length, 0);
  assert.equal(instances.length, 2);
  assert.ok(instances.every(item => item.closed));
}

test('task live resync rejects foreign history before emitting any message', async () => {
  await assertLiveRejectsTaskIdentity('other');
});

test('task live resync rejects malformed task identities before emitting any message', async () => {
  for (const taskId of [false, 0, {}, []]) await assertLiveRejectsTaskIdentity(taskId);
});
