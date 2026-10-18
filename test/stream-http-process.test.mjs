import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { SSEParser, pythonStream, streamSSE } from '../src/stream-http.mjs';

const url = 'https://chatgpt.com/backend-api/tbo/dot/activity/stream';
const route = '/backend-api/tbo/dot/activity/stream';
const transport = { authLoader: async () => ({ accessToken: 'private-token', accountId: 'account' }) };
const response = { type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } };
const encode = value => Buffer.from(value).toString('base64');

function processDouble({ inputError, onSpawn, script } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let calls = 0, kills = 0, input = '';
  child.stdin.on('data', chunk => { input += chunk; });
  if (inputError) child.stdin.end = () => { throw inputError; };
  const close = (code = 0) => { child.stdout.end(); child.emit('close', code); };
  child.kill = () => { kills++; close(0); return true; };
  const spawnImpl = () => {
    calls++; onSpawn?.();
    if (script) queueMicrotask(() => script(child, close));
    return child;
  };
  return { child, spawnImpl, close, get calls() { return calls; }, get kills() { return kills; }, get input() { return input; } };
}

async function collect(iterator) { const records = []; for await (const record of iterator) records.push(record); return records; }
const options = signal => ({ method: 'GET', headers: { Authorization: 'Bearer private-token' }, signal });
const code = expected => error => error?.code === expected && !String(error.message).includes('private-token');

