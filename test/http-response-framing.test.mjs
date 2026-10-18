import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { pythonFetch } from '../src/http.mjs';
import { Transport, classifyResponse } from '../src/transport.mjs';
import { DotLibrary } from '../src/library.mjs';
import { LibraryContent } from '../src/library-content.mjs';

const helper = fileURLToPath(new URL('../src/http.py', import.meta.url));
const json = Buffer.from('{"ok":true}');
// Feed real HTTP wire bytes to http.client.HTTPResponse. Only urllib's opener
// is replaced; the parser, helper, envelope validation and cleanup are real.
const harness = String.raw`
import base64, contextlib, http.client, io, json, runpy, sys, urllib.error, urllib.request
config = json.loads(sys.argv[2])
counts = {'opens': 0, 'reads': 0, 'closes': 0, 'remaining': None}
wire = ('HTTP/1.1 ' + str(config['status']) + ' Fixture\r\n').encode('ascii')
for key, value in config.get('headers', {}).items():
    wire += (key + ': ' + str(value) + '\r\n').encode('ascii')
wire += b'\r\n' + base64.b64decode(config['body'])
class Socket:
    def makefile(self, *args, **kwargs): return io.BytesIO(wire)
class Response(http.client.HTTPResponse):
    def read(self, maximum=None):
        counts['reads'] += 1
        try: return super().read(maximum)
        finally: counts['remaining'] = self.length
    def close(self):
        if not self.closed: counts['closes'] += 1
        super().close()
class Opener:
    def open(self, request, timeout):
        counts['opens'] += 1
        response = Response(Socket()); response.begin()
        if config.get('httpError'):
            raise urllib.error.HTTPError(request.full_url, response.status, 'fixture', response.headers, response)
        return response
urllib.request.build_opener = lambda *args: Opener()
output = io.StringIO()
with contextlib.redirect_stdout(output): runpy.run_path(sys.argv[1], run_name='__main__')
sys.stdout.write(output.getvalue())
sys.stderr.write(json.dumps(counts))
`;
function fixture({ status = 200, body = json, headers = { 'Content-Length': body.length }, httpError = status >= 400, maxBytes = 1024 } = {}) {
  return { status, body: body.toString('base64'), headers, httpError, maxBytes };
}
function invoke(value) {
  const result = spawnSync('python3', ['-I', '-c', harness, helper, JSON.stringify(value)], {
    input: JSON.stringify({ url: 'https://chatgpt.com/backend-api/offline-framing', method: 'GET', headers: {}, maxBytes: value.maxBytes }),
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return { envelope: JSON.parse(result.stdout), counts: JSON.parse(result.stderr) };
}
function released(counts) { assert.equal(counts.opens, 1); assert.equal(counts.reads, 1); assert.equal(counts.closes, 1); }
function successful(value, expected = json) {
  const result = invoke(value); released(result.counts);
  assert.equal(result.envelope.status, value.status);
  assert.deepEqual(Buffer.from(result.envelope.body, 'base64'), expected);
  return result;
}

for (const status of [200, 201, 206]) {
  test(`real parser rejects silent short fixed-length HTTP ${status}`, () => {
    const value = fixture({ status, headers: { 'Content-Length': 30 } });
    const { envelope, counts } = invoke(value); released(counts);
    assert.deepEqual(envelope, { error: 'NETWORK_ERROR' }); assert.equal(counts.remaining, 30 - json.length);
  });
}

test('exact fixed-length HTTP 200 remains successful', () => {
  const result = successful(fixture()); assert.equal(result.counts.remaining, 0);
});

test('an exact body at the configured maximum remains successful', () => {
  successful(fixture({ maxBytes: json.length }));
});

test('response size limit takes precedence over residual fixed-length bytes', () => {
  const { envelope, counts } = invoke(fixture({ maxBytes: 5, headers: { 'Content-Length': 30 } }));
  released(counts); assert.deepEqual(envelope, { error: 'RESPONSE_TOO_LARGE' });
});

test('close-delimited HTTP 200 is complete at EOF without Content-Length', () => {
  const result = successful(fixture({ headers: {} })); assert.equal(result.counts.remaining, null);
});

const chunked = Buffer.concat([Buffer.from(json.length.toString(16) + '\r\n'), json, Buffer.from('\r\n0\r\n\r\n')]);
for (const length of [undefined, '9999']) {
  test(`real chunked parser ${length === undefined ? 'accepts absent' : 'rejects conflicting'} Content-Length`, () => {
    const headers = { 'Transfer-Encoding': 'chunked', ...(length === undefined ? {} : { 'Content-Length': length }) };
    if (length === undefined) {
      const result = successful(fixture({ body: chunked, headers })); assert.equal(result.counts.remaining, null);
    } else {
      const result = invoke(fixture({ body: chunked, headers }));
      assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
      assert.equal(result.counts.opens, 1); assert.equal(result.counts.closes, 1);
      assert.equal(result.counts.reads, 0);
    }
  });
}

for (const status of [204, 304]) {
  test(`bodyless HTTP ${status} ignores a representation Content-Length`, () => {
    const result = successful(fixture({ status, body: Buffer.alloc(0), headers: { 'Content-Length': 9999 }, httpError: status === 304 }), Buffer.alloc(0));
    assert.equal(result.counts.remaining, 0);
  });
}

test('compressed response framing measures wire bytes without decompressing', () => {
  const compressed = gzipSync(json);
  const result = successful(fixture({ body: compressed, headers: { 'Content-Length': compressed.length, 'Content-Encoding': 'gzip' } }), compressed);
  assert.equal(result.counts.remaining, 0);
});

test('HTTP 206 framing uses response Content-Length rather than total Content-Range size', () => {
  successful(fixture({ status: 206, headers: { 'Content-Length': json.length, 'Content-Range': `bytes 0-${json.length - 1}/9999` } }));
});

for (const status of [401, 403, 503]) {
  test(`silent-short HTTP ${status} retains its received refusal status and bounded prefix`, () => {
    const result = successful(fixture({ status, headers: { 'Content-Length': 30 } }));
    assert.equal(result.counts.remaining, 30 - json.length);
  });
}

function realTransport(value) {
  const audits = [], pending = [], calls = [];
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account', accessToken: 'synthetic-token' }),
    fetchImpl: (url, options) => pythonFetch(url, options, { spawnImpl: (_command, _args, childOptions) => {
      calls.push({ method: options.method, path: new URL(url).pathname });
      const selected = typeof value === 'function' ? value(calls.at(-1)) : value;
      const child = spawn('python3', ['-I', '-c', harness, helper, JSON.stringify(selected)], { ...childOptions, stdio: ['pipe', 'pipe', 'pipe'] });
      let counters = ''; child.stderr.on('data', value => { counters += value; });
      pending.push(new Promise(resolve => child.once('close', () => { audits.push(JSON.parse(counters)); resolve(); })));
      return child;
    } }) });
  return { transport, audits, calls, done: () => Promise.all(pending) };
}

