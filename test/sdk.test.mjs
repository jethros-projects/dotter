import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createClient, DotterClient, DotterError, ErrorCode } from '../src/index.mjs';
import { DotError } from '../src/errors.mjs';
import { run } from '../src/cli.mjs';

const ROOM = 'room_1';
const KEY = '11111111-2222-4333-8444-555555555555';
const DATE = '2026-10-19T10:00:00.000Z';
const MESSAGE_ROUTE = `/backend-api/messaging/rooms/${ROOM}/messages`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const output = () => ({ text: '', write(value) { this.text += value; return true; } });
const rawMessage = (overrides = {}) => ({ id: 'message_1', role: 'assistant', content: { text: 'Hello' }, created_at: DATE, ...overrides });

function transport(handler = () => assert.fail('Unexpected transport request')) {
  const calls = [];
  return {
    calls,
    async request(method, route, options = {}) {
      calls.push({ method, route, options });
      assert.ok(options.signal instanceof AbortSignal, 'Every native request receives a lifecycle signal');
      return handler(method, route, options);
    },
  };
}

function client(t, options = {}) {
  const result = createClient(options);
  t.after(() => result.close());
  return result;
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dotter-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function watcher(t, overrides = {}) {
  const started = deferred();
  let callbacks;
  const api = client(t, { nativeClient: {
    async watch(options) {
      callbacks = options;
      started.resolve();
      if (overrides.watch) return overrides.watch(options);
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    },
    ...overrides,
  } });
  const subscription = await api.watch({ roomId: ROOM, bufferSize: 8 });
  await started.promise;
  return { api, subscription, callbacks };
}

test('SDK construction, capabilities and error constants are available offline', async t => {
  let loads = 0;
  const wire = transport();
  const api = client(t, { transport: wire, auth: { async load() { loads++; assert.fail('Capabilities must not load credentials'); } } });
  assert.ok(api instanceof DotterClient);
  const capabilities = api.capabilities();
  assert.equal(capabilities.service, 'dot');
  assert.deepEqual(capabilities.targets, ['roomId', 'dotId']);
  assert.equal(capabilities.send, true);
  assert.equal(capabilities.watchDelivery, 'at-least-once');
  assert.equal(capabilities.maxAttachments, 10);
  assert.equal(capabilities.maxUploadBytes, 20 * 1024 * 1024);
  assert.equal(capabilities.upload, false, 'A request-only injected transport cannot upload files');
  assert.equal(capabilities.download, false, 'A request-only injected transport cannot download bytes');
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(ErrorCode.ABORTED, 'ABORTED');
  assert.equal(Object.isFrozen(ErrorCode), true);
  assert.equal(loads, 0);
  assert.equal(wire.calls.length, 0);
});

test('SDK rejects invalid inputs before auth, file access or transport access', async t => {
  const wire = transport();
  let loads = 0;
  const api = client(t, { transport: wire, auth: { async load() { loads++; assert.fail('Invalid inputs must not authenticate'); } } });
  const invalid = [
    () => api.send({ roomId: ROOM, text: '' }),
    () => api.send({ roomId: ROOM, text: 'x', waitTimeoutMs: 5 }),
    () => api.send({ roomId: ROOM, text: 'x', wait: 'true' }),
    () => api.send({ roomId: ROOM, text: 'x', attachments: ['/does/not/exist'], attachmentIds: Array(10).fill('file_1') }),
    () => api.send({ roomId: ROOM, text: 'x', attachments: [{ path: '/does/not/exist', name: '../secret' }] }),
    () => api.send({ roomId: ROOM, dotId: 'dot_1', text: 'x', attachments: ['/does/not/exist'] }),
    () => api.send({ roomId: ROOM, text: 'x', idempotencyKey: 'bad' }),
    () => api.send({ roomId: ROOM, text: 'x', private_wire_field: true }),
    () => api.send({ roomId: ROOM, text: 'x', replyToMessageId: 'message_1', replyTo: 'message_1' }),
    () => api.history({ roomId: ROOM, limit: 21 }),
    () => api.history({ before: 'one', after: 'two' }),
    () => api.history({ around: 'message_1', pages: 1 }),
    () => api.search({ query: '', dotId: 'dot_1' }),
    () => api.search({ query: 'x', all: true, roomId: ROOM }),
    () => api.search({ query: 'x', since: '2026-10-20', until: '2026-10-19' }),
    () => api.watch({ roomId: ROOM, bufferSize: 0 }),
    () => api.watch({ all: true, resumeAfter: 'message_1' }),
    () => api.watch({ resumeAfter: 'message_1', cursorFile: '/does/not/exist' }),
    () => api.upload({ roomId: ROOM, path: '/does/not/exist', mimeType: 'invalid' }),
    () => api.download({ roomId: ROOM, fileId: '../secret' }),
    () => api.artifacts({ roomId: ROOM, pages: 0 }),
    () => api.history({}, { timeoutMs: 0 }),
    () => api.history({}, { signal: {} }),
  ];
  for (const invoke of invalid) await assert.rejects(invoke, error => error instanceof DotterError && error.code === 'INVALID_ARGUMENT');
  await assert.rejects(api.upload({ path: '/does/not/exist', stateFile: '/does/not/exist', name: 'custom.txt' }), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(loads, 0);
  assert.equal(wire.calls.length, 0);
});

test('SDK send defaults to acceptance and forwards explicit target, request key and context', async t => {
  const wire = transport((method, route, options) => {
    assert.equal(method, 'POST');
    assert.equal(route, MESSAGE_ROUTE);
    assert.equal(options.idempotencyKey, KEY);
    assert.equal(options.body.request_id, KEY);
    assert.equal(options.body.idempotency_token, KEY);
    assert.deepEqual(options.body.content, { text: 'Ship it' });
    assert.deepEqual(options.body.reply_to, { message_id: 'parent_1' });
    assert.equal(options.body.task_id, 'task_1');
    assert.deepEqual(options.body.page_context, { page_id: 'page_1', thread_id: 'thread_1' });
    return { id: 'sent_1', created_at: DATE };
  });
  const api = client(t, { transport: wire });
  assert.deepEqual(await api.send({ roomId: ROOM, text: 'Ship it', replyToMessageId: 'parent_1', taskId: 'task_1', pageContext: { page_id: 'page_1', thread_id: 'thread_1' }, idempotencyKey: KEY }), {
    accepted: true, roomId: ROOM, messageId: 'sent_1', idempotencyKey: KEY, createdAt: DATE,
  });
  assert.equal(wire.calls.length, 1, 'The default send must not poll history or imply background completion');
});

test('SDK resolves dotId through the native profile and exposes the resolved room', async t => {
  const wire = transport((method, route) => {
    if (route === '/backend-api/tbo/dot_1') return { id: 'dot_1', display_name: 'Dot', messaging_room_id: ROOM };
    assert.equal(method, 'GET');
    assert.equal(route, MESSAGE_ROUTE);
    return { items: [] };
  });
  const api = client(t, { transport: wire });
  const result = await api.history({ dotId: 'dot_1' });
  assert.equal(result.roomId, ROOM);
  assert.equal(result.hasMore, false);
  assert.equal(wire.calls.length, 2);
});

test('SDK history and search expose streaming and replyToMessageId without private message content', async t => {
  const wire = transport((method, route) => {
    assert.equal(method, 'GET');
    assert.equal(route, MESSAGE_ROUTE);
    return { items: [
      rawMessage({ generation: { status: 'in_progress' }, reply_to: { message_id: 'parent_1' }, raw_messages: [
        { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Visible answer'] } },
        { author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['private thinking'] } },
      ] }),
      rawMessage({ id: 'hidden_1', hidden: true, content: { text: 'private content' } }),
    ], prev_cursor: 'opaque:before' };
  });
  const api = client(t, { transport: wire });
  const page = await api.history({ roomId: ROOM, before: 'opaque:cursor', limit: 10 });
  assert.equal(page.hasMore, true);
  assert.equal(page.prevCursor, 'opaque:before');
  assert.equal(page.messages.length, 1);
  const [message] = page.messages;
  assert.equal(message.streaming, true);
  assert.equal(message.replyToMessageId, 'parent_1');
  assert.equal(message.text, 'Visible answer');
  assert.equal('inProgress' in message, false);
  assert.equal('replyTo' in message, false);
  assert.equal('raw_messages' in message, false);
  assert.equal(wire.calls[0].options.query.before, 'opaque:cursor');
  const found = await api.search({ roomId: ROOM, query: 'visible', pages: 1 });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].streaming, true);
  assert.equal(found.matches[0].replyToMessageId, 'parent_1');
  assert.equal(found.matches[0].roomId, ROOM);
  assert.equal(found.truncated, true);
});

