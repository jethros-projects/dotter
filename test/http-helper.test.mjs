import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Execute the real helper with only its network opener replaced. Each run owns
// a local regular file and records its descriptor lifetime independently of
// the helper; process exit must not mask a missing close(). No URL is opened.
const harness = String.raw`
import base64, contextlib, hashlib, io, json, os, runpy, sys, tempfile, urllib.error, urllib.request
from email.message import Message
config = json.loads(sys.stdin.read())
real_open, real_close, real_request = os.open, os.close, urllib.request.Request
calls, active = [], set()
counts = {'opened': 0, 'closed': 0, 'responseClosed': 0, 'requestConstructed': 0}
response_read_limits = []
with tempfile.TemporaryDirectory(prefix='dot-http-helper-') as directory:
    source_path = os.path.join(os.path.realpath(directory), 'source.bin')
    source_bytes = b'offline-upload-fixture'
    with open(source_path, 'wb') as source: source.write(source_bytes)
    info = os.stat(source_path)
    source = {'path': source_path, 'sizeBytes': len(source_bytes), 'offset': 0, 'length': len(source_bytes),
              'sha256': hashlib.sha256(source_bytes).hexdigest(), 'dev': str(info.st_dev), 'ino': str(info.st_ino),
              'mtimeMs': info.st_mtime_ns / 1e6, 'ctimeMs': info.st_ctime_ns / 1e6}
    source.update(config.get('sourcePatch', {}))
    def track_open(path, *args, **kwargs):
        fd = real_open(path, *args, **kwargs)
        if path == source_path:
            active.add(fd); counts['opened'] += 1
        return fd
    def track_close(fd):
        if fd in active:
            active.remove(fd); counts['closed'] += 1
        return real_close(fd)
    os.open, os.close = track_open, track_close
    def request_constructor(*args, **kwargs):
        counts['requestConstructed'] += 1
        if config.get('mode') == 'request-error': raise ValueError('synthetic-private-request-detail')
        return real_request(*args, **kwargs)
    urllib.request.Request = request_constructor
    class Response(io.BytesIO):
        def __init__(self):
            super().__init__(base64.b64decode(config.get('responseBody', 'e30=')))
            self.code = config.get('status', 200)
            self.headers = Message()
            self.headers['Content-Type'] = 'application/json'
        def read(self, maximum=-1):
            response_read_limits.append(maximum)
            if config.get('mode') == 'response-error': raise OSError('synthetic-private-response-detail')
            return super().read(maximum)
        def close(self):
            if not self.closed: counts['responseClosed'] += 1
            super().close()
    class Opener:
        def open(self, request, timeout):
            call = {'method': request.get_method(), 'timeout': timeout,
                    'contentLength': request.get_header('Content-length'),
                    'transferEncoding': request.get_header('Transfer-encoding')}
            calls.append(call)
            mode = config.get('mode')
            if mode == 'network-error': raise urllib.error.URLError('synthetic-private-network-detail')
            data = request.data
            if hasattr(data, 'read'):
                if mode in ('mutate-stream', 'wrapped-mutate-stream'):
                    data.read(1)
                    with open(source_path, 'r+b') as source:
                        source.seek(1); source.write(b'Z'); source.flush(); os.fsync(source.fileno())
                    try: data.read(1)
                    except Exception as error:
                        if mode == 'wrapped-mutate-stream': raise urllib.error.URLError(error)
                        raise
                    raise AssertionError('Changed source was accepted')
                chunks = []
                if mode != 'premature-response':
                    while True:
                        chunk = data.read(7)
                        if not chunk: break
                        chunks.append(chunk)
                body = b''.join(chunks)
            else:
                body = data or b''
            call['bodyBytes'] = len(body)
            call['bodySha256'] = hashlib.sha256(body).hexdigest()
            call['body'] = base64.b64encode(body).decode('ascii')
            response = Response()
            if mode == 'http-error':
                raise urllib.error.HTTPError(request.full_url, 409, 'synthetic-private-http-detail', response.headers, response)
            return response
    urllib.request.build_opener = lambda *args: Opener()
    request = {'url': 'https://chatgpt.com/backend-api/offline-fixture', 'method': 'POST', 'headers': {}}
    if config.get('file'):
        request = {'url': 'https://files.oaiusercontent.com/offline-fixture?sig=synthetic',
                   'method': 'PUT', 'headers': {'Content-Type': 'application/octet-stream'},
                   'signedUpload': True, 'bodyFile': source}
    request.update(config.get('request', {}))
    sys.stdin = io.StringIO(json.dumps(request))
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output): runpy.run_path(sys.argv[1], run_name='__main__')
        result = {'envelope': json.loads(output.getvalue()), 'calls': calls, 'counts': counts,
                  'activeDescriptors': len(active), 'responseReadLimits': response_read_limits}
    finally:
        for fd in list(active): real_close(fd)
        os.open, os.close, urllib.request.Request = real_open, real_close, real_request
print(json.dumps(result))
`;