test('stream request serialization fails before starting a process or adding an abort listener', async () => {
  const controller = new AbortController(), process = processDouble();
  const headers = {}; headers.self = headers;
  try {
    await assert.rejects(collect(pythonStream(url, { ...options(controller.signal), headers }, process)), code('INVALID_ARGUMENT'));
    assert.equal(process.calls, 0); assert.equal(process.kills, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { process.close(); }
});

test('stream request URL conversion exceptions are sanitized before spawning', async () => {
  const process = processDouble();
  try {
    await assert.rejects(collect(pythonStream({ toString() { throw Error('private-token'); } }, options(), process)), code('INVALID_ARGUMENT'));
    assert.equal(process.calls, 0);
  } finally { process.close(); }
});

test('stream request larger than the native stdin limit is rejected without spawning', async () => {
  const process = processDouble();
  try {
    await assert.rejects(collect(pythonStream(url, { ...options(), body: 'a'.repeat(1024 * 1024) }, process)), code('INVALID_ARGUMENT'));
    assert.equal(process.calls, 0);
  } finally { process.close(); }
});

test('synchronous stream stdin failure cleans up once and removes the abort listener', async () => {
  const controller = new AbortController(), process = processDouble({ inputError: Error('private-token') });
  try {
    await assert.rejects(collect(pythonStream(url, options(controller.signal), process)), code('NETWORK_ERROR'));
    assert.equal(process.kills, 1); assert.equal(process.child.stdin.destroyed, true); assert.equal(process.child.stdout.destroyed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort(); assert.equal(process.kills, 1);
  } finally { process.close(); }
});

test('asynchronous stream stdin failure cannot be ignored as successful EOF', async () => {
  const process = processDouble({ script(child, close) { child.stdin.emit('error', Error('private-token')); close(); } });
  await assert.rejects(collect(pythonStream(url, options(), process)), code('NETWORK_ERROR'));
  assert.equal(process.kills, 1);
});

test('stream stdout errors are sanitized and terminate the child exactly once', async () => {
  const process = processDouble({ script(child) { child.stdout.destroy(Error('private-token')); } });
  await assert.rejects(collect(pythonStream(url, options(), process)), code('NETWORK_ERROR'));
  assert.equal(process.kills, 1);
});

test('a child error interrupts a pending stdout read and cleans up', async () => {
  const process = processDouble({ script(child) { child.emit('error', Object.assign(Error('private-token'), { code: 'ENOENT' })); } });
  await assert.rejects(collect(pythonStream(url, options(), process)), code('PYTHON_REQUIRED'));
  assert.equal(process.kills, 1);
});

test('synchronous spawn failure is sanitized and identifies missing Python', async () => {
  await assert.rejects(collect(pythonStream(url, options(), { spawnImpl() { throw Object.assign(Error('private-token'), { code: 'ENOENT' }); } })), code('PYTHON_REQUIRED'));
});

for (const reason of [null, false, 0, '', Error('cancelled')]) {
  test(`abort during spawn prevents stdin delivery and preserves the ${typeof reason} reason`, async () => {
    const controller = new AbortController(), process = processDouble({ onSpawn: () => controller.abort(reason) });
    try {
      let caught = Symbol('missing');
      try { await collect(pythonStream(url, options(controller.signal), process)); } catch (error) { caught = error; }
      assert.equal(caught, reason); assert.equal(process.input, ''); assert.equal(process.kills, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { process.close(); }
  });
}

test('abort interrupts pending stdout reads and performs a single cleanup', async () => {
  const controller = new AbortController(), reason = Error('cancelled');
  const process = processDouble({ script: () => controller.abort(reason) });
  await assert.rejects(collect(pythonStream(url, options(controller.signal), process)), error => error === reason);
  assert.equal(process.kills, 1); assert.equal(process.child.stdout.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('an inert local Python stream process exits after cancellation without a network request', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  let child, closed;
  const spawnImpl = (command, _args, spawnOptions) => {
    child = spawn(command, ['-I', '-c', 'import sys,time; sys.stdin.read(); print(\'{"type":"response","status":200,"headers":{}}\', flush=True); time.sleep(30)'], spawnOptions);
    closed = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    return child;
  };
  try {
    let caught = Symbol('missing');
    try {
      for await (const record of pythonStream(url, options(controller.signal), { spawnImpl })) {
        assert.equal(record.type, 'response'); controller.abort(false);
      }
    } catch (error) { caught = error; }
    assert.equal(caught, false);
    const exit = await closed;
    assert.equal(exit.signal, 'SIGTERM'); assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); }
});

test('early stream consumer return destroys pipes and terminates the child once', async () => {
  const controller = new AbortController();
  const process = processDouble({ script(child) { child.stdout.write(`${JSON.stringify(response)}\n`); } });
  let returned = 0;
  const original = process.child.stdout[Symbol.asyncIterator].bind(process.child.stdout);
  process.child.stdout[Symbol.asyncIterator] = () => {
    const iterator = original();
    return { next: () => iterator.next(), return: () => { returned++; return iterator.return(); } };
  };
  for await (const record of pythonStream(url, options(controller.signal), process)) { assert.deepEqual(record, response); break; }
  assert.equal(process.kills, 1); assert.equal(process.child.stdin.destroyed, true); assert.equal(process.child.stdout.destroyed, true);
  assert.equal(returned, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('clean stream EOF does not kill an exited child and preserves private stdin transport', async () => {
  const controller = new AbortController();
  const process = processDouble({ script(child, close) { child.stdout.write(`${JSON.stringify(response)}\n`); close(); } });
  assert.deepEqual(await collect(pythonStream(url, options(controller.signal), process)), [response]);
  assert.equal(process.kills, 0); assert.match(process.input, /Bearer private-token/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('multiple bounded records in one pipe chunk are accepted independently', async () => {
  const record = { type: 'chunk', body: encode('x'.repeat(50000)) };
  const process = processDouble({ script(child, close) { child.stdout.write(`${JSON.stringify(record)}\n${JSON.stringify(record)}\n`); close(); } });
  assert.deepEqual(await collect(pythonStream(url, options(), process)), [record, record]);
});

test('an oversized native record is rejected before yielding even when newline terminated', async () => {
  const process = processDouble({ script(child, close) { child.stdout.write(`${JSON.stringify({ type: 'chunk', body: 'x'.repeat(131073) })}\n`); close(); } });
  await assert.rejects(collect(pythonStream(url, options(), process)), code('STREAM_TOO_LARGE'));
});

test('a truncated native record or abnormal child exit remains a safe transport error', async () => {
  for (const [text, status] of [['{"type":"response"}', 0], ['', 1]]) {
    const process = processDouble({ script(child, close) { child.stdout.write(text); close(status); } });
    await assert.rejects(collect(pythonStream(url, options(), process)), code('NETWORK_ERROR'));
  }
});

for (const text of ['null\n', '[]\n', '"private-token"\n', 'private-token\n']) {
  test(`non-object or malformed native stream record is rejected (${text[0]})`, async () => {
    const process = processDouble({ script(child, close) { child.stdout.write(text); close(); } });
    await assert.rejects(collect(pythonStream(url, options(), process)), code('INVALID_STREAM'));
  });
}

async function runRecords(records, extra = {}) {
  await streamSSE(transport, 'GET', route, { streamImpl: async function* () { yield* records; }, ...extra });
}

for (const record of [null, [], 'private-token', { type: 'response', status: 100, headers: {} }, { type: 'response', status: 600, headers: {} },
  { ...response, headers: null }, { ...response, headers: [] }, { ...response, headers: { 'content-type': 'text/event-stream', 'Content-Type': 'application/json' } },
  { ...response, headers: { 'content-type': 'application/json;text/event-stream' } }]) {
  test(`SSE rejects malformed native response ${JSON.stringify(record)}`, async () => {
    await assert.rejects(runRecords([record]), code('INVALID_STREAM'));
  });
}

for (const body of ['!!!!', 'YQ', 'YQ=', 'YQ===', 'Y Q==', 'YR==', 9, null]) {
  test(`SSE rejects noncanonical chunk base64 ${JSON.stringify(body)}`, async () => {
    await assert.rejects(runRecords([response, { type: 'chunk', body }]), code('INVALID_STREAM'));
  });
}

test('SSE rejects error-body records before response or after success', async () => {
  const errorBody = { type: 'error-body', body: encode('{}') };
  for (const records of [[errorBody], [response, errorBody]]) {
    await assert.rejects(runRecords(records), code('INVALID_STREAM'));
  }
});

test('SSE classifies the first complete error body without consuming a duplicate tail', async () => {
  let duplicates = 0;
  await assert.rejects(streamSSE(transport, 'GET', route, { streamImpl: async function* () {
    yield { type: 'response', status: 403, headers: { 'content-type': 'application/json' } };
    yield { type: 'error-body', body: encode('{}') };
    duplicates++;
    yield { type: 'error-body', body: encode('{}') };
  } }), code('FORBIDDEN'));
  assert.equal(duplicates, 0);
});

test('SSE rejects malformed or oversized error body encoding instead of classifying incomplete data', async () => {
  const errorResponse = { type: 'response', status: 403, headers: { 'content-type': 'application/json' } };
  for (const body of ['!!', encode('x'.repeat(65537))]) {
    await assert.rejects(runRecords([errorResponse, { type: 'error-body', body }]), code('INVALID_STREAM'));
  }
});

test('SSE retains edge classification for a valid error envelope and delivers canonical data', async () => {
  await assert.rejects(runRecords([{ type: 'response', status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } },
    { type: 'error-body', body: encode('challenge') }]), code('EDGE_CHALLENGE'));
  const seen = [];
  await runRecords([response, { type: 'chunk', body: encode('data: {"ok":true}\n\n') }], { onEvent: event => seen.push(event) });
  assert.deepEqual(seen, [{ event: 'message', data: '{"ok":true}' }]);
});

test('SSE limits each event independently of complete neighboring events in the same chunk', async () => {
  const seen = [], parser = new SSEParser({ maxEventBytes: 20, onEvent: event => seen.push(event.data) });
  await parser.push(Buffer.from('data: first\n\ndata: second\n\n'));
  assert.deepEqual(seen, ['first', 'second']);
});

test('SSE accepts large neighboring events without relaxing the individual event limit', async () => {
  const seen = [], parser = new SSEParser({ onEvent: event => seen.push(event.data.length) });
  await parser.push(Buffer.from(`data: ${'a'.repeat(600000)}\n\ndata: ${'b'.repeat(600000)}\n\n`));
  assert.deepEqual(seen, [600000, 600000]);
  await assert.rejects(new SSEParser().push(Buffer.from(`data: ${'x'.repeat(1024 * 1024)}\n\n`)), code('STREAM_TOO_LARGE'));
});

test('SSE carries the current event size across chunks while bounding unfinished lines', async () => {
  const parser = new SSEParser({ maxEventBytes: 20 });
  await parser.push(Buffer.from('data: 1234\n'));
  await assert.rejects(parser.push(Buffer.from('data: 12345678901')), code('STREAM_TOO_LARGE'));
  await assert.rejects(new SSEParser({ maxEventBytes: 20 }).push(Buffer.from(`:${'x'.repeat(21)}\n`)), code('STREAM_TOO_LARGE'));
  await assert.rejects(new SSEParser({ maxEventBytes: 20 }).push(Buffer.from(`unknown:${'x'.repeat(21)}\n`)), code('STREAM_TOO_LARGE'));
});

test('SSE preserves split multibyte text and applies byte limits to unfinished data', async () => {
  const seen = [], parser = new SSEParser({ maxEventBytes: 10, onEvent: event => seen.push(event.data) });
  const input = Buffer.from('data: 🍌\n\n');
  await parser.push(input.subarray(0, 8)); await parser.push(input.subarray(8));
  assert.deepEqual(seen, ['🍌']);
  const oversized = new SSEParser({ maxEventBytes: 10 });
  await oversized.push(Buffer.from('data: '));
  await assert.rejects(oversized.push(Buffer.from('🍌x')), code('STREAM_TOO_LARGE'));
});

test('SSE ignores one initial UTF8 BOM across chunks and retains later data BOM characters', async () => {
  const seen = [], parser = new SSEParser({ onEvent: event => seen.push(event.data) });
  const bytes = Buffer.from('\uFEFFdata: first\n\ndata: \uFEFFsecond\n\n');
  await parser.push(bytes.subarray(0, 1)); await parser.push(bytes.subarray(1, 2)); await parser.push(bytes.subarray(2));
  assert.deepEqual(seen, ['first', '\uFEFFsecond']);
});

test('SSE final carriage-return separator dispatches complete events but drops partial events', async () => {
  const seen = [], parser = new SSEParser({ onEvent: event => seen.push(event.data) });
  await parser.push(Buffer.from('data: complete\r\r')); await parser.end();
  assert.deepEqual(seen, ['complete']);
  const partial = new SSEParser({ onEvent: event => seen.push(event.data) });
  await partial.push(Buffer.from('data: partial\r')); await partial.end();
  assert.deepEqual(seen, ['complete']);
});

test('SSE event-limit checks are invariant when CRLF and comment lines are fragmented', async () => {
  for (const chunks of [
    ['data: 1234\r', '\n\r\n'],
    ['data: 1234\n', '\r'],
    ['data: 1234\n', ': hi', '\n\n'],
    ['data: 1234\r\n: hi\r\n\r\n'],
  ]) {
    const seen = [], parser = new SSEParser({ maxEventBytes: 10, onEvent: event => seen.push(event.data) });
    for (const chunk of chunks) await parser.push(Buffer.from(chunk));
    await parser.end(); assert.deepEqual(seen, ['1234']);
  }
});
