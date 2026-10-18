import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonFetch } from '../src/http.mjs';
import { Transport } from '../src/transport.mjs';
import { DotLive } from '../src/live.mjs';

const helper = fileURLToPath(new URL('../src/http.py', import.meta.url));
// Run the real Python helper with only urllib's opener replaced. No URL can be
// opened. stderr is a separate synthetic counter channel, never request data.
const harness = String.raw`
import contextlib, io, json, runpy, sys, urllib.error, urllib.request
from email.message import Message
config = json.loads(sys.argv[2])
counts = {'opens': 0, 'reads': 0, 'closes': 0, 'limits': []}
class Response:
    def __init__(self):
        self.code = config['status']
        self.headers = Message()
        self.headers['Content-Type'] = 'application/json'
        self.headers['Set-Cookie'] = 'synthetic-private-cookie'
        self.headers['X-Unrelated'] = 'synthetic-private-header'
        if config.get('challenge'):
            self.headers['CF-Mitigated'] = 'challenge'
        self.closed = False
    def __enter__(self): return self
    def __exit__(self, *args): self.close()
    def close(self):
        if not self.closed:
            self.closed = True
            counts['closes'] += 1
    def read(self, maximum):
        counts['reads'] += 1
        counts['limits'].append(maximum)
        if config.get('broken'):
            raise OSError('synthetic-private-read-error')
        return b'{"ok":true}'[:maximum]
class Opener:
    def open(self, request, timeout):
        counts['opens'] += 1
        response = Response()
        if config.get('httpError'):
            raise urllib.error.HTTPError(request.full_url, response.code, 'synthetic', response.headers, response)
        return response
urllib.request.build_opener = lambda *args: Opener()
output = io.StringIO()
with contextlib.redirect_stdout(output):
    runpy.run_path(sys.argv[1], run_name='__main__')
sys.stdout.write(output.getvalue())
sys.stderr.write(json.dumps(counts))
`;

function invoke(config) {
  const result = spawnSync('python3', ['-I', '-c', harness, helper, JSON.stringify(config)], {
    input: JSON.stringify({ url: 'https://chatgpt.com/backend-api/offline-fixture', method: 'GET', headers: {}, maxBytes: 100 }),
    encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('synthetic-private'), false);
  return { envelope: JSON.parse(result.stdout), counts: JSON.parse(result.stderr) };
}

const challenges = [
  { label: '200 response', status: 200, challenge: true, broken: true },
  { label: '503 response', status: 503, challenge: true, broken: true },
  { label: '503 HTTPError', status: 503, challenge: true, broken: true, httpError: true }
];

for (const config of challenges) {
  test(`real Python helper preserves ${config.label} challenge headers without reading a broken body`, () => {
    const { envelope, counts } = invoke(config);
    assert.deepEqual(envelope, { status: config.status, headers: { 'content-type': 'application/json', 'cf-mitigated': 'challenge' }, body: '' });
    assert.deepEqual(counts, { opens: 1, reads: 0, closes: 1, limits: [] });
  });
}

for (const status of [200, 503]) {
  test(`real Python helper still reads and closes an ordinary ${status} body`, () => {
    const { envelope, counts } = invoke({ status, httpError: status === 503 });
    assert.deepEqual(envelope, { status, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}').toString('base64') });
    assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1, limits: [101] });
  });
}

test('an ordinary broken Python response remains a closed network failure', () => {
  const { envelope, counts } = invoke({ status: 503, broken: true, httpError: true });
  assert.deepEqual(envelope, { error: 'NETWORK_ERROR' });
  assert.deepEqual(counts, { opens: 1, reads: 1, closes: 1, limits: [101] });
});

function realPythonTransport(config, audits) {
  const closed = [];
  const transport = new Transport({
    authLoader: async () => ({ accountId: 'account', accessToken: 'synthetic-token' }),
    fetchImpl: (url, options) => pythonFetch(url, options, { spawnImpl: (_command, _args, childOptions) => {
      const child = spawn('python3', ['-I', '-c', harness, helper, JSON.stringify(config)], { ...childOptions, stdio: ['pipe', 'pipe', 'pipe'] });
      let counters = '';
      child.stderr.on('data', value => { counters += value; });
      closed.push(new Promise(resolve => child.once('close', () => { audits.push(JSON.parse(counters)); resolve(); })));
      return child;
    } })
  });
  return { transport, completed: () => Promise.all(closed) };
}

for (const config of challenges) {
  test(`default Python → Transport → live watch stops once on a ${config.label} challenge`, async () => {
    const audits = []; let sleeps = 0, sockets = 0;
    const fixture = realPythonTransport(config, audits);
    const live = new DotLive({ transport: fixture.transport, resolveRoom: async () => 'room' }, {
      sleep: async () => { sleeps++; throw new Error('unexpected reconnect'); },
      webSocketFactory: () => { sockets++; throw new Error('must not connect'); }
    });
    await assert.rejects(live.watch({ roomId: 'room' }), error => error.code === 'EDGE_CHALLENGE' && error.details.status === config.status);
    await fixture.completed();
    assert.deepEqual(audits, [{ opens: 1, reads: 0, closes: 1, limits: [] }]);
    assert.equal(sleeps, 0); assert.equal(sockets, 0);
  });
}

test('default Python challenge at a write preserves delivery uncertainty', async () => {
  const audits = [], fixture = realPythonTransport(challenges[2], audits);
  await assert.rejects(fixture.transport.request('POST', '/backend-api/offline-fixture', { body: {} }), error => {
    assert.equal(error.code, 'EDGE_CHALLENGE'); assert.equal(error.details.status, 503); assert.equal(error.details.delivery, 'unknown'); return true;
  });
  await fixture.completed();
  assert.deepEqual(audits, [{ opens: 1, reads: 0, closes: 1, limits: [] }]);
});
