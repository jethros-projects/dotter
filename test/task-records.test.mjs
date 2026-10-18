import test from 'node:test';
import assert from 'node:assert/strict';
import { DotOperations } from '../src/operations.mjs';
import { normalizeTaskEvent } from '../src/live.mjs';
import { projectTaskRecord, taskTime } from '../src/task-records.mjs';

const instant = '2026-10-18T01:02:03.123456+01:00';
const summary = () => ({ id: 'task', title: 'Arithmetic canary', description: null, latest_update: 'Complete',
  emoji: '🧮', status: 'completed', created_at: instant, updated_at: instant });
const operations = data => new DotOperations({ transport: { request: async () => data } });
const nativeEvent = task => ({ type: 'task-upsert', payload: { tbo_id: 'dot', task, update: null } });

test('task reads and task-state events reject the same explicit private and deleted summaries', async () => {
  const patches = [{ deleted_at: instant }, { is_user_visible: false }, { hidden: true }, { is_hidden: true },
    { is_visually_hidden_from_conversation: true }, { recipient: 'tool' }, { channel: 'analysis' },
    { metadata: { deleted_at: instant } }, { metadata: { is_user_visible: false } }, { metadata: { hidden: true } },
    { metadata: { is_hidden: true } }, { metadata: { is_visually_hidden_from_conversation: true } },
    { metadata: { recipient: 'tool' } }, { metadata: { channel: 'analysis' } }];
  for (const patch of patches) {
    const task = { ...summary(), ...patch };
    assert.deepEqual(await operations({ data: [task, summary()] }).listTasks({ dotId: 'dot' }), { data: [summary()], next_cursor: null });
    await assert.rejects(operations(task).getTask({ dotId: 'dot', taskId: 'task' }), { code: 'NOT_VISIBLE' });
    assert.equal(normalizeTaskEvent(nativeEvent(task), { dotId: 'dot' }), null);
  }
});

test('malformed public task summaries reject the read rather than emitting partial misleading rows', async () => {
  for (const task of [null, [], 'text', {}, { id: '..' }, { ...summary(), title: true },
    { ...summary(), latest_update: { private: 'raw payload' } }, { ...summary(), status: '' },
    { ...summary(), created_at: '2026-02-30T00:00:00Z' }, { ...summary(), updated_at: 123 }]) {
    await assert.rejects(operations({ data: [summary(), task] }).listTasks({ dotId: 'dot' }), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(operations({ ...summary(), latest_update: [] }).getTask({ dotId: 'dot', taskId: 'task' }), { code: 'INVALID_RESPONSE' });
  for (const task of [null, [], 'text', 1]) await assert.rejects(operations(task).getTask({ dotId: 'dot', taskId: 'task' }), { code: 'INVALID_RESPONSE' });
});

test('control bytes, internal completion markers and overlong task text never reach reads or events', async () => {
  for (const patch of [{ title: 'unsafe\x1b[31m' }, { description: '\0unsafe' }, { latest_update: '::SKIP_COMPLETION::' },
    { emoji: '\x7f' }, { status: 'x'.repeat(129) }, { title: 'x'.repeat(1025) }, { description: 'x'.repeat(64001) }]) {
    const task = { ...summary(), ...patch };
    await assert.rejects(operations({ data: [task] }).listTasks({ dotId: 'dot' }), { code: 'INVALID_RESPONSE' });
    assert.equal(normalizeTaskEvent(nativeEvent(task), { dotId: 'dot' }), null);
  }
});

test('task read verifies explicit Dot identity and task stream verifies both outer and nested identity', async () => {
  const task = { ...summary(), tbo_id: 'other' };
  await assert.rejects(operations({ data: [task] }).listTasks({ dotId: 'dot' }), { code: 'IDENTITY_MISMATCH' });
  await assert.rejects(operations(task).getTask({ dotId: 'dot', taskId: 'task' }), { code: 'IDENTITY_MISMATCH' });
  assert.equal(normalizeTaskEvent(nativeEvent(task), { dotId: 'dot' }), null);
  assert.equal(normalizeTaskEvent(nativeEvent(summary()), { dotId: 'other' }), null);
  const own = { ...summary(), tbo_id: 'dot', raw_messages: ['private'], updates: ['private'] };
  assert.deepEqual(await operations(own).getTask({ dotId: 'dot', taskId: 'task' }), summary());
});

test('task projection retains valid legacy partial summaries and native field names without leaking extras', () => {
  assert.deepEqual(projectTaskRecord({ id: 'task', title: 'Visible', raw_messages: ['private'] }), { id: 'task', title: 'Visible' });
  assert.throws(() => projectTaskRecord({ id: 'task', title: 'Visible' }, { complete: true }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(projectTaskRecord({ ...summary(), provider_token: 'private' }, { complete: true }), summary());
});

test('task timestamp validation covers Gregorian leap years including two-digit years and zoned instants', () => {
  for (const value of ['2000-02-29T00:00:00Z', '0000-02-29T00:00:00Z', '0096-02-29T00:00:00Z', instant, '2026-01-01T23:59:59-12:00']) assert.equal(taskTime(value), true, value);
  for (const value of ['1900-02-29T00:00:00Z', '0100-02-29T00:00:00Z', '2026-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+99:99', '2026-01-01', 'not a date']) assert.equal(taskTime(value), false, value);
});

test('task history cursor accepts only bounded opaque strings or absent/null terminal cursors', async () => {
  for (const cursor of [undefined, null, 'eyJwYWdlIjoyfQ==', 'next:2026-10-18T01:02:03+01:00/a?b=c', 'x'.repeat(8192)]) {
    const result = await operations({ data: [summary()], ...(cursor === undefined ? {} : { next_cursor: cursor }) }).listTasks({ dotId: 'dot' });
    assert.equal(result.next_cursor, cursor ?? null);
    assert.deepEqual(result.data, [summary()]);
  }
});

test('task history never emits nested cursor payloads or malformed cursor strings', async () => {
  for (const cursor of [{ private_payload: 'SHOULD_NOT_BE_OUTPUT' }, [], ['SHOULD_NOT_BE_OUTPUT'], 1, false,
    '', '  ', 'x'.repeat(8193), 'next\0page', 'next\npage', 'next\rpage', 'next\tpage', 'next\x1bpage', 'next\x7fpage', 'next\x85page']) {
    await assert.rejects(operations({ data: [summary()], next_cursor: cursor }).listTasks({ dotId: 'dot' }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(JSON.stringify(error.toJSON()).includes('SHOULD_NOT_BE_OUTPUT'), false);
      return true;
    });
  }
});
