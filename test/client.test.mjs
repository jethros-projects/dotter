import test from 'node:test';
import assert from 'node:assert/strict';
import { DotClient, normalizeMessage, validateRoom, validateSendContext } from '../src/client.mjs';

const roomId = 'room_test-1';
const key = 'b1b7788f-0b32-4386-a7da-ce111700ee23';

function mockClient(responses) {
  const calls = [];
  const transport = {
    async request(method, path, options = {}) {
      const call = { method, path, ...options };
      calls.push(call);
      assert.ok(calls.length <= responses.length, `Unexpected request: ${method} ${path}`);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(call) : response;
    },
  };
  return { client: new DotClient({ transport }), calls };
}

function user(id, text, createdAt = '2026-10-17T10:00:00Z') {
  return { id, account_user_id: 'user_test', content: { text }, created_at: createdAt };
}

function assistant(id, text, { inProgress = false, createdAt = '2026-10-17T10:00:01Z' } = {}) {
  return {
    id, created_at: createdAt, generation: { status: inProgress ? 'in_progress' : 'completed' },
    raw_messages: [{ author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: [text] } }],
  };
}

test('direct hidden flags and deletion on inner raw messages never reach visible output', () => {
  for (const flag of [{ hidden: true }, { is_hidden: true }, { is_visually_hidden_from_conversation: true }, { deleted_at: '2026-10-17' }]) {
    const item = assistant('hidden_inner', 'PRIVATE');
    Object.assign(item.raw_messages[0], flag);
    assert.equal(normalizeMessage(item), null);
  }
});

