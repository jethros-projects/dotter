import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, realpath, rm, writeFile, stat, symlink, rename, open } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { nodeFetch } from '../src/node-http.mjs';
import { headerProbe } from '../src/http-node/response.mjs';
import { Transport } from '../src/transport.mjs';

const URL = 'https://chatgpt.com/backend-api/offline-native';
const STORAGE = 'https://files.oaiusercontent.com/offline-native?sig=synthetic';
const JSON_BYTES = Buffer.from('{"ok":true}');
const sha = value => createHash('sha256').update(value).digest('hex');

async function listening(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

async function wire(t, bytes, { split = false, keepOpen = false } = {}) {
  let requests = 0;
  const server = netServer(socket => {
    let input = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (!input.includes('\r\n\r\n') || requests) return;
      requests++;
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (split) {
        const cut = payload.indexOf('Content-Length') + 8;
        socket.write(payload.subarray(0, cut));
        setTimeout(() => keepOpen ? socket.write(payload.subarray(cut)) : socket.end(payload.subarray(cut)), 5);
      } else if (keepOpen) socket.write(payload);
      else socket.end(payload);
    });
  });
  const port = await listening(t, server);
  const requestImpl = (url, options, callback) => {
    assert.equal(url.protocol, 'https:'); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.insecureHTTPParser, false); assert.equal(options.agent, false);
    return httpRequest({ ...options, hostname: '127.0.0.1', port, path: url.pathname + url.search }, callback);
  };
  return { requestImpl, count: () => requests };
}

