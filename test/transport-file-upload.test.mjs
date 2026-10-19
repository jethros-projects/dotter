import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm, symlink, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Transport } from '../src/transport.mjs';
import { pythonFetch } from '../src/http.mjs';

const URL = 'https://sdmntprcentralus.oaiusercontent.com/files/test/raw?sv=v&sig=private-test-signature';
const blockId = index => Buffer.from(String(index).padStart(8, '0')).toString('base64');
const jwt = subject => `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.test`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, { size = 32773 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dot-upload-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.bin'), handle = await open(path, 'wx', 0o600);
  const digest = createHash('sha256'), chunk = Buffer.alloc(Math.min(size, 1024 * 1024), 0xa7);
  try {
    for (let written = 0; written < size;) {
      const data = chunk.subarray(0, Math.min(chunk.length, size - written));
      await handle.writeFile(data); digest.update(data); written += data.length;
    }
  } finally { await handle.close(); }
  const info = await stat(path);
  return { path, name: 'source.bin', mimeType: 'application/octet-stream', sizeBytes: size,
    sha256: digest.digest('hex'), dev: String(info.dev), ino: String(info.ino), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

function transport(response = () => new Response('', { status: 201 })) {
  const calls = [];
  return { calls, client: new Transport({ authLoader: async () => { throw Error('must remain anonymous'); },
    fetchImpl: async (url, options) => { calls.push({ url: new globalThis.URL(url), ...options }); return response(url, options); } }) };
}

test('native Azure block and commit use the exact signed URL, headers, order and XML', async () => {
  const { client, calls } = transport();
  await client.uploadAzureBlock(`${URL}&comp=old&blockid=old`, { bytes: Buffer.from('part'), blockId: blockId(1), contentType: 'application/pdf' });
  await client.commitAzureBlocks(`${URL}&blockid=old`, { blockIds: [blockId(0), blockId(1)], contentType: 'application/pdf' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('comp'), 'block'); assert.equal(calls[0].url.searchParams.get('blockid'), blockId(1));
  assert.equal(calls[0].url.searchParams.get('sig'), 'private-test-signature');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/pdf', 'x-ms-version': '2020-04-08' });
  assert.equal(calls[0].azureMultipart, 'block'); assert.equal(calls[0].signedUpload, true); assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[1].url.searchParams.get('comp'), 'blocklist'); assert.equal(calls[1].url.searchParams.has('blockid'), false);
  assert.deepEqual(calls[1].headers, { 'Content-Type': 'application/xml', 'x-ms-version': '2020-04-08', 'x-ms-blob-content-type': 'application/pdf' });
  assert.equal(calls[1].body.toString(), `<?xml version="1.0" encoding="utf-8"?>\n<BlockList>\n  <Latest>${blockId(0)}</Latest>\n  <Latest>${blockId(1)}</Latest>\n</BlockList>`);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, undefined); assert.equal(call.headers.Cookie, undefined); assert.equal(call.headers['ChatGPT-Account-Id'], undefined);
  }
});

test('file-backed signed uploads retain 512MiB file bounds separately from response and in-memory limits', async t => {
  const source = await fixture(t), { client, calls } = transport(() => new Response('{}', { status: 201 }));
  const out = await client.uploadSignedFile(URL, { source, contentType: source.mimeType, timeoutMs: 120000 });
  assert.deepEqual(out, { uploaded: true, sizeBytes: source.sizeBytes });
  assert.equal(calls[0].body, undefined); assert.equal(calls[0].bodyFile.path, source.path); assert.equal(calls[0].bodyFile.length, source.sizeBytes);
  assert.equal(calls[0].maxBytes, 65536); assert.equal(calls[0].timeoutMs, 120000);
  await client.uploadSignedFile(URL, { source: { ...source, sizeBytes: 512 * 1024 * 1024 } });
  await assert.rejects(client.uploadSignedFile(URL, { source: { ...source, sizeBytes: 512 * 1024 * 1024 + 1 } }), { code: 'INVALID_FILE' });
  assert.equal(calls.length, 2);
});

