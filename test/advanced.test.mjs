import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, readdir, open, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullDotClient } from '../src/advanced.mjs';

const roomId = 'room_explicit';
const key = 'b1b7788f-0b32-4386-a7da-ce111700ee23';
const when = second => new Date(Date.UTC(2026, 9, 17, 10, 0, second)).toISOString();
const message = (id, text = id, second = 0) => ({ id, account_user_id: 'user_1', content: { text }, created_at: when(second) });
const answer = (id, text, second = 1, extra = {}) => ({ id, created_at: when(second), raw_messages: [
  { author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: [text] } }
], ...extra });
const page = (items = [], extra = {}) => ({ items, ...extra });

function mockClient(responses = []) {
  const calls = [];
  const client = new FullDotClient({ transport: { async request(method, path, options = {}) {
    const call = { method, path, ...options }; calls.push(call);
    assert.ok(calls.length <= responses.length, `Unexpected request ${method} ${path}`);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(call) : response;
  } } });
  return { client, calls };
}
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-advanced-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('historyPages keeps an explicit room across pages, deduplicates and retains the newer message version', async () => {
  const { client, calls } = mockClient([
    page([message('m2', 'Old version', 2), message('m3', 'Newest', 3)], { prev_cursor: 'older_page' }),
    page([message('m1', 'Oldest', 1), message('m2', 'Corrected version', 2)]),
    page([])
  ]);
  const result = await client.historyPages({ roomId, pages: 5, limit: 2 });
  assert.deepEqual(result.messages.map(item => [item.id, item.text]), [['m1', 'Oldest'], ['m2', 'Corrected version'], ['m3', 'Newest']]);
  assert.equal(result.roomId, roomId);
  assert.equal(result.pagesRead, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(calls.map(call => call.query.before), [undefined, 'older_page', 'm1']);
  assert.ok(calls.every(call => call.path === `/backend-api/messaging/rooms/${roomId}/messages`));
});

test('historyPages resolves the primary only once and paginates forward with next cursors', async () => {
  const { client, calls } = mockClient([
    { selection: { available: true, messaging_room_id: roomId, aeon_id: 'dot_1' } },
    page([message('m1', 'First', 1)], { next_cursor: 'forward_page' }),
    page([message('m2', 'Second', 2)], { next_cursor: 'not_consumed' })
  ]);
  const result = await client.historyPages({ after: 'start', pages: 2 });
  assert.deepEqual(calls.map(call => call.query?.after), [undefined, 'start', 'forward_page']);
  assert.equal(calls.filter(call => call.path === '/backend-api/tbo/primary').length, 1);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, 'not_consumed');
});

test('historyPages rejects repeated cursors instead of returning an incomplete successful export', async () => {
  const { client, calls } = mockClient([page([], { prev_cursor: 'same' }), page([], { prev_cursor: 'same' })]);
  await assert.rejects(client.historyPages({ roomId, pages: 4 }), { code: 'CURSOR_LOOP' });
  assert.equal(calls.length, 2);
});