function raw(status = 200, headers = [], body = JSON_BYTES) {
  return Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Fixture\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`), body]);
}
const call = (fixture, options = {}) => nodeFetch(URL, { method: 'GET', ...options }, fixture);
const transport = fixture => new Transport({ authLoader: async () => ({ accessToken: 'synthetic-token', accountId: 'synthetic-account' }), fetchImpl: (url, options) => nodeFetch(url, options, fixture) });

test('native transport uses actual TLS and preserves ordinary request and response bytes', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-native-tls-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'fixture.key'), certFile = join(directory, 'fixture.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
    '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1'], { stdio: 'ignore' });
  if (generated.error?.code === 'ENOENT') { t.skip('OpenSSL is unavailable for the optional local TLS certificate fixture.'); return; }
  assert.equal(generated.status, 0);
  const key = await readFile(keyFile), cert = await readFile(certFile);
  let received;
  const server = httpsServer({ key, cert }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { url: request.url, method: request.method, token: request.headers.authorization, body: Buffer.concat(chunks) };
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'synthetic-id', 'Set-Cookie': 'private=discard' }); response.end(JSON_BYTES);
  });
  const port = await listening(t, server);
  const requestImpl = (url, options, callback) => httpsRequest({ ...options, hostname: '127.0.0.1', port, servername: 'localhost', ca: cert, path: url.pathname + url.search }, callback);
  const response = await nodeFetch(URL, { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: '{"hello":"world"}' }, { requestImpl });
  assert.equal(await response.text(), JSON_BYTES.toString());
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-request-id'), 'synthetic-id');
  assert.deepEqual(received, { url: '/backend-api/offline-native', method: 'POST', token: 'Bearer synthetic', body: Buffer.from('{"hello":"world"}') });
});

test('response preserves raw compressed bytes, duplicate encoding, and exact wire-size bound', async t => {
  const body = gzipSync(JSON_BYTES);
  const f = await wire(t, raw(200, [['Content-Length', body.length], ['Content-Encoding', 'gzip'], ['Content-Encoding', 'identity']], body));
  const response = await call(f, { maxBytes: body.length });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.equal(response.headers.get('content-encoding'), 'gzip, identity');
  assert.equal(f.count(), 1);
});

test('overflow rejects before retaining the whole response', async t => {
  const f = await wire(t, raw(200, [['Content-Length', 1000000]], Buffer.alloc(128 * 1024)));
  await assert.rejects(call(f, { maxBytes: 5 }), { code: 'RESPONSE_TOO_LARGE', details: { delivery: 'unknown' } });
});

for (const [name, headers, body] of [
  ['fixed', [['Content-Length', JSON_BYTES.length]], JSON_BYTES],
  ['close-delimited', [], JSON_BYTES],
  ['chunked', [['Transfer-Encoding', 'chunked']], Buffer.concat([Buffer.from(`${JSON_BYTES.length.toString(16)}\r\n`), JSON_BYTES, Buffer.from('\r\n0\r\n\r\n')])],
]) test(`complete ${name} response succeeds through the native parser`, async t => {
  const f = await wire(t, raw(200, headers, body));
  assert.deepEqual(await (await call(f)).json(), { ok: true });
});

for (const status of [200, 201, 206, 404, 410]) test(`short fixed-length ${status} stays indeterminate`, async t => {
  const f = await wire(t, raw(status, [['Content-Length', JSON_BYTES.length + 10]], JSON_BYTES));
  await assert.rejects(call(f, { method: 'POST', body: '{}' }), { code: 'NETWORK_ERROR', details: { delivery: 'unknown' } });
  assert.equal(f.count(), 1);
});

for (const status of [401, 403, 503]) test(`short fixed-length ${status} retains its known refusal`, async t => {
  const f = await wire(t, raw(status, [['Content-Length', JSON_BYTES.length + 10]], JSON_BYTES));
  const response = await call(f); assert.equal(response.status, status); assert.deepEqual(await response.json(), { ok: true });
});

for (const status of [204, 205, 304]) test(`bodyless ${status} creates a bodyless Response`, async t => {
  const f = await wire(t, raw(status, [['Content-Length', status === 205 ? 0 : 9999]], Buffer.alloc(0)));
  const response = await call(f); assert.equal(response.status, status); assert.equal(response.body, null);
});

for (const [name, headers] of [
  ['duplicate-identical', [['Content-Length', JSON_BYTES.length], ['Content-Length', JSON_BYTES.length]]],
  ['duplicate-conflicting', [['Content-Length', JSON_BYTES.length], ['Content-Length', 99]]],
  ['comma', [['Content-Length', '11, 11']]], ['negative', [['Content-Length', '-1']]],
  ['fraction', [['Content-Length', '11.0']]], ['invalid', [['Content-Length', 'bad']]],
  ['overflow', [['Content-Length', '9'.repeat(5000)]]],
  ['transfer-conflict', [['Content-Length', 11], ['Transfer-Encoding', 'chunked']]],
]) test(`ambiguous ${name} framing cannot become a complete absence`, async t => {
  const f = await wire(t, raw(404, headers)); await assert.rejects(call(f), { code: 'NETWORK_ERROR' }); assert.equal(f.count(), 1);
});

for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'FORBIDDEN']]) test(`split malformed framing preserves HTTP ${status}`, async t => {
  const f = await wire(t, raw(status, [['Content-Length', 'bad']]), { split: true });
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code });
});

test('known header challenge wins over malformed framing after informational headers', async t => {
  const f = await wire(t, Buffer.concat([Buffer.from('HTTP/1.1 103 Early Hints\r\nLink: </offline>\r\n\r\n'),
    raw(404, [['Content-Length', 11], ['Content-Length', 999], ['CF-Mitigated', 'challenge']])]), { split: true });
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code: 'EDGE_CHALLENGE' });
});

test('known header challenge terminates a body that never finishes', async t => {
  const f = await wire(t, raw(404, [['Content-Length', 99999], ['CF-Mitigated', 'challenge']], Buffer.alloc(0)), { keepOpen: true });
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code: 'EDGE_CHALLENGE' });
});

test('informational response headers have a cumulative bound before a final response', async t => {
  const information = Buffer.from('HTTP/1.1 103 Early Hints\r\nX-Padding: ' + 'x'.repeat(900) + '\r\n\r\n');
  const f = await wire(t, Buffer.concat([...Array.from({ length: 100 }, () => information), raw(401, [['Content-Length', 'bad']])]));
  await assert.rejects(call(f), { code: 'NETWORK_ERROR' });
});

test('a header probe cannot lose overflow exactly at an informational boundary', () => {
  const prefix = 'HTTP/1.1 103 Early Hints\r\nX-Padding: ', suffix = '\r\n\r\n';
  const info = Buffer.from(prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix);
  const probe = headerProbe(); probe.capture(Buffer.concat([info, raw(200, [['Content-Length', JSON_BYTES.length]])]));
  assert.equal(probe.done, true); assert.equal(probe.overflow, true); assert.equal(probe.refusal(), undefined);
});

test('many headers cannot hide a late content encoding from inspection', async t => {
  const headers = Array.from({ length: 2100 }, (_, index) => [`X-${index}`, 'x']);
  headers.push(['Content-Encoding', 'gzip'], ['Content-Length', JSON_BYTES.length]);
  const f = await wire(t, raw(200, headers));
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code: 'INVALID_RESPONSE' });
});

for (const status of [200, 404, 410, 503]) test(`truncated chunked ${status} is never complete`, async t => {
  const f = await wire(t, raw(status, [['Transfer-Encoding', 'chunked']], Buffer.concat([Buffer.from('b\r\n'), JSON_BYTES, Buffer.from('\r\n')])));
  await assert.rejects(call(f), { code: 'NETWORK_ERROR' });
});

test('a truncated absence with a received challenge marker remains definitive', async t => {
  const body = Buffer.from('enable javascript and cookies to continue');
  const f = await wire(t, raw(404, [['Content-Length', body.length + 20]], body));
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code: 'EDGE_CHALLENGE' });
});

for (const status of [401, 403, 404, 410]) test(`malformed chunked ${status} preserves its already received challenge marker`, async t => {
  const body = Buffer.from('enable javascript and cookies to continue');
  const f = await wire(t, raw(status, [['Transfer-Encoding', 'chunked']], Buffer.concat([
    Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\nnot-a-size\r\n'),
  ])));
  await assert.rejects(transport(f).request('GET', '/backend-api/offline-native'), { code: 'EDGE_CHALLENGE' });
});

test('redirect is returned once without following it or forwarding credentials', async t => {
  const f = await wire(t, raw(302, [['Location', 'https://example.invalid/private'], ['Content-Length', 0]], Buffer.alloc(0)));
  await assert.rejects(transport(f).request('POST', '/backend-api/offline-native', { body: {} }), { code: 'REDIRECT_BLOCKED' }); assert.equal(f.count(), 1);
});

test('request timeout and caller cancellation close a hanging native response', async t => {
  const f = await wire(t, raw(200, [['Content-Length', 99999]], JSON_BYTES), { keepOpen: true });
  await assert.rejects(call(f, { timeoutMs: 15 }), { code: 'NETWORK_ERROR' });
  const f2 = await wire(t, raw(200, [['Content-Length', 99999]], JSON_BYTES), { keepOpen: true });
  const controller = new AbortController(); const pending = call(f2, { signal: controller.signal });
  setTimeout(() => controller.abort('synthetic-reason'), 15);
  await assert.rejects(pending, error => error === 'synthetic-reason');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const status of [401, 403]) test(`a timed-out HTTP ${status} body preserves its known refusal`, async t => {
  const f = await wire(t, raw(status, [['Content-Length', 99999]], JSON_BYTES), { keepOpen: true });
  const response = await call(f, { timeoutMs: 15 }); assert.equal(response.status, status);
});

test('a timed-out server error body remains an indeterminate network failure', async t => {
  const f = await wire(t, raw(503, [['Content-Length', 99999]], JSON_BYTES), { keepOpen: true });
  await assert.rejects(call(f, { timeoutMs: 15 }), { code: 'NETWORK_ERROR' });
});

test('pre-aborted falsy reasons remain exact and never open a connection', async () => {
  for (const reason of [false, 0, '', null]) {
    const controller = new AbortController(); controller.abort(reason);
    await assert.rejects(nodeFetch(URL, { method: 'GET', signal: controller.signal }, { requestImpl() { assert.fail('must not connect'); } }), value => value === reason);
  }
});

test('URL, headers, body and size input guards run before any connection', async () => {
  for (const [url, options] of [
    ['http://chatgpt.com/backend-api/x', {}], ['https://example.invalid/backend-api/x', {}], ['https://chatgpt.com/not-api', {}],
    ['https://chatgpt.com:444/backend-api/x', {}], ['https://synthetic@chatgpt.com/backend-api/x', {}], [`${URL}#fragment`, {}],
    [URL, { method: 'HEAD' }], [URL, { headers: { Host: 'example.invalid' } }], [URL, { headers: { Cookie: 'bad\r\nInjected: true' } }],
    [URL, { headers: { Accept: 'x', accept: 'y' } }], [URL, { headers: { 'Content-Length': '99' }, body: 'x' }],
    [URL, { headers: { 'Transfer-Encoding': 'chunked' }, body: 'x' }], [URL, { maxBytes: 0 }], [URL, { maxBytes: null }],
    [URL, { timeoutMs: '1' }], [URL, { body: {} }], [URL, { body: 'x', bodyFile: {} }],
    [STORAGE, { signedFile: true, headers: { Authorization: 'synthetic' } }], [STORAGE, { signedUpload: true, method: 'POST' }],
  ]) await assert.rejects(nodeFetch(url, { method: 'GET', ...options }, { requestImpl() { assert.fail('must not connect'); } }), { code: 'INVALID_ARGUMENT', details: { delivery: 'not_sent' } });
});