test('default helper and Transport reject valid JSON carried by a silent-short HTTP 200', async () => {
  const value = realTransport(fixture({ headers: { 'Content-Length': 30 } }));
  await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'NETWORK_ERROR' });
  await value.done(); assert.equal(value.audits.length, 1); released(value.audits[0]);
});

for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'FORBIDDEN'], [503, 'HTTP_ERROR']]) {
  test(`default Transport retains HTTP ${status} classification for silent-short response`, async () => {
    const value = realTransport(fixture({ status, headers: { 'Content-Length': 30, 'Content-Type': 'application/json' } }));
    await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), error => error.code === code && error.details.status === status);
    await value.done(); assert.equal(value.audits.length, 1); released(value.audits[0]);
  });
}

test('silent-short auth response keeps its received body challenge marker', async () => {
  const body = Buffer.from('<script src="/cdn-cgi/challenge-platform/x"></script>');
  const value = realTransport(fixture({ status: 403, body, headers: { 'Content-Length': body.length + 20, 'Content-Type': 'text/html' } }));
  await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'EDGE_CHALLENGE' });
  await value.done(); assert.equal(value.audits.length, 1); released(value.audits[0]);
});

test('silent-short successful write retains unknown delivery rather than returning partial JSON', async () => {
  const value = realTransport(fixture({ headers: { 'Content-Length': 30 } }));
  await assert.rejects(value.transport.request('POST', '/backend-api/offline-framing', { body: {} }), error => error.code === 'NETWORK_ERROR' && error.details.delivery === 'unknown');
  await value.done(); assert.equal(value.audits.length, 1); released(value.audits[0]);
});

for (const status of [404, 410]) {
  test(`real parser rejects a silent-short HTTP ${status} absence response`, () => {
    const { envelope, counts } = invoke(fixture({ status, headers: { 'Content-Length': 30 } }));
    released(counts); assert.equal(counts.remaining, 30 - json.length);
    assert.deepEqual(envelope, { error: 'NETWORK_ERROR' });
  });

  test(`default Transport keeps truncated HTTP ${status} indeterminate`, async () => {
    const value = realTransport(fixture({ status, headers: { 'Content-Length': 30 } }));
    await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'NETWORK_ERROR' });
    await value.done(); assert.equal(value.calls.length, 1); released(value.audits[0]);
  });

  test(`a complete HTTP ${status} body retains the ordinary absence classification`, async () => {
    const value = realTransport(fixture({ status }));
    await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), error => error.code === 'HTTP_ERROR' && error.details.status === status);
    await value.done(); assert.equal(value.calls.length, 1); released(value.audits[0]);
  });

  test(`HTTP ${status} size bounds still win over incomplete framing`, () => {
    const { envelope, counts } = invoke(fixture({ status, maxBytes: 5, headers: { 'Content-Length': 30 } }));
    released(counts); assert.deepEqual(envelope, { error: 'RESPONSE_TOO_LARGE' });
  });

  test(`complete chunked HTTP ${status} remains an ordinary absence response`, async () => {
    const value = realTransport(fixture({ status, body: chunked, headers: { 'Transfer-Encoding': 'chunked' } }));
    await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), error => error.code === 'HTTP_ERROR' && error.details.status === status);
    await value.done(); released(value.audits[0]); assert.equal(value.audits[0].remaining, null);
  });
}

