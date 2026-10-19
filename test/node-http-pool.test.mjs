import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent as HttpAgent, createServer as httpServer, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, createServer as httpsServer, request as httpsRequest } from 'node:https';
import { createServer as netServer } from 'node:net';
import { once, getEventListeners } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { mkdtemp, realpath, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createNodeFetch, nodeFetch } from '../src/node-http.mjs';

const URL = 'https://chatgpt.com/backend-api/offline-pool';
const STORAGE = 'https://files.oaiusercontent.com/offline-pool?sig=synthetic';
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const lookup = (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
const json = (response, value = { ok: true }) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

async function listener(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, sockets, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

async function fixture(t, handler) {
  const requests = [], agents = [], connections = new Set();
  const server = httpServer((request, response) => { requests.push(request); connections.add(request.socket); handler(request, response); });
  const local = await listener(server);
  class AgentImpl extends HttpAgent {
    constructor(options) { super(options); this.destroyCalls = 0; agents.push(this); }
    destroy() { this.destroyCalls++; super.destroy(); }
  }
  const clientRequests = [];
  const requestImpl = (url, options, callback) => {
    const req = httpRequest({ ...options, hostname: url.hostname, lookup, port: local.port, path: url.pathname + url.search }, callback);
    clientRequests.push(req); return req;
  };
  const fetch = createNodeFetch({ AgentImpl, requestImpl });
  t.after(async () => { await fetch.close(); await local.close(); });
  return { fetch, agents, requests, connections, clientRequests, requestImpl, local };
}
const get = (fetch, options = {}) => fetch(URL, { method: 'GET', ...options });

test('pool construction, invalid input and closing an unused factory perform no I/O', async () => {
  let constructed = 0, opened = 0;
  class AgentImpl { constructor() { constructed++; } }
  const fetch = createNodeFetch({ AgentImpl, requestImpl() { opened++; assert.fail('must not open'); } });
  assert.equal(constructed, 0); assert.equal(opened, 0);
  await assert.rejects(fetch('https://example.invalid/private', { method: 'GET' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(constructed, 0);
  const closing = fetch.close(); assert.equal(fetch.close(), closing); await closing;
  await assert.rejects(get(fetch), { code: 'CLOSED', details: { delivery: 'not_sent' } });
  assert.equal(constructed, 0); assert.equal(opened, 0);
});

test('healthy requests reuse one bounded owned pool and close it exactly once', async t => {
  const f = await fixture(t, (_request, response) => json(response));
  assert.equal(f.agents.length, 0);
  assert.deepEqual(await (await get(f.fetch)).json(), { ok: true });
  assert.deepEqual(await (await get(f.fetch)).json(), { ok: true });
  assert.equal(f.connections.size, 1); assert.equal(f.agents.length, 1);
  const agent = f.agents[0];
  assert.equal(agent.keepAlive, true); assert.equal(agent.maxSockets, 8); assert.equal(agent.maxTotalSockets, 16);
  assert.equal(agent.maxFreeSockets, 2); assert.equal(agent.options.timeout, 10000); assert.equal(agent.options.maxCachedSessions, 32);
  assert.equal(f.clientRequests[1].reusedSocket, true);
  await f.fetch.close(); await f.fetch.close(); assert.equal(agent.destroyCalls, 1);
  await assert.rejects(get(f.fetch), { code: 'CLOSED', details: { delivery: 'not_sent' } });
});

test('complete refusals preserve filtered headers on a reused connection', async t => {
  let count = 0;
  const f = await fixture(t, (_request, response) => {
    if (++count === 2) {
      response.writeHead(403, { 'Content-Type': 'application/json', 'X-Request-Id': 'synthetic-denied', 'Set-Cookie': 'discard=private' }); response.end('{"denied":true}');
    } else json(response);
  });
  await get(f.fetch);
  const refusal = await get(f.fetch);
  assert.equal(refusal.status, 403); assert.equal(refusal.headers.get('x-request-id'), 'synthetic-denied'); assert.equal(refusal.headers.get('set-cookie'), null);
  assert.deepEqual(await refusal.json(), { denied: true });
  await get(f.fetch); assert.equal(f.connections.size, 1); assert.equal(f.requests.length, 3);
});

test('late errors from a settled request do not poison its reusable connection', async t => {
  const f = await fixture(t, (_request, response) => json(response));
  await get(f.fetch);
  f.clientRequests[0].emit('error', new Error('synthetic-late-error'));
  await get(f.fetch); assert.equal(f.connections.size, 1); assert.equal(f.requests.length, 2);
});

test('request headers and credentials do not persist or cross pooled origins', async t => {
  const f = await fixture(t, (_request, response) => json(response));
  await get(f.fetch, { headers: { Authorization: 'Bearer synthetic-first', 'ChatGPT-Account-Id': 'synthetic-account' } });
  await get(f.fetch);
  await f.fetch(STORAGE, { method: 'GET', signedFile: true });
  assert.equal(f.requests[0].headers.authorization, 'Bearer synthetic-first');
  assert.equal(f.requests[1].headers.authorization, undefined); assert.equal(f.requests[1].headers['chatgpt-account-id'], undefined);
  assert.equal(f.requests[2].headers.authorization, undefined); assert.equal(f.requests[2].headers.cookie, undefined);
  assert.equal(f.requests[2].headers['chatgpt-account-id'], undefined);
  assert.equal(f.connections.size, 2); assert.equal(f.clientRequests[1].reusedSocket, true); assert.equal(f.clientRequests[2].reusedSocket, false);
});

for (const [status, challenge] of [[401, false], [403, true]]) test(`a reused socket gets a fresh header probe for malformed ${status}`, async t => {
  let count = 0;
  const f = await fixture(t, (request, response) => {
    if (++count === 2) request.socket.end(`HTTP/1.1 ${status} Fixture\r\nContent-Length: bad\r\nX-Request-Id: synthetic-second\r\n${challenge ? 'CF-Mitigated: challenge\r\n' : ''}\r\n`);
    else json(response);
  });
  await get(f.fetch); const value = await get(f.fetch);
  assert.equal(value.status, status); assert.equal(value.headers.get('x-request-id'), 'synthetic-second');
  assert.equal(value.headers.get('cf-mitigated'), challenge ? 'challenge' : null);
  assert.equal(f.clientRequests[1].reusedSocket, true);
  await get(f.fetch); assert.equal(f.connections.size, 2);
});

for (const kind of ['challenge', 'malformed', 'truncated', 'overflow', 'cancelled']) test(`${kind} response is never returned to the pool`, async t => {
  let count = 0;
  const started = deferred();
  const f = await fixture(t, (request, response) => {
    if (++count !== 2) { json(response); return; }
    started.resolve();
    if (kind === 'malformed') request.socket.end('HTTP/1.1 404 Fixture\r\nContent-Length: 2\r\nContent-Length: 99\r\n\r\n{}');
    else if (kind === 'truncated') request.socket.end('HTTP/1.1 200 Fixture\r\nContent-Length: 99\r\n\r\n{}');
    else if (kind === 'overflow') { response.writeHead(200, { 'Content-Length': 99999 }); response.write(Buffer.alloc(1024)); }
    else { response.writeHead(kind === 'challenge' ? 403 : 200, { 'Content-Length': 99999, ...(kind === 'challenge' ? { 'CF-Mitigated': 'challenge' } : {}) }); response.flushHeaders(); }
  });
  await get(f.fetch);
  const controller = new AbortController();
  const pending = get(f.fetch, { maxBytes: kind === 'overflow' ? 5 : 1024, signal: controller.signal });
  if (kind === 'cancelled') { await started.promise; controller.abort(false); }
  if (kind === 'challenge') { const value = await pending; assert.equal(value.status, 403); assert.equal(value.headers.get('cf-mitigated'), 'challenge'); }
  else await assert.rejects(pending, kind === 'cancelled' ? error => error === false : { code: kind === 'overflow' ? 'RESPONSE_TOO_LARGE' : 'NETWORK_ERROR' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await get(f.fetch); assert.equal(f.connections.size, 2); assert.equal(f.requests.length, 3);
});

test('close cancels active and queued calls without opening queued requests afterward', async t => {
  const saturated = deferred();
  let count = 0;
  const f = await fixture(t, () => { if (++count === 8) saturated.resolve(); });
  const pending = Array.from({ length: 12 }, () => get(f.fetch).then(value => ({ value }), error => ({ error })));
  await saturated.promise;
  const agent = f.agents[0];
  assert.equal(Object.values(agent.sockets).flat().length, 8); assert.equal(Object.values(agent.requests).flat().length, 4);
  await f.fetch.close();
  const outcomes = await Promise.all(pending);
  assert.equal(outcomes.length, 12); assert.ok(outcomes.every(value => value.error?.code === 'CLOSED' && value.error.details.delivery === 'unknown'));
  await immediate(); assert.equal(f.requests.length, 8); assert.equal(agent.destroyCalls, 1);
});

test('the total connection bound applies across service and storage origins', async t => {
  const saturated = deferred();
  let count = 0;
  const f = await fixture(t, () => { if (++count === 16) saturated.resolve(); });
  const targets = [URL, STORAGE, 'https://sdmntprfixture.oaiusercontent.com/offline?sig=synthetic'];
  const pending = Array.from({ length: 24 }, (_, index) => f.fetch(targets[index % 3], { method: 'GET', signedFile: true }).then(value => ({ value }), error => ({ error })));
  await saturated.promise;
  const agent = f.agents[0];
  assert.equal(agent.totalSocketCount, 16); assert.ok(Object.values(agent.sockets).every(value => value.length <= 8));
  await f.fetch.close(); const outcomes = await Promise.all(pending);
  assert.ok(outcomes.every(value => value.error?.code === 'CLOSED')); assert.equal(f.requests.length, 16);
});

test('caller cancellation removes a queued request and preserves its exact reason', async t => {
  const saturated = deferred(); let count = 0;
  const f = await fixture(t, () => { if (++count === 8) saturated.resolve(); });
  const running = Array.from({ length: 8 }, () => get(f.fetch).catch(error => error));
  await saturated.promise;
  const controller = new AbortController(), queued = get(f.fetch, { signal: controller.signal });
  controller.abort(null); await assert.rejects(queued, error => error === null);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await f.fetch.close(); await Promise.all(running); assert.equal(f.requests.length, 8);
});

test('closing during file preflight closes the source without constructing an Agent', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-pool-file-'))), path = join(directory, 'fixture.bin');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(17 * 1024 * 1024, 0xa7); await writeFile(path, bytes); const info = await stat(path);
  const bodyFile = { path, sizeBytes: bytes.length, dev: String(info.dev), ino: String(info.ino), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
    offset: 0, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let constructed = 0;
  class AgentImpl { constructor() { constructed++; } }
  const fetch = createNodeFetch({ AgentImpl, requestImpl() { assert.fail('must not open'); } });
  const pending = fetch(STORAGE, { method: 'PUT', signedUpload: true, bodyFile }).catch(error => error);
  await fetch.close(); const error = await pending;
  assert.equal(error.code, 'CLOSED'); assert.equal(error.details.delivery, 'not_sent'); assert.equal(constructed, 0);
});

test('standalone requests can borrow an Agent without closing that Agent', async t => {
  const f = await fixture(t, (_request, response) => json(response));
  const borrowed = new HttpAgent({ keepAlive: true }); let destroyed = 0;
  const destroy = borrowed.destroy; borrowed.destroy = function () { destroyed++; return destroy.call(this); };
  t.after(() => borrowed.destroy());
  await nodeFetch(URL, { method: 'GET' }, { requestImpl: f.requestImpl, getAgent: () => borrowed });
  await f.fetch.close(); assert.equal(destroyed, 0);
  await nodeFetch(URL, { method: 'GET' }, { requestImpl: f.requestImpl, getAgent: () => borrowed });
  assert.equal(f.connections.size, 1); assert.equal(destroyed, 0);
});

async function earlyResponse(t, status, { challenge = false } = {}) {
  const received = deferred(), responseSeen = deferred(), drained = deferred();
  const body = Buffer.alloc(32 * 1024 * 1024, 0xa7);
  let socket, bytesRead = 0, headers = Buffer.alloc(0), hasHeaders = false;
  const server = netServer(value => {
    socket = value; socket.on('error', () => {});
    socket.on('data', bytes => {
      if (!hasHeaders) {
        headers = Buffer.concat([headers, bytes]); const end = headers.indexOf('\r\n\r\n'); if (end < 0) return;
        hasHeaders = true; bytesRead += headers.length - end - 4; headers = undefined;
        socket.pause(); socket.write(`HTTP/1.1 ${status} Fixture\r\nContent-Length: 2\r\n${challenge ? 'CF-Mitigated: challenge\r\n' : ''}\r\n{}`); received.resolve();
      } else bytesRead += bytes.length;
      if (bytesRead === body.length) drained.resolve();
    });
  });
  const local = await listener(server); t.after(() => local.close());
  let request;
  const requestImpl = (url, options, callback) => {
    request = httpRequest({ ...options, hostname: url.hostname, lookup, port: local.port, path: url.pathname }, callback);
    request.once('response', () => responseSeen.resolve()); return request;
  };
  const operation = nodeFetch(URL, { method: 'POST', body, timeoutMs: 5000 }, { requestImpl });
  return { operation, received: received.promise, responseSeen: responseSeen.promise, drained: drained.promise, resume: () => socket.resume(), request: () => request, bytesRead: () => bytesRead, bodySize: body.length };
}

test('early 2xx cannot resolve before a buffered upload finishes flushing', async t => {
  const f = await earlyResponse(t, 200);
  let settled = false; f.operation.then(() => { settled = true; }, () => { settled = true; });
  await f.received; await f.responseSeen; await immediate();
  assert.equal(f.request().writableFinished, false); assert.equal(settled, false);
  f.resume(); const result = await f.operation; await f.drained;
  assert.equal(result.status, 200); assert.equal(f.request().writableFinished, true); assert.equal(f.bytesRead(), f.bodySize);
});

for (const challenge of [false, true]) test(`early buffered-upload refusal${challenge ? ' with challenge' : ''} disposes promptly`, async t => {
  const f = await earlyResponse(t, 403, { challenge });
  await f.responseSeen; const result = await f.operation;
  assert.equal(result.status, 403); assert.equal(result.headers.get('cf-mitigated'), challenge ? 'challenge' : null);
  assert.equal(f.request().writableFinished, false); assert.equal(f.request().destroyed, true);
});

test('owned HTTPS pool reuses its bounded TLS session cache across closed connections', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-pool-tls-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'fixture.key'), certFile = join(directory, 'fixture.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
    '-out', certFile, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1'], { stdio: 'ignore' });
  if (generated.error?.code === 'ENOENT') { t.skip('OpenSSL is unavailable for the optional local TLS fixture.'); return; }
  assert.equal(generated.status, 0);
  const key = await readFile(keyFile), cert = await readFile(certFile), agents = [], reused = [];
  const server = httpsServer({ key, cert, maxVersion: 'TLSv1.2' }, (_request, response) => { response.writeHead(200, { Connection: 'close' }); response.end('{}'); });
  const local = await listener(server);
  class AgentImpl extends HttpsAgent { constructor(options) { super(options); agents.push(this); } }
  const fetch = createNodeFetch({ AgentImpl, requestImpl(url, options, callback) {
    const req = httpsRequest({ ...options, hostname: 'localhost', lookup, port: local.port, servername: 'localhost', ca: cert, maxVersion: 'TLSv1.2', path: url.pathname }, callback);
    req.once('socket', socket => socket.once('secureConnect', () => reused.push(socket.isSessionReused()))); return req;
  } });
  t.after(async () => { await fetch.close(); await local.close(); });
  await get(fetch); await get(fetch);
  assert.equal(agents.length, 1); assert.equal(agents[0].maxCachedSessions, 32); assert.deepEqual(reused, [false, true]);
});
