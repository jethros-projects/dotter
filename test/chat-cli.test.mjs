import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runChat } from '../src/chat.mjs';
import { nativeCliFixture } from './helpers/native-cli-fixture.mjs';

const cli = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));
async function fixture(t, holdWatch = false) {
  const native = await nativeCliFixture(t, {
    respond(request, response) {
      const path = new URL(request.url).pathname;
      const watch = request.method === 'GET' && path === '/backend-api/messaging/rooms/room_test/messages';
      if (holdWatch && watch) return;
      const body = request.method === 'POST' ? { id: 'synthetic-message' }
        : watch ? { items: [], next_cursor: null, prev_cursor: null }
        : { id: 'room_test', members: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    },
  });
  const auth = join(native.directory, 'auth.json');
  await writeFile(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-chat-token', account_id: 'synthetic-chat-account' } }), { mode: 0o600 });
  return { directory: native.directory, log: native.logFile, env: native.env,
    args: [...native.nodeArgs, cli, 'chat', '--room', 'room_test', '--auth-file', auth, '--interval', '1'],
    nativeCalls: native.calls, nativeConnections: native.connections,
    async calls() {
      return native.calls.map(({ request }) => ({ method: request.method, path: new URL(request.url).pathname,
        body: request.body ? JSON.parse(request.body) : null }));
    },
  };
}
async function piped(f, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, f.args, { cwd: f.directory, env: f.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}
function messages(calls) { return calls.filter(call => call.method === 'POST').map(call => call.body.content.text); }

test('real chat CLI sends leading-space slash commands literally and quits only on an unescaped command', async t => {
  const f = await fixture(t);
  const result = await piped(f, ' /help\n /quit\n /attach literal\n/quit\nThis must not send\n');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(messages(await f.calls()), [' /help', ' /quit', ' /attach literal']);
});

test('real chat CLI ignores help, blank and unknown commands and exits on EOF without a send', async t => {
  const f = await fixture(t), result = await piped(f, '/help\n\n/unknown\n/attach\n');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(messages(await f.calls()), []);
  assert.match(result.stderr, /Unknown command/); assert.match(result.stderr, /Use \/attach PATH/);
});

test('real chat CLI clears a failed attachment attempt before the next explicit message', async t => {
  const f = await fixture(t), result = await piped(f, '/attach missing-fixture.txt\nReview attachment\nNext message\n/quit\n');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(messages(await f.calls()), ['Next message']);
  assert.match(result.stderr, /Send failed:/);
  const keys = [...result.stderr.matchAll(/Request key: ([a-f0-9-]{36})/g)].map(match => match[1]);
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
});

test('real chat CLI reuses a native connection for sequential sends and releases its pool on exit', async t => {
  const f = await fixture(t), result = await piped(f, 'First message\nSecond message\nThird message\n/quit\n');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(messages(await f.calls()), ['First message', 'Second message', 'Third message']);
  const sends = f.nativeCalls.filter(({ request }) => request.method === 'POST');
  assert.ok(new Set(sends.map(call => call.connectionId)).size < sends.length,
    'sequential sends must reuse a native connection');
  assert.ok(f.nativeConnections.every(connection => connection.closed),
    'normal CLI exit must release every active and idle pooled connection');
});

// Python provides an offline controlling terminal for readline's raw keys.
// The Node CLI itself runs without Python on PATH; its native requests use
// the same loopback fixture, including a real pending watcher socket.
const terminalHarness = String.raw`
import errno, fcntl, json, os, pty, select, signal, subprocess, sys, termios, time
config = json.load(sys.stdin)
master, slave = pty.openpty()
def setup():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
child = subprocess.Popen([config['node']] + config['args'], cwd=config['directory'], env=config['env'], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
os.close(slave)
output = bytearray()
def calls():
    try:
        with open(config['log']) as source: return [json.loads(line) for line in source if line.strip()]
    except FileNotFoundError: return []
def pump(until, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if until(): return True
        readable, _, _ = select.select([master], [], [], 0.03)
        if readable:
            try: data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                data = b''
            output.extend(data)
        if child.poll() is not None: return until()
    return until()
timed_out = False
def interrupted(_signum, _frame): raise SystemExit(124)
try:
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    ready = pump(lambda: b'You> ' in output and (not config['holdWatch'] or any(call['request']['method'] == 'GET' and call['request']['url'].split('?', 1)[0].endswith('/rooms/room_test/messages') for call in calls())), 5)
    if ready:
        if config['operation'] == 'ctrl-c': os.write(master, b'\x03')
        elif config['operation'] == 'quit': os.write(master, b'/quit\r')
        elif config['operation'] == 'edited-message':
            os.write(master, b'hellx\x7fo\r')
            if not pump(lambda: any(call['request']['method'] == 'POST' for call in calls()), 5):
                raise RuntimeError('Edited terminal message was not submitted')
            os.write(master, b'/quit\r')
        else: os.kill(child.pid, signal.SIGTERM)
        timed_out = not pump(lambda: child.poll() is not None, 3)
    else: timed_out = True
    if timed_out:
        os.kill(child.pid, signal.SIGKILL)
    code = child.wait(timeout=2)
    print(json.dumps({'ready': ready, 'code': code, 'timedOut': timed_out, 'output': output.decode('utf-8', errors='replace')}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
`;

for (const operation of ['ctrl-c', 'sigterm', 'quit', 'edited-message']) test(`real chat CLI handles ${operation} and closes its native watcher socket`, async t => {
  const holdWatch = operation !== 'edited-message', f = await fixture(t, holdWatch);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', terminalHarness], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify({ ...f, node: process.execPath, holdWatch, operation }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.ready, true, observed.output); assert.equal(observed.timedOut, false, observed.output);
  assert.equal(observed.code, 0, observed.output);
  const watchers = f.nativeCalls.filter(({ request }) => request.method === 'GET'
    && new URL(request.url).pathname === '/backend-api/messaging/rooms/room_test/messages');
  if (holdWatch) assert.ok(watchers.length > 0, 'the terminal must cancel a real pending watcher request');
  assert.ok(watchers.every(call => call.closed), 'exiting chat must close its native watcher socket');
  assert.ok(f.nativeConnections.every(connection => connection.closed),
    'terminal exit must release active and idle pooled connections');
  assert.deepEqual(messages(await f.calls()), operation === 'edited-message' ? ['hello'] : []);
});

test('repeated chat sessions remove their process signal handlers after cancellation', async () => {
  const signals = new EventEmitter();
  for (let index = 0; index < 2; index++) {
    const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
    let watched;
    const ready = new Promise(resolve => { watched = resolve; });
    const result = runChat({
      async send() { assert.fail('Cancelling idle chat must not send'); },
      async watch({ signal }) { watched(); if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    }, { input, output, error, signals });
    await ready;
    assert.equal(signals.listenerCount('SIGINT'), 1); assert.equal(signals.listenerCount('SIGTERM'), 1);
    signals.emit('SIGTERM');
    assert.deepEqual(await result, { sentCount: 0, reason: 'aborted' });
    assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    input.destroy(); output.destroy(); error.destroy();
  }
});