test('SDK explicitly waits and normalizes observed reply messages', async t => {
  const wire = transport((method, route) => {
    assert.equal(route, MESSAGE_ROUTE);
    if (method === 'POST') return { id: 'sent_1', created_at: DATE };
    return { items: [rawMessage({ reply_to: { message_id: 'sent_1' } })] };
  });
  const result = await client(t, { transport: wire }).send({ roomId: ROOM, text: 'hello', wait: true, waitTimeoutMs: 1000 });
  assert.equal(result.accepted, true);
  assert.equal(result.wait.status, 'observed');
  assert.equal(result.wait.messages[0].streaming, false);
  assert.equal(result.wait.messages[0].replyToMessageId, 'sent_1');
  assert.equal(wire.calls.length, 2);
});

test('SDK upload and send honor attachment name and MIME overrides through the transport', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'local.bin');
  await writeFile(file, 'hello');
  const wire = transport((method, route, options) => {
    assert.equal(method, 'POST');
    assert.equal(route, MESSAGE_ROUTE);
    assert.deepEqual(options.body.content.attachments, [{ type: 'file', file_id: 'file_1' }]);
    return { id: 'sent_1', created_at: DATE };
  });
  const uploads = [];
  wire.requestMultipart = async (method, route, options) => {
    assert.equal(method, 'POST');
    assert.equal(route, `/backend-api/messaging/rooms/${ROOM}/files`);
    assert.ok(options.signal instanceof AbortSignal);
    uploads.push(options.file);
    assert.equal(options.file.name, 'public.txt');
    assert.equal(options.file.mimeType, 'text/plain');
    assert.equal(Buffer.from(options.file.bytes).toString(), 'hello');
    return { file_id: 'file_1', name: options.file.name, mime_type: options.file.mimeType, size_bytes: 5 };
  };
  const api = client(t, { transport: wire });
  const uploaded = await api.upload({ roomId: ROOM, path: file, name: 'public.txt', mimeType: 'text/plain' });
  assert.deepEqual(uploaded.attachment, { type: 'file', fileId: 'file_1', name: 'public.txt', mimeType: 'text/plain', sizeBytes: 5 });
  await api.send({ roomId: ROOM, attachments: [{ path: file, name: 'public.txt', mimeType: 'text/plain' }] });
  assert.equal(uploads.length, 2);
  assert.equal(wire.calls.length, 1);
});