test('throwing input conversions are sanitized before opening the network', async () => {
  const secret = () => { throw new Error('synthetic-private-detail'); };
  for (const [url, options, code] of [
    [{ toString: secret }, { method: 'GET' }, 'INVALID_ARGUMENT'],
    [URL, { method: 'GET', headers: { get Authorization() { return secret(); } } }, 'INVALID_ARGUMENT'],
    [URL, { method: 'GET', get signal() { return secret(); } }, 'INVALID_ARGUMENT'],
    [STORAGE, { method: 'PUT', signedUpload: true, bodyFile: { get path() { return secret(); } } }, 'INVALID_FILE'],
  ]) await assert.rejects(nodeFetch(url, options, { requestImpl() { assert.fail('must not connect'); } }), error => error.code === code
    && error.details.delivery === 'not_sent' && !JSON.stringify(error).includes('synthetic-private'));
});

async function uploadSource(t, bytes = Buffer.from('offline-upload-fixture')) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-native-file-'))), path = join(directory, 'fixture.bin');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, bytes); const info = await stat(path);
  return { path, sizeBytes: bytes.length, dev: String(info.dev), ino: String(info.ino), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
    offset: 0, length: bytes.length, sha256: sha(bytes) };
}

async function uploadServer(t, { onData } = {}) {
  const calls = [];
  const server = httpServer(async (request, response) => {
    const digest = createHash('sha256'); let size = 0, maximum = 0;
    try {
      for await (const chunk of request) { digest.update(chunk); size += chunk.length; maximum = Math.max(maximum, chunk.length); await onData?.(chunk, size); }
      calls.push({ headers: request.headers, size, maximum, sha256: digest.digest('hex') });
      response.writeHead(201, { 'Content-Length': 2 }); response.end('{}');
    } catch { response.destroy(); }
  });
  const port = await listening(t, server);
  return { calls, requestImpl: (url, options, callback) => httpRequest({ ...options, hostname: '127.0.0.1', port, path: url.pathname + url.search }, callback) };
}

