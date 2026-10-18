import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CliError, HELP, parseArgs, run } from '../src/cli.mjs';
import { readJsonObject } from '../src/commands.mjs';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;


const KEY = '8b68bc03-a0f6-425a-9e0f-e1269d6eae10';
const buffer = () => ({ text: '', write(value) { this.text += value; } });
function dependencies(client = {}) {
  return { stdout: buffer(), stderr: buffer(), createClient: async () => client, uuid: () => KEY };
}
async function temporary(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dot-commands-'));
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('offline capabilities expose limitations without reading authentication or creating a client', async () => {
  const deps = dependencies();
  deps.createClient = () => assert.fail('Offline capability discovery must not create a client');
  deps.authStatus = () => assert.fail('Offline capability discovery must not inspect login');
  const result = await run(['capabilities', '--auth-file', '/does-not-exist/auth.json'], deps);
  assert.equal(result.version, PACKAGE_VERSION);
  assert.ok(result.parityGaps.length > 0);
  assert.equal(result.liveMutationsTested, false);
  assert.deepEqual(JSON.parse(deps.stdout.text), result);
});

test('auth refresh delegates to the managed refresh implementation with the selected path', async () => {
  const deps = dependencies();
  deps.createClient = () => assert.fail('Refresh must not create an API client');
  let received;
  deps.refreshLogin = async options => { received = options; return { refreshed: true }; };
  await run(['auth', 'refresh', '--auth-file', './example/auth.json'], deps);
  assert.deepEqual(received, { authFile: path.resolve('./example/auth.json') });
  assert.deepEqual(JSON.parse(deps.stdout.text), { refreshed: true });
});

test('auth logout uses only the injected logout, explains shared login impact, and never opens a client', async () => {
  const deps = dependencies();
  let calls = 0;
  deps.createClient = () => assert.fail('Logout must not instantiate an authenticated client');
  deps.login = () => assert.fail('Logout must not start login');
  deps.logout = async () => { calls++; return { completed: true, loggedOut: true }; };
  await run(['auth', 'logout', '--json'], deps);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(deps.stdout.text), { completed: true, loggedOut: true });
  assert.match(deps.stderr.text, /shared Codex CLI session/);
  assert.match(HELP, /auth logout.*shared Codex CLI session/);
  assert.throws(() => parseArgs(['auth', 'logout', '--auth-file', './auth.json']), /does not accept --auth-file/);
  deps.logout = async () => { calls++; throw new Error('Simulated logout failure'); };
  await assert.rejects(run(['auth', 'logout'], deps), /logout failure/);
  assert.equal(calls, 2);
});

test('advanced help aliases and ISO dates parse without opening a client', () => {
  assert.deepEqual(parseArgs(['action', '--help']), { command: 'help', topic: 'action' });
  assert.deepEqual(parseArgs(['routine', '-h']), { command: 'help', topic: 'routine' });
  assert.deepEqual(parseArgs(['search', '--query', 'x', '--since', '2026-10-17']), { command: 'search', query: 'x', since: '2026-10-17' });
  assert.throws(() => parseArgs(['search', '--query', 'x', '--since', '2026-02-30']), /valid calendar date/);
});

