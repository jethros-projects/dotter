import test from 'node:test';
import assert from 'node:assert/strict';
import { DotClient } from '../src/client.mjs';
import { DotLive } from '../src/live.mjs';

const roomId = 'room', taskId = 'task';
const route = '/backend-api/messaging/rooms/room/tasks/task/subscription';
function direct(responses) {
  const calls = [];
  const client = new DotClient({ transport: { request: async (method, path, options) => {
    calls.push({ method, path, options });
    assert.ok(calls.length <= responses.length, 'No unplanned request');
    return responses[calls.length - 1];
  } } });
  return { calls, run: () => client.taskSubscription({ roomId, taskId }) };
}
function live(responses) {
  const calls = [], topics = [];
  const auth = { accountId: 'account', userId: 'user', accessToken: 'private-test-token' };
  const client = { resolveRoom: async id => id, transport: {
    authLoader: async () => auth,
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      assert.ok(calls.length <= responses.length, 'No unplanned request');
      return responses[calls.length - 1];
    }
  } };
  const watcher = new DotLive(client);
  // Exercise the real task resolver and its pre-subscribe refresh without
  // opening a network socket or introducing unrelated websocket framing.
  watcher.subscribe = async options => {
    if (!options.resolveTopic) return;
    const topic = await options.resolveTopic();
    topics.push(topic);
    await options.beforeSubscribe(topic);
  };
  return { calls, topics, run: () => watcher.watch({ roomId, taskId, reconnect: false }) };
}

for (const [reader, fixture] of [['direct', direct], ['live', live]]) {
  test(`${reader} task subscription preserves native topic-only replies and explicit matching optional scope`, async () => {
    for (const extra of [{}, { room_id: roomId }, { task_id: taskId }, { room_id: roomId, task_id: taskId }, { room_id: null, task_id: null }]) {
      const response = { topic_id: 'task/opaque:topic~value?part=1', ...extra, access_token: 'NEVER_RETURN' };
      const f = fixture([response, response]);
      const result = await f.run();
      if (reader === 'direct') assert.deepEqual(result, { roomId, taskId, topicId: response.topic_id });
      else assert.deepEqual(f.topics, [response.topic_id]);
      assert.equal(f.calls.length, reader === 'direct' ? 1 : 2);
      assert.ok(f.calls.every(c => c.method === 'GET' && c.path === route));
      assert.equal(JSON.stringify(result ?? null).includes('NEVER_RETURN'), false);
    }
  });
  for (const [name, response, code] of [
    ['wrong room', { topic_id: 'topic', room_id: 'other' }, 'IDENTITY_MISMATCH'],
    ['wrong task', { topic_id: 'topic', task_id: 'other' }, 'IDENTITY_MISMATCH'],
    ['malformed room identity', { topic_id: 'topic', room_id: [] }, 'IDENTITY_MISMATCH'],
    ['malformed task identity', { topic_id: 'topic', task_id: false }, 'IDENTITY_MISMATCH'],
    ['null response', null, 'INVALID_RESPONSE'],
    ['array response', [{ topic_id: 'topic' }], 'INVALID_RESPONSE'],
    ['missing topic', {}, 'INVALID_RESPONSE'],
    ['non-string topic', { topic_id: 1 }, 'INVALID_RESPONSE'],
    ['empty topic', { topic_id: '' }, 'INVALID_RESPONSE'],
    ['overlong topic', { topic_id: 'x'.repeat(4097) }, 'INVALID_RESPONSE'],
  ]) test(`${reader} task subscription rejects ${name} before emitting a topic or retrying`, async () => {
    const f = fixture([response]);
    await assert.rejects(f.run(), { code });
    assert.equal(f.calls.length, 1);
    if (reader === 'live') assert.deepEqual(f.topics, []);
  });
  test(`${reader} task subscription rejects all C0, DEL and C1 control characters`, async () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i)]) {
      const f = fixture([{ topic_id: `prefix${String.fromCharCode(code)}suffix` }]);
      await assert.rejects(f.run(), { code: 'INVALID_RESPONSE' });
      assert.equal(f.calls.length, 1);
    }
  });
  test(`${reader} task subscription preserves the existing public 4096-character opaque topic bound`, async () => {
    for (const length of [1024, 1025, 4096]) {
      const response = { topic_id: 'x'.repeat(length) }, f = fixture([response, response]);
      const result = await f.run();
      assert.equal(reader === 'direct' ? result.topicId.length : f.topics[0].length, length);
    }
  });
}

test('task live pre-subscribe refresh validates explicit scope before accepting an unchanged topic', async () => {
  for (const patch of [{ room_id: 'other' }, { task_id: 'other' }]) {
    const f = live([{ topic_id: 'topic' }, { topic_id: 'topic', ...patch }]);
    await assert.rejects(f.run(), { code: 'IDENTITY_MISMATCH' });
    assert.equal(f.calls.length, 2);
  }
});
test('task live pre-subscribe refresh still rejects a changed topic', async () => {
  const f = live([{ topic_id: 'one' }, { topic_id: 'two' }]);
  await assert.rejects(f.run(), { code: 'TASK_SUBSCRIPTION_CHANGED' });
  assert.equal(f.calls.length, 2);
});