test('native upload streams a 17 MiB file with exact length, digest and bounded chunks', async t => {
  const bytes = Buffer.alloc(17 * 1024 * 1024, 0xa7), source = await uploadSource(t, bytes), f = await uploadServer(t);
  const response = await nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source }, f);
  assert.equal(response.status, 201); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['content-length'], String(bytes.length)); assert.equal(f.calls[0].headers['transfer-encoding'], undefined);
  assert.equal(f.calls[0].size, bytes.length); assert.equal(f.calls[0].sha256, sha(bytes)); assert.ok(f.calls[0].maximum <= 1024 * 1024);
});

test('native Azure block upload streams precisely the verified file range', async t => {
  const bytes = Buffer.from('0123456789abcdefghijklmnop'), source = await uploadSource(t, bytes), f = await uploadServer(t), range = bytes.subarray(7, 22);
  const url = 'https://fixture.blob.core.windows.net/x?sig=synthetic&comp=block&blockid=MDAwMDAwMDA%3D';
  await nodeFetch(url, { method: 'PUT', signedUpload: true, azureMultipart: 'block', headers: { 'Content-Type': 'application/octet-stream', 'x-ms-version': '2020-04-08' },
    bodyFile: { ...source, offset: 7, length: range.length, sha256: sha(range) } }, f);
  assert.equal(f.calls[0].size, range.length); assert.equal(f.calls[0].sha256, sha(range));
});