test('primary reads the selection/profile wrapper and prefers the selected room', async () => {
  const { client, calls } = mockClient([{
    selection: { available: true, thread_id: 'thread_selected', messaging_room_id: roomId, aeon_id: 'dot_selected' },
    profile: { id: 'dot_selected', display_name: 'Test Dot', messaging_room_id: 'room_old', active_root_thread_id: 'thread_old', aeon_kind: 'orbit' },
  }]);
  assert.deepEqual(await client.primary(), {
    id: 'dot_selected', name: 'Test Dot', roomId, threadId: 'thread_selected', kind: 'orbit', available: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/backend-api/tbo/primary');
});

test('primary uses the embedded profile room or fetches a profile by thread', async () => {
  const embedded = mockClient([{
    selection: { available: true, thread_id: 'thread_test' },
    profile: { id: 'dot_test', display_name: 'Embedded Dot', messaging_room_id: roomId },
  }]);
  assert.equal((await embedded.client.primary()).roomId, roomId);
  assert.equal(embedded.calls.length, 1);

  const fallback = mockClient([
    { selection: { available: true, thread_id: 'thread/with space' } },
    { id: 'dot_test', messaging_room_id: roomId, active_root_thread_id: 'thread/with space', aeon_kind: 'orbit' },
  ]);
  const controller = new AbortController();
  assert.deepEqual(await fallback.client.primary({ signal: controller.signal }), {
    id: 'dot_test', name: 'Dot', roomId, threadId: 'thread/with space', kind: 'orbit', available: true,
  });
  assert.equal(fallback.calls[1].path, '/backend-api/tbo/by-thread/thread%2Fwith%20space');
  assert.ok(fallback.calls.every(call => call.signal === controller.signal));
});

test('primary reports unavailable selections and absent messaging rooms', async () => {
  for (const selection of [null, { available: false }]) {
    const { client, calls } = mockClient([{ selection }]);
    await assert.rejects(client.primary(), { code: 'DOT_UNAVAILABLE' });
    assert.equal(calls.length, 1);
  }
  const { client } = mockClient([{ selection: { available: true, aeon_id: 'dot_test' } }]);
  await assert.rejects(client.primary(), { code: 'ROOM_UNAVAILABLE' });
});

test('listDots follows cursor pages and returns readable profile summaries', async () => {
  const { client, calls } = mockClient([
    { items: [{ id: 'dot_1', display_name: 'First', messaging_room_id: roomId, active_root_thread_id: 'thread_1', aeon_kind: 'orbit' }], cursor: 'page_2' },
    { items: [{ id: 'dot_2' }], cursor: null },
  ]);
  assert.deepEqual(await client.listDots(), [
    { id: 'dot_1', name: 'First', roomId, threadId: 'thread_1', kind: 'orbit' },
    { id: 'dot_2', name: 'Dot', roomId: null, threadId: null, kind: null },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.query), [
    { limit: 25, include_room_preview: false, cursor: undefined },
    { limit: 25, include_room_preview: false, cursor: 'page_2' },
  ]);
  assert.ok(calls.every(call => call.method === 'GET' && call.path === '/backend-api/tbo'));
});

test('listDots rejects repeated/invalid cursors and malformed pages', async () => {
  const repeated = mockClient([{ items: [], cursor: 'same' }, { items: [], cursor: 'same' }]);
  await assert.rejects(repeated.client.listDots(), { code: 'CURSOR_LOOP' });
  assert.equal(repeated.calls.length, 2);
  const invalid = mockClient([{ items: [], cursor: { next: 'unexpected' } }]);
  await assert.rejects(invalid.client.listDots(), { code: 'CURSOR_LOOP' });
  const malformed = mockClient([{ items: null }]);
  await assert.rejects(malformed.client.listDots(), { code: 'INVALID_RESPONSE' });
});

test('normalization keeps user and visible assistant text while excluding private or tool messages', () => {
  const raw = text => ({ author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: [text] } });
  const item = {
    id: 'assistant_visible', created_at: '2026-10-17T10:00:01Z', generation: { status: 'in_progress' },
    raw_messages: [
      raw('Visible answer'),
      { ...raw('Analysis'), channel: 'analysis' },
      { ...raw('Tool input'), recipient: 'functions.exec' },
      { ...raw('Hidden'), metadata: { is_hidden: true } },
      { ...raw('Also hidden'), metadata: { hidden: true } },
      { ...raw('Visually hidden'), metadata: { is_visually_hidden_from_conversation: true } },
      { ...raw('Tool output'), author: { role: 'tool' } },
      raw('::SKIP_COMPLETION::'),
      { ...raw('ignored'), content: { content_type: 'multimodal_text', parts: ['More ', { image: 'private_pointer' }, 'text'] } },
    ],
  };
  const result = normalizeMessage(item);
  assert.equal(result.role, 'assistant');
  assert.equal(result.text, 'Visible answer\n\nMore text');
  assert.equal(result.inProgress, true);
  assert.equal(normalizeMessage(user('user_1', 'Banana')).text, 'Banana');
  assert.equal(normalizeMessage(user('user_1', 'Banana')).role, 'user');
  assert.equal(normalizeMessage({ ...user('deleted', 'gone'), deleted_at: '2026-10-17T10:01:00Z' }), null);
  assert.equal(normalizeMessage({ ...user('error', ''), content: { type: 'message_error', text: 'error' } }), null);
  assert.equal(normalizeMessage({ id: 'hidden', raw_messages: [{ ...raw('hidden'), channel: 'analysis' }] }), null);
});

test('normalization rejects hidden or non-user-facing outer containers and whitespace placeholders', () => {
  const inner = { author: { role: 'assistant' }, channel: 'final', recipient: 'all',
    content: { content_type: 'text', parts: ['Inner visible-looking text'] } };
  const outer = { id: 'outer', raw_messages: [inner] };
  for (const metadata of [
    { is_hidden: true }, { hidden: true }, { is_visually_hidden_from_conversation: true },
  ]) {
    assert.equal(normalizeMessage({ ...outer, metadata }), null, JSON.stringify(metadata));
  }
  assert.equal(normalizeMessage({ ...outer, channel: 'analysis' }), null);
  assert.equal(normalizeMessage({ ...outer, recipient: 'functions.exec' }), null);
  assert.equal(normalizeMessage({ ...outer, channel: 'commentary', recipient: 'all' }).text, 'Inner visible-looking text');
  assert.equal(normalizeMessage({ ...user('placeholder', '  \n::SKIP_COMPLETION::\n\t') }), null);
  assert.equal(normalizeMessage({ ...outer, raw_messages: [
    { ...inner, content: { content_type: 'text', parts: [' \n ::SKIP_COMPLETION:: \t'] } },
  ] }), null);
  assert.equal(normalizeMessage({ ...outer, raw_messages: [
    { ...inner, content: { content_type: 'text', parts: [' \n ::SKIP_COMPLETION:: \t'] } }, inner,
  ] }).text, 'Inner visible-looking text');
});

test('history sorts chronologically, preserves cursors, and advances across hidden records', async () => {
  const { client, calls } = mockClient([{
    items: [assistant('answer_2', 'Second', { createdAt: '2026-10-17T10:00:02Z' }), user('user_1', 'First'), { id: 'hidden_last', raw_messages: [] }],
    prev_cursor: 'older', next_cursor: 'newer',
  }]);
  const result = await client.history({ roomId, limit: 7, before: 'message_older' });
  assert.deepEqual(result.messages.map(message => message.id), ['user_1', 'answer_2']);
  assert.equal(result.prevCursor, 'older');
  assert.equal(result.nextCursor, 'newer');
  assert.equal(result.lastItemId, 'hidden_last');
  assert.deepEqual(calls[0].query, { limit: 7, before: 'message_older', after: undefined });
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}/messages`);
});

test('send submits one minimal request with the same UUID in both idempotency fields', async () => {
  const { client, calls } = mockClient([{ id: 'accepted_1', created_at: '2026-10-17T10:00:00Z' }]);
  assert.deepEqual(await client.send({ roomId, text: 'Hello Dot', idempotencyKey: key }), {
    accepted: true, roomId, messageId: 'accepted_1', idempotencyKey: key, createdAt: '2026-10-17T10:00:00Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}/messages`);
  assert.equal(calls[0].idempotencyKey, key);
  assert.deepEqual(calls[0].body, {
    content: { text: 'Hello Dot' }, request_id: key, idempotency_token: key, timezone_offset_min: new Date().getTimezoneOffset(),
  });
});