test('file-backed block uploads send an exact verified range without retaining byte buffers', async t => {
  const source = await fixture(t), { client, calls } = transport();
  const proof = { source, offset: 3, length: 19, sha256: sha(Buffer.alloc(19, 0xa7)) };
  const out = await client.uploadAzureBlock(URL, { ...proof, blockId: blockId(0) });
  assert.deepEqual(out, { uploaded: true, sizeBytes: 19 }); assert.equal(calls[0].body, undefined);
  assert.deepEqual(calls[0].bodyFile, { path: source.path, sizeBytes: source.sizeBytes, dev: source.dev, ino: source.ino,
    mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, offset: 3, length: 19, sha256: proof.sha256 });
});

test('malformed strategies, non-Azure signed hosts and mixed body sources never make requests', async t => {
  const source = await fixture(t), { client, calls } = transport();
  for (const url of ['https://files.oaiusercontent.com/f?sig=x', 'https://s3.amazonaws.com/f?X-Amz-Signature=x',
    'https://sdmntprcentralus.oaiusercontent.com.evil.test/f?sig=x', 'https://storage.blob.core.windows.net/f?sig=', 'https://storage.blob.core.windows.net:443/f?sig=x#fragment']) {
    await assert.rejects(client.uploadAzureBlock(url, { bytes: Buffer.from('p'), blockId: blockId(0) }), { code: 'UNSUPPORTED_FILE_HOST' });
  }
  for (const invalid of ['bad', Buffer.from('0000000x').toString('base64'), Buffer.from('000000000').toString('base64')]) {
    await assert.rejects(client.uploadAzureBlock(URL, { bytes: Buffer.from('p'), blockId: invalid }), { code: 'INVALID_ARGUMENT' });
  }
  for (const blockIds of [[], [blockId(0)], [blockId(0), blockId(0)], [blockId(1), blockId(0)], [blockId(0), blockId(2)], Array(2)]) {
    await assert.rejects(client.commitAzureBlocks(URL, { blockIds }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(client.uploadAzureBlock(URL, { source, bytes: Buffer.from('p'), blockId: blockId(0) }), { code: 'INVALID_FILE' });
  await assert.rejects(client.uploadAzureBlock(URL, { source, offset: source.sizeBytes, length: 1, blockId: blockId(0) }), { code: 'INVALID_FILE' });
  await assert.rejects(client.uploadAzureBlock(URL, { source: { ...source, sha256: 'wrong' }, blockId: blockId(0) }), { code: 'INVALID_FILE' });
  assert.equal(calls.length, 0);
});

test('multipart failures are not retried and preserve acknowledged versus uncertain transport state', async () => {
  const { client, calls } = transport(() => new Response('error', { status: 503 }));
  await assert.rejects(client.uploadAzureBlock(URL, { bytes: Buffer.from('p'), blockId: blockId(0) }), error => error.code === 'HTTP_ERROR' && error.details.delivery === 'unknown');
  assert.equal(calls.length, 1);
});

test('already cancelled uploads never call the HTTP transport', async t => {
  const source = await fixture(t), { client, calls } = transport(), controller = new AbortController();
  controller.abort(new Error('cancelled'));
  for (const invoke of [
    () => client.uploadSignedFile(URL, { source, signal: controller.signal }),
    () => client.uploadAzureBlock(URL, { bytes: Buffer.from('p'), blockId: blockId(0), signal: controller.signal }),
    () => client.commitAzureBlocks(URL, { blockIds: [blockId(0), blockId(1)], signal: controller.signal }),
    () => client.uploadEstuaryFile(URL, { source, expectedAccountId: 'account', signal: controller.signal }),
  ]) await assert.rejects(invoke(), /cancelled/);
  assert.equal(calls.length, 0);
});

test('Estuary file streaming pins account and subject and supports only its fixed multipart route', async t => {
  const source = await fixture(t), calls = []; let subject = 'owner';
  const client = new Transport({ authLoader: async () => ({ accessToken: jwt(subject), accountId: 'account' }),
    fetchImpl: async (url, options) => { calls.push({ url: new globalThis.URL(url), ...options }); return new Response('{}'); } });
  await client.uploadEstuaryFile(URL, { source, expectedAccountId: 'account' });
  assert.equal(calls[0].url.pathname, '/backend-api/estuary/upload_content_bytes'); assert.equal(calls[0].url.searchParams.get('upload_url'), URL);
  assert.equal(calls[0].body, undefined); assert.equal(calls[0].bodyFile.multipart.name, source.name);
  assert.equal(calls[0].headers['X-OpenAI-Attach-Auth'], '1'); assert.match(calls[0].headers.Authorization, /^Bearer /);
  subject = 'other'; await assert.rejects(client.uploadEstuaryFile(URL, { source, expectedAccountId: 'account' }), { code: 'AUTH_IDENTITY_CHANGED' });
  await assert.rejects(client.request('POST', '/backend-api/other', { bodyFile: source }), { code: 'INVALID_FILE' });
  assert.equal(calls.length, 1);
});

// Run the real helper against a local HTTP server. HTTPSConnection alone is
// replaced to connect to loopback, after all production destination checks.
// The request still traverses urllib/http.client and a real socket; no external
// connection, credentials, or network service is used by this test.
const pythonHarness = String.raw`
import contextlib, faulthandler, hashlib, http.client, http.server, io, json, os, runpy, socketserver, sys, threading, urllib.request
config = json.loads(sys.stdin.read())
# A loopback fixture must not discover OS or environment proxies or reverse DNS.
urllib.request.getproxies = lambda: {}
faulthandler.dump_traceback_later(5)
class LocalHTTPServer(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'localhost', self.server_address[1]
calls, read_sizes = [], []
original_read = os.read
def bounded_read(fd, size):
    read_sizes.append(size)
    return original_read(fd, size)
os.read = bounded_read
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_PUT(self): self.consume()
    def do_POST(self): self.consume()
    def consume(self):
        remaining = int(self.headers['Content-Length'])
        digest, count, first, last = hashlib.sha256(), 0, b'', b''
        while remaining:
            data = self.rfile.read(min(remaining, 1024 * 1024))
            if not data: raise ValueError('incomplete body')
            if not first: first = data[:512]
            last = (last + data)[-512:]
            digest.update(data); remaining -= len(data); count += len(data)
        calls.append({'path': self.path, 'method': self.command, 'headers': dict(self.headers), 'size': count, 'sha256': digest.hexdigest(), 'first': first.hex(), 'last': last.hex()})
        body = b'{}'
        self.send_response(201); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
server = LocalHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
thread.start()
class LocalHTTPSConnection(http.client.HTTPConnection):
    def __init__(self, host, timeout=30, **kwargs):
        super().__init__('127.0.0.1', server.server_port, timeout=timeout)
http.client.HTTPSConnection = LocalHTTPSConnection
if config.get('mutateDuringRead'):
    class Opener:
        def open(self, request, timeout):
            calls.append({'started': True})
            request.data.read(1)
            with open(config['request']['bodyFile']['path'], 'r+b') as file:
                file.seek(2); file.write(b'x'); file.flush(); os.fsync(file.fileno())
            request.data.read(1)
            raise RuntimeError('mutation not detected')
    urllib.request.build_opener = lambda *args: Opener()
sys.stdin = io.StringIO(json.dumps(config['request']))
out = io.StringIO()
try:
    with contextlib.redirect_stdout(out): runpy.run_path(sys.argv[1], run_name='__main__')
finally:
    server.shutdown(); server.server_close(); thread.join()
faulthandler.cancel_dump_traceback_later()
sys.stdout.write(json.dumps({'envelope': json.loads(out.getvalue()), 'calls': calls, 'readMax': max(read_sizes, default=0), 'readCount': len(read_sizes)}))
`;

function python(request, options = {}) {
  const result = spawnSync('python3', ['-I', '-c', pythonHarness, fileURLToPath(new globalThis.URL('../src/http.py', import.meta.url))],
    { input: JSON.stringify({ request, ...options }), encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.slice(0, 16384)); assert.equal(result.error, undefined); assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
function fileRequest(source, patch = {}) {
  return { url: URL, method: 'PUT', headers: { 'Content-Type': source.mimeType }, signedUpload: true,
    bodyFile: { path: source.path, sizeBytes: source.sizeBytes, dev: source.dev, ino: source.ino,
      mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, offset: 0, length: source.sizeBytes, sha256: source.sha256 }, ...patch };
}

test('real Python file PUT streams a real 17MiB file in bounded reads with exact length and digest', async t => {
  const source = await fixture(t, { size: 17 * 1024 * 1024 + 37 });
  const result = python(fileRequest(source));
  assert.equal(result.envelope.status, 201); assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].size, source.sizeBytes); assert.equal(result.calls[0].sha256, source.sha256);
  assert.equal(result.calls[0].headers['Content-Length'], String(source.sizeBytes));
  assert.equal(result.calls[0].headers.Authorization, undefined); assert.equal(result.calls[0].headers.Cookie, undefined);
  assert(result.readMax <= 1024 * 1024); assert(result.readCount > 17);
});

test('real Python native block upload streams only the exact requested range', async t => {
  const source = await fixture(t), request = fileRequest(source);
  request.url += `&comp=block&blockid=${encodeURIComponent(blockId(1))}`; request.azureMultipart = 'block';
  request.headers['x-ms-version'] = '2020-04-08'; request.bodyFile.offset = 7; request.bodyFile.length = 25; request.bodyFile.sha256 = sha(Buffer.alloc(25, 0xa7));
  const result = python(request);
  assert.equal(result.envelope.status, 201); assert.equal(result.calls[0].size, 25); assert.equal(result.calls[0].sha256, request.bodyFile.sha256);
});

test('real Python commits exact native XML and rejects malformed XML or extra headers before HTTP', async () => {
  const { client, calls } = transport();
  await client.commitAzureBlocks(URL, { blockIds: [blockId(0), blockId(1)], contentType: 'application/pdf' });
  const call = calls[0], request = { url: String(call.url), method: call.method, headers: call.headers,
    bodyBase64: call.body.toString('base64'), signedUpload: true, azureMultipart: 'blocklist' };
  const result = python(request);
  assert.equal(result.envelope.status, 201); assert.equal(result.calls.length, 1); assert.equal(result.calls[0].sha256, sha(call.body));
  for (const patch of [
    { bodyBase64: Buffer.from(call.body.toString().replace(blockId(1), blockId(0))).toString('base64') },
    { headers: { ...call.headers, 'x-ms-blob-type': 'BlockBlob' } },
    { url: String(call.url) + '&blockid=forbidden' },
  ]) { const invalid = python({ ...request, ...patch }); assert.equal(invalid.calls.length, 0); assert.equal(invalid.envelope.error, 'NETWORK_ERROR'); }
});

test('real Python file upload rejects changed hash, identity, bounds and symbolic links before HTTP', async t => {
  const source = await fixture(t), request = fileRequest(source);
  for (const patch of [{ sha256: 'a'.repeat(64) }, { ino: String(BigInt(source.ino) + 1n) }, { sizeBytes: source.sizeBytes + 1 }, { mtimeMs: source.mtimeMs + 1 }]) {
    const result = python({ ...request, bodyFile: { ...request.bodyFile, ...patch } });
    assert.equal(result.calls.length, 0); assert.deepEqual(result.envelope, { error: 'FILE_CHANGED', delivery: 'not_sent' });
  }
  const link = join(source.path, '..', 'link.bin'); await symlink(source.path, link);
  const linked = python({ ...request, bodyFile: { ...request.bodyFile, path: link } });
  assert.equal(linked.calls.length, 0); assert.deepEqual(linked.envelope, { error: 'INVALID_FILE', delivery: 'not_sent' });
  const oversized = python({ ...request, bodyFile: { ...request.bodyFile, sizeBytes: 512 * 1024 * 1024 + 1 } });
  assert.equal(oversized.calls.length, 0); assert.equal(oversized.envelope.error, 'INVALID_FILE');
});

test('real Python detects source mutation after streaming starts and reports uncertain delivery', async t => {
  const source = await fixture(t), result = python(fileRequest(source), { mutateDuringRead: true });
  assert.equal(result.calls.length, 1); assert.deepEqual(result.envelope, { error: 'FILE_CHANGED', delivery: 'unknown' });
});

test('real Python rejects credentials, malformed block IDs and unauthorized file-backed routes before HTTP', async t => {
  const source = await fixture(t), request = fileRequest(source);
  for (const patch of [{ headers: { Authorization: 'Bearer synthetic-secret' } }, { url: 'https://evil.test/f?sig=x' },
    { url: 'https://chatgpt.com/backend-api/tbo', signedUpload: false, method: 'POST' },
    { url: URL + '&comp=block&blockid=bad', azureMultipart: 'block', headers: { 'Content-Type': 'application/pdf', 'x-ms-version': '2020-04-08' } }]) {
    const result = python({ ...request, ...patch }); assert.equal(result.calls.length, 0); assert.equal(result.envelope.error, 'NETWORK_ERROR');
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  }
});

test('real Python Estuary multipart stream preserves its native file and upstream form fields', async t => {
  const source = await fixture(t), { client, calls } = transport(() => new Response('{}', { status: 201 }));
  // Capture production construction, then execute its request in real Python.
  client.authLoader = async () => ({ accessToken: jwt('owner'), accountId: 'account' });
  await client.uploadEstuaryFile(URL, { source, expectedAccountId: 'account' });
  const call = calls[0], result = python({ url: String(call.url), method: call.method, headers: call.headers, bodyFile: call.bodyFile });
  assert.equal(result.envelope.status, 201); assert.equal(result.calls.length, 1);
  const { boundary } = call.bodyFile.multipart;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload_url"\r\n\r\n${URL}\r\n--${boundary}--\r\n`);
  const expected = Buffer.concat([prefix, Buffer.alloc(source.sizeBytes, 0xa7), suffix]);
  assert.equal(result.calls[0].size, expected.length); assert.equal(result.calls[0].sha256, sha(expected));
  assert.match(Buffer.from(result.calls[0].first, 'hex').toString('utf8'), /name="file"; filename="source.bin"/);
  assert.match(Buffer.from(result.calls[0].last, 'hex').toString('utf8'), /name="upload_url"/);
});

test('Python-to-JavaScript errors preserve file failure phase without exposing private path or URL', async () => {
  // A nonexistent verified source is rejected inside the real helper, before
  // DNS or HTTP. This checks the actual private-pipe error mapping end to end.
  const source = { path: '/does-not-exist/dot-upload.bin', sizeBytes: 1, dev: '1', ino: '1', mtimeMs: 1, ctimeMs: 1, sha256: sha(Buffer.from('x')) };
  const client = new Transport({ fetchImpl: pythonFetch });
  await assert.rejects(client.uploadSignedFile(URL, { source }), error => {
    assert.equal(error.code, 'INVALID_FILE'); assert.equal(error.details.delivery, 'not_sent');
    assert.equal(JSON.stringify(error.toJSON()).includes(source.path), false); assert.equal(JSON.stringify(error.toJSON()).includes('private-test-signature'), false);
    return true;
  });
});