test('historyPages validates page limits before any API request', async () => {
  const { client, calls } = mockClient();
  for (const pages of [0, 101, 1.5, NaN]) await assert.rejects(client.historyPages({ roomId, pages }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});

test('search all scans each unique room and applies inclusive date bounds case-insensitively', async () => {
  const { client, calls } = mockClient([
    { items: [
      { id: 'dot_1', messaging_room_id: 'room_one' }, { id: 'dot_2', messaging_room_id: 'room_two' },
      { id: 'dot_duplicate', messaging_room_id: 'room_one' }, { id: 'dot_no_room' }
    ] },
    page([message('before', 'Banana', 0), message('lower', 'BANANA lower', 1), message('after', 'banana', 4)]),
    page([message('upper', 'Banana upper', 3), message('unmatched', 'Orange', 2)])
  ]);
  const result = await client.search({ query: 'banana', all: true, since: when(1), until: when(3) });
  assert.deepEqual(result.matches.map(item => [item.id, item.roomId]), [['lower', 'room_one'], ['upper', 'room_two']]);
  assert.equal(result.scanned, 5);
  assert.equal(result.rooms, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(calls.slice(1).map(call => call.path), [
    '/backend-api/messaging/rooms/room_one/messages', '/backend-api/messaging/rooms/room_two/messages'
  ]);
});

test('search validates conflicting scope, query and dates before network access', async () => {
  const { client, calls } = mockClient();
  for (const options of [
    { query: '' }, { query: 'a'.repeat(4097) }, { query: 'x', all: true, roomId },
    { query: 'x', since: 'not a date' }, { query: 'x', since: when(3), until: when(1) }
  ]) await assert.rejects(client.search(options), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
});

test('thread forwards its reply-root filter on every paginated request', async () => {
  const { client, calls } = mockClient([page([message('m1')], { prev_cursor: 'older' }), page([message('m2')])]);
  await client.thread({ roomId, messageId: 'root~message.1', pages: 2 });
  assert.ok(calls.every(call => call.query.reply_root_message_id === 'root~message.1'));
  assert.equal(calls[1].query.before, 'older');
  await assert.rejects(client.thread({ roomId, messageId: '../bad' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 2);
});

test('outline contains only visible previews and attachment counts', async () => {
  const visible = answer('visible', 'V'.repeat(250), 2);
  visible.raw_messages.push({ author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['private reasoning'] } });
  visible.attachments = [{ type: 'file', file_id: 'file_1', name: 'document.txt' }];
  const { client } = mockClient([page([
    { ...message('hidden', 'private hidden'), metadata: { is_hidden: true } },
    { ...message('deleted', 'private deleted'), deleted_at: when(1) },
    { ...message('tool', 'private tool'), recipient: 'functions.exec' }, visible
  ])]);
  const result = await client.outline({ roomId });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].preview, 'V'.repeat(200));
  assert.equal(result.messages[0].attachments, 1);
  assert.deepEqual(Object.keys(result.messages[0]).sort(), ['attachments', 'createdAt', 'id', 'preview', 'replyTo', 'role']);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('raw_messages'));
});

test('export creates a private file and never overwrites without explicit consent', async t => {
  const dir = await scratch(t), output = join(dir, 'history.json');
  const { client } = mockClient([page([message('m1', 'Visible')]), page([message('m2', 'Replacement')])]);
  const result = await client.exportHistory({ roomId, output });
  assert.equal(result.path, await realpath(output));
  assert.equal(result.messageCount, 1);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  const saved = await readFile(output, 'utf8');
  assert.equal(JSON.parse(saved).messages[0].text, 'Visible');
  await assert.rejects(client.exportHistory({ roomId, output }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(output, 'utf8'), saved);
  assert.deepEqual(await readdir(dir), ['history.json']);
});

test('explicit export overwrite atomically replaces the file rather than modifying an open inode', async t => {
  const dir = await scratch(t), output = join(dir, 'history.md');
  await writeFile(output, 'original', { mode: 0o644 });
  const old = await open(output, 'r');
  t.after(() => old.close());
  const { client } = mockClient([page([message('m1', 'New visible text')])]);
  await client.exportHistory({ roomId, output, format: 'md', overwrite: true });
  assert.equal(await old.readFile('utf8'), 'original');
  assert.match(await readFile(output, 'utf8'), /New visible text/);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['history.md']);
});

test('export refuses symlink targets and leaves linked content intact', async t => {
  const dir = await scratch(t), target = join(dir, 'target'), output = join(dir, 'link');
  await writeFile(target, 'private existing'); await symlink(target, output);
  const { client } = mockClient([page([message('m1')])]);
  await assert.rejects(client.exportHistory({ roomId, output, overwrite: true }), { code: 'INVALID_OUTPUT' });
  assert.equal(await readFile(target, 'utf8'), 'private existing');
  assert.deepEqual((await readdir(dir)).sort(), ['link', 'target']);
});

test('send rejects invalid text, keys and reply IDs before uploading any file', async t => {
  const dir = await scratch(t), file = join(dir, 'upload.txt'); await writeFile(file, 'data');
  const { client, calls } = mockClient(); let uploads = 0;
  client.upload = async () => { uploads++; return { fileId: 'file_uploaded' }; };
  for (const options of [
    { text: 'a'.repeat(64001) }, { text: 'invalid\0text' }, { text: 42 },
    { text: 'valid', idempotencyKey: 'invalid' }, { text: 'valid', replyTo: 'invalid/reply' }, { text: 'valid', waitSeconds: -1 }
  ]) await assert.rejects(client.send({ roomId, files: [file], ...options }));
  assert.equal(uploads, 0); assert.equal(calls.length, 0);
});

test('send prevalidates every local file before uploading the first', async t => {
  const dir = await scratch(t), valid = join(dir, 'valid.txt'), empty = join(dir, 'empty.txt'), linked = join(dir, 'link.txt');
  await writeFile(valid, 'data'); await writeFile(empty, ''); await symlink(valid, linked);
  const { client, calls } = mockClient(); let uploads = 0;
  client.upload = async () => { uploads++; return { fileId: 'uploaded' }; };
  for (const invalid of [empty, linked, join(dir, 'missing.txt'), dir]) {
    await assert.rejects(client.send({ roomId, text: 'Message', files: [valid, invalid] }), { code: 'INVALID_FILE' });
  }
  assert.equal(uploads, 0); assert.equal(calls.length, 0);
});

test('send validates attachment IDs before it creates uploaded artifacts', async t => {
  const dir = await scratch(t), file = join(dir, 'valid.txt'); await writeFile(file, 'data');
  const { client, calls } = mockClient(); let uploads = 0;
  client.upload = async () => { uploads++; return { fileId: 'uploaded' }; };
  for (const attachmentIds of [['bad/id'], 'file_1', [42], [null]]) {
    await assert.rejects(client.send({ roomId, text: 'Message', files: [file], attachmentIds }), { code: 'INVALID_FILE' });
  }
  assert.equal(uploads, 0); assert.equal(calls.length, 0);
});

test('send forwards existing and newly uploaded file IDs, reply and request key exactly once', async t => {
  const dir = await scratch(t), first = join(dir, 'first.txt'), second = join(dir, 'second.txt');
  await writeFile(first, 'first'); await writeFile(second, 'second');
  const { client, calls } = mockClient([{ id: 'accepted', created_at: when(2) }]);
  const uploads = [];
  client.upload = async options => { uploads.push(options); return { fileId: uploads.length === 1 ? 'file_first' : 'file_second' }; };
  const signal = new AbortController().signal;
  const result = await client.send({ roomId, text: 'Hello', attachmentIds: ['file_existing'], files: [first, second], replyTo: 'message~parent', idempotencyKey: key, signal });
  assert.equal(result.messageId, 'accepted'); assert.equal(result.accepted, true);
  assert.deepEqual(uploads, [{ roomId, file: first, signal }, { roomId, file: second, signal }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, key);
  assert.deepEqual(calls[0].body, { content: { text: 'Hello', attachments: [
    { type: 'file', file_id: 'file_existing' }, { type: 'file', file_id: 'file_first' }, { type: 'file', file_id: 'file_second' }
  ] }, request_id: key, idempotency_token: key, timezone_offset_min: new Date().getTimezoneOffset(), reply_to: { message_id: 'message~parent' } });
});

test('wait preserves accepted receipt when subsequent polling fails and never resends', async () => {
  const failure = Object.assign(new Error('edge challenge'), { code: 'EDGE_CHALLENGE' });
  const { client, calls } = mockClient([{ id: 'accepted', created_at: when(0) }, failure]);
  const result = await client.send({ roomId, text: 'Hello', idempotencyKey: key, waitSeconds: 1 });
  assert.equal(result.accepted, true); assert.equal(result.messageId, 'accepted'); assert.equal(result.idempotencyKey, key);
  assert.deepEqual(result.wait, { status: 'interrupted', error: 'EDGE_CHALLENGE', messages: [] });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(calls[1].query.after, 'accepted');
});

test('wait reports observed assistant reply separately from acceptance', async () => {
  const { client, calls } = mockClient([{ id: 'accepted' }, page([message('someone', 'Another user', 1), answer('reply', 'Done', 2)])]);
  const result = await client.send({ roomId, text: 'Hello', waitSeconds: 1 });
  assert.equal(result.accepted, true); assert.equal(result.wait.status, 'observed');
  assert.deepEqual(result.wait.messages.map(item => item.id), ['reply']);
  assert.match(result.wait.correlation, /after accepted send/);
  assert.equal(calls.length, 2);
});

test('wait drains hidden and visible cursor pages before checking for assistant replies', async () => {
  const hidden = { ...message('hidden', 'Private', 1), metadata: { is_hidden: true } };
  const { client, calls } = mockClient([
    { id: 'accepted' },
    page([hidden], { next_cursor: 'hidden_page' }),
    page([message('someone', 'Another user', 2)], { next_cursor: 'reply_page' }),
    page([answer('reply', 'Completed after the backlog', 3)]),
  ]);
  const result = await client.send({ roomId, text: 'Hello', waitSeconds: 1 });
  assert.equal(result.accepted, true); assert.equal(result.wait.status, 'observed');
  assert.deepEqual(result.wait.messages.map(item => item.id), ['reply']);
  assert.deepEqual(calls.slice(1).map(call => call.query.after), ['accepted', 'hidden_page', 'reply_page']);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('wait preserves the accepted receipt when reply pagination loops or fails', async () => {
  for (const responses of [
    [page([], { next_cursor: 'repeated' }), page([], { next_cursor: 'repeated' })],
    [page([], { next_cursor: 'second' }), Object.assign(new Error('Read failed'), { code: 'RATE_LIMITED' })],
  ]) {
    const { client, calls } = mockClient([{ id: 'accepted' }, ...responses]);
    const result = await client.send({ roomId, text: 'Hello', waitSeconds: 1 });
    assert.equal(result.accepted, true); assert.equal(result.messageId, 'accepted');
    assert.equal(result.wait.status, 'interrupted');
    assert.equal(result.wait.error, responses[1] instanceof Error ? 'RATE_LIMITED' : 'CURSOR_LOOP');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('wait stops after 100 reply pages and retains its acceptance receipt', async () => {
  const { client, calls } = mockClient([
    { id: 'accepted' },
    ...Array.from({ length: 100 }, (_, index) => page([], { next_cursor: `page_${index + 1}` })),
  ]);
  const result = await client.send({ roomId, text: 'Hello', waitSeconds: 1 });
  assert.equal(result.accepted, true); assert.equal(result.messageId, 'accepted');
  assert.equal(result.wait.status, 'interrupted'); assert.equal(result.wait.error, 'PAGE_LIMIT');
  assert.equal(calls.length, 101); assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('resumable watch drains all cursor pages before persisting its new anchor', { timeout: 5000 }, async t => {
  const dir = await scratch(t), cursorFile = join(dir, 'cursor.json');
  await writeFile(cursorFile, JSON.stringify({ version: 1, roomId, anchor: 'm0' }), { mode: 0o600 });
  const controller = new AbortController(), emitted = [], persisted = [];
  const { client, calls } = mockClient([
    page([message('m0', 'Replayed snapshot', 0)]),
    page([message('m1', 'First', 1)], { next_cursor: 'page_2' }),
    async call => {
      assert.equal(call.query.after, 'page_2');
      assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).anchor, 'm0');
      return page([message('m1', 'First', 1), message('m2', 'Second', 2), message('m3', 'Third', 3)]);
    },
    // New arrivals in the latest snapshot must not replace the drained cursor.
    page([message('m99', 'Not yet traversed', 59)])
  ]);
  let ready;
  await client.watch({ roomId, cursorFile, intervalMs: 1000, signal: controller.signal,
    onMessage: item => emitted.push(item.id), onReady: value => { ready = value; },
    onCursor: async value => { persisted.push(value.anchor); assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).anchor, value.anchor); controller.abort(); }
  });
  assert.deepEqual(ready, { roomId, initialCount: 1, resumed: true, replayed: true });
  assert.deepEqual(emitted, ['m0', 'm1', 'm2', 'm3']); assert.deepEqual(persisted, ['m3']);
  assert.deepEqual(calls.map(call => call.query.after), [undefined, 'm0', 'page_2', undefined]);
  assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).anchor, 'm3');
  assert.equal((await lstat(cursorFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['cursor.json']);
});

test('failed backlog traversal retains old cursor and removes only its own lock', { timeout: 5000 }, async t => {
  const dir = await scratch(t), cursorFile = join(dir, 'cursor.json');
  await writeFile(cursorFile, JSON.stringify({ version: 1, roomId, anchor: 'm0' }));
  const failure = Object.assign(new Error('rate limit'), { code: 'RATE_LIMITED' });
  const { client, calls } = mockClient([page([]), page([message('m1')], { next_cursor: 'page_2' }), failure]);
  const emitted = [];
  await assert.rejects(client.watch({ roomId, cursorFile, intervalMs: 1000, onMessage: item => emitted.push(item.id) }), { code: 'RATE_LIMITED' });
  assert.deepEqual(emitted, ['m1']);
  assert.equal(JSON.parse(await readFile(cursorFile, 'utf8')).anchor, 'm0');
  assert.deepEqual(await readdir(dir), ['cursor.json']); assert.equal(calls.length, 3);
});

test('cursor room mismatch and incompatible from-start are rejected before requests or lock creation', async t => {
  const dir = await scratch(t), cursorFile = join(dir, 'cursor.json');
  const { client, calls } = mockClient();
  await writeFile(cursorFile, JSON.stringify({ version: 1, roomId: 'room_other', anchor: 'm0' }));
  await assert.rejects(client.watch({ roomId, cursorFile }), { code: 'INVALID_STATE' });
  await writeFile(cursorFile, JSON.stringify({ version: 1, roomId, anchor: 'm0' }));
  await assert.rejects(client.watch({ roomId, cursorFile, fromStart: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0); assert.deepEqual(await readdir(dir), ['cursor.json']);
});

test('existing cursor lock is retained and no watch requests are sent', async t => {
  const dir = await scratch(t), cursorFile = join(dir, 'cursor.json'), lock = `${cursorFile}.lock`;
  await writeFile(lock, 'other process');
  const { client, calls } = mockClient();
  await assert.rejects(client.watch({ roomId, cursorFile }), { code: 'CURSOR_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), 'other process'); assert.equal(calls.length, 0);
});

test('new cursor stores initial anchor privately and cleans lock on immediate cancellation', async t => {
  const dir = await scratch(t), cursorFile = join(dir, 'cursor.json'), controller = new AbortController();
  const { client, calls } = mockClient([page([message('initial', 'Visible')])]);
  await client.watch({ roomId, cursorFile, signal: controller.signal, onReady: () => controller.abort() });
  assert.deepEqual(JSON.parse(await readFile(cursorFile, 'utf8')), { version: 1, roomId, anchor: 'initial' });
  assert.equal((await lstat(cursorFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['cursor.json']); assert.equal(calls.length, 1);
});

test('watchAll tags room identity and deduplicates shared rooms', async () => {
  const client = new FullDotClient({ transport: { request() { throw new Error('unexpected'); } } });
  client.listDots = async () => [{ id: 'dot1', roomId: 'room1' }, { id: 'alias', roomId: 'room1' }, { id: 'dot2', roomId: 'room2' }];
  const visited = [], messages = [];
  client.watch = async options => {
    visited.push(options.roomId);
    await options.onMessage({ id: 'm', role: 'assistant', text: 'Hello' });
  };
  await client.watchAll({ onMessage: message => messages.push(message) });
  assert.deepEqual(visited.sort(), ['room1', 'room2']);
  assert.deepEqual(messages.map(message => message.roomId).sort(), ['room1', 'room2']);
  await assert.rejects(client.watchAll({ cursorFile: '/tmp/state' }), { code: 'INVALID_ARGUMENT' });
});

test('reply wait observes current user-shaped Dot replies through verified room membership', async () => {
  const { client, calls } = mockClient([
    { id: 'sent', created_at: when(0) },
    page([{ id: 'dot_reply', role: 'user', account_user_id: 'opaque_dot_member', content: { text: 'EXACT_MARKER' }, created_at: when(1) }]),
    { id: roomId, type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'selected_dot', members: [{ account_user_id: 'human', aeon_id: null }, { account_user_id: 'opaque_dot_member', aeon_id: 'selected_dot' }] },
  ]);
  const result = await client.send({ roomId, text: 'Reply with EXACT_MARKER', idempotencyKey: key, waitSeconds: 0.02 });
  assert.equal(result.accepted, true);assert.equal(result.wait.status, 'observed');
  assert.equal(result.wait.messages[0].role, 'assistant');assert.equal(result.wait.messages[0].text, 'EXACT_MARKER');
  assert.equal(result.wait.correlation, 'messages after accepted send in this room');
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
});

test('cursorless repeated full pages fail instead of looping or claiming complete history', async () => {
  const same=page([message('m1'),message('m2')]);const {client,calls}=mockClient([same,same]);
  await assert.rejects(client.historyPages({roomId,limit:2,pages:4}),{code:'CURSOR_LOOP'});assert.equal(calls.length,2);
});
test('cursorless forward pages traverse in the after direction and stop on a short page', async () => {
  const {client,calls}=mockClient([page([message('m1','one',1),message('m2','two',2)]),page([message('m3','three',3)])]);
  const result=await client.historyPages({roomId,after:'start',limit:2,pages:4});
  assert.deepEqual(calls.map(c=>c.query.after),['start','m2']);assert.deepEqual(result.messages.map(m=>m.id),['m1','m2','m3']);assert.equal(result.pagesRead,2);assert.equal(result.truncated,false);
});
