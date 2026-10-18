import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Transport } from '../src/transport.mjs';
import { DotLive } from '../src/live.mjs';
import { pythonFetch } from '../src/http.mjs';

const helper = fileURLToPath(new URL('../src/http.py', import.meta.url));
const authLoader = async () => ({ accountId: 'account', accessToken: 'synthetic-token' });
const route = '/backend-api/celsius/ws/user';
const cases = [
  { status: 401, contentType: 'application/json', code: 'AUTH_REJECTED' },
  { status: 403, contentType: 'application/json', code: 'FORBIDDEN' },
  { status: 403, contentType: 'text/html', code: 'FORBIDDEN_HTML' }
];
const label = value => `${value.status} ${value.contentType}`;
const classified = value => error => error.code === value.code && error.details.status === value.status;
function brokenResponse(value) {
  return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('synthetic-private-body')); } }, { highWaterMark: 0 }), {
    status: value.status, headers: { 'content-type': value.contentType }
  });
}

// This substitutes only urllib's opener and cannot contact the network. The
// real helper, pythonFetch envelope validation and Transport all still run.
const harness = String.raw`
import contextlib, http.client, io, json, runpy, sys, urllib.error, urllib.request
from email.message import Message
config = json.loads(sys.argv[2])
counts = {'opens': 0, 'reads': 0, 'closes': 0}
class Response:
    def __init__(self):
        self.code = config['status']
        self.closed = False
        self.headers = Message()
        self.headers['Content-Type'] = config['contentType']
        self.headers['Set-Cookie'] = 'synthetic-private-cookie'
        self.headers['X-Unrelated'] = 'synthetic-private-header'
    def __enter__(self): return self
    def __exit__(self, *args): self.close()
    def close(self):
        if not self.closed:
            self.closed = True
            counts['closes'] += 1
    def read(self, maximum):
        counts['reads'] += 1
        if 'partial' in config:
            raise http.client.IncompleteRead(config['partial'].encode('utf8'), 1)
        raise OSError('synthetic-private-body')
class Opener:
    def open(self, request, timeout):
        counts['opens'] += 1
        response = Response()
        raise urllib.error.HTTPError(request.full_url, response.code, 'synthetic', response.headers, response)
urllib.request.build_opener = lambda *args: Opener()
output = io.StringIO()
with contextlib.redirect_stdout(output): runpy.run_path(sys.argv[1], run_name='__main__')
sys.stdout.write(output.getvalue())
sys.stderr.write(json.dumps(counts))
`;
function invokePython(value) {
  const result = spawnSync('python3', ['-I', '-c', harness, helper, JSON.stringify(value)], {
    input: JSON.stringify({ url: `https://chatgpt.com${route}`, method: 'GET', headers: {}, ...(value.maxBytes ? { maxBytes: value.maxBytes } : {}) }), encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout.includes('synthetic-private'), false);
  return { envelope: JSON.parse(result.stdout), counts: JSON.parse(result.stderr) };
}
function realPython(value) {
  const audits = [], pending = [];
  const transport = new Transport({ authLoader, fetchImpl: (url, options) => pythonFetch(url, options, {
    spawnImpl: (_command, _args, childOptions) => {
      const child = spawn('python3', ['-I', '-c', harness, helper, JSON.stringify(value)], { ...childOptions, stdio: ['pipe', 'pipe', 'pipe'] });
      let counters = ''; child.stderr.on('data', value => { counters += value; });
      pending.push(new Promise(resolve => child.once('close', () => { audits.push(JSON.parse(counters)); resolve(); })));
      return child;
    }
  }) });
  return { transport, audits, done: () => Promise.all(pending) };
}

for (const value of cases) {
  test(`Transport preserves ${label(value)} when its body fails`, async () => {
    let calls = 0;
    const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return brokenResponse(value); } });
    await assert.rejects(transport.request('GET', route), classified(value));
    assert.equal(calls, 1);
  });

  test(`Python helper preserves and closes ${label(value)} when its body fails`, () => {
    const { envelope, counts } = invokePython(value);
    assert.deepEqual(envelope, { status: value.status, headers: { 'content-type': value.contentType }, body: '' });
    assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1 });
  });

  test(`live bootstrap stops after ${label(value)} with a broken body`, async () => {
    let calls = 0, sleeps = 0, sockets = 0;
    const transport = new Transport({ authLoader, fetchImpl: async () => { calls++; return brokenResponse(value); } });
    const live = new DotLive({ transport, resolveRoom: async () => 'room' }, {
      sleep: async () => { sleeps++; throw new Error('unexpected retry'); }, webSocketFactory: () => { sockets++; throw new Error('unexpected socket'); }
    });
    await assert.rejects(live.watch({ roomId: 'room' }), classified(value));
    assert.equal(calls, 1); assert.equal(sleeps, 0); assert.equal(sockets, 0);
  });

  test(`default Python to live bootstrap stops after ${label(value)} with a broken body`, async () => {
    const fixture = realPython(value); let sleeps = 0, sockets = 0;
    const live = new DotLive({ transport: fixture.transport, resolveRoom: async () => 'room' }, {
      sleep: async () => { sleeps++; throw new Error('unexpected retry'); }, webSocketFactory: () => { sockets++; throw new Error('unexpected socket'); }
    });
    await assert.rejects(live.watch({ roomId: 'room' }), classified(value));
    await fixture.done();
    assert.deepEqual(fixture.audits, [{ opens: 1, reads: 1, closes: 1 }]); assert.equal(sleeps, 0); assert.equal(sockets, 0);
  });

  test(`complete ${label(value)} body retains its normal classification and diagnostics`, async () => {
    const transport = new Transport({ authLoader, fetchImpl: async () => new Response('{"code":"cloud_aeon_recovery_required"}', {
      status: value.status, headers: { 'content-type': value.contentType }
    }) });
    await assert.rejects(transport.request('GET', route), error => {
      assert.ok(classified(value)(error));
      assert.equal(error.details.apiCode, value.contentType === 'application/json' ? 'cloud_aeon_recovery_required' : undefined);
      return true;
    });
  });

  test(`body-only challenge detection still wins over ${label(value)}`, async () => {
    const transport = new Transport({ authLoader, fetchImpl: async () => new Response('Enable JavaScript and cookies to continue', {
      status: value.status, headers: { 'content-type': value.contentType }
    }) });
    await assert.rejects(transport.request('GET', route), { code: 'EDGE_CHALLENGE' });
  });

  test(`${label(value)} broken write response retains unknown delivery without exposing body text`, async () => {
    const transport = new Transport({ authLoader, fetchImpl: async () => brokenResponse(value) });
    await assert.rejects(transport.request('POST', '/backend-api/offline-fixture', { body: {} }), error => {
      assert.ok(classified(value)(error)); assert.equal(error.details.delivery, 'unknown');
      assert.equal(JSON.stringify(error).includes('synthetic-private'), false); return true;
    });
  });
}