function invoke(options = {}) {
  const result = spawnSync('python3', ['-I', '-c', harness, fileURLToPath(new URL('../src/http.py', import.meta.url))], {
    input: JSON.stringify(options), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('synthetic-private-'), false);
  return JSON.parse(result.stdout);
}

function released(result, opened = 1, responseClosed = 0) {
  assert.equal(result.counts.opened, opened);
  assert.equal(result.counts.closed, opened);
  assert.equal(result.activeDescriptors, 0);
  assert.equal(result.counts.responseClosed, responseClosed);
}

test('real Python helper streams exact bytes with length framing and closes both resources', () => {
  const result = invoke({ file: true });
  assert.equal(result.envelope.status, 200);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].contentLength, String(Buffer.byteLength('offline-upload-fixture')));
  assert.equal(result.calls[0].transferEncoding, null);
  assert.equal(Buffer.from(result.calls[0].body, 'base64').toString(), 'offline-upload-fixture');
  released(result, 1, 1);
});

test('real Python helper rejects non-integer response limits before acquiring an upload file', () => {
  for (const maxBytes of [true, false, 1.5, '100', null, 0, 100 * 1024 * 1024 + 1]) {
    const result = invoke({ file: true, request: { maxBytes } });
    assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
    assert.equal(result.calls.length, 0);
    released(result, 0);
  }
});

test('real Python helper accepts response-limit boundaries and reads only one overflow byte', () => {
  for (const maxBytes of [1, 100 * 1024 * 1024]) {
    const result = invoke({ request: { maxBytes }, responseBody: Buffer.from('x').toString('base64') });
    assert.equal(result.envelope.status, 200);
    assert.deepEqual(result.responseReadLimits, [maxBytes + 1]);
    released(result, 0, 1);
  }
});

test('real Python helper validates timeout before acquiring an upload file', () => {
  for (const timeoutMs of [0, true, 1.5, '100', 600001]) {
    const result = invoke({ file: true, request: { timeoutMs } });
    assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
    assert.equal(result.calls.length, 0);
    released(result, 0);
  }
});

test('real Python helper rejects conflicting body encodings instead of silently choosing one', () => {
  for (const options of [
    { request: { body: '', bodyBase64: '' } },
    { file: true, request: { body: '' } },
    { file: true, request: { bodyBase64: '' } },
    { file: true, request: { body: 'one', bodyBase64: 'dHdv' } },
  ]) {
    const result = invoke(options);
    assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
    assert.equal(result.calls.length, 0);
    released(result, 0);
  }
});

test('real Python helper closes a verified file when Request construction fails', () => {
  const result = invoke({ file: true, mode: 'request-error' });
  assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
  assert.equal(result.counts.requestConstructed, 1);
  assert.equal(result.calls.length, 0);
  released(result);
});

test('real Python helper rejects caller-supplied file framing before opening the source', () => {
  for (const headers of [{ 'Content-Length': '1' }, { 'Transfer-Encoding': 'chunked' }]) {
    const result = invoke({ file: true, request: { headers } });
    assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
    assert.equal(result.calls.length, 0);
    released(result, 0);
  }
});

test('real Python helper closes rejected source descriptors and preserves not-sent delivery', () => {
  const result = invoke({ file: true, sourcePatch: { sha256: '0'.repeat(64) } });
  assert.deepEqual(result.envelope, { error: 'FILE_CHANGED', delivery: 'not_sent' });
  assert.equal(result.calls.length, 0);
  released(result);
});

test('real Python helper closes the file after an opener network failure', () => {
  const result = invoke({ file: true, mode: 'network-error' });
  assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
  assert.equal(result.calls.length, 1);
  released(result);
});

test('real Python helper closes both resources for an HTTP error response', () => {
  const result = invoke({ file: true, mode: 'http-error' });
  assert.equal(result.envelope.status, 409);
  assert.equal(result.calls.length, 1);
  released(result, 1, 1);
});

test('real Python helper rejects a premature upload response and closes both resources', () => {
  const result = invoke({ file: true, mode: 'premature-response' });
  assert.deepEqual(result.envelope, { error: 'FILE_CHANGED', delivery: 'unknown' });
  released(result, 1, 1);
});

test('real Python helper closes response and source after response-read failure', () => {
  const result = invoke({ file: true, mode: 'response-error' });
  assert.deepEqual(result.envelope, { error: 'NETWORK_ERROR' });
  released(result, 1, 1);
});

test('real Python helper closes both resources when the response exceeds its limit', () => {
  const result = invoke({ file: true, request: { maxBytes: 1 } });
  assert.deepEqual(result.envelope, { error: 'RESPONSE_TOO_LARGE' });
  assert.deepEqual(result.responseReadLimits, [2]);
  released(result, 1, 1);
});

for (const mode of ['mutate-stream', 'wrapped-mutate-stream']) {
  test(`real Python helper closes a changed in-flight file and preserves unknown delivery: ${mode}`, () => {
    const result = invoke({ file: true, mode });
    assert.deepEqual(result.envelope, { error: 'FILE_CHANGED', delivery: 'unknown' });
    assert.equal(result.calls.length, 1);
    released(result);
  });
}