test('all advanced read and write commands map to exactly the intended client operation', async () => {
  const cases = [
    { argv: ['search', '--query', 'Banana', '--all', '--pages', '4', '--since', '2026-10-01T00:00:00Z', '--until', '2026-10-17T00:00:00Z'], method: 'search', expected: { query: 'Banana', all: true, pages: 4, since: '2026-10-01T00:00:00Z', until: '2026-10-17T00:00:00Z' } },
    { argv: ['thread', 'm_1', '--room', 'r_1', '--pages', '2'], method: 'thread', expected: { messageId: 'm_1', roomId: 'r_1', pages: 2 } },
    { argv: ['outline', '--room', 'r_1'], method: 'outline', expected: { roomId: 'r_1' } },
    { argv: ['export', '--output', './history.md', '--format', 'md', '--overwrite'], method: 'exportHistory', expected: { output: path.resolve('./history.md'), format: 'md', overwrite: true } },
    { argv: ['upload', './file.txt'], method: 'upload', expected: { file: path.resolve('./file.txt') } },
    { argv: ['download', 'f_1', '--output', './file.txt', '--overwrite'], method: 'download', expected: { fileId: 'f_1', output: path.resolve('./file.txt'), overwrite: true } },
    { argv: ['artifacts', '--pages', '3'], method: 'artifacts', expected: { pages: 3 } },
    { argv: ['actions', '--limit', '5', '--before', 'cursor'], method: 'actions', expected: { limit: 5, before: 'cursor' } },
    { argv: ['action', 'inspect', 'm_1'], method: 'elicitation', expected: { messageId: 'm_1' } },
    { argv: ['action', 'respond', 'm_1', '--request-id', 'req_1', '--fingerprint', 'fp_1', '--action', 'decline'], method: 'respond', expected: { messageId: 'm_1', requestId: 'req_1', requestFingerprint: 'fp_1', action: 'decline' } },
    { argv: ['react', 'm_1', '--emoji', '🍌'], method: 'react', expected: { messageId: 'm_1', reaction: '🍌' } },
    { argv: ['react', 'm_1', '--clear'], method: 'react', expected: { messageId: 'm_1', reaction: null } },
    { argv: ['read', 'm_1'], method: 'markRead', expected: { messageId: 'm_1' } },
    { argv: ['email', 'm_1'], method: 'email', expected: { messageId: 'm_1' } },
    { argv: ['profile', '--dot', 'd_1'], method: 'profile', expected: { dotId: 'd_1' } },
    { argv: ['rename', 'New Dot', '--dot', 'd_1'], method: 'renameDot', expected: { name: 'New Dot', dotId: 'd_1' } },
    { argv: ['pause', '--dot', 'd_1'], method: 'pauseDot', expected: { dotId: 'd_1' } },
    { argv: ['resume', '--dot', 'd_1'], method: 'resumeDot', expected: { dotId: 'd_1' } },
  ];
  for (const entry of cases) {
    const calls = [];
    const expectedResult = { command: entry.method, completed: true };
    const deps = dependencies({ async [entry.method](options) { calls.push(options); return expectedResult; } });
    const signal = new AbortController().signal;
    deps.signal = signal;
    const result = await run([...entry.argv, '--json'], deps);
    assert.deepEqual(calls, [{ ...entry.expected, signal }], entry.argv.join(' '));
    assert.equal(result, expectedResult);
    assert.deepEqual(JSON.parse(deps.stdout.text), expectedResult);
  }
});

test('task, routine, tool, and resource commands dispatch only the selected operations method', async () => {
  const cases = [
    { argv: ['tasks', '--dot', 'd_1', '--limit', '7', '--cursor', 'cursor'], method: 'listTasks', expected: { dotId: 'd_1', limit: 7, cursor: 'cursor' } },
    { argv: ['task', 't_1', '--dot', 'd_1'], method: 'getTask', expected: { taskId: 't_1', dotId: 'd_1' } },
    { argv: ['threads', 'all', '--dot', 'd_1'], method: 'listThreads', expected: { dotId: 'd_1', limit: 100 } },
    { argv: ['routine', 'list', '--all', '--filter', 'paused'], method: 'listRoutines', expected: { all: true, filter: 'paused', limit: 25 } },
    { argv: ['routine', 'get', 'rt_1'], method: 'getRoutine', expected: { routineId: 'rt_1' } },
    { argv: ['routine', 'enable', 'rt_1'], method: 'setRoutineEnabled', expected: { routineId: 'rt_1', enabled: true } },
    { argv: ['routine', 'disable', 'rt_1'], method: 'setRoutineEnabled', expected: { routineId: 'rt_1', enabled: false } },
    { argv: ['routine', 'delete', 'rt_1'], method: 'deleteRoutine', expected: { routineId: 'rt_1' } },
    { argv: ['routine', 'run', 'rt_1', '--key', KEY], method: 'runRoutine', expected: { routineId: 'rt_1', idempotencyKey: KEY } },
    { argv: ['routine', 'runs', 'rt_1', '--limit', '8', '--cursor', 'next'], method: 'routineRuns', expected: { routineId: 'rt_1', limit: 8, cursor: 'next' } },
    { argv: ['routine', 'result', 'rt_1', '--run', 'run_1'], method: 'routineRun', expected: { routineId: 'rt_1', runId: 'run_1' } },
    { argv: ['tools', 'c_1', '--cursor', 'next'], method: 'toolList', expected: { connectorId: 'c_1', cursor: 'next' } },
    { argv: ['connectors', 'list'], method: 'listConnectors', expected: {} },
    { argv: ['connectors', 'list', '--connector', 'c_1'], method: 'listConnectors', expected: { connectorId: 'c_1' } },
    { argv: ['tools', 'c_1', '--link', 'implicit_link::account'], method: 'toolList', expected: { connectorId: 'c_1', linkId: 'implicit_link::account' } },
    { argv: ['tool-call', 'c_1', 'tool_name', '--args', '{"text":"hello"}'], method: 'toolCall', expected: { connectorId: 'c_1', name: 'tool_name', arguments: { text: 'hello' } } },
    { argv: ['connector-actions', 'c_1'], method: 'connectorActions', expected: { connectorId: 'c_1' } },
    { argv: ['resources', 'c_1'], method: 'resourceList', expected: { connectorId: 'c_1' } },
    { argv: ['resource', 'c_1', 'library://file'], method: 'resourceRead', expected: { connectorId: 'c_1', uri: 'library://file' } },
    { argv: ['resource-templates', 'c_1'], method: 'resourceTemplates', expected: { connectorId: 'c_1' } },
    { argv: ['prompts', 'c_1'], method: 'promptList', expected: { connectorId: 'c_1' } },
  ];
  for (const entry of cases) {
    const calls = [], expectedResult = { method: entry.method };
    const deps = dependencies({ operations: { async [entry.method](options) { calls.push(options); return expectedResult; } } });
    await run(entry.argv, deps);
    assert.deepEqual(calls, [{ ...entry.expected, signal: undefined }], entry.argv.join(' '));
    assert.deepEqual(JSON.parse(deps.stdout.text), expectedResult);
  }
});

