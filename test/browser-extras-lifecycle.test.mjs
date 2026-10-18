import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DotBrowserExtras } from '../src/browser-extras.mjs';

// All service replies are local fixtures. No browser opener or remote URL is
// invoked; HTTP and TCP exercise only the production loopback server.
function fixture() {
  const calls = [];
  let reply = () => ({ novnc_url: 'https://chatgpt.com/fixture-viewer' });
  const extras = new DotBrowserExtras({ transport: {
    authLoader: async () => ({ accountId: 'account-fixture' }),
    request: async (method, route, options) => { calls.push([method, route, options]); return reply(method, route, options); },
  } });
  return { extras, calls, setReply(value) { reply = value; } };
}
const scope = { conversationId: 'conversation-fixture', challengeId: 'challenge-fixture' };
const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
function localRequest(viewer, path = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${viewer.origin}${path}`, { method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}
function api(viewer, path, extra = {}) {
  return localRequest(viewer, `/api/${path}`, { method: 'POST', body: '{}', headers: {
    Origin: viewer.origin, Authorization: `Bearer ${new URL(viewer.url).hash.slice(1)}`, 'Content-Type': 'application/json', ...extra,
  } });
}

for (const mode of ['qr', 'legacy']) {
  test(`${mode} viewer accepts cross-site top-level document navigation only`, async t => {
    const f = fixture(), viewer = await f.extras.viewerServer({ ...scope, mode });
    t.after(() => viewer.close());
    const page = await localRequest(viewer, '/', { headers: navigation });
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    for (const [path, headers] of [
      ['/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }],
      ['/', { ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
      ['/', { ...navigation, Origin: 'https://foreign.example' }],
      ['/', { ...navigation, Host: 'foreign.example' }],
      ['/browser-extras-browser.mjs', navigation],
      ['/browser-extras-browser.mjs', { ...navigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' }],
      ['/api/poll', navigation],
    ]) {
      const response = await localRequest(viewer, path, { headers });
      assert.equal(response.status, 403, `${path}: ${JSON.stringify(headers)}`);
      assert.equal(JSON.parse(response.body).error.code, 'LOOPBACK_ORIGIN_REJECTED');
    }
    assert.equal((await api(viewer, 'heartbeat', navigation)).status, 403);
    assert.equal((await api(viewer, 'heartbeat')).status, 200);
    if (mode === 'legacy') {
      const connected = await api(viewer, 'connect');
      const frame = JSON.parse(connected.body).viewer;
      assert.match(frame, /^\/legacy-frame\//);
      assert.equal((await localRequest(viewer, frame, { headers: navigation })).status, 403);
      assert.equal((await localRequest(viewer, frame)).status, 200);
      assert.equal(f.calls.length, 1);
    } else assert.equal(f.calls.length, 0);
  });

  test(`${mode} viewer closes unused preconnect and incomplete HTTP sockets idempotently`, async t => {
    const f = fixture(), viewer = await f.extras.viewerServer({ ...scope, mode });
    const sockets = [];
    t.after(async () => { for (const socket of sockets) socket.destroy(); await viewer.close(); });
    for (const partial of ['', 'GET / HTTP/1.1\r\n']) {
      const socket = createConnection(viewer.address.port, viewer.address.address);
      sockets.push(socket); socket.on('error', () => {});
      await once(socket, 'connect');
      if (partial) socket.write(partial);
    }
    // Let the server accept the raw sockets; no service request is sent.
    await delay(30);
    const first = viewer.close('fixture-closed'), second = viewer.close('different-reason');
    assert.equal(first, second);
    const result = await Promise.race([first, delay(1000).then(() => { throw new Error('Viewer close did not terminate pending sockets.'); })]);
    assert.deepEqual(result, { mode, reason: 'fixture-closed' });
    assert.equal(await viewer.done, result);
    assert.equal(viewer.close(), first);
    assert.equal(f.calls.length, mode === 'legacy' ? 1 : 0);
  });
}

test('QR viewer aborts an in-flight service request before closing pending sockets', async t => {
  const f = fixture(), viewer = await f.extras.viewerServer(scope);
  t.after(() => viewer.close());
  let started, aborted = false;
  const requestStarted = new Promise(resolve => { started = resolve; });
  f.setReply((_method, _route, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    started();
  }));
  const pending = api(viewer, 'poll');
  // Connection shutdown may race the error response; both are valid closures.
  const observed = pending.then(value => value, error => error);
  await requestStarted;
  const result = await viewer.close('fixture-cancelled');
  const response = await observed;
  assert.equal(aborted, true); assert.equal(f.calls.length, 1);
  assert.deepEqual(result, { mode: 'qr', reason: 'fixture-cancelled' });
  if (!(response instanceof Error)) assert.equal(response.status, 502);
});