test('a known edge header still wins over truncated HTTP 404 framing', async () => {
  const value = realTransport(fixture({ status: 404, headers: { 'Content-Length': 30, 'CF-Mitigated': 'challenge' } }));
  await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'EDGE_CHALLENGE' });
  await value.done(); assert.deepEqual(value.audits, [{ opens: 1, reads: 0, closes: 1, remaining: null }]);
});

const libraryFile = Buffer.from(JSON.stringify({ id: 'file:framing', kind: 'file', file_id: 'file-raw', file_name: 'framing.txt' }));
const libraryPath = '/backend-api/files/library/files/file%3Aframing';
function libraryResponses({ complete = false } = {}) {
  return call => {
    if (call.method === 'DELETE') return fixture({ body: Buffer.from('{"success":true}') });
    if (call.path.endsWith('/node')) return fixture({ body: libraryFile });
    assert.equal(call.path, libraryPath);
    return fixture({ status: 404, headers: { 'Content-Length': complete ? json.length : 30 } });
  };
}

test('Library details stop before node fallback after truncated HTTP 404', async () => {
  const value = realTransport(libraryResponses());
  await assert.rejects(new DotLibrary({ transport: value.transport }).get({ fileId: 'file:framing' }), { code: 'NETWORK_ERROR' });
  await value.done(); assert.deepEqual(value.calls, [{ method: 'GET', path: libraryPath }]);
});

test('Library permanent deletion cannot follow a truncated HTTP 404 into fallback metadata', async () => {
  const value = realTransport(libraryResponses());
  await assert.rejects(new LibraryContent({ transport: value.transport }).permanentDelete({ fileId: 'file:framing', confirm: 'file:framing' }), { code: 'NETWORK_ERROR' });
  await value.done(); assert.deepEqual(value.calls, [{ method: 'GET', path: libraryPath }]);
});

test('complete HTTP 404 still permits verified Library fallback and synthetic deletion', async () => {
  const value = realTransport(libraryResponses({ complete: true }));
  const result = await new LibraryContent({ transport: value.transport }).permanentDelete({ fileId: 'file:framing', confirm: 'file:framing' });
  await value.done(); assert.deepEqual(result, { fileId: 'file:framing', status: 'completed' });
  assert.deepEqual(value.calls, [{ method: 'GET', path: libraryPath }, { method: 'GET', path: `${libraryPath}/node` }, { method: 'DELETE', path: libraryPath }]);
});

test('truncated HTTP 404 from a write retains unknown delivery', async () => {
  const value = realTransport(fixture({ status: 404, headers: { 'Content-Length': 30 } }));
  await assert.rejects(value.transport.request('DELETE', '/backend-api/offline-framing'), error => error.code === 'NETWORK_ERROR' && error.details.delivery === 'unknown');
  await value.done(); assert.equal(value.calls.length, 1); released(value.audits[0]);
});

const challengeMarkers = ['/cdn-cgi/challenge-platform/', '_cf_chl_opt', 'enable javascript and cookies to continue', 'ENABLE JavaScript AND COOKIES TO CONTINUE'];
for (const status of [404, 410]) {
  for (const marker of challengeMarkers) {
    test(`truncated HTTP ${status} preserves the existing challenge marker ${marker}`, async () => {
      assert.equal(classifyResponse(status, new Headers(), marker).code, 'EDGE_CHALLENGE');
      const body = Buffer.from(`prefix ${marker} suffix`);
      const value = realTransport(fixture({ status, body, headers: { 'Content-Length': body.length + 20 } }));
      await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'EDGE_CHALLENGE' });
      await value.done(); assert.equal(value.calls.length, 1); released(value.audits[0]);
    });
  }

  test(`truncated HTTP ${status} does not invent an edge challenge from near-match text`, async () => {
    for (const marker of ['/cdn-cgi/not-a-challenge/', '_cf_chl_other', 'enable javascript']) {
      assert.equal(classifyResponse(status, new Headers(), marker).code, 'HTTP_ERROR');
      const body = Buffer.from(marker), value = realTransport(fixture({ status, body, headers: { 'Content-Length': body.length + 20 } }));
      await assert.rejects(value.transport.request('GET', '/backend-api/offline-framing'), { code: 'NETWORK_ERROR' });
      await value.done(); assert.equal(value.calls.length, 1); released(value.audits[0]);
    }
  });
}

test('a confirmed truncated body challenge blocks Library fallback and deletion', async () => {
  const body = Buffer.from('<script src="/cdn-cgi/challenge-platform/x"></script>');
  const value = realTransport(call => call.path.endsWith('/node') ? fixture({ body: libraryFile })
    : fixture({ status: 404, body, headers: { 'Content-Length': body.length + 20 } }));
  await assert.rejects(new LibraryContent({ transport: value.transport }).permanentDelete({ fileId: 'file:framing', confirm: 'file:framing' }), { code: 'EDGE_CHALLENGE' });
  await value.done(); assert.deepEqual(value.calls, [{ method: 'GET', path: libraryPath }]);
});