test('routine run announces a new key before a single mutation and never retries failures', async () => {
  let calls = 0;
  const deps = dependencies({ operations: { async runRoutine(options) {
    calls++;
    assert.equal(options.idempotencyKey, KEY);
    assert.match(deps.stderr.text, new RegExp(KEY));
    throw new Error('Simulated uncertain delivery');
  } } });
  await assert.rejects(run(['routine', 'run', 'rt_1'], deps), /uncertain delivery/);
  assert.equal(calls, 1);
});

test('file-based action content, routine specifications, and tool arguments remain structured JSON', async () => {
  await temporary(async directory => {
    const filename = path.join(directory, 'input.json');
    const checks = [
      { data: { approved: true }, argv: ['action', 'respond', 'm_1', '--request-id', 'req', '--fingerprint', 'fp', '--action', 'accept', '--content-file', filename, '--persist', 'session'], method: 'respond', expected: { messageId: 'm_1', requestId: 'req', requestFingerprint: 'fp', action: 'accept', persist: 'session', content: { approved: true } } },
      { data: { title: 'Check feed', prompt: 'Check this feed', schedule: 'RRULE:FREQ=DAILY', timeZone: 'Europe/London' }, argv: ['routine', 'create', '--spec', filename], operation: true, method: 'createRoutine', expected: { title: 'Check feed', prompt: 'Check this feed', schedule: 'RRULE:FREQ=DAILY', timeZone: 'Europe/London' } },
      { data: { title: 'Changed title' }, argv: ['routine', 'update', 'rt_1', '--spec', filename], operation: true, method: 'updateRoutine', expected: { routineId: 'rt_1', title: 'Changed title' } },
      { data: { text: '$(do-not-execute) `echo nope`\nnext' }, argv: ['tool-call', 'c_1', 'write', '--args-file', filename], operation: true, method: 'toolCall', expected: { connectorId: 'c_1', name: 'write', arguments: { text: '$(do-not-execute) `echo nope`\nnext' } } },
    ];
    for (const entry of checks) {
      await writeFile(filename, JSON.stringify(entry.data));
      let received;
      const methods = { async [entry.method](options) { received = options; return { ok: true }; } };
      const deps = dependencies(entry.operation ? { operations: methods } : methods);
      await run(entry.argv, deps);
      assert.deepEqual(received, { ...entry.expected, signal: undefined });
    }
  });
});

test('removed event-trigger specifications fail before authentication or client creation', async () => {
  await temporary(async directory => {
    const filename = path.join(directory, 'event.json');
    for (const triggers of [[], [{ connector_type: 'gmail', webhook_name: 'message', params: {} }], null]) {
      await writeFile(filename, JSON.stringify({ title: 'Test', prompt: 'Test', schedule: 'RRULE:FREQ=DAILY', triggers }));
      for (const argv of [['routine', 'create', '--spec', filename], ['routine', 'update', 'r', '--spec', filename]]) {
        const deps = dependencies();
        deps.createClient = () => assert.fail('Unsupported event authoring must fail before authentication');
        await assert.rejects(run(argv, deps), error => error.code === 'UNSUPPORTED' && /Event-trigger authoring is unavailable/.test(error.message));
      }
    }
  });
});