test('SDK preflights every file before uploading, resolving a target or authenticating', async t => {
  const directory = await temporary(t);
  const good = path.join(directory, 'good.txt');
  const empty = path.join(directory, 'empty.txt');
  const tooLarge = path.join(directory, 'large.bin');
  const linked = path.join(directory, 'link.txt');
  await writeFile(good, 'hello');
  await writeFile(empty, '');
  await symlink(good, linked);
  const handle = await open(tooLarge, 'w');
  await handle.truncate(20 * 1024 * 1024 + 1);
  await handle.close();
  const wire = transport();
  wire.requestMultipart = async () => assert.fail('No partial upload should occur before all paths pass preflight');
  const api = client(t, { transport: wire });
  for (const bad of [empty, tooLarge, linked, directory, path.join(directory, 'missing')]) {
    await assert.rejects(api.send({ dotId: 'dot_1', attachments: [good, bad] }), { code: 'INVALID_ARGUMENT', deliveryState: 'not_sent' });
  }
  assert.equal(wire.calls.length, 0);
});

test('SDK unsupported file capabilities fail before local-file reads or remote target resolution', async t => {
  const wire = transport();
  const api = client(t, { transport: wire });
  const missingPath = '/does/not/exist/dotter-sdk-test-file.txt';
  await assert.rejects(api.upload({ dotId: 'dot_1', path: missingPath }), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(api.send({ dotId: 'dot_1', attachments: [missingPath] }), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(api.download({ dotId: 'dot_1', fileId: 'file_1', output: missingPath }), { code: 'UNSUPPORTED_OPERATION' });
  assert.equal(wire.calls.length, 0);
});

test('SDK download saves verified bytes and returns the common output field with the legacy path alias', async t => {
  const directory = await temporary(t);
  const destination = path.join(directory, 'downloaded.txt');
  const wire = transport((method, route) => {
    assert.equal(method, 'GET');
    assert.equal(route, `/backend-api/messaging/rooms/${ROOM}/files/file_1`);
    return { file_id: 'file_1', name: 'report.txt', mime_type: 'text/plain', size_bytes: 5, download_url: '/backend-api/estuary/content?id=file_1' };
  });
  let downloads = 0;
  wire.requestBytes = async (method, route, { signal, query }) => {
    assert.equal(method, 'GET');
    assert.equal(route, '/backend-api/estuary/content');
    assert.deepEqual(query, { id: 'file_1' });
    assert.ok(signal instanceof AbortSignal);
    downloads++;
    return Buffer.from('hello');
  };
  const api = client(t, { transport: wire });
  assert.equal(api.capabilities().download, true);
  const result = await api.download({ roomId: ROOM, fileId: 'file_1', output: destination });
  assert.equal(result.output, await realpath(destination));
  assert.equal(result.path, result.output);
  assert.equal(result.fileId, 'file_1');
  assert.equal(result.mimeType, 'text/plain');
  assert.equal(await readFile(result.output, 'utf8'), 'hello');
  assert.equal(downloads, 1);
  assert.equal(wire.calls.length, 1);
});

test('SDK frozen injected transports remain usable with their original method receiver', async t => {
  const calls = [];
  const wire = Object.freeze({
    async request(method, route, options) {
      assert.equal(this, wire);
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ method, route });
      return { items: [rawMessage()] };
    },
  });
  const result = await client(t, { transport: wire }).history({ roomId: ROOM });
  assert.equal(result.messages[0].text, 'Hello');
  assert.deepEqual(calls, [{ method: 'GET', route: MESSAGE_ROUTE }]);
});