test('send generates a consistent UUID and does not retry transport errors', async () => {
  const generated = mockClient([{ id: 'accepted_2' }]);
  const result = await generated.client.send({ roomId, text: 'Hello' });
  assert.match(result.idempotencyKey, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(generated.calls[0].body.request_id, result.idempotencyKey);
  assert.equal(generated.calls[0].body.idempotency_token, result.idempotencyKey);
  const failure = new Error('connection lost');
  const failed = mockClient([failure]);
  await assert.rejects(failed.client.send({ roomId, text: 'Hello', idempotencyKey: key }), error => error === failure);
  assert.equal(failed.calls.length, 1);
  const malformed = mockClient([{}]);
  await assert.rejects(malformed.client.send({ roomId, text: 'Hello', idempotencyKey: key }), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.details.delivery, 'unknown');
    assert.equal(error.details.idempotencyKey, key);
    return true;
  });
});

test('validation rejects bad arguments before any transport operation', async () => {
  const { client, calls } = mockClient([]);
  for (const invalid of ['', '  ', 'a\0b', 'a'.repeat(64001), 42]) {
    await assert.rejects(client.send({ text: invalid }), { code: 'INVALID_MESSAGE' });
  }
  await assert.rejects(client.send({ text: 'Hello', idempotencyKey: 'not-a-uuid' }), { code: 'INVALID_KEY' });
  await assert.rejects(client.send({ roomId: '../secrets', text: 'Hello', idempotencyKey: key }), { code: 'INVALID_ROOM' });
  for (const limit of [0, 21, 1.5, NaN]) {
    await assert.rejects(client.history({ limit }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(client.history({ before: 'a', after: 'b' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.history({ roomId: 'bad/room' }), { code: 'INVALID_ROOM' });
  await assert.rejects(client.watch({ intervalMs: 999 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validateRoom('a'.repeat(257)), { code: 'INVALID_ROOM' });
  assert.equal(calls.length, 0);
});

test('watch can emit initial messages then stop immediately on cancellation', async () => {
  const controller = new AbortController();
  const { client, calls } = mockClient([{ items: [assistant('answer', 'Answer'), user('question', 'Question')] }]);
  const emitted = [];
  let ready;
  await client.watch({ roomId, fromStart: true, signal: controller.signal,
    onMessage: message => emitted.push(message.id),
    onReady: value => { ready = value; controller.abort(); },
  });
  assert.deepEqual(emitted, ['question', 'answer']);
  assert.deepEqual(ready, { roomId, initialCount: 2 });
  assert.equal(calls.length, 1);
});

test('watch catches multipage bursts, deduplicates messages, and emits streamed edits', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const firstAnswer = assistant('answer', 'Partial', { inProgress: true, createdAt: '2026-10-17T10:00:02Z' });
  const finalAnswer = assistant('answer', 'Complete', { createdAt: '2026-10-17T10:00:02Z' });
  const firstUser = user('new_1', 'New 1', '2026-10-17T10:00:01Z');
  const secondUser = user('new_2', 'New 2', '2026-10-17T10:00:03Z');
  const { client, calls } = mockClient([
    { items: [user('old', 'Existing')], next_cursor: null },
    { items: [firstAnswer, firstUser], next_cursor: 'burst_page_2' },
    { items: [firstUser, secondUser], next_cursor: null },
    { items: [secondUser, finalAnswer, firstUser], next_cursor: null },
  ]);
  const emitted = [];
  await client.watch({ roomId, intervalMs: 1000, signal: controller.signal, onMessage: message => {
    emitted.push([message.id, message.text, message.inProgress]);
    if (message.id === 'answer' && !message.inProgress) controller.abort();
  } });
  assert.deepEqual(emitted, [
    ['new_1', 'New 1', false], ['answer', 'Partial', true], ['new_2', 'New 2', false], ['answer', 'Complete', false],
  ]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call.query.after), [undefined, 'old', 'burst_page_2', undefined]);
  assert.ok(calls.every(call => call.signal === controller.signal));
});

test('watch does not skip a burst arriving between cursor traversal and the latest snapshot', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const record = number => user(`m${number}`, `Message ${number}`, new Date(Date.UTC(2026, 9, 17, 10, 0, number)).toISOString());
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => record(from + offset));
  const emitted = [];
  const { client, calls } = mockClient([
    { items: [record(0)], next_cursor: null },
    { items: [record(1)], next_cursor: null },
    // Two hundred records arrive after the cursor traversal finishes. The
    // latest-page view can show only the final hundred; it is not a watermark.
    { items: range(102, 201), next_cursor: null },
    call => {
      assert.equal(call.query.after, 'm1');
      assert.deepEqual(emitted, ['m1'], 'unseen latest-page records must wait for ordered cursor traversal');
      return { items: range(2, 101), next_cursor: 'burst_page_2' };
    },
    call => {
      assert.equal(call.query.after, 'burst_page_2');
      return { items: range(102, 201), next_cursor: null };
    },
  ]);
  await client.watch({ roomId, intervalMs: 1000, signal: controller.signal, onMessage: message => {
    emitted.push(message.id);
    if (message.id === 'm201') controller.abort();
  } });
  assert.deepEqual(emitted, Array.from({ length: 201 }, (_, index) => `m${index + 1}`));
  assert.deepEqual(calls.map(call => call.query.after), [undefined, 'm0', undefined, 'm1', 'burst_page_2']);
});

test('resumed watch replays completed revisions without advancing past an unconsumed gap', { timeout: 5000 }, async () => {
  const controller = new AbortController(), emitted = [], anchors = [];
  const completed = assistant('saved_response', 'Finished while disconnected', { createdAt: '2026-10-17T10:00:00Z' });
  const gap = user('gap', 'Arrived during disconnect', '2026-10-17T10:00:01Z');
  const newest = user('newest', 'Recent snapshot item', '2026-10-17T10:00:02Z');
  const { client, calls } = mockClient([
    { items: [completed, newest] },
    call => {
      assert.equal(call.query.after, 'saved_response');
      assert.deepEqual(anchors, [], 'snapshot replay must not persist a newer anchor');
      return { items: [gap], next_cursor: 'next_page' };
    },
    { items: [newest] },
    { items: [completed, newest] },
  ]);
  let ready;
  await client.watch({ roomId, resumeAfter: 'saved_response', intervalMs: 1000, signal: controller.signal,
    onMessage: value => emitted.push([value.id, value.text]),
    onReady: value => { ready = value; },
    onCursor: value => { anchors.push(value.anchor); controller.abort(); },
  });
  assert.deepEqual(ready, { roomId, initialCount: 2, resumed: true, replayed: true });
  assert.deepEqual(emitted, [
    ['saved_response', 'Finished while disconnected'], ['newest', 'Recent snapshot item'],
    ['gap', 'Arrived during disconnect'],
  ]);
  assert.deepEqual(anchors, ['newest']);
  assert.deepEqual(calls.map(call => call.query.after), [undefined, 'saved_response', 'next_page', undefined]);
});

const browserAnnotations = {
  version: 1, context_file_id: 'file_context', annotations: [{
    comment: 'Change this label', target_label: 'Save', screenshot_file_id: 'file_screenshot',
    browser_annotation_kind: 'element', attached_browser_region: false, design_tweak: true,
    browser_selections: [
      { kind: 'element', immediate_text: 'Save', label: 'Button', element_type: 'button' },
      { kind: 'region', area_number: 2, immediate_text: null, label: null, element_type: null },
    ], design_tweak_changes: [{ property: 'opacity', previous_value: null, next_value: 0.8 }],
  }],
};

test('send includes task routing, Page context, and schema-validated browser annotations', async () => {
  const { client, calls } = mockClient([{ id: 'accepted' }]);
  const result = await client.send({ roomId, text: 'Make the selected change', taskId: 'task~1',
    replyTo: 'room~CalpicoMessage~1', pageContext: { page_id: 'page_1' }, browserAnnotations, idempotencyKey: key });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.task_id, 'task~1');
  assert.deepEqual(calls[0].body.page_context, { page_id: 'page_1' });
  assert.deepEqual(calls[0].body.message_metadata, { browser_annotations: browserAnnotations });
  assert.deepEqual(calls[0].body.reply_to, { message_id: 'room~CalpicoMessage~1' });
});

test('browser metadata validation accepts both schema entry points and clones validated metadata', () => {
  const source = structuredClone(browserAnnotations);
  const metadata = validateSendContext({ messageMetadata: { browser_annotations: source }, pageContext: { page_id: null } });
  assert.deepEqual(metadata.messageMetadata.browser_annotations, source);
  source.annotations[0].comment = 'Changed after validation';
  assert.equal(metadata.messageMetadata.browser_annotations.annotations[0].comment, 'Change this label');
  assert.deepEqual(metadata.pageContext, { page_id: null });
});

test('send rejects unsupported metadata, invalid context, and invalid task IDs before transport', async () => {
  const { client, calls } = mockClient([]);
  const changes = [
    { taskId: '../task' }, { taskId: '' }, { taskId: '.' }, { replyTo: '..' },
    { pageContext: null }, { pageContext: {} }, { pageContext: { page_id: 5 } },
    { pageContext: { page_id: 'page', url: 'https://example.com' } },
    { messageMetadata: { hidden: 'unreviewed value' } },
    { messageMetadata: { browser_annotations: browserAnnotations, hidden: true } },
    { browserAnnotations, messageMetadata: { browser_annotations: browserAnnotations } },
  ];
  for (const change of changes) await assert.rejects(client.send({ roomId, text: 'Hello', ...change }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});

test('browser annotation fields are strict, typed, and bounded before transport', async () => {
  const { client, calls } = mockClient([]);
  const cases = [
    annotation => { annotation.version = 2; },
    annotation => { annotation.context_file_id = ''; },
    annotation => { annotation.annotations = []; },
    annotation => { annotation.annotations[0].comment = 42; },
    annotation => { annotation.annotations[0].unknown = true; },
    annotation => { annotation.annotations[0].browser_annotation_kind = 'secret'; },
    annotation => { annotation.annotations[0].attached_browser_region = 'yes'; },
    annotation => { annotation.annotations[0].browser_selections[1].area_number = 1.2; },
    annotation => { annotation.annotations[0].browser_selections[1].label = 'not null'; },
    annotation => { annotation.annotations[0].design_tweak_changes[0].next_value = null; },
    annotation => { annotation.annotations[0].design_tweak_changes[0].previous_value = NaN; },
    annotation => { annotation.annotations[0].comment = 'x'.repeat(16384); },
  ];
  for (const change of cases) {
    const annotation = structuredClone(browserAnnotations); change(annotation);
    await assert.rejects(client.send({ roomId, text: 'Hello', browserAnnotations: annotation }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls.length, 0);
});

test('history passes exact task, reply-root, and around query contracts', async () => {
  const { client, calls } = mockClient([{ items: [] }, { items: [] }]);
  await client.history({ roomId, taskId: 'task~1', around: 'message~1', limit: 3 });
  await client.history({ roomId, taskId: 'task~1', replyRootMessageId: 'message~root', before: 'opaque+/=cursor', limit: 5 });
  assert.deepEqual(calls[0].query, { limit: 3, before: undefined, after: undefined, task_id: 'task~1', around: 'message~1' });
  assert.deepEqual(calls[1].query, { limit: 5, before: 'opaque+/=cursor', after: undefined, task_id: 'task~1', reply_root_message_id: 'message~root' });
});

test('history rejects ambiguous navigation and invalid filters before resolving a default room', async () => {
  const { client, calls } = mockClient([]);
  for (const options of [
    { before: 'a', around: 'b' }, { after: 'a', around: 'b' }, { before: null },
    { before: '' }, { after: 'a\nb' }, { taskId: 'a/b' }, { replyRootMessageId: '..' }, { around: '' },
  ]) await assert.rejects(client.history(options), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});

test('normalization retains safe visible message metadata and reaction counts', () => {
  const item = { ...user('message', 'Visible'), task_id: 'task', reply_root_message_id: 'root', request_id: 'request',
    sender: { name: 'The sender', hidden_analysis: 'PRIVATE' }, delivery_state: 'failed', delivery_error: 'Delivery unavailable',
    is_task_update: false, reactions: { user_a: '👍', user_b: '👍', user_c: '🎉' },
    message_metadata: { private: 'PRIVATE' }, token: 'PRIVATE' };
  const result = normalizeMessage(item);
  assert.equal(result.senderId, 'user_test');
  assert.equal(result.senderName, 'The sender');
  assert.equal(result.taskId, 'task');
  assert.equal(result.replyRootMessageId, 'root');
  assert.equal(result.requestId, 'request');
  assert.equal(result.deliveryState, 'failed');
  assert.equal(result.deliveryError, 'Delivery unavailable');
  assert.equal(result.isTaskUpdate, false);
  assert.deepEqual(result.reactions, [
    { emoji: '👍', count: 2, accountUserIds: ['user_a', 'user_b'] },
    { emoji: '🎉', count: 1, accountUserIds: ['user_c'] },
  ]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(normalizeMessage({ ...item, delivery_state: 'new-server-state' }).deliveryState, 'unknown');
  assert.equal(normalizeMessage({ ...item, hidden: true }), null);
});

test('room verifies identity and projects members and visible messages without raw fields', async () => {
  const { client, calls } = mockClient([{
    id: roomId, type: 'DM', app_source: 'chatgpt:messaging', name: 'Room', aeon_id: 'dot',
    last_read_at: '2026-10-17T10:00:00Z', updated_at: '2026-10-17T10:00:02Z',
    members: [{ account_user_id: 'user_test', name: '', avatar_url: 'PRIVATE' }, { account_user_id: 'dot_user', name: 'Dot', aeon_id: 'dot' }],
    member_profile_snapshots: [{ account_user_id: 'user_test', name: 'Owner', username: 'owner', access_token: 'PRIVATE' }],
    latest_messages: [assistant('answer', 'Visible'), { ...assistant('hidden', 'PRIVATE'), hidden: true }],
  }]);
  const result = await client.room({ roomId });
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}`);
  assert.deepEqual(result.members, [{ id: 'user_test', aeonId: null, name: 'Owner', username: 'owner' }, { id: 'dot_user', aeonId: 'dot', name: 'Dot', username: '' }]);
  assert.equal(result.lastReadAt, '2026-10-17T10:00:00Z');
  assert.deepEqual(result.messages.map(message => message.text), ['Visible']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('room rejects other room identities, non-Dot rooms, and malformed membership', async () => {
  for (const response of [
    { id: 'other', type: 'DM', app_source: 'chatgpt:messaging', members: [] },
    { id: roomId, type: 'GROUP_DM', app_source: 'chatgpt:messaging', members: [] },
    { id: roomId, type: 'DM', app_source: 'other', members: [] },
    { id: roomId, type: 'DM', app_source: 'chatgpt:messaging', members: null },
  ]) await assert.rejects(mockClient([response]).client.room({ roomId }), { code: 'INVALID_RESPONSE' });
});

test('typing and prepare each submit one explicit request and ignore response bytes', async () => {
  const { client, calls } = mockClient([Buffer.alloc(0), Buffer.from('private routing data')]);
  const controller = new AbortController();
  assert.deepEqual(await client.typing({ roomId, signal: controller.signal }), { roomId, completed: true });
  assert.deepEqual(await client.prepare({ roomId, signal: controller.signal }), { roomId, completed: true });
  assert.deepEqual(calls.map(call => [call.method, call.path, call.responseType]), [
    ['POST', `/backend-api/messaging/rooms/${roomId}/responding_heartbeat`, 'bytes'],
    ['POST', `/backend-api/messaging/rooms/${roomId}/aeon/prepare`, 'bytes'],
  ]);
  assert.ok(calls.every(call => call.signal === controller.signal && call.body === undefined));
});

test('typing and prepare do not retry uncertain writes', async () => {
  for (const operation of ['typing', 'prepare']) {
    const failure = new Error('Connection failed');
    const { client, calls } = mockClient([failure]);
    await assert.rejects(client[operation]({ roomId }), error => error === failure);
    assert.equal(calls.length, 1);
  }
});

test('task subscriptions validate IDs and project only the scoped topic', async () => {
  const { client, calls } = mockClient([{ topic_id: 'topic/task~1', access_token: 'PRIVATE' }]);
  assert.deepEqual(await client.taskSubscription({ roomId, taskId: 'task~1' }), { roomId, taskId: 'task~1', topicId: 'topic/task~1' });
  assert.equal(calls[0].path, `/backend-api/messaging/rooms/${roomId}/tasks/task~1/subscription`);
  const invalid = mockClient([]);
  await assert.rejects(invalid.client.taskSubscription({ taskId: '../task' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(invalid.calls.length, 0);
  for (const response of [{}, { topic_id: '' }, { topic_id: 'bad\ntopic' }]) await assert.rejects(mockClient([response]).client.taskSubscription({ roomId, taskId: 'task' }), { code: 'INVALID_RESPONSE' });
});

test('call attachments retain native identity, duration and outcome with the visible shared summary', () => {
  const message = assistant('calls', 'We discussed the release.', { inProgress: false });
  message.attachments = [
    { type: 'call', call_id: 'call_one', duration_ms: 123456, outcome: 'completed' },
    { type: 'call', call_id: 'call_two', duration_ms: 0, outcome: 'not_connected' },
  ];
  const result = normalizeMessage(message);
  assert.deepEqual(result.attachments, [
    { type: 'call', callId: 'call_one', durationMs: 123456, outcome: 'completed' },
    { type: 'call', callId: 'call_two', durationMs: 0, outcome: 'not_connected' },
  ]);
  assert.deepEqual(result.callHistory, { calls: result.attachments, summary: 'We discussed the release.', summarizing: false });
});
test('call-only messages remain visible while the native summary is being generated', () => {
  const message = assistant('call_pending', '', { inProgress: true });
  message.attachments = [{ type: 'call', call_id: 'call_pending', outcome: 'interrupted' }];
  const result = normalizeMessage(message);
  assert.equal(result.text, '');
  assert.deepEqual(result.callHistory, { calls: [{ type: 'call', callId: 'call_pending', outcome: 'interrupted' }], summary: '', summarizing: true });
});
test('call projection never includes provider payloads, transcripts, tokens or unverified participant metadata', () => {
  const message = assistant('call_private', 'Visible summary');
  message.raw_messages.push({ author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['PRIVATE_REASONING'] } });
  message.attachments = [{
    type: 'call', call_id: 'call_safe', duration_ms: 1000, outcome: 'failed',
    token: 'PRIVATE_TOKEN', authorization: 'PRIVATE_TOKEN', sdp: 'PRIVATE_SDP',
    transcript: 'PRIVATE_TRANSCRIPT', raw_messages: [{ content: 'PRIVATE_REASONING' }],
    participants: [{ name: 'PRIVATE_PARTICIPANT', access_token: 'PRIVATE_TOKEN' }],
    artifacts: [{ file_id: 'PRIVATE_ARTIFACT', download_url: 'https://example.test/?token=PRIVATE_TOKEN' }],
    error: { message: 'PRIVATE_ERROR' }, metadata: { provider_payload: 'PRIVATE_METADATA' },
  }];
  const result = normalizeMessage(message), serialized = JSON.stringify(result);
  assert.deepEqual(result.attachments, [{ type: 'call', callId: 'call_safe', durationMs: 1000, outcome: 'failed' }]);
  assert.ok(!serialized.includes('PRIVATE_'));
  assert.equal(result.callHistory.summary, 'Visible summary');
});
test('call identity is required and malformed scalar payloads do not throw', () => {
  for (const call_id of [undefined, null, {}, [], '', '../secret', 'https://example.test/token', 'bad\nline']) {
    const message = assistant('call_invalid', ''); message.attachments = [{ type: 'call', call_id }];
    assert.equal(normalizeMessage(message), null);
  }
  for (const attachment of [null, undefined, false, 12, 'payload', []]) {
    const message = assistant('primitive', ''); message.attachments = [attachment]; assert.equal(normalizeMessage(message), null);
  }
});
test('call duration validation prevents invalid, negative or unsafe values while retaining metadata', () => {
  for (const duration_ms of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1000', {}, null]) {
    const message = assistant('call_duration', ''); message.attachments = [{ type: 'call', call_id: 'call_safe', duration_ms }];
    assert.deepEqual(normalizeMessage(message).attachments, [{ type: 'call', callId: 'call_safe' }]);
  }
  const message = assistant('fractional', ''); message.attachments = [{ type: 'call', call_id: 'call_safe', duration_ms: 0.5 }];
  assert.equal(normalizeMessage(message).attachments[0].durationMs, 0.5);
});
test('call outcomes preserve established states and suppress arbitrary provider state', () => {
  for (const outcome of ['completed', 'ended', 'failed', 'interrupted', 'not_connected']) {
    const message = assistant('outcomes', ''); message.attachments = [{ type: 'call', call_id: 'call_safe', outcome }];
    assert.equal(normalizeMessage(message).attachments[0].outcome, outcome);
  }
  for (const outcome of ['PRIVATE_PROVIDER_ERROR', {}, [], false, 3]) {
    const message = assistant('unknown_outcome', ''); message.attachments = [{ type: 'call', call_id: 'call_safe', outcome }];
    const result = normalizeMessage(message); assert.equal(result.attachments[0].outcome, 'unknown');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR'));
  }
});
test('hidden, deleted, analysis and tool-recipient attachment records are excluded', () => {
  const flags = [{ hidden: true }, { is_hidden: true }, { is_visually_hidden_from_conversation: true },
    { metadata: { hidden: true } }, { metadata: { is_hidden: true } }, { metadata: { is_visually_hidden_from_conversation: true } },
    { channel: 'analysis' }, { metadata: { channel: 'analysis' } }, { recipient: 'python' }, { metadata: { recipient: 'python' } },
    { deleted_at: '2026-10-18' }, { deletedAt: '2026-10-18' }];
  for (const flag of flags) {
    const message = assistant('hidden_call', ''); message.attachments = [{ type: 'call', call_id: 'call_hidden', ...flag }];
    assert.equal(normalizeMessage(message), null, JSON.stringify(flag));
  }
});
test('inner raw-message metadata channels and recipients cannot become call summaries', () => {
  for (const metadata of [{ channel: 'analysis' }, { recipient: 'python' }]) {
    const message = assistant('summary_hidden', 'PRIVATE_SUMMARY'); message.raw_messages[0].metadata = metadata;
    message.attachments = [{ type: 'call', call_id: 'call_safe' }];
    const result = normalizeMessage(message); assert.equal(result.text, ''); assert.equal(result.callHistory.summary, '');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SUMMARY'));
  }
});
test('native nested files retain file compatibility and artifact reference identities alongside calls', () => {
  const message = assistant('call_file', 'Saved the recording.');
  message.attachments = [
    { type: 'call', call_id: 'call_one', duration_ms: 2500, outcome: 'completed' },
    { type: 'file', attachment_id: 'attachment_one', file: { id: 'file_one', name: 'notes.txt', mime_type: 'text/plain', size_bytes: 25, title: 'Meeting notes', download_url: 'PRIVATE_URL', access_token: 'PRIVATE_TOKEN' } },
    { type: 'post', post_id: 'post_one', conversation_id: 'conversation_one', title: 'Recap', messages: [{ role: 'system', content: 'PRIVATE_REASONING' }] },
    { type: 'thread', thread_id: 'thread_one' },
  ];
  const result = normalizeMessage(message);
  assert.deepEqual(result.attachments.slice(1), [
    { type: 'file', attachmentId: 'attachment_one', fileId: 'file_one', name: 'notes.txt', mimeType: 'text/plain', title: 'Meeting notes', sizeBytes: 25 },
    { type: 'post', title: 'Recap', postId: 'post_one', conversationId: 'conversation_one' },
    { type: 'thread', threadId: 'thread_one' },
  ]);
  assert.equal(result.callHistory.calls.length, 1); assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});
test('flat file attachment output remains compatible and hidden nested files are omitted', () => {
  const message = user('files', 'Here'); message.content.attachments = [
    { type: 'file', file_id: 'file_flat', name: 'plain.txt', mime_type: 'text/plain', size_bytes: 10, title: 'Plain' },
    { type: 'file', file: { id: 'file_hidden', hidden: true, name: 'PRIVATE' } },
  ];
  assert.deepEqual(normalizeMessage(message).attachments, [{ type: 'file', fileId: 'file_flat', name: 'plain.txt', mimeType: 'text/plain', title: 'Plain', sizeBytes: 10 }]);
});
test('history carries projected call metadata through its public result without mutating source data', async () => {
  const message = assistant('history_call', 'Recap'); message.attachments = [{ type: 'call', call_id: 'call_id', duration_ms: 8, outcome: 'completed' }];
  const before = JSON.stringify(message);
  const { client } = mockClient([{ items: [message] }]); const result = await client.history({ roomId });
  assert.equal(result.messages[0].callHistory.calls[0].durationMs, 8);assert.equal(JSON.stringify(message), before);
});

test('send accepts a Page comment thread only alongside its explicit Page identity', async () => {
  const pageContext = { page_id: 'page_one', thread_id: 'comment_thread_one' };
  assert.deepEqual(validateSendContext({ pageContext }), { pageContext });
  const { client, calls } = mockClient([{ id: 'sent_comment' }]);
  await client.send({ roomId, text: 'A comment reply', pageContext, idempotencyKey: key });
  assert.deepEqual(calls[0].body.page_context, pageContext);
  assert.equal(calls.length, 1);
});
test('Page comment context rejects missing/null Page, malformed thread and extra fields before transport', async () => {
  for (const pageContext of [
    { thread_id: 'thread' }, { page_id: null, thread_id: 'thread' },
    { page_id: 'page', thread_id: null }, { page_id: 'page', thread_id: '../thread' },
    { page_id: 'page', thread_id: 'bad\nthread' }, { page_id: 'page', thread_id: 'thread', raw: {} },
  ]) {
    const { client, calls } = mockClient([]);
    await assert.rejects(client.send({ roomId, text: 'reply', pageContext, idempotencyKey: key }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(validateSendContext({ pageContext: { page_id: null } }), { pageContext: { page_id: null } });
});

test('real user-shaped Dot replies are classified only by verified room AEON membership', async () => {
  const bot = { id: 'bot_message', role: 'user', account_user_id: 'opaque_bot_member', content: { text: 'DOT_REPLY' } };
  const human = { id: 'human_message', role: 'user', account_user_id: 'calpico-member-spoof-looking-human', content: { text: 'HUMAN' } };
  const room = { id: roomId, type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot_verified', members: [
    { account_user_id: 'opaque_bot_member', aeon_id: 'dot_verified' },
    { account_user_id: 'calpico-member-spoof-looking-human', aeon_id: null },
    { account_user_id: 'other_bot', aeon_id: 'different_dot' },
  ] };
  const { client, calls } = mockClient([{ items: [human, bot] }, room, { items: [bot] }]);
  const first = await client.history({ roomId });
  assert.equal(first.messages.find(m => m.id === 'bot_message').role, 'assistant');
  assert.equal(first.messages.find(m => m.id === 'human_message').role, 'user');
  const second = await client.history({ roomId });assert.equal(second.messages[0].role, 'assistant');
  assert.equal(calls.length, 3);assert.equal(calls[1].path, `/backend-api/messaging/rooms/${roomId}`);
  assert.equal(bot.role, 'user');
});
test('unknown or mismatched room membership never upgrades a sender to assistant', async () => {
  const wire = { id: 'reply', role: 'user', account_user_id: 'calpico-member-any', content: { text: 'visible' } };
  assert.equal(normalizeMessage(wire).role, 'user');
  assert.equal(normalizeMessage(wire, { assistantSenderIds: new Set(['different']) }).role, 'user');
  const { client } = mockClient([{ items: [wire] }, { id: 'other_room', type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot', members: [] }]);
  await assert.rejects(client.history({ roomId }), { code: 'INVALID_RESPONSE' });
});
test('room latest messages use verified membership and preserve hidden/system/tool handling', async () => {
  const wire = { id: 'reply', role: 'user', account_user_id: 'bot', content: { text: 'visible' } };
  const { client } = mockClient([{ id: roomId, type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot', members: [{ account_user_id: 'bot', aeon_id: 'dot' }], latest_messages: [wire, { ...wire, id: 'hidden', metadata: { channel: 'analysis' } }, { id: 'system', role: 'system', content: { text: 'System' } }, { id: 'tool', role: 'tool', content: { text: 'Tool' } }] }]);
  const result = await client.room({ roomId });
  assert.equal(result.messages.find(m=>m.id==='reply').role,'assistant');
  assert.ok(!result.messages.some(m=>m.id==='hidden'));
  assert.notEqual(result.messages.find(m=>m.id==='system').role,'assistant');
  assert.notEqual(result.messages.find(m=>m.id==='tool').role,'assistant');
});

test('full cursorless room pages expose real message-ID boundaries instead of false EOF', async () => {
  const wire = [user('first', 'one', '2026-10-18T10:00:00Z'), user('second', 'two', '2026-10-18T10:00:01Z')];
  const { client } = mockClient([{ items: wire }, { items: wire }, { items: wire }, { items: wire }, { items: wire }]);
  const backward = await client.history({ roomId, limit: 2 });assert.equal(backward.prevCursor, 'first');assert.equal(backward.nextCursor,null);
  const forward = await client.history({ roomId, limit: 2, after: 'earlier' });assert.equal(forward.nextCursor,'second');
  assert.equal((await client.history({roomId,limit:2,taskId:'task'})).prevCursor,null);
  assert.equal((await client.history({roomId,limit:2,replyRootMessageId:'root'})).prevCursor,null);
  assert.equal((await client.history({roomId,limit:2,around:'around'})).prevCursor,null);
});

test('cursor fallback counts hidden wire records, stops on short pages and honors server cursors', async () => {
  const hidden={...user('hidden','PRIVATE','2026-10-18T10:00:00Z'),hidden:true};
  const visible=user('visible','Public','2026-10-18T10:00:01Z');
  const {client}=mockClient([{items:[hidden,visible]},{items:[visible]},{items:[hidden,visible],prev_cursor:'server-before',next_cursor:'server-after'}]);
  const full=await client.history({roomId,limit:2});assert.equal(full.prevCursor,'hidden');assert.deepEqual(full.messages.map(m=>m.id),['visible']);
  const terminal=await client.history({roomId,limit:2,after:'older'});assert.equal(terminal.prevCursor,null);assert.equal(terminal.nextCursor,null);
  const server=await client.history({roomId,limit:2,after:'older'});assert.equal(server.prevCursor,'server-before');assert.equal(server.nextCursor,'server-after');
});