test('ordinary 503 broken response still reports a retryable network failure', async () => {
  const transport = new Transport({ authLoader, fetchImpl: async () => brokenResponse({ status: 503, contentType: 'application/json' }) });
  await assert.rejects(transport.request('GET', route), { code: 'NETWORK_ERROR' });
});

test('Python helper retains an ordinary 503 broken response as a network failure', () => {
  const { envelope, counts } = invokePython({ status: 503, contentType: 'application/json' });
  assert.deepEqual(envelope, { error: 'NETWORK_ERROR' }); assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1 });
});

test('explicit cancellation wins over a known 401 with a broken response body', async () => {
  const controller = new AbortController(), reason = new Error('explicit cancellation');
  const transport = new Transport({ authLoader, fetchImpl: async () => { controller.abort(reason); return brokenResponse(cases[0]); } });
  await assert.rejects(transport.request('GET', route, { signal: controller.signal }), error => error === reason);
});

test('default Python broken 401 write response retains unknown delivery', async () => {
  const fixture = realPython(cases[0]);
  await assert.rejects(fixture.transport.request('POST', '/backend-api/offline-fixture', { body: {} }), error => {
    assert.ok(classified(cases[0])(error)); assert.equal(error.details.delivery, 'unknown'); return true;
  });
  await fixture.done(); assert.deepEqual(fixture.audits, [{ opens: 1, reads: 1, closes: 1 }]);
});