test('SDK errors sanitize native exceptions and retain safe status and native machine code', async t => {
  const wire = transport(() => { throw new DotError('HTTP_ERROR', 'credential secret token=private', { status: 503, private: 'do not expose' }); });
  await assert.rejects(client(t, { transport: wire }).history({ roomId: ROOM }), error => {
    assert.ok(error instanceof DotterError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.nativeCode, 'HTTP_ERROR');
    assert.doesNotMatch(JSON.stringify(error), /credential|private|token=/);
    assert.equal('cause' in error, false);
    return true;
  });
});

test('SDK auth status returns a safe projection and forwards the selected auth file', async t => {
  const expiresAt = Date.now() + 3_600_000;
  const api = client(t, { authFile: '/tmp/dotter-auth-fixture.json', auth: { async load(options) {
    assert.equal(options.authFile, '/tmp/dotter-auth-fixture.json');
    assert.ok(options.signal instanceof AbortSignal);
    return { accessToken: 'private', refreshToken: 'also-private', accountId: 'account_1', expiresAt };
  } } });
  assert.deepEqual(await api.auth.status(), { status: 'ready', mode: 'chatgpt', accountId: 'account_1', hasAccountSelector: true, expiresAt: new Date(expiresAt).toISOString() });
});

test('SDK abort and deadlines settle authentication even when a host loader ignores its signal', async t => {
  for (const mode of ['abort', 'timeout', 'close']) {
    const started = deferred(), completion = deferred();
    let loaderSignal;
    const api = client(t, { auth: { async load({ signal }) { loaderSignal = signal; started.resolve(); return completion.promise; } } });
    const controller = new AbortController();
    const operation = api.auth.status({ signal: controller.signal, ...(mode === 'timeout' ? { timeoutMs: 20 } : {}) });
    const rejection = assert.rejects(operation, { code: mode === 'abort' ? 'ABORTED' : mode === 'timeout' ? 'TIMEOUT' : 'CLOSED' });
    await started.promise;
    if (mode === 'abort') controller.abort(new Error('private cancellation details'));
    if (mode === 'close') await api.close();
    await rejection;
    assert.equal(loaderSignal.aborted, true);
    completion.resolve({ accessToken: 'late-private-token' });
    await nextTurn();
  }
});

test('SDK abort settles an active injected request that ignores its signal', async t => {
  const started = deferred(), completion = deferred();
  let requestSignal;
  const wire = transport((method, route, { signal }) => { requestSignal = signal; started.resolve(); return completion.promise; });
  const api = client(t, { transport: wire });
  const controller = new AbortController();
  const operation = api.history({ roomId: ROOM }, { signal: controller.signal });
  const rejection = assert.rejects(operation, { code: 'ABORTED' });
  await started.promise;
  controller.abort();
  await rejection;
  assert.equal(requestSignal.aborted, true);
  completion.resolve({ items: [rawMessage()] });
  await nextTurn();
  assert.equal(wire.calls.length, 1);
});

