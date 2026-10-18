import assert from 'node:assert/strict';
import { commandHelp } from '../src/help.mjs';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CliError, HELP, parseArgs, run } from '../src/cli.mjs';
import { v3CommandNames } from '../src/v3-commands.mjs';
import { DotConnections } from '../src/connections.mjs';
import { v4Commands } from '../src/v4-commands.mjs';

const KEY = 'bcd22c2c-481e-488b-aefa-c3bac9cc60e7';
const buffer = () => ({ text: '', write(value) { this.text += value; return true; } });
function setup(invoke = async () => ({ completed: true })) {
  const calls = [], clientCalls = [], client = {};
  const deps = {
    stdout: buffer(), stderr: buffer(), stdin: Readable.from([]), uuid: () => KEY,
    async createClient(config) { clientCalls.push(config); return client; },
    async v3Invoke(module, method, args) { calls.push({ module, method, args }); return invoke(module, method, args); }
  };
  return { deps, calls, clientCalls, client };
}
async function temporary(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dot-v3-cli-'));
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const dispatchCases = [
  ['room', [], 'client', 'room', {}],
  ['typing', ['--room', 'room_1'], 'client', 'typing', { roomId: 'room_1' }],
  ['prepare', ['--room', 'room_1'], 'client', 'prepare', { roomId: 'room_1' }],
  ['task-subscription', ['task_1', '--room', 'room_1'], 'client', 'taskSubscription', { taskId: 'task_1', roomId: 'room_1' }],
  ['dot create', ['Example'], 'lifecycle', 'create', { name: 'Example' }],
  ['dot delete', ['dot_1', '--confirm', 'dot_1'], 'lifecycle', 'remove', { dotId: 'dot_1', confirmDotId: 'dot_1' }],
  ['dot primary', ['dot_1'], 'lifecycle', 'setPrimary', { dotId: 'dot_1' }],
  ['dot clear-primary', ['--generation', 'generation_1', '--confirm'], 'lifecycle', 'clearPrimary', { generation: 'generation_1', confirm: true }],
  ['dot avatar-upload', ['./avatar.png'], 'lifecycle', 'uploadAvatarSnapshot', { file: path.resolve('./avatar.png') }],
  ['dot ensure-room', ['--dot', 'dot_1'], 'lifecycle', 'ensureRoom', { dotId: 'dot_1' }],
  ['dot root', [], 'lifecycle', 'rootThread', {}],
  ['dot reboot', ['--dot', 'dot_1', '--confirm', 'dot_1'], 'lifecycle', 'reboot', { dotId: 'dot_1', confirmDotId: 'dot_1' }],
  ['environment status', ['--dot', 'dot_1', '--thread', 'thread_1'], 'lifecycle', 'environmentStatus', { dotId: 'dot_1', threadId: 'thread_1' }],
  ['environment recreate', ['--dot', 'dot_1', '--thread', 'thread_1', '--confirm', 'dot_1'], 'lifecycle', 'recreateEnvironment', { dotId: 'dot_1', threadId: 'thread_1', confirmDotId: 'dot_1' }],
  ['computer list', ['--dot', 'dot_1'], 'lifecycle', 'listComputers', { dotId: 'dot_1' }],
  ['computer connect', ['env_1', '--dot', 'dot_1', '--thread', 'thread_1'], 'lifecycle', 'connectComputer', { environmentId: 'env_1', dotId: 'dot_1', threadId: 'thread_1' }],
  ['computer replace', ['env_1', '--dot', 'dot_1', '--confirm', 'env_1'], 'lifecycle', 'replaceComputer', { environmentId: 'env_1', dotId: 'dot_1', confirmEnvironmentId: 'env_1' }],
  ['computer disconnect', ['env_1', '--confirm', 'env_1'], 'lifecycle', 'disconnectComputer', { environmentId: 'env_1', confirmEnvironmentId: 'env_1' }],
  ['activity list', ['--dot', 'dot_1', '--limit=10', '--cursor', 'next'], 'lifecycle', 'activity', { dotId: 'dot_1', limit: 10, cursor: 'next' }],
  ['doctor check-in', ['--thread', 'thread_1'], 'lifecycle', 'doctorCheckIn', { threadId: 'thread_1' }],
  ['doctor setup', ['--thread', 'thread_1', '--confirm'], 'lifecycle', 'doctorSetup', { threadId: 'thread_1', confirm: true }],
  ['safety review', ['--dot', 'dot_1'], 'lifecycle', 'safetyReview', { dotId: 'dot_1' }],
  ['safety resume', ['--dot', 'dot_1', '--thread', 'thread_1', '--fingerprint', 'a'.repeat(64), '--confirm', 'dot_1'], 'lifecycle', 'resumeReviewed', { dotId: 'dot_1', threadId: 'thread_1', reviewFingerprint: 'a'.repeat(64), confirmDotId: 'dot_1' }],
  ['email-channel status', ['--dot', 'dot_1'], 'channels', 'emailStatus', { dotId: 'dot_1' }],
  ['email-channel options', [], 'channels', 'emailOptions', {}],
  ['email-channel claim', ['--dot', 'dot_1', '--local-part', 'person', '--domain', 'chatgpt.email', '--consent'], 'channels', 'claimEmail', { dotId: 'dot_1', localPart: 'person', domain: 'chatgpt.email', acceptedConsent: true }],
  ['email-channel link', ['inbox_1', '--consent'], 'channels', 'linkEmail', { inboxId: 'inbox_1', acceptedConsent: true }],
  ['email-channel unlink', ['--dot', 'dot_1', '--confirm'], 'channels', 'removeEmail', { dotId: 'dot_1', confirm: true }],
  ['meeting start', ['abc-defg-hij', '--dot', 'dot_1', '--key', KEY], 'channels', 'startMeeting', { meetingUrl: 'abc-defg-hij', dotId: 'dot_1', idempotencyKey: KEY }],
  ['voice attach', ['call_1', '--dot', 'dot_1'], 'voice', 'attachVoiceCall', { callId: 'call_1', dotId: 'dot_1' }],
  ['voice stop', ['call_1'], 'voice', 'stopVoiceCall', { callId: 'call_1' }],
  ['routine threads', ['routine_1', '--limit', '8', '--cursor', 'next'], 'extras', 'executionThreads', { routineId: 'routine_1', limit: 8, cursor: 'next' }],
  ['routine mark-read', ['routine_1', '--run', 'run_1'], 'extras', 'markRunRead', { routineId: 'routine_1', runId: 'run_1' }],
  ['routine latest', ['routine_1'], 'extras', 'latestRun', { routineId: 'routine_1' }],
  ['routine batch', ['routine_1'], 'extras', 'batchStatus', { routineId: 'routine_1' }],
  ['routine flush-batch', ['routine_1', '--key', KEY], 'extras', 'flushBatch', { routineId: 'routine_1', requestId: KEY }],
  ['routine policy', ['--service-account', 'service_1'], 'extras', 'schedulePolicy', { serviceAccountId: 'service_1' }],
  ['connector info', ['connector_1'], 'extras', 'connectorDetails', { connectorId: 'connector_1' }],
  ['connector health', ['connector_1', '--link', 'link_1'], 'extras', 'connectorHealth', { connectorId: 'connector_1', linkId: 'link_1' }],
  ['connection info', ['connector_1'], 'connections', 'get', { connectorId: 'connector_1' }],
  ['connection status', ['connector_1', '--link', 'link_1'], 'connections', 'status', { connectorId: 'connector_1', linkId: 'link_1' }],
  ['connection oauth', ['connector_1'], 'connections', 'startOAuth', { connectorId: 'connector_1' }],
  ['connection reauthorize', ['connector_1', '--link', 'link_1'], 'connections', 'reauthorize', { connectorId: 'connector_1', linkId: 'link_1' }],
  ['connection complete', ['connector_1', '--redirect-file', '-'], 'connections', 'completeOAuth', { connectorId: 'connector_1', redirectFile: '-' }],
  ['connection api-key', ['connector_1', '--key-file', './private-key'], 'connections', 'linkApiKey', { connectorId: 'connector_1', keyFile: path.resolve('./private-key') }],
  ['connection no-auth', ['connector_1'], 'connections', 'linkNoAuth', { connectorId: 'connector_1' }],
  ['connection unlink', ['connector_1', '--link', 'link_1', '--confirm'], 'connections', 'unlink', { connectorId: 'connector_1', linkId: 'link_1', confirm: true }],
  ['library browse', ['--directory', 'dir_1', '--query', 'hello', '--category', 'document', '--folders-only'], 'library', 'browse', { directoryId: 'dir_1', query: 'hello', categories: ['document'], foldersOnly: true }],
  ['library search', ['--query', 'hello', '--category', 'image', '--trash', '--limit', '8', '--cursor', 'next'], 'library', 'search', { query: 'hello', categories: ['image'], trash: true, limit: 8, cursor: 'next' }],
  ['library get', ['file_1'], 'library', 'get', { fileId: 'file_1' }],
  ['library get', ['file_1', '--include-trashed'], 'library', 'get', { fileId: 'file_1', includeTrashed: true }],
  ['library rename', ['file_1', 'New name'], 'library', 'rename', { fileId: 'file_1', name: 'New name' }],
  ['library move', ['file_1', '--directory', 'dir_1'], 'library', 'move', { fileId: 'file_1', directoryId: 'dir_1' }],
  ['library trash', ['file_1', '--confirm', 'file_1'], 'library', 'trash', { fileId: 'file_1', confirm: 'file_1' }],
  ['library restore', ['file_1'], 'library', 'restore', { fileId: 'file_1' }],
  ['library versions', ['file_1', '--limit', '5', '--cursor', 'next'], 'library', 'versions', { fileId: 'file_1', limit: 5, cursor: 'next' }],
  ['library restore-version', ['file_1', '--version', '2', '--expected-version', '5', '--confirm', 'file_1'], 'library', 'restoreVersion', { fileId: 'file_1', version: 2, expectedCurrentVersion: 5, confirm: 'file_1' }],
  ['library favorites', ['--limit', '4'], 'library', 'favorites', { limit: 4 }],
  ['library favorite', ['file_1'], 'library', 'favorite', { fileId: 'file_1' }],
  ['library unfavorite', ['favorite_1'], 'library', 'unfavorite', { favoriteId: 'favorite_1' }],
  ['library favorite-status', ['file_1, file_2'], 'library', 'favoriteStatus', { fileIds: ['file_1', 'file_2'] }],
  ['library usage', [], 'library', 'storageUsage', {}],
  ['library directory-path', ['dir_1'], 'library', 'directoryPath', { directoryId: 'dir_1' }],
  ['library rename-directory', ['dir_1', 'New directory'], 'library', 'renameDirectory', { directoryId: 'dir_1', name: 'New directory' }],
  ['library move-directory', ['dir_1', '--parent', 'dir_2'], 'library', 'moveDirectory', { directoryId: 'dir_1', parentDirectoryId: 'dir_2' }],
];

// V4 intentionally replaces these public routes; the v4 descriptor suite
// verifies their new implementations through the complete CLI entry point.
const activeDispatchCases = dispatchCases.filter(([name]) => !Object.hasOwn(v4Commands, name));

for (const [command, argv, module, method, expected] of activeDispatchCases) {
  test(`v3 dispatch: ${command}`, async () => {
    const result = { completed: true, command };
    const { deps, calls, clientCalls } = setup(async () => result);
    deps.signal = new AbortController().signal;
    assert.equal(await run([...command.split(' '), ...argv, '--auth-file', './custom-auth.json', '--json'], deps), result);
    const injected = module === 'connections' ? { input: deps.stdin } : module === 'voice' ? { output: deps.stdout } : {};
    assert.deepEqual(calls, [{ module, method, args: { ...expected, ...injected, signal: deps.signal } }]);
    assert.deepEqual(clientCalls, [{ authFile: path.resolve('./custom-auth.json') }]);
    assert.deepEqual(JSON.parse(deps.stdout.text), result);
  });
}

test('v3 routes all have parser or stream coverage and help stays offline', async () => {
  const covered = new Set([...activeDispatchCases.map(entry => entry[0]), 'dot avatar', 'voice allocate', 'voice chat', 'activity watch', 'activity room', 'events watch', 'task-events watch']);
  assert.deepEqual([...covered].sort(), [...v3CommandNames].filter(name => !Object.hasOwn(v4Commands, name)).sort());
  for (const argv of [['dot', '--help'], ['environment', '-h'], ['email-channel', 'claim', '--help'], ['routine', 'threads', '-h'], ['events', 'watch', '--help'], ['task-events', 'watch', '--help'], ['library', '--help']]) {
    const { deps, calls, clientCalls } = setup();
    await run(argv, deps);
    assert.equal(calls.length, 0);
    assert.equal(clientCalls.length, 0);
    assert.equal(deps.stdout.text, commandHelp(argv.slice(0, -1).join(' ')));
  }
});

test('v3 optional keys are allocated and announced before exactly one mutation', async () => {
  for (const command of [['meeting', 'start', 'abc-defg-hij'], ['routine', 'flush-batch', 'routine_1']]) {
    const { deps, calls } = setup(async (module, method, args) => {
      assert.equal(deps.stderr.text, `Request key: ${KEY}\n`);
      assert.equal(args[method === 'startMeeting' ? 'idempotencyKey' : 'requestId'], KEY);
      throw new Error('uncertain delivery');
    });
    await assert.rejects(run(command, deps), /uncertain delivery/);
    assert.equal(calls.length, 1);
    assert.equal(deps.stdout.text, '');
  }
});

test('v3 rejects malformed flags and missing or mismatched confirmations before client creation', async () => {
  const invalid = [
    ['dot', 'mystery'], ['dot', 'create'], ['dot', 'create', 'one', 'two'], ['room', 'extra'],
    ['dot', 'delete', 'dot_1'], ['dot', 'delete', 'dot_1', '--confirm', 'dot_2'],
    ['dot', 'clear-primary', '--generation', 'gen'], ['doctor', 'setup', '--thread', 't'],
    ['environment', 'recreate', '--dot', 'dot_1', '--confirm', 'dot_2'],
    ['computer', 'replace', 'env_1', '--confirm', 'env_2'], ['computer', 'disconnect', 'env_1'],
    ['safety', 'resume', '--dot', 'dot_1', '--confirm', 'dot_1'],
    ['email-channel', 'claim', '--local-part', 'a', '--domain', 'chatgpt.email'],
    ['email-channel', 'link', 'inbox_1'], ['email-channel', 'unlink'],
    ['connection', 'unlink', 'c', '--link', 'l'], ['connection', 'complete', 'c'], ['connection', 'api-key', 'c'],
    ['connection', 'reauthorize', 'c'], ['library', 'trash', 'f', '--confirm', 'other'],
    ['library', 'move', 'f'], ['library', 'restore-version', 'f', '--version', '1', '--confirm', 'f'],
    ['events', 'watch', '--all', '--room', 'r'], ['events', 'watch', '--all', '--task', 't'],
    ['events', 'watch', '--duration', '0'], ['events', 'watch', '--duration', '86401'],
    ['activity', 'list', '--limit', '0'], ['activity', 'list', '--limit', '101'], ['activity', 'list', '--limit', '1.5'],
    ['activity', 'list', '--limit', '-1'], ['activity', 'list', '--limit', '9007199254740992'],
    ['room', '--room', 'one', '--room', 'two'], ['room', '--json=true'], ['room', '--room'],
    ['room', '--room='], ['room', '--room', 'bad\nvalue'], ['library', 'get', 'bad\0value'],
    ['meeting', 'start', 'abc-defg-hij', '--key', 'bad-key'], ['routine', 'flush-batch', 'r', '--key', 'not-a-uuid'],
    ['connection', 'api-key', 'c', '--key', 'secret-do-not-echo'],
  ];
  for (const argv of invalid.filter(argv => !Object.keys(v4Commands).some(name => name.split(' ').every((word,index) => argv[index] === word)))) {
    const { deps, calls, clientCalls } = setup();
    await assert.rejects(run(argv, deps), CliError, JSON.stringify(argv));
    assert.equal(calls.length, 0, JSON.stringify(argv));
    assert.equal(clientCalls.length, 0, JSON.stringify(argv));
    assert.equal(deps.stdout.text, '');
  }
});

test('v3 unknown options never include submitted secrets in their error message', () => {
  assert.throws(() => parseArgs(['room', '--secret=super-secret-value']), error =>
    error instanceof CliError && !error.message.includes('super-secret-value'));
});

test('v3 allows -- to keep option-shaped positional names literal', async () => {
  const { deps, calls } = setup();
  await run(['dot', 'create', '--', '--not-an-option'], deps);
  assert.equal(calls[0].args.name, '--not-an-option');
});

test('v3 destructive runtime commands use the confirmed Dot when no --dot is supplied', async () => {
  for (const argv of [
    ['dot', 'reboot', '--confirm', 'dot_1'],
    ['environment', 'recreate', '--confirm', 'dot_1'],
    ['safety', 'resume', '--fingerprint', 'a'.repeat(64), '--confirm', 'dot_1'],
  ]) {
    const { deps, calls } = setup();
    await run(argv, deps);
    assert.equal(calls[0].args.dotId, 'dot_1');
    assert.equal(calls[0].args.confirmDotId, 'dot_1');
  }
});

test('v3 does not advertise or silently accept an unsupported connection info flag', async () => {
  const { deps, clientCalls } = setup();
  await assert.rejects(run(['connection', 'info', 'connector_1', '--actions'], deps), CliError);
  assert.equal(clientCalls.length, 0);
});

test('v3 JSON specs are merged with only command-appropriate fields', async () => temporary(async directory => {
  const createFile = path.join(directory, 'create.json'), avatarFile = path.join(directory, 'avatar.json');
  const manifestFile = path.join(directory, 'manifest.json'), authFile = path.join(directory, 'oauth.json');
  const reauthFile = path.join(directory, 'reauth.json');
  await writeFile(createFile, JSON.stringify({ avatarType: 'static', avatar: '😀', createThread: false, createAdditional: true, shouldInitialize: false }));
  await writeFile(avatarFile, JSON.stringify({ avatar: '😀', name: 'New name' }));
  await writeFile(manifestFile, JSON.stringify({ width: 128, height: 128 }));
  await writeFile(authFile, JSON.stringify({ actionNames: ['read'], requestedScopes: ['scope.read'], linkParams: { host: 'service.example' } }));
  await writeFile(reauthFile, JSON.stringify({ requestedScopes: ['scope.read'] }));
  const tests = [
    [['dot', 'create', 'Name', '--spec', createFile], 'lifecycle', 'create', { name: 'Name', avatarType: 'static', avatar: '😀', createThread: false, createAdditional: true, shouldInitialize: false }],
    [['dot', 'avatar', 'dot_1', '--spec', avatarFile], 'lifecycle', 'avatar', { dotId: 'dot_1', avatar: '😀', name: 'New name' }],
    [['dot', 'avatar-upload', './avatar.png', '--manifest', manifestFile], 'lifecycle', 'uploadAvatarSnapshot', { file: path.resolve('./avatar.png'), avatarManifest: { width: 128, height: 128 } }],
    [['connection', 'oauth', 'connector_1', '--spec', authFile], 'connections', 'startOAuth', { connectorId: 'connector_1', actionNames: ['read'], requestedScopes: ['scope.read'], linkParams: { host: 'service.example' } }],
    [['connection', 'reauthorize', 'connector_1', '--link', 'link_1', '--spec', reauthFile], 'connections', 'reauthorize', { connectorId: 'connector_1', linkId: 'link_1', requestedScopes: ['scope.read'] }],
  ];
  for (const [argv, module, method, args] of tests) {
    const { deps, calls } = setup();
    await run(argv, deps);
    assert.deepEqual(calls, [{ module, method, args: { ...args, ...(module === 'connections' ? { input: deps.stdin } : {}), signal: undefined } }]);
  }
  const rejected = setup();
  await assert.rejects(run(['connection', 'reauthorize', 'connector_1', '--link', 'link_1', '--spec', authFile], rejected.deps), CliError);
  assert.equal(rejected.clientCalls.length, 0);
}));

test('v3 rejects malformed JSON specs and unsupported input files before authentication', async () => temporary(async directory => {
  const invalid = path.join(directory, 'invalid.json'), utf8 = path.join(directory, 'utf8.json');
  const array = path.join(directory, 'array.json');
  const oversized = path.join(directory, 'large.json');
  const folder = path.join(directory, 'folder'), injected = path.join(directory, 'injected.json');
  await writeFile(invalid, '{"secret":"do-not-echo",');
  await writeFile(utf8, Buffer.from([0xff]));
  await writeFile(array, '[]');
  await writeFile(oversized, ' '.repeat(256 * 1024 + 1));
  await mkdir(folder);
  await writeFile(injected, JSON.stringify({ signal: {}, authFile: '/secret', name: 'override' }));
  const files = [invalid, utf8, array, oversized, folder, path.join(directory, 'missing'), injected];
  for (const filename of files) {
    const { deps, calls, clientCalls } = setup();
    await assert.rejects(run(['dot', 'create', 'Name', '--spec', filename], deps), error =>
      error instanceof CliError && !error.message.includes('do-not-echo'));
    assert.equal(clientCalls.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(deps.stdout.text, '');
  }
}));

test('v3 reads a bounded SDP file before starting the voice API', async () => temporary(async directory => {
  const filename = path.join(directory, 'offer.sdp'), sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
  await writeFile(filename, sdp);
  const { deps, calls } = setup();
  await run(['voice', 'allocate', '--dot', 'dot_1', '--root-thread', 'thread_1', '--sdp-file', filename, '--instant-connect'], deps);
  assert.deepEqual(calls, [{ module: 'voice', method: 'allocateVoiceCall', args: {
    dotId: 'dot_1', rootThreadId: 'thread_1', sdp, instantConnect: true, output: deps.stdout, signal: undefined
  } }]);
  for (const content of ['', 'not an SDP', 'v=0\0bad', Buffer.from([0xff]), 'v=0' + ' '.repeat(256 * 1024)]) {
    await writeFile(filename, content);
    const bad = setup();
    await assert.rejects(run(['voice', 'allocate', '--sdp-file', filename], bad.deps), CliError);
    assert.equal(bad.clientCalls.length, 0);
    assert.equal(bad.calls.length, 0);
  }
  const linked = path.join(directory, 'link.sdp'); await symlink(filename, linked);
  const bad = setup();
  await assert.rejects(run(['voice', 'allocate', '--sdp-file', linked], bad.deps), CliError);
  assert.equal(bad.clientCalls.length, 0);
}));

for (const [argv, method, expected] of [
  [['events', 'watch', '--room', 'room_1', '--task', 'task_1', '--no-reconnect'], 'watch', { roomId: 'room_1', taskId: 'task_1', reconnect: false }],
  [['events', 'watch', '--all'], 'watch', { all: true }],
  [['task-events', 'watch', '--dot', 'dot_1', '--task', 'task_1', '--no-reconnect'], 'taskEvents', { dotId: 'dot_1', taskId: 'task_1', reconnect: false }],
  [['activity', 'watch', '--dot', 'dot_1'], 'activity', { dotId: 'dot_1' }],
  [['activity', 'room', '--room', 'room_1'], 'roomLive', { roomId: 'room_1' }],
]) {
  test(`v3 live streams emit NDJSON and clean up cancellation: ${argv.join(' ')}`, async () => {
    const signals = new EventEmitter(), external = new AbortController();
    const baseline = getEventListeners(external.signal, 'abort').length;
    const { deps, calls } = setup(async (module, gotMethod, args) => {
      assert.equal(module, 'live'); assert.equal(gotMethod, method);
      assert.deepEqual(Object.fromEntries(Object.entries(args).filter(([key]) => !['signal', 'onEvent', 'onReady'].includes(key))), expected);
      assert.notEqual(args.signal, external.signal);
      args.onReady({ roomId: 'room_1' });
      await args.onEvent({ type: 'message', text: 'hello\nworld' });
      signals.emit('SIGINT');
      assert.equal(args.signal.aborted, true);
      throw new DOMException('Aborted', 'AbortError');
    });
    Object.assign(deps, { signals, signal: external.signal });
    assert.equal(await run(argv, deps), undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(deps.stdout.text.trim().split('\n').map(JSON.parse), [{ type: 'message', text: 'hello\nworld' }]);
    assert.match(deps.stderr.text, /Live connection ready for room_1/);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(getEventListeners(external.signal, 'abort').length, baseline);
  });
}

test('voice listen-only option reaches the voice workflow and cleans up stream listeners', async () => {
  const signals = new EventEmitter();
  const { deps, calls } = setup(async (module, method, args) => {
    assert.equal(module, 'voice');
    assert.equal(method, 'runVoiceChat');
    assert.equal(args.listenOnly, true);
    assert.equal(args.openBrowser, false);
    assert.equal(args.dotId, 'dot_1');
    return { status: 'stopped' };
  });
  deps.signals = signals;
  await run(['voice', 'chat', '--dot', 'dot_1', '--listen-only', '--no-open'], deps);
  assert.equal(calls.length, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('v3 stream failures propagate once and still detach listeners', async () => {
  const signals = new EventEmitter(), external = new AbortController();
  const { deps, calls } = setup(async () => { throw new Error('live connection failed'); });
  Object.assign(deps, { signals, signal: external.signal });
  await assert.rejects(run(['events', 'watch'], deps), /live connection failed/);
  assert.equal(calls.length, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('v3 stream duration aborts and clears event handlers', async () => {
  const signals = new EventEmitter();
  const { deps } = setup(async (module, method, args) => new Promise((resolve, reject) => {
    args.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  deps.signals = signals;
  await run(['events', 'watch', '--duration', '1'], deps);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('v3 streams propagate preexisting and future external cancellation', async () => {
  for (const alreadyAborted of [false, true]) {
    const external = new AbortController(), signals = new EventEmitter();
    if (alreadyAborted) external.abort();
    const { deps } = setup(async (module, method, args) => {
      if (!alreadyAborted) external.abort();
      assert.equal(args.signal.aborted, true);
      throw new DOMException('Aborted', 'AbortError');
    });
    Object.assign(deps, { signals, signal: external.signal });
    await run(['activity', 'watch'], deps);
    assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  }
});

test('v3 interactive voice passes output and no-open then handles SIGTERM without JSON suffix', async () => {
  const signals = new EventEmitter();
  const { deps, calls } = setup(async (module, method, args) => {
    assert.equal(module, 'voice'); assert.equal(method, 'runVoiceChat');
    assert.equal(args.dotId, 'dot_1'); assert.equal(args.rootThreadId, 'thread_1');
    assert.equal(args.openBrowser, false); assert.equal(args.output, deps.stdout);
    deps.stdout.write('Voice ready\n');
    signals.emit('SIGTERM');
    assert.equal(args.signal.aborted, true);
    return { closed: true };
  });
  deps.signals = signals;
  assert.deepEqual(await run(['voice', 'chat', '--dot', 'dot_1', '--root-thread', 'thread_1', '--no-open'], deps), { closed: true });
  assert.equal(deps.stdout.text, 'Voice ready\n');
  assert.equal(calls.length, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('v3 surfaces uncertain voice cleanup even when interrupted', async () => {
  const signals = new EventEmitter();
  const { deps } = setup(async () => {
    signals.emit('SIGINT');
    return { dotId: 'dot_1', callId: 'rtc_call', stopError: { code: 'ACCOUNT_CHANGED' } };
  });
  deps.signals = signals;
  await assert.rejects(run(['voice', 'chat', '--dot', 'dot_1'], deps), error => {
    assert.equal(error.code, 'VOICE_CLEANUP_UNCONFIRMED');
    assert.equal(error.details.callId, 'rtc_call');
    assert.equal(error.details.cleanup, 'unconfirmed');
    return true;
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('v3 connection key files and stdin stay out of CLI output', async () => temporary(async directory => {
  const secret = 'private-api-key-never-print-this', filename = path.join(directory, 'key.txt');
  await writeFile(filename, secret + '\n', { mode: 0o600 });
  for (const keyFile of [filename, '-']) {
    const { deps } = setup();
    deps.stdin = Readable.from([Buffer.from(secret + '\n')]);
    const requests = [];
    const client = { transport: { async request(method, route, args) {
      requests.push({ method, route, args });
      if (method === 'GET') return { id: 'connector_1', name: 'Example', status: 'ENABLED', supported_auth: [{ type: 'API_KEY' }] };
      assert.equal(args.body.key, secret);
      return { id: 'link_1', token: secret };
    } } };
    deps.createClient = async () => client;
    deps.v3Invoke = async (module, method, args) => new DotConnections(client)[method](args);
    await run(['connection', 'api-key', 'connector_1', '--key-file', keyFile], deps);
    assert.equal(requests.length, 2);
    assert.doesNotMatch(deps.stdout.text + deps.stderr.text, new RegExp(secret));
    assert.deepEqual(JSON.parse(deps.stdout.text), { status: 'link_created', connectorId: 'connector_1', linkId: 'link_1' });
    assert.equal(await readFile(filename, 'utf8'), secret + '\n');
  }
}));

test('v3 OAuth callback files are forwarded privately and never echoed', async () => temporary(async directory => {
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect?state=private-state&code=private-oauth-code';
  const filename = path.join(directory, 'callback.txt'); await writeFile(filename, callback, { mode: 0o600 });
  const { deps } = setup();
  const client = { transport: { async request(method, route, args) {
    assert.equal(args.body.full_redirect_url, callback);
    return { link: { id: 'link_1', connector_id: 'connector_1', auth_type: 'OAUTH', auth_status: 'ACTIVE', access_token: 'private-token' } };
  } } };
  deps.createClient = async () => client;
  deps.v3Invoke = async (module, method, args) => new DotConnections(client)[method](args);
  await run(['connection', 'complete', 'connector_1', '--redirect-file', filename], deps);
  assert.equal(JSON.parse(deps.stdout.text).status, 'callback_accepted');
  assert.doesNotMatch(deps.stdout.text + deps.stderr.text, /private-state|private-oauth-code|private-token/);
}));