function partialResponse(value, prefix, afterPrefix) {
  let read = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!read) { read = true; controller.enqueue(Buffer.from(prefix)); }
    else { afterPrefix?.(); controller.error(new Error('synthetic-private-tail')); }
  } }, { highWaterMark: 0 }), { status: value.status, headers: { 'content-type': value.contentType } });
}

for (const value of cases) {
  test(`bounded partial challenge still overrides ${label(value)} in Transport`, async () => {
    const transport = new Transport({ authLoader, fetchImpl: async () => partialResponse(value, '<script src="/cdn-cgi/challenge-platform/x"></script>') });
    await assert.rejects(transport.request('GET', route), error => {
      assert.equal(error.code, 'EDGE_CHALLENGE'); assert.equal(error.details.status, value.status);
      assert.equal(JSON.stringify(error).includes('synthetic-private'), false); return true;
    });
  });

  test(`Python IncompleteRead challenge prefix overrides ${label(value)} without retry`, async () => {
    const fixture = realPython({ ...value, partial: '<script src="/cdn-cgi/challenge-platform/x"></script>' }); let sleeps = 0;
    await assert.rejects(new DotLive({ transport: fixture.transport, resolveRoom: async () => 'room' }, {
      sleep: async () => { sleeps++; throw new Error('unexpected retry'); }
    }).watch({ roomId: 'room' }), error => error.code === 'EDGE_CHALLENGE' && error.details.status === value.status);
    await fixture.done(); assert.equal(sleeps, 0); assert.deepEqual(fixture.audits, [{ opens: 1, reads: 1, closes: 1 }]);
  });
}

test('an HTTP 200 body that fails after a prefix cannot become a successful Transport response', async () => {
  const transport = new Transport({ authLoader, fetchImpl: async () => partialResponse({ status: 200, contentType: 'application/json' }, '{"ok":true}') });
  await assert.rejects(transport.request('GET', route), { code: 'NETWORK_ERROR' });
});

test('Python IncompleteRead on HTTP 200 cannot become a successful envelope', () => {
  const { envelope, counts } = invokePython({ status: 200, contentType: 'application/json', partial: '{"ok":true}' });
  assert.deepEqual(envelope, { error: 'NETWORK_ERROR' }); assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1 });
});

test('default Python IncompleteRead on HTTP 200 cannot become a successful Transport response', async () => {
  const fixture = realPython({ status: 200, contentType: 'application/json', partial: '{"ok":true}' });
  await assert.rejects(fixture.transport.request('GET', route), { code: 'NETWORK_ERROR' });
  await fixture.done(); assert.deepEqual(fixture.audits, [{ opens: 1, reads: 1, closes: 1 }]);
});

test('Python retained refusal prefix is bounded before classification', () => {
  const prefix = 'x'.repeat(32), marker = '/cdn-cgi/challenge-platform/';
  const { envelope, counts } = invokePython({ ...cases[1], maxBytes: 32, partial: prefix + marker });
  assert.equal(Buffer.from(envelope.body, 'base64').toString(), prefix);
  assert.equal(Buffer.byteLength(Buffer.from(envelope.body, 'base64')), 32);
  assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1 });
});

test('cancellation after a partial challenge prefix keeps the explicit caller reason', async () => {
  const controller = new AbortController(), reason = new Error('explicit cancellation');
  const transport = new Transport({ authLoader, fetchImpl: async () => partialResponse(cases[1], '/cdn-cgi/challenge-platform/', () => controller.abort(reason)) });
  await assert.rejects(transport.request('GET', route, { signal: controller.signal }), error => error === reason);
});
