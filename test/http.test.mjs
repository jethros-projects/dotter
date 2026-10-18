import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pythonFetch } from '../src/http.mjs';

function mockChild(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => child.emit('close', 1);
  let input = '';
  child.stdin.on('data', chunk => input += chunk);
  child.stdin.on('finish', () => onInput(JSON.parse(input), child));
  return child;
}

test('Python transport passes credentials only on stdin and reconstructs the response', async () => {
  const access = 'test-secret-not-an-argument';
  const options = { method: 'GET', headers: { Authorization: `Bearer ${access}` } };
  const response = await pythonFetch('https://chatgpt.com/backend-api/tbo/primary', options, {
    spawnImpl(command, args, spawnOptions) {
      assert.equal(command, 'python3');
      assert.equal(args[0], '-I');
      assert(!JSON.stringify(args).includes(access));
      assert(!JSON.stringify(spawnOptions).includes(access));
      return mockChild((input, child) => {
        assert.equal(input.headers.Authorization, `Bearer ${access}`);
        child.stdout.write(JSON.stringify({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}').toString('base64') }));
        child.emit('close', 0);
      });
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('Python transport preserves HTTP error classification without solving challenges', async () => {
  const response = await pythonFetch('https://chatgpt.com/backend-api/tbo', { method: 'GET', headers: {} }, {
    spawnImpl: () => mockChild((_input, child) => {
      child.stdout.write(JSON.stringify({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: Buffer.from('<html>challenge</html>').toString('base64') }));
      child.emit('close', 0);
    })
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cf-mitigated'), 'challenge');
});

test('missing Python produces actionable error without leaking subprocess details', async () => {
  await assert.rejects(pythonFetch('https://chatgpt.com/backend-api/tbo', { method: 'GET', headers: {} }, {
    spawnImpl: () => {
      const child = mockChild(() => {});
      queueMicrotask(() => child.emit('error', Object.assign(new Error('private details'), { code: 'ENOENT' })));
      return child;
    }
  }), { code: 'PYTHON_REQUIRED' });
});

test('Python helper rejects non-OpenAI destinations before making a request', async () => {
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL('../src/http.py', import.meta.url));
  const input = JSON.stringify({ url: 'https://example.com/backend-api/tbo', method: 'GET', headers: { Authorization: 'Bearer synthetic-secret' } });
  const code = 'import subprocess,sys; p=subprocess.run([sys.executable,"-I",sys.argv[1]],input=sys.argv[2],capture_output=True,text=True);print(p.stdout,end="")';
  const result = await exec('python3', ['-I', '-c', code, script, input]);
  assert.deepEqual(JSON.parse(result.stdout), { error: 'NETWORK_ERROR' });
  assert(!result.stdout.includes('synthetic-secret'));
  assert.equal(result.stderr, '');
});

const url = 'https://chatgpt.com/backend-api/offline-fixture';
const envelope = (body = '') => ({ status: 200, headers: {}, body: Buffer.from(body).toString('base64') });
function respond(value, options = {}) {
  return pythonFetch(url, options, { spawnImpl: () => mockChild((_input, child) => {
    child.stdout.write(JSON.stringify(value)); child.emit('close', 0);
  }) });
}
function rejected(code, delivery = 'unknown') {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.details.delivery, delivery);
    assert(!JSON.stringify(error).includes('synthetic-private'));
    assert(!error.message.includes('synthetic-private'));
    return true;
  };
}
function trackedChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kills = 0;
  child.kill = () => { child.kills++; child.emit('close', null, 'SIGTERM'); return true; };
  return child;
}

test('synchronous spawn failures are sanitized and establish no request delivery', async () => {
  for (const [failure, code] of [
    [Object.assign(new Error('synthetic-private-path'), { code: 'ENOENT' }), 'PYTHON_REQUIRED'],
    [Object.assign(new Error('synthetic-private-path'), { code: 'EACCES' }), 'NETWORK_ERROR'],
    [null, 'NETWORK_ERROR'],
  ]) {
    await assert.rejects(pythonFetch(url, {}, { spawnImpl() { throw failure; } }), rejected(code, 'not_sent'));
  }
});

test('serialization failures happen before any subprocess is started', async () => {
  const circular = {}; circular.self = circular;
  let starts = 0;
  for (const options of [{ headers: circular }, { bodyFile: circular }, { body: Symbol('synthetic-private-body') }]) {
    await assert.rejects(pythonFetch(url, options, { spawnImpl() { starts++; } }), rejected('INVALID_ARGUMENT', 'not_sent'));
  }
  await assert.rejects(pythonFetch({ toString() { throw new Error('synthetic-private-url'); } }, {}, {
    spawnImpl() { starts++; }
  }), rejected('INVALID_ARGUMENT', 'not_sent'));
  assert.equal(starts, 0);
});

test('invalid response limits, timeouts, and conflicting bodies fail before spawn', async () => {
  let starts = 0;
  const cases = [
    ...[true, null, 0, -1, 1.5, '100', 100 * 1024 * 1024 + 1].map(maxBytes => ({ maxBytes })),
    ...[true, null, 0, -1, 1.5, '100', 600001].map(timeoutMs => ({ timeoutMs })),
    { body: '', bodyFile: {} }, { body: Buffer.alloc(0), bodyFile: {} },
  ];
  for (const options of cases) await assert.rejects(pythonFetch(url, options, { spawnImpl() { starts++; } }), rejected('INVALID_ARGUMENT', 'not_sent'));
  assert.equal(starts, 0);
});

test('non-object options reject cleanly without starting a subprocess', async () => {
  let starts = 0;
  for (const options of [null, false, 5, 'request', []]) {
    await assert.rejects(pythonFetch(url, options, { spawnImpl() { starts++; } }), rejected('INVALID_ARGUMENT', 'not_sent'));
  }
  assert.equal(starts, 0);
});

test('valid response and timeout boundaries reach the helper without coercion', async () => {
  for (const [maxBytes, timeoutMs] of [[1, 1], [100 * 1024 * 1024, 600000]]) {
    const result = await pythonFetch(url, { maxBytes, timeoutMs }, { spawnImpl: () => mockChild((input, child) => {
      assert.equal(input.maxBytes, maxBytes); assert.equal(input.timeoutMs, timeoutMs);
      child.stdout.write(JSON.stringify(envelope('x'))); child.emit('close', 0);
    }) });
    assert.equal(await result.text(), 'x');
  }
});

test('binary and streaming request descriptors preserve native transport fields on stdin', async () => {
  const body = Buffer.from([0, 255, 13, 10]);
  for (const options of [
    { method: 'PUT', body, signedUpload: true, azureMultipart: { kind: 'block' } },
    { method: 'POST', bodyFile: { path: '/synthetic-private-source', length: 4 }, realtimeSdp: true },
  ]) {
    await pythonFetch(url, options, { spawnImpl(_command, args, config) {
      assert(!JSON.stringify([args, config]).includes('synthetic-private'));
      return mockChild((input, child) => {
        assert.equal(input.method, options.method);
        if (options.body) { assert.equal(input.bodyBase64, body.toString('base64')); assert(!Object.hasOwn(input, 'body')); }
        else { assert.deepEqual(input.bodyFile, options.bodyFile); assert(!Object.hasOwn(input, 'bodyBase64')); }
        assert.equal(input.signedUpload, options.signedUpload === true);
        assert.equal(input.realtimeSdp, options.realtimeSdp === true);
        if (options.azureMultipart) assert.deepEqual(input.azureMultipart, options.azureMultipart);
        child.stdout.write(JSON.stringify(envelope())); child.emit('close', 0);
      });
    } });
  }
});

test('an already-aborted signal never starts Python and preserves its reason', async () => {
  const controller = new AbortController(), reason = new Error('cancelled by caller');
  controller.abort(reason);
  let starts = 0;
  await assert.rejects(pythonFetch(url, { signal: controller.signal }, { spawnImpl() { starts++; } }), error => error === reason);
  assert.equal(starts, 0);
});

test('false, zero, empty, and null abort reasons always reject without replacement', async () => {
  for (const reason of [false, 0, '', null]) {
    for (const beforeStart of [true, false]) {
      const controller = new AbortController(), child = trackedChild();
      if (beforeStart) controller.abort(reason);
      const pending = pythonFetch(url, { signal: controller.signal }, { spawnImpl: () => child });
      const outcome = pending.then(value => ({ resolved: value }), error => ({ rejected: error }));
      if (!beforeStart) controller.abort(reason);
      assert.deepEqual(await outcome, { rejected: reason });
      assert.equal(child.kills, beforeStart ? 0 : 1);
    }
  }
});

test('active cancellation closes pipes, kills the exact child, and removes its listener', async () => {
  const controller = new AbortController(), child = trackedChild(), reason = new Error('cancelled by caller');
  const pending = pythonFetch(url, { signal: controller.signal }, { spawnImpl: () => child });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  child.emit('error', new Error('synthetic-private-late-error'));
  child.emit('close', 0);
});

test('cancellation during subprocess creation cannot write the request', async () => {
  const controller = new AbortController(), child = trackedChild();
  let writes = 0;
  child.stdin.end = () => { writes++; };
  await assert.rejects(pythonFetch(url, { signal: controller.signal }, { spawnImpl() { controller.abort(); return child; } }), { name: 'AbortError' });
  assert.equal(writes, 0); assert.equal(child.kills, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('native abort errors close both pipes and do not expose helper details', async () => {
  const child = trackedChild();
  const reason = new DOMException('The operation was aborted.', 'AbortError');
  const pending = pythonFetch(url, {}, { spawnImpl: () => child });
  child.emit('error', reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
});

test('real subprocess cancellation preserves the caller reason and closes the process', { timeout: 10000 }, async () => {
  const controller = new AbortController(), reason = { cancelled: 'caller' };
  let child;
  const pending = pythonFetch(url, { signal: controller.signal }, { spawnImpl(_command, _args, options) {
    // Inert local process exercises Node's actual AbortSignal event ordering.
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    return child;
  } });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await once(child, 'spawn');
    const rejected = assert.rejects(pending, error => error === reason);
    controller.abort(reason);
    await rejected;
    await closed;
    assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { child.kill('SIGKILL'); }
});

test('synchronous stdin failures stop the child with uncertain delivery', async () => {
  const child = trackedChild();
  child.stdin.end = () => { throw new Error('synthetic-private-pipe'); };
  await assert.rejects(pythonFetch(url, {}, { spawnImpl: () => child }), rejected('NETWORK_ERROR'));
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
});

for (const pipe of ['stdin', 'stdout']) {
  test(`${pipe} stream failures are sanitized and release the child`, async () => {
    const child = trackedChild();
    const pending = pythonFetch(url, {}, { spawnImpl: () => child });
    child[pipe].emit('error', new Error('synthetic-private-pipe'));
    await assert.rejects(pending, rejected('NETWORK_ERROR'));
    assert.equal(child.kills, 1);
    assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
  });
}

test('a child error after input submission closes resources with unknown delivery', async () => {
  const child = trackedChild(); let submitted = false;
  child.stdin.on('finish', () => { submitted = true; child.emit('error', new Error('synthetic-private-late-process')); });
  const pending = pythonFetch(url, { body: 'already submitted' }, { spawnImpl: () => child });
  await assert.rejects(pending, rejected('NETWORK_ERROR'));
  assert.equal(submitted, true); assert.equal(child.kills, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
});

test('ENOENT after a confirmed spawn cannot claim that no request was sent', async () => {
  const child = trackedChild();
  const pending = pythonFetch(url, { body: 'already submitted' }, { spawnImpl: () => child });
  child.emit('spawn');
  child.emit('error', Object.assign(new Error('synthetic-private-child-error'), { code: 'ENOENT' }));
  await assert.rejects(pending, rejected('NETWORK_ERROR'));
  assert.equal(child.kills, 1);
});

test('process failure and malformed output never produce a response', async () => {
  for (const [output, exitCode] of [['', 1], ['', null], ['{synthetic-private', 0]]) {
    const child = trackedChild();
    const pending = pythonFetch(url, {}, { spawnImpl: () => child });
    child.stdout.write(output); child.emit('close', exitCode);
    await assert.rejects(pending, rejected('NETWORK_ERROR'));
  }
});

test('envelope overflow remains RESPONSE_TOO_LARGE when killing synchronously emits close', async () => {
  const child = trackedChild();
  const pending = pythonFetch(url, { maxBytes: 1 }, { spawnImpl: () => child });
  child.stdout.write(Buffer.alloc(65539));
  await assert.rejects(pending, rejected('RESPONSE_TOO_LARGE'));
  assert.equal(child.kills, 1);
  assert.equal(child.stdin.destroyed, true); assert.equal(child.stdout.destroyed, true);
});

test('decoded response bytes cannot use the envelope allowance to exceed the requested limit', async () => {
  await assert.rejects(respond(envelope(Buffer.from([0, 1])), { maxBytes: 1 }), rejected('RESPONSE_TOO_LARGE'));
});

test('primitive, missing-field, and contradictory helper envelopes are rejected', async () => {
  for (const value of [null, [], false, 'synthetic-private', 1, {}, { status: 200, body: '' },
    { ...envelope(), error: 'NETWORK_ERROR' }, { error: null }, { error: '' }]) {
    await assert.rejects(respond(value), rejected('NETWORK_ERROR'));
  }
});

test('invalid HTTP statuses are rejected before constructing a response', async () => {
  for (const status of [null, '200', 101, 199, 600, 200.5]) await assert.rejects(respond({ ...envelope(), status }), rejected('NETWORK_ERROR'));
});

test('noncanonical base64 cannot be silently decoded into different response bytes', async () => {
  for (const body of [null, [], 'Zg', 'Zg=', 'Zg===', 'Zg==\n', 'Zg==$private', 'Zh==', 'Zm9=', '____']) {
    await assert.rejects(respond({ ...envelope(), body }), rejected('NETWORK_ERROR'));
  }
});

test('a valid 32 MiB download is decoded without recursive regex stack limits', async () => {
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0xa5);
  const result = await respond(envelope(bytes), { maxBytes: bytes.length });
  const received = Buffer.from(await result.arrayBuffer());
  assert.equal(received.length, bytes.length);
  assert.equal(received.equals(bytes), true);
});

test('invalid or ambiguous header envelopes are rejected', async () => {
  for (const headers of [null, [], 'synthetic-private', { 'content-length': 3 }, { 'x-test': null },
    { 'x-test': ['a'] }, { 'x-test': 'a\r\nsynthetic-private: b' }, { 'invalid name': 'x' },
    { 'X-Test': 'a', 'x-test': 'b' }]) await assert.rejects(respond({ ...envelope(), headers }), rejected('NETWORK_ERROR'));
});

test('binary bytes and classification headers are preserved without text roundtrips', async () => {
  const bytes = Buffer.from([0, 128, 255, 10, 195, 169]);
  const result = await respond({ status: 429, headers: { 'Content-Type': 'application/octet-stream', 'retry-after': '7', 'x-request-id': 'fixture-id' }, body: bytes.toString('base64') });
  assert.equal(result.status, 429); assert.equal(result.ok, false);
  assert.equal(result.headers.get('content-type'), 'application/octet-stream');
  assert.equal(result.headers.get('Retry-After'), '7'); assert.equal(result.headers.get('x-request-id'), 'fixture-id');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
});

test('bodyless HTTP status mapping remains valid while redirects remain observable', async () => {
  for (const status of [204, 205, 304]) {
    const result = await respond({ ...envelope('discarded'), status });
    assert.equal(result.status, status); assert.equal(result.body, null); assert.equal(await result.text(), '');
  }
  const redirect = await respond({ ...envelope(), status: 302, headers: { location: 'https://example.invalid/fixture' } });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), 'https://example.invalid/fixture');
});

test('helper error mappings preserve only verified source-delivery certainty', async () => {
  for (const code of ['FILE_CHANGED', 'INVALID_FILE']) {
    for (const delivery of ['not_sent', 'unknown']) await assert.rejects(respond({ error: code, delivery }), rejected(code, delivery));
    await assert.rejects(respond({ error: code, delivery: 'invented' }), rejected(code));
  }
  for (const code of ['NETWORK_ERROR', 'RESPONSE_TOO_LARGE', 'synthetic-private-error']) {
    await assert.rejects(respond({ error: code, delivery: 'not_sent' }), rejected(code === 'RESPONSE_TOO_LARGE' ? code : 'NETWORK_ERROR'));
  }
});

test('a successful response removes abort listeners and ignores late subprocess events', async () => {
  const controller = new AbortController(); let child;
  const result = await pythonFetch(url, { signal: controller.signal }, { spawnImpl: () => {
    child = mockChild((_input, value) => { value.stdout.write(JSON.stringify(envelope('ok'))); value.emit('close', 0); });
    child.kills = 0; child.kill = () => { child.kills++; };
    return child;
  } });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(); child.emit('error', new Error('synthetic-private-late')); child.emit('close', 1);
  child.stdin.emit('error', new Error('synthetic-private-late-input'));
  child.stdout.emit('error', new Error('synthetic-private-late-output'));
  assert.equal(child.kills, 0); assert.equal(await result.text(), 'ok');
});