test('SDK configured request deadlines also bound injected transports that ignore abort', async t => {
  let requestSignal;
  const wire = transport((method, route, { signal }) => { requestSignal = signal; return new Promise(() => {}); });
  const api = client(t, { transport: wire, requestTimeoutMs: 10 });
  await assert.rejects(api.history({ roomId: ROOM }), { code: 'TIMEOUT' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(wire.calls.length, 1);
});

test('SDK active operations can cancel during default-transport authentication without starting network I/O', async t => {
  const started = deferred(), completion = deferred();
  let authSignal;
  const api = client(t, { auth: { async load({ signal }) { authSignal = signal; started.resolve(); return completion.promise; } } });
  const controller = new AbortController();
  const operation = api.history({ roomId: ROOM }, { signal: controller.signal });
  const rejection = assert.rejects(operation, { code: 'ABORTED' });
  await started.promise;
  controller.abort();
  await rejection;
  assert.equal(authSignal.aborted, true);
  completion.reject(new Error('late loader rejection containing credentials'));
  await nextTurn();
});

test('SDK close is idempotent, preserves caller-owned transports and rejects future work', async t => {
  for (const ownsTransport of [false, true]) {
    let closes = 0;
    const wire = transport();
    wire.close = async () => { closes++; };
    const api = client(t, { transport: wire, ownsTransport });
    await Promise.all([api.close(), api.close(), api.close()]);
    assert.equal(closes, ownsTransport ? 1 : 0);
    for (const operation of [api.send({ text: 'hello' }), api.history(), api.search({ query: 'hello' }), api.watch(), api.auth.status()]) await assert.rejects(operation, { code: 'CLOSED' });
    assert.throws(() => api.advanced, { code: 'CLOSED' });
    assert.equal(wire.calls.length, 0);
  }
});

test('SDK advanced handles remain active across methods and are guarded after close', async t => {
  let calls = 0;
  const wire = transport((method, route) => {
    assert.equal(route, '/backend-api/tbo/primary');
    calls++;
    return { selection: { available: true, messaging_room_id: ROOM, aeon_id: 'dot_1' } };
  });
  const api = client(t, { transport: wire });
  const advanced = api.advanced;
  const primary = advanced.primary;
  assert.equal((await primary()).roomId, ROOM);
  assert.equal((await advanced.primary()).roomId, ROOM);
  assert.equal(calls, 2);
  await api.close();
  await assert.rejects(primary(), { code: 'CLOSED' });
  assert.throws(() => advanced.primary, { code: 'CLOSED' });
  assert.equal(calls, 2);
});

test('SDK returning an advanced connection handle does not abort its ongoing lifetime', async t => {
  let connectionSignal;
  let disconnected = 0;
  const connection = { id: 'connection_1' };
  const api = client(t, { nativeClient: { async openConnection({ signal }) {
    connectionSignal = signal;
    signal.addEventListener('abort', () => { disconnected++; }, { once: true });
    return connection;
  } } });
  assert.equal(await api.advanced.openConnection(), connection);
  await nextTurn();
  assert.equal(connectionSignal.aborted, false);
  assert.equal(disconnected, 0);
  await api.close();
  assert.equal(connectionSignal.aborted, true);
  assert.equal(disconnected, 1);
});

for (const method of ['exportHistory', 'download']) test(`SDK unknown injected ${method} methods keep bounded cancellation behavior`, async t => {
  const api = client(t, { nativeClient: { [method]() { return new Promise(() => {}); } } });
  const controller = new AbortController();
  const operation = method === 'download'
    ? api.download({ roomId: ROOM, fileId: 'file_1', output: './unused.txt' }, { signal: controller.signal })
    : api.advanced.exportHistory({ output: './unused.json', signal: controller.signal });
  await nextTurn(); controller.abort();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('An injected method ignored cancellation.')), 1000); });
  try { await assert.rejects(Promise.race([operation, deadline]), { code: 'ABORTED' }); }
  finally { clearTimeout(timer); }
});