test('Estuary multipart framing is constructed from validated fields around exact file bytes', async t => {
  const bytes = Buffer.from('offline-upload-fixture'), source = await uploadSource(t, bytes), f = await uploadServer(t);
  const boundary = 'dot-library-12345678-1234-1234-1234-123456789012', name = 'quote".bin', mimeType = 'application/octet-stream';
  await nodeFetch(`https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=${encodeURIComponent(STORAGE)}`, {
    method: 'POST', headers: { 'X-OpenAI-Attach-Auth': '1', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    bodyFile: { ...source, multipart: { boundary, name, mimeType, uploadUrl: STORAGE } },
  }, f);
  const expected = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quote%22.bin"\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload_url"\r\n\r\n${STORAGE}\r\n--${boundary}--\r\n`)]);
  assert.equal(f.calls[0].size, expected.length); assert.equal(f.calls[0].sha256, sha(expected));
});

test('source digest, stat, path and symlink guards fail before opening the network', async t => {
  const source = await uploadSource(t), linked = join(source.path, '..', 'linked.bin'); await symlink(source.path, linked);
  for (const [bodyFile, code] of [[{ ...source, sha256: '0'.repeat(64) }, 'FILE_CHANGED'], [{ ...source, ino: '0' }, 'FILE_CHANGED'],
    [{ ...source, path: linked }, 'INVALID_FILE'], [{ ...source, offset: source.sizeBytes, length: 1 }, 'INVALID_FILE'], [{ ...source, path: source.path.replace('/fixture.bin', '/../fixture.bin') }, 'INVALID_FILE']]) {
    await assert.rejects(nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile }, { requestImpl() { assert.fail('must not connect'); } }), { code, details: { delivery: 'not_sent' } });
  }
});

test('replacing the named source after request creation cannot send the file', async t => {
  const source = await uploadSource(t), f = await uploadServer(t);
  let bodyWrites = 0;
  await assert.rejects(nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source }, {
    requestImpl(url, options, callback) {
      const req = f.requestImpl(url, options, callback);
      // Complete replacement before returning to the first streaming check.
      // An async rename could lose the race to this tiny body's final write;
      // pausing the response would then turn a valid send into a timeout.
      renameSync(source.path, `${source.path}.old`);
      writeFileSync(source.path, 'replacement');
      const write = req.write;
      req.write = function (...args) { bodyWrites++; return write.apply(this, args); };
      return req;
    },
  }), error => error.code === 'FILE_CHANGED' && error.details.delivery === 'unknown');
  assert.equal(bodyWrites, 0);
  assert.equal(f.calls.length, 0);
});

test('a file changed while streaming stops transmission and preserves unknown delivery', async t => {
  const source = await uploadSource(t, Buffer.alloc(17 * 1024 * 1024, 0xa7));
  let changed = false;
  const f = await uploadServer(t, { async onData() {
    if (changed) return; changed = true;
    const handle = await open(source.path, 'r+');
    try { await handle.write(Buffer.from([0]), 0, 1, 0); await handle.sync(); }
    finally { await handle.close(); }
  } });
  await assert.rejects(nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source }, f), { code: 'FILE_CHANGED', details: { delivery: 'unknown' } });
  assert.equal(changed, true);
});

test('source identity is rechecked after request completion when the response arrives', async t => {
  const source = await uploadSource(t);
  let changed;
  const server = httpServer(async (request, response) => {
    for await (const _ of request) { /* Consume every transmitted byte. */ }
    await changed;
    response.writeHead(201, { 'Content-Length': 2 }); response.end('{}');
  });
  const port = await listening(t, server);
  await assert.rejects(nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source }, {
    requestImpl(url, options, callback) {
      const req = httpRequest({ ...options, hostname: '127.0.0.1', port, path: url.pathname + url.search }, callback);
      changed = once(req, 'finish').then(async () => {
        await rename(source.path, `${source.path}.old`); await writeFile(source.path, 'replacement');
      });
      return req;
    },
  }), { code: 'FILE_CHANGED', details: { delivery: 'unknown' } });
});

test('cancelling file verification never opens the network', async t => {
  const source = await uploadSource(t, Buffer.alloc(17 * 1024 * 1024, 0xa7)), controller = new AbortController();
  const pending = nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source, signal: controller.signal }, { requestImpl() { assert.fail('must not connect'); } });
  controller.abort(false); await assert.rejects(pending, value => value === false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Azure ordered block-list XML is accepted and malformed commits fail before networking', async t => {
  const url = 'https://fixture.blob.core.windows.net/x?sig=synthetic&comp=blocklist';
  const headers = { 'Content-Type': 'application/xml', 'x-ms-version': '2020-04-08' };
  const body = '<?xml version="1.0" encoding="utf-8"?>\n<BlockList>\n  <Latest>MDAwMDAwMDA=</Latest>\n  <Latest>MDAwMDAwMDE=</Latest>\n</BlockList>';
  const options = { method: 'PUT', signedUpload: true, azureMultipart: 'blocklist', headers, body };
  const f = await uploadServer(t); await nodeFetch(url, options, f);
  assert.equal(f.calls[0].sha256, sha(Buffer.from(body)));
  for (const [target, patch] of [[url, { body: body.replace('MDAwMDAwMDE=', 'MDAwMDAwMDI=') }], [`${url}&comp=blocklist`, {}],
    [`${url}&blockid=MDAwMDAwMDA%3D`, {}], [url, { headers: { ...headers, 'x-ms-version': 'wrong' } }],
    [url, { headers: { ...headers, Authorization: 'synthetic' } }], [url, { body: undefined, bodyFile: {} }]]) {
    await assert.rejects(nodeFetch(target, { ...options, ...patch }, { requestImpl() { assert.fail('must not connect'); } }), { code: 'INVALID_ARGUMENT' });
  }
});

test('realtime SDP accepts only the fixed first-party route and unique safe target', async t => {
  const f = await uploadServer(t);
  const options = { method: 'POST', realtimeSdp: true, headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer synthetic' }, body: 'v=0\r\n' };
  await nodeFetch('https://realtime.chatgpt.com/v1/cua?source=flora&cid=synthetic-id', options, f);
  assert.equal(f.calls[0].sha256, sha(Buffer.from(options.body)));
  for (const url of ['https://realtime.chatgpt.com/v1/cua?source=flora&cid=synthetic&cid=duplicate',
    'https://realtime.chatgpt.com/v1/cua?source=flora&cid=..', 'https://realtime.chatgpt.com/v1/cua?source=aeon&thread_id=synthetic',
    'https://realtime.chatgpt.com/v1/other?source=flora&cid=synthetic']) {
    await assert.rejects(nodeFetch(url, options, { requestImpl() { assert.fail('must not connect'); } }), { code: 'INVALID_ARGUMENT' });
  }
});

test('an early successful response cannot certify an incomplete file upload', async t => {
  const source = await uploadSource(t, Buffer.alloc(8 * 1024 * 1024, 0xa7));
  const f = await wire(t, raw(201, [['Content-Length', 2]], Buffer.from('{}')));
  await assert.rejects(nodeFetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile: source }, f), { code: 'FILE_CHANGED', details: { delivery: 'unknown' } });
});