test('malformed or ambiguous advanced commands are rejected before any client is opened', async () => {
  const cases = [
    ['search'], ['search', '--query', 'banana', '--all', '--room', 'r'],
    ['search', '--query', 'x', '--since', 'yesterday'],
    ['search', '--query', 'x', '--since', '2026-10-17T00:00:00Z', '--until', '2026-10-01T00:00:00Z'],
    ['search', '--query', 'x'.repeat(4097)], ['search', '--query', 'x', '--pages', '101'],
    ['thread'], ['thread', 'x', 'extra'], ['outline', '--unknown'],
    ['export'], ['export', '--output', 'file', '--format', 'yaml'], ['download', 'f'],
    ['actions', '--limit', '21'], ['actions', '--before', 'a', '--after', 'b'],
    ['action', 'get', 'm'], ['action', 'respond', 'm', '--action', 'accept'],
    ['action', 'respond', 'm', '--request-id', 'r', '--fingerprint', 'f', '--action', 'decline', '--persist', 'always'],
    ['react', 'm'], ['react', 'm', '--emoji', '🍌', '--clear'], ['read', 'm', '--delete'],
    ['rename', 'Name'], ['pause'], ['resume', '--dot', 'd', '--dot', 'e'],
    ['tasks', '--limit', '0'], ['threads'], ['threads', 'hidden'],
    ['routine', 'unknown'], ['routine', 'create'], ['routine', 'update', 'r'],
    ['routine', 'list', '--all', '--dot', 'd'], ['routine', 'list', '--filter', 'paused'],
    ['routine', 'run', 'r', '--key', 'invalid'], ['routine', 'result', 'r'],
    ['tools'], ['tool-call', 'c', 't'], ['tool-call', 'c', 't', '--args', '{}', '--args-file', 'f'],
    ['tool-call', 'c', 't', '--args', '[1]'], ['tool-call', 'c', 't', '--args', 'null'],
    ['tool-call', 'c', 't', '--args', '{invalid'], ['tool-call', 'c', 't', '--args', `{"text":"${'x'.repeat(256 * 1024)}"}`],
    ['chat', '--interval', '0'], ['capabilities', 'extra'], ['capabilities', '--json=true'],
  ];
  for (const argv of cases) {
    const deps = dependencies();
    deps.createClient = () => assert.fail('Invalid arguments must fail before client creation');
    await assert.rejects(run(argv, deps), CliError, argv.slice(0, 5).join(' '));
  }
});

test('unreadable, oversized, non-object, invalid UTF-8, and unsafe routine JSON fails before auth', async () => {
  await temporary(async directory => {
    const filename = path.join(directory, 'input.json');
    const folder = path.join(directory, 'folder');
    await mkdir(folder);
    const cases = [
      { file: path.join(directory, 'absent'), pattern: /Could not read/ },
      { file: folder, pattern: /regular file/ },
      { value: Buffer.from([0xc3, 0x28]), pattern: /UTF-8/ },
      { value: '[]', pattern: /JSON object/ },
      { value: '{', pattern: /valid JSON/ },
      { value: '{"text":"' + 'x'.repeat(256 * 1024) + '"}', pattern: /256 KiB/ },
      { value: '{"routineId":"hijack"}', routine: true, pattern: /unknown field/ },
      { value: '{}', routine: true, pattern: /at least one field/ },
    ];
    for (const entry of cases) {
      if (entry.value !== undefined) await writeFile(filename, entry.value);
      const deps = dependencies();
      deps.createClient = () => assert.fail('Bad JSON input must fail before client creation');
      const argv = entry.routine ? ['routine', 'update', 'rt_1', '--spec', filename] : ['tool-call', 'c', 't', '--args-file', entry.file ?? filename];
      await assert.rejects(run(argv, deps), entry.pattern);
    }
    await writeFile(filename, '{"x":1}' + ' '.repeat(256 * 1024 - 7));
    assert.deepEqual(await readJsonObject(filename), { x: 1 });
  });
});