test('SDK watch exposes ready, normalized messages and a cursor advanced only on consumption', async t => {
  const { subscription, callbacks } = await watcher(t);
  callbacks.onReady({ roomId: ROOM, initialCount: 0 });
  await subscription.ready;
  callbacks.onMessage({ id: 'message_1', role: 'assistant', text: 'hello', inProgress: true, replyTo: 'parent_1', attachments: [], createdAt: DATE, updatedAt: null });
  callbacks.onCursor({ roomId: ROOM, anchor: 'message_1' });
  assert.equal(subscription.cursor, null);
  assert.equal((await subscription.next()).value.type, 'ready');
  const event = (await subscription.next()).value;
  assert.equal(event.type, 'message');
  assert.equal(event.message.streaming, true);
  assert.equal(event.message.replyToMessageId, 'parent_1');
  assert.equal(event.roomId, ROOM);
  assert.equal(subscription.cursor, null);
  assert.deepEqual((await subscription.next()).value, { type: 'cursor', roomId: ROOM, anchor: 'message_1' });
  assert.equal(subscription.cursor, 'message_1');
  await subscription.cancel();
  await subscription.done;
});

test('SDK watch cancellation settles pending reads, discards queued events and ignores late callbacks', async t => {
  const { subscription, callbacks } = await watcher(t);
  const pending = subscription.next();
  await subscription.cancel();
  assert.equal(callbacks.signal.aborted, true);
  assert.deepEqual(await pending, { done: true, value: undefined });
  await subscription.done;
  await assert.rejects(subscription.ready, { code: 'ABORTED' });
  callbacks.onReady({ roomId: ROOM, initialCount: 1 });
  callbacks.onMessage({ id: 'late', text: 'late', inProgress: false });
  callbacks.onCursor({ roomId: ROOM, anchor: 'late' });
  assert.deepEqual(await subscription.next(), { done: true, value: undefined });
  assert.equal(subscription.cursor, null);
  await subscription.cancel();
});

test('SDK watch ending before readiness rejects ready without failing normal completion', async t => {
  const api = client(t, { nativeClient: { async watch() {} } });
  const subscription = await api.watch({ roomId: ROOM });
  const pending = subscription.next();
  await subscription.done;
  await assert.rejects(subscription.ready, error => error.code === 'OPERATION_FAILED' && /ended before it became ready/.test(error.message));
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await subscription.next(), { done: true, value: undefined });
});

test('SDK external watch cancellation before readiness rejects ready and closes iteration normally', async t => {
  const controller = new AbortController();
  const api = client(t, { nativeClient: { watch() { return new Promise(() => {}); } } });
  const subscription = await api.watch({ roomId: ROOM }, { signal: controller.signal });
  const pending = subscription.next();
  controller.abort();
  await subscription.done;
  await assert.rejects(subscription.ready, { code: 'ABORTED' });
  assert.deepEqual(await pending, { done: true, value: undefined });
});

test('SDK watch iterator return cancels the underlying operation', async t => {
  const { subscription, callbacks } = await watcher(t);
  callbacks.onReady({ roomId: ROOM, initialCount: 0 });
  for await (const event of subscription) { assert.equal(event.type, 'ready'); break; }
  await subscription.done;
  assert.equal(callbacks.signal.aborted, true);
  assert.deepEqual(await subscription.next(), { done: true, value: undefined });
});

test('SDK watch overflow fails explicitly and keeps the last consumed cursor', async t => {
  const { subscription, callbacks } = await watcher(t);
  callbacks.onCursor({ roomId: ROOM, anchor: 'consumed_1' });
  await subscription.next();
  assert.equal(subscription.cursor, 'consumed_1');
  for (let index = 0; index < 9; index++) callbacks.onCursor({ roomId: ROOM, anchor: `unconsumed_${index}` });
  await assert.rejects(subscription.done, { code: 'RESYNC_REQUIRED' });
  await assert.rejects(subscription.ready, { code: 'RESYNC_REQUIRED' });
  await assert.rejects(subscription.next(), { code: 'RESYNC_REQUIRED' });
  assert.equal(callbacks.signal.aborted, true);
  assert.equal(subscription.cursor, 'consumed_1');
  await subscription.cancel();
});

