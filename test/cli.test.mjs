import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CliError, formatMessage, parseArgs, run } from '../src/cli.mjs';

const KEY = '11111111-2222-4333-8444-555555555555';
function output() {
  const capture = { text: '', write(value) { this.text += value; return true; } };
  return capture;
}
function dependencies(client = {}) {
  return { stdout: output(), stderr: output(), createClient: () => client };
}
function requestArguments(options) {
  const { signal, onAccepted, ...request } = options;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false, 'The SDK must invoke an operation with an active signal');
  if (Object.hasOwn(options, 'onAccepted')) assert.equal(typeof onAccepted, 'function');
  return request;
}
async function temporary(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dot-cli-test-'));
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('help and version never access auth, login, or an API client', async () => {
  const fail = () => { throw new Error('Should not be called'); };
  for (const argv of [[], ['--help'], ['--version']]) {
    const deps = { ...dependencies(), createClient: fail, authStatus: fail, login: fail, version: 'test-version' };
    await run(argv, deps);
    assert.match(deps.stdout.text, argv[0] === '--version' ? /test-version/ : /internal API/);
  }
});

test('parser accepts deliberate selections and cursor controls', () => {
  assert.deepEqual(parseArgs(['history', '--room', 'room_1', '--limit=20', '--before', 'cursor', '--json']), {
    command: 'history', roomId: 'room_1', json: true, limit: 20, before: 'cursor',
  });
  assert.deepEqual(parseArgs(['watch', '--interval', '1.5', '--duration', '2', '--from-start']), {
    command: 'watch', intervalMs: 1500, duration: 2, fromStart: true,
  });
  assert.deepEqual(parseArgs(['send', '--key', KEY, '--', '--this is text']), {
    command: 'send', idempotencyKey: KEY, text: '--this is text',
  });
});

test('parser rejects ambiguous or malformed command arguments', () => {
  const invalid = [
    ['history', '--before', 'a', '--after', 'b'], ['history', '--limit', '0'],
    ['history', '--limit', '21'], ['history', '--limit', '1.5'],
    ['history', '--json=true'], ['history', '--room', 'one', '--room', 'two'],
    ['history', '--unknown'], ['history', 'extra'], ['watch', '--interval', '0'],
    ['watch', '--interval', '3601'], ['watch', '--duration', 'NaN'],
    ['send', 'one', 'two'], ['send', 'one', '--file', 'file'],
    ['send', '--file', 'file', '--stdin'], ['send'], ['send', ' '],
    ['send', 'hello\0world'], ['send', 'x'.repeat(64_001)], ['send', 'ok', '--key', 'invalid'],
    ['auth', 'login', '--auth-file', '/unrelated/auth.json'], ['auth', 'unknown'],
  ];
  for (const argv of invalid) assert.throws(() => parseArgs(argv), CliError, JSON.stringify(argv.slice(0, 4)));
});

test('auth status passes the selected path to its safe status provider', async () => {
  const deps = dependencies();
  let received;
  deps.authStatus = async args => { received = args; return { status: 'ready', hasAccountSelector: true }; };
  await run(['auth', 'status', '--auth-file', './fake-auth.json'], deps);
  assert.equal(received.authFile, path.resolve('./fake-auth.json'));
  assert.deepEqual(JSON.parse(deps.stdout.text), { status: 'ready', hasAccountSelector: true });
});

test('auth login uses the injected Codex login without creating a client', async () => {
  const deps = dependencies();
  let count = 0;
  deps.createClient = () => assert.fail('Login must not instantiate a client');
  deps.login = async () => { count++; return { completed: true }; };
  await run(['auth', 'login'], deps);
  assert.equal(count, 1);
  assert.deepEqual(JSON.parse(deps.stdout.text), { completed: true });
});

test('status and dots call only the relevant discovery operation', async () => {
  const calls = [];
  const deps = dependencies({
    async primary() { calls.push('primary'); return { name: 'Dot', roomId: 'room' }; },
    async listDots() { calls.push('dots'); return [{ name: 'Dot', roomId: 'room' }]; },
  });
  await run(['status'], deps);
  await run(['dots'], deps);
  assert.deepEqual(calls, ['primary', 'dots']);
});

test('history forwards paging options and prints the normalized response', async () => {
  const result = { roomId: 'room', messages: [{ id: 'm1', role: 'user', text: 'hello', inProgress: false, replyTo: null }], prevCursor: 'before', nextCursor: null };
  let received;
  const deps = dependencies({ async history(args) { received = requestArguments(args); return result; } });
  deps.signal = new AbortController().signal;
  await run(['history', '--room', 'room', '--after', 'cursor', '--json'], deps);
  assert.deepEqual(received, { roomId: 'room', limit: 20, before: undefined, after: 'cursor' });
  assert.deepEqual(JSON.parse(deps.stdout.text), result);
});

test('history forwards cancellation through the SDK without printing a partial result', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const deps = dependencies({ async history(options) {
    requestArguments(options);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started();
    });
  } });
  deps.signal = controller.signal;
  const running = run(['history', '--json'], deps);
  await ready;
  controller.abort();
  await assert.rejects(running, error => error.code === 'ABORTED');
  assert.equal(deps.stdout.text, '');
});