test('extended send supports attachments, replies, wait time, and file-only messages without altering the basic shape', async () => {
  const cases = [
    { argv: ['send', 'Hello', '--attach', './one.png', '--attach=./two.pdf', '--reply-to', 'm_1', '--wait', '2.5'], expected: { text: 'Hello', files: [path.resolve('./one.png'), path.resolve('./two.pdf')], replyTo: 'm_1', waitSeconds: 2.5 } },
    { argv: ['send', '--attach', './one.txt'], expected: { text: '', files: [path.resolve('./one.txt')] } },
    { argv: ['send', '', '--attach', './one.txt', '--wait', '0'], expected: { text: '', files: [path.resolve('./one.txt')], waitSeconds: 0 } },
  ];
  for (const entry of cases) {
    let received;
    const deps = dependencies({ async send(options) { received = options; return { accepted: true }; } });
    deps.signals = new EventEmitter();
    await run(entry.argv, deps);
    const { signal, ...request } = received;
    assert.deepEqual(request, { ...entry.expected, roomId: undefined, idempotencyKey: KEY });
    if (entry.expected.waitSeconds > 0) {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
    } else assert.equal(signal, undefined);
    assert.equal(deps.signals.listenerCount('SIGINT'), 0);
    assert.equal(deps.signals.listenerCount('SIGTERM'), 0);
  }
  const deps = dependencies({ async send(options) { assert.equal(options.text, ''); return { accepted: true }; } });
  deps.stdin = Readable.from(['']);
  await run(['send', '--stdin', '--attach', './one.txt'], deps);
  for (const argv of [
    ['send', 'x', '--wait', '-1'], ['send', 'x', '--wait', '301'], ['send', 'x', '--wait', 'NaN'],
    ['send', 'x', '--reply-to', 'one', '--reply-to', 'two'],
    ['send', ...Array.from({ length: 11 }, () => ['--attach', './file']).flat()],
  ]) assert.throws(() => parseArgs(argv), CliError);
});

test('paged history uses historyPages and watch forwards persistent cursor path', async () => {
  const deps = dependencies({
    async historyPages(options) {
      assert.deepEqual(options, { roomId: 'r', limit: 20, before: undefined, after: 'anchor', pages: 7, signal: undefined });
      return { messages: [], pagesRead: 7 };
    },
    async watch(options) { assert.equal(options.cursorFile, path.resolve('./cursor.json')); },
  });
  deps.signals = new EventEmitter();
  await run(['history', '--room', 'r', '--after', 'anchor', '--pages', '7', '--json'], deps);
  await run(['watch', '--cursor-file', './cursor.json'], deps);
  assert.deepEqual(JSON.parse(deps.stdout.text), { messages: [], pagesRead: 7 });
  assert.equal(deps.signals.listenerCount('SIGINT'), 0);
});

test('watch all dispatches the shared callbacks to watchAll and excludes room and cursor state', async () => {
  assert.deepEqual(parseArgs(['watch', '--all', '--from-start', '--interval', '2', '--duration', '10', '--json']), {
    command: 'watch', all: true, fromStart: true, intervalMs: 2000, duration: 10, json: true,
  });
  for (const argv of [
    ['watch', '--all', '--room', 'r'], ['watch', '--all', '--cursor-file', './cursor.json'],
    ['watch', '--all', '--all'], ['watch', '--all=true'],
  ]) assert.throws(() => parseArgs(argv), CliError);
  const signals = new EventEmitter();
  const message = { roomId: 'room_1', id: 'm_1', role: 'assistant', text: 'Hello' };
  let calls = 0;
  const deps = dependencies({
    async watch() { assert.fail('watch --all must use watchAll'); },
    async watchAll(options) {
      calls++;
      assert.equal(options.roomId, undefined);
      assert.equal(options.cursorFile, undefined);
      assert.equal(options.intervalMs, 2000);
      assert.equal(options.fromStart, true);
      await options.onReady({ roomCount: 2 });
      await options.onMessage(message);
      signals.emit('SIGINT');
      assert.equal(options.signal.aborted, true);
    },
  });
  deps.signals = signals;
  await run(['watch', '--all', '--interval', '2', '--from-start', '--json'], deps);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(deps.stdout.text), message);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(deps.stderr.text, '');
});

test('interactive chat receives streams and signal without a trailing JSON receipt', async () => {
  const client = {};
  const deps = dependencies(client);
  const signal = new AbortController().signal;
  deps.signal = signal;
  deps.stdin = Readable.from([]);
  deps.chat = async (receivedClient, options) => {
    assert.equal(receivedClient, client);
    assert.deepEqual(options, { roomId: 'r', intervalMs: 2000, signal, input: deps.stdin, output: deps.stdout, error: deps.stderr });
    options.output.write('Dot> Ready\n');
    return { sentCount: 0, reason: 'quit' };
  };
  const result = await run(['chat', '--room', 'r', '--interval', '2'], deps);
  assert.equal(result.reason, 'quit');
  assert.equal(deps.stdout.text, 'Dot> Ready\n');
});