test('SDK native watch startup and resumed replay preserve at-least-once behavior', async t => {
  const calls = [];
  const wire = transport((method, route, options) => {
    assert.equal(route, MESSAGE_ROUTE);
    calls.push(options.query);
    return { items: [rawMessage({ id: 'anchor_1', generation: { status: 'in_progress' } })] };
  });
  const api = client(t, { transport: wire });
  const first = await api.watch({ roomId: ROOM, intervalMs: 1000 });
  await first.ready;
  assert.equal(first.cursor, null);
  assert.deepEqual((await first.next()).value, { type: 'cursor', roomId: ROOM, anchor: 'anchor_1' });
  assert.equal(first.cursor, 'anchor_1');
  assert.equal((await first.next()).value.type, 'ready');
  await first.cancel();
  const resumed = await api.watch({ roomId: ROOM, intervalMs: 1000, resumeAfter: first.cursor });
  await resumed.ready;
  const replayed = (await resumed.next()).value;
  assert.equal(replayed.type, 'message');
  assert.equal(replayed.message.id, 'anchor_1');
  assert.equal(replayed.message.streaming, true);
  assert.deepEqual((await resumed.next()).value, { type: 'ready', roomId: ROOM, initialCount: 1, resumed: true, replayed: true });
  assert.equal(resumed.cursor, null, 'A replayed snapshot must not acknowledge the unconsumed cursor backlog');
  await resumed.cancel();
  assert.equal(calls.length, 2);
  assert.equal(calls.every(query => query.after === undefined), true);
});

test('SDK resumed native watch drains from the saved cursor before acknowledging new records', async t => {
  let snapshotReads = 0;
  const requestedCursors = [];
  const wire = transport((method, route, { query }) => {
    assert.equal(route, MESSAGE_ROUTE);
    if (query.after === undefined) {
      snapshotReads++;
      return { items: [rawMessage({ id: 'old_1' })] };
    }
    requestedCursors.push(query.after);
    assert.equal(query.after, 'saved_1');
    return { items: [rawMessage({ id: 'new_1', created_at: '2026-10-19T10:00:01.000Z' })] };
  });
  const api = client(t, { transport: wire });
  const subscription = await api.watch({ roomId: ROOM, intervalMs: 1000, resumeAfter: 'saved_1' }, { timeoutMs: 5000 });
  await subscription.ready;
  assert.equal((await subscription.next()).value.message.id, 'old_1');
  assert.equal((await subscription.next()).value.type, 'ready');
  assert.equal(subscription.cursor, null);
  const arrival = (await subscription.next()).value;
  assert.equal(arrival.type, 'message');
  assert.equal(arrival.message.id, 'new_1');
  assert.equal(subscription.cursor, null, 'The cursor remains unacknowledged until the following cursor event is consumed');
  assert.equal((await subscription.next()).value.anchor, 'new_1');
  assert.equal(subscription.cursor, 'new_1');
  await subscription.cancel();
  assert.deepEqual(requestedCursors, ['saved_1']);
  assert.ok(snapshotReads >= 1);
});

test('SDK maps native cursor loop failures into a terminal resync event-stream error', async t => {
  const failure = deferred();
  const api = client(t, { nativeClient: { async watch({ onReady }) { onReady({ roomId: ROOM, initialCount: 0 }); await failure.promise; throw new DotError('CURSOR_LOOP', 'private native details'); } } });
  const subscription = await api.watch({ roomId: ROOM });
  await subscription.ready;
  assert.equal((await subscription.next()).value.type, 'ready');
  const pending = subscription.next();
  const rejection = assert.rejects(pending, { code: 'RESYNC_REQUIRED', nativeCode: 'CURSOR_LOOP' });
  failure.resolve();
  await rejection;
  await assert.rejects(subscription.done, { code: 'RESYNC_REQUIRED' });
});

test('SDK watch timeout settles ready and iteration even when the underlying watcher ignores abort', async t => {
  const api = client(t, { nativeClient: { watch() { return new Promise(() => {}); } } });
  const subscription = await api.watch({ roomId: ROOM }, { timeoutMs: 20 });
  await assert.rejects(subscription.ready, { code: 'TIMEOUT' });
  await assert.rejects(subscription.done, { code: 'TIMEOUT' });
  await assert.rejects(subscription.next(), { code: 'TIMEOUT' });
});