test('readable message output removes terminal sequences and control characters', async () => {
  const message = {
    id: 'id\r\nforged', role: 'user\x1b[31m', createdAt: 'today',
    text: '\x1b]52;c;clipboard\x07Hello\x1b[31m world\x1b[0m\r\nnext\x00line',
  };
  assert.equal(formatMessage(message), 'today user [id forged]\nHello world\nnextline\n');
  const deps = dependencies({ async history() { return { messages: [message] }; } });
  await run(['history'], deps);
  assert.equal(deps.stdout.text, formatMessage(message));
  assert.doesNotMatch(deps.stdout.text, /\x1b|clipboard|\x00|\r/);
});

test('send validates input, announces the key before one request, and prints receipt', async () => {
  let calls = 0;
  const deps = dependencies({ async send(args) {
    calls++;
    assert.match(deps.stderr.text, new RegExp(KEY));
    assert.deepEqual(requestArguments(args), { roomId: 'room', text: 'hello', idempotencyKey: KEY });
    return { accepted: true, messageId: 'm1', idempotencyKey: args.idempotencyKey };
  } });
  deps.uuid = () => KEY;
  await run(['send', 'hello', '--room', 'room'], deps);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(deps.stdout.text).accepted, true);
});

test('failed sends are not automatically retried', async () => {
  let calls = 0;
  const deps = dependencies({ async send() { calls++; throw new Error('Simulated failure'); } });
  await assert.rejects(run(['send', 'hello', '--key', KEY], deps), /Simulated failure/);
  assert.equal(calls, 1);
  assert.match(deps.stderr.text, new RegExp(KEY));
});

test('file and stdin sources deliver valid UTF-8 without altering content', async () => {
  await temporary(async directory => {
    const filename = path.join(directory, 'message.txt');
    const text = 'Hello 🍌\nsecond line\n';
    await writeFile(filename, text);
    for (const argv of [['send', '--file', filename], ['send', '--stdin']]) {
      const deps = dependencies({ async send(args) { assert.equal(args.text, text); return { accepted: true }; } });
      deps.stdin = Readable.from([Buffer.from(text)]);
      await run([...argv, '--key', KEY], deps);
    }
  });
});

test('malformed, missing, and oversized source input fails before auth/client creation', async () => {
  await temporary(async directory => {
    const invalid = path.join(directory, 'invalid.txt');
    const oversized = path.join(directory, 'oversized.txt');
    const folder = path.join(directory, 'folder');
    await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await writeFile(oversized, 'x'.repeat(64_001));
    await mkdir(folder);
    const cases = [
      { args: ['--file', invalid], pattern: /UTF-8/ },
      { args: ['--file', oversized], pattern: /64,000/ },
      { args: ['--file', folder], pattern: /regular file/ },
      { args: ['--file', path.join(directory, 'missing')], pattern: /Could not read/ },
      { args: ['--stdin'], data: Buffer.from([0xff]), pattern: /UTF-8/ },
      { args: ['--stdin'], data: Buffer.from('\0bad'), pattern: /NUL/ },
      { args: ['--stdin'], data: Buffer.from(''), pattern: /empty/ },
      { args: ['--stdin'], data: Buffer.alloc(256_001, 0x61), pattern: /64,000/ },
    ];
    for (const value of cases) {
      const deps = dependencies();
      deps.createClient = () => assert.fail('Invalid input must fail before client creation');
      deps.stdin = Readable.from([value.data ?? Buffer.alloc(0)]);
      await assert.rejects(run(['send', ...value.args], deps), value.pattern);
    }
  });
});

test('watch emits NDJSON and detaches signal handlers after cancellation', async () => {
  const signals = new EventEmitter();
  const external = new AbortController();
  const message = { id: 'm1', role: 'user', text: 'hello\nworld', inProgress: false, replyTo: null };
  const deps = dependencies({ async watch(args) {
    assert.equal(args.roomId, 'room');
    assert.equal(args.intervalMs, 2000);
    assert.equal(args.fromStart, true);
    await args.onReady({ roomId: 'room', initialCount: 0 });
    await args.onMessage(message);
    await new Promise(setImmediate);
    external.abort();
    assert.equal(args.signal.aborted, true);
    throw new DOMException('aborted', 'AbortError');
  } });
  deps.signals = signals;
  deps.signal = external.signal;
  await run(['watch', '--room', 'room', '--interval', '2', '--from-start', '--json'], deps);
  assert.deepEqual(JSON.parse(deps.stdout.text.trim()), message);
  assert.equal(deps.stdout.text.trim().split('\n').length, 1);
  assert.equal(deps.stderr.text, '');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('watch propagates real failures and removes listeners', async () => {
  const signals = new EventEmitter();
  const deps = dependencies({ async watch() { throw new Error('Watch failed'); } });
  deps.signals = signals;
  await assert.rejects(run(['watch'], deps), /Watch failed/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('watch stops cleanly for SIGINT with readable ready and message output', async () => {
  const signals = new EventEmitter();
  const deps = dependencies({ async watch(args) {
    await args.onReady({ roomId: 'room\x1b[31m', initialCount: 0 });
    await args.onMessage({ id: 'one', role: 'assistant', text: 'hello' });
    await new Promise(setImmediate);
    signals.emit('SIGINT');
    assert.equal(args.signal.aborted, true);
  } });
  deps.signals = signals;
  await run(['watch', '--duration', '1'], deps);
  assert.match(deps.stderr.text, /Watching room\. Ctrl\+C to stop\./);
  assert.equal(deps.stdout.text, 'assistant [one]\nhello\n');
});