test('SDK close cancels subscriptions and prevents callbacks from re-opening the stream', async t => {
  const { api, subscription, callbacks } = await watcher(t);
  const pending = subscription.next();
  await api.close();
  await subscription.done;
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(callbacks.signal.aborted, true);
  callbacks.onReady({ roomId: ROOM, initialCount: 1 });
  await assert.rejects(subscription.ready, { code: 'ABORTED' });
  callbacks.onCursor({ roomId: ROOM, anchor: 'late_1' });
  assert.equal(subscription.cursor, null);
  assert.deepEqual(await subscription.next(), { done: true, value: undefined });
});

test('SDK uncertain writes retain the request key and never claim an aborted write was unsent', async t => {
  const started = deferred(), completion = deferred();
  const wire = transport((method, route) => { assert.equal(method, 'POST'); assert.equal(route, MESSAGE_ROUTE); started.resolve(); return completion.promise; });
  const api = client(t, { transport: wire });
  const operation = api.send({ roomId: ROOM, text: 'hello', idempotencyKey: KEY }, { timeoutMs: 20 });
  const rejection = assert.rejects(operation, error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.requestId, KEY);
    assert.equal(error.deliveryState, 'unknown');
    assert.equal(error.receipt, undefined);
    assert.equal(error.details.requestId, KEY);
    assert.equal(error.details.deliveryState, 'unknown');
    return true;
  });
  await started.promise;
  await rejection;
  completion.resolve({ id: 'late_1' });
  await nextTurn();
  assert.equal(wire.calls.length, 1);
});

test('SDK cancellation while waiting preserves the already accepted receipt', async t => {
  const polling = deferred(), lateHistory = deferred();
  const wire = transport((method, route) => {
    assert.equal(route, MESSAGE_ROUTE);
    if (method === 'POST') return { id: 'sent_1', created_at: DATE };
    polling.resolve();
    return lateHistory.promise;
  });
  const api = client(t, { transport: wire });
  const controller = new AbortController();
  const operation = api.send({ roomId: ROOM, text: 'hello', wait: true, idempotencyKey: KEY }, { signal: controller.signal });
  const rejection = assert.rejects(operation, error => {
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.requestId, KEY);
    assert.equal(error.deliveryState, 'accepted');
    assert.deepEqual(error.receipt, { accepted: true, roomId: ROOM, messageId: 'sent_1', idempotencyKey: KEY, createdAt: DATE });
    assert.deepEqual(error.details.receipt, error.receipt);
    return true;
  });
  await polling.promise;
  controller.abort();
  await rejection;
  lateHistory.resolve({ items: [rawMessage()] });
  await nextTurn();
  assert.equal(wire.calls.length, 2);
});

test('CLI core commands invoke the canonical SDK methods and preserve terminal projections', async t => {
  const wire = transport((method, route) => {
    assert.equal(route, MESSAGE_ROUTE);
    return method === 'POST' ? { id: 'sent_1', created_at: DATE } : { items: [rawMessage({ reply_to: { message_id: 'parent_1' }, generation: { status: 'in_progress' } })] };
  });
  class ObservedClient extends DotterClient {
    calls = [];
    send(input, options) { this.calls.push({ method: 'send', input, options }); return super.send(input, options); }
    history(input, options) { this.calls.push({ method: 'history', input, options }); return super.history(input, options); }
    search(input, options) { this.calls.push({ method: 'search', input, options }); return super.search(input, options); }
  }
  const created = [];
  const stdout = output(), stderr = output();
  const deps = { stdout, stderr, createClient() { const api = new ObservedClient({ transport: wire }); created.push(api); return api; }, uuid: () => KEY };
  const sent = await run(['send', '--room', ROOM, 'hello'], deps);
  assert.equal(created[0].calls[0].method, 'send');
  assert.equal(created[0].calls[0].input.text, 'hello');
  assert.equal(created[0].calls[0].input.idempotencyKey, KEY);
  assert.equal(sent.accepted, true);
  const history = await run(['history', '--room', ROOM, '--json'], deps);
  assert.equal(created[1].calls[0].method, 'history');
  assert.equal(history.messages[0].inProgress, true);
  assert.equal(history.messages[0].replyTo, 'parent_1');
  assert.equal('streaming' in history.messages[0], false);
  const found = await run(['search', '--query', 'Hello', '--room', ROOM, '--pages', '1'], deps);
  assert.equal(created[2].calls[0].method, 'search');
  assert.equal(found.matches[0].inProgress, true);
  for (const api of created) await assert.rejects(api.history(), { code: 'CLOSED' });
  assert.equal(wire.calls.length, 3);
});
