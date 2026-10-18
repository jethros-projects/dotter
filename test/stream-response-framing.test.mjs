import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonStream, streamSSE } from '../src/stream-http.mjs';

const helper = fileURLToPath(new URL('../src/stream-http.py', import.meta.url));
const route = '/backend-api/offline-stream-framing';
const event = Buffer.from('data: {"ok":true}\n\n');
const missing = Buffer.from('{"detail":"Not Found"}');
// Redirect only HTTPSConnection after the helper's origin checks. urllib and
// http.client parse real wire bytes from a loopback socket, including duplicates.
const harness = String.raw`
import base64,contextlib,http.client,http.server,io,json,runpy,sys,threading
config=json.loads(sys.argv[2]); calls=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self): self.respond()
 def respond(self):
  calls.append({'method':self.command,'path':self.path})
  wire=('HTTP/1.1 '+str(config['status'])+' Fixture\r\nConnection: close\r\n').encode('ascii')
  for key,value in config['headers']: wire+=(key+': '+str(value)+'\r\n').encode('utf-8')
  wire+=b'\r\n'+base64.b64decode(config['body'])
  try: self.wfile.write(wire);self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError): pass
  self.close_connection=True
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=0.01),daemon=True);thread.start()
class LocalHTTPSConnection(http.client.HTTPConnection):
 def __init__(self,host,timeout=30,**kwargs): super().__init__('127.0.0.1',server.server_port,timeout=timeout)
http.client.HTTPSConnection=LocalHTTPSConnection
output=io.StringIO();exit_code=0
try:
 with contextlib.redirect_stdout(output):
  try: runpy.run_path(sys.argv[1],run_name='__main__')
  except SystemExit as error: exit_code=error.code
finally: server.shutdown();server.server_close();thread.join()
# The JS consumer may intentionally close on the first rejection. Flush the
# request audit before records, so that cancellation cannot erase evidence.
sys.stderr.write(json.dumps(calls));sys.stderr.flush()
sys.stdout.write(output.getvalue());sys.stdout.flush()
sys.exit(exit_code)
`;

function response({ status = 200, body = event, headers = [['Content-Type', 'text/event-stream'], ['Content-Length', body.length]] } = {}) {
  return { status, body: body.toString('base64'), headers };
}

function fixture(value) {
  const audits = [], pending = [], records = [];
  let opens = 0, ready = 0;
  const events = [];
  const streamImpl = (url, options) => pythonStream(url, options, { spawnImpl: (_cmd, _args, childOptions) => {
    opens++;
    assert.equal(opens, 1, 'The helper must not retry a framing failure');
    const child = spawn('python3', ['-I', '-c', harness, helper, JSON.stringify(value)], {
      ...childOptions, stdio: ['pipe', 'pipe', 'pipe']
    });
    let audit = '', output = '';
    child.stderr.on('data', chunk => { audit += chunk; });
    child.stdout.on('data', chunk => { output += chunk; });
    pending.push(new Promise((resolve, reject) => child.once('close', () => {
      try {
        assert.ok(audit, 'The loopback request audit must survive early cancellation');
        audits.push(...JSON.parse(audit));
        records.push(...output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
        resolve();
      } catch (error) { reject(error); }
    })));
    return child;
  } });
  return {
    run: () => streamSSE({ authLoader: async () => ({ accountId: 'fixture-account', accessToken: 'synthetic-token' }) }, 'GET', route, {
      streamImpl, onReady: () => { ready++; }, onEvent: item => { events.push(item); }
    }),
    async done() {
      await Promise.all(pending);
      assert.equal(opens, 1);
      assert.deepEqual(audits, [{ method: 'GET', path: route }]);
      return { ready, events, records };
    }
  };
}

async function rejected(value, code = 'NETWORK_ERROR', expectedReady = 0, expectedEvents = 0) {
  const f = fixture(value);
  await assert.rejects(f.run(), { code });
  const result = await f.done();
  assert.equal(result.ready, expectedReady);
  assert.equal(result.events.length, expectedEvents);
  return result;
}

const invalidLengths = [
  ['duplicate equal', [['Content-Length', event.length], ['Content-Length', event.length]]],
  ['duplicate conflicting', [['Content-Length', event.length], ['Content-Length', event.length + 1]]],
  ['comma list', [['Content-Length', `${event.length}, ${event.length}`]]],
  ['negative', [['Content-Length', '-1']]],
  ['positive sign', [['Content-Length', `+${event.length}`]]],
  ['decimal', [['Content-Length', '18.0']]],
  ['text', [['Content-Length', 'invalid']]],
  ['empty', [['Content-Length', '']]],
  ['non-ASCII digits', [['Content-Length', '١٨']]],
  ['integer conversion overflow', [['Content-Length', '1'.repeat(5000)]]]
];
for (const [name, lengths] of invalidLengths) {
  test(`real stream rejects ${name} Content-Length before ready`, async () => {
    const result = await rejected(response({ headers: [['Content-Type', 'text/event-stream'], ...lengths] }));
    assert.ok(result.records.every(record => record.type !== 'response' && record.type !== 'chunk'));
  });
}

test('real stream rejects Content-Length plus chunked before ready', async () => {
  const body = Buffer.concat([Buffer.from(event.length.toString(16) + '\r\n'), event, Buffer.from('\r\n0\r\n\r\n')]);
  await rejected(response({ body, headers: [['Content-Type', 'text/event-stream'], ['Transfer-Encoding', 'chunked'], ['Content-Length', event.length]] }));
});

test('ambiguous framing is rejected before an encoded 200 can become ready', async () => {
  await rejected(response({ headers: [['Content-Type', 'text/event-stream'], ['Content-Encoding', 'gzip'], ['Content-Length', event.length], ['Content-Length', event.length]] }));
});

for (const [name, headers, body] of [
  ['exact fixed length', [['Content-Length', event.length]], event],
  ['trimmed fixed length', [['Content-Length', ` \t${event.length}\t `]], event],
  ['close-delimited', [], event],
  ['chunked', [['Transfer-Encoding', 'chunked']], Buffer.concat([Buffer.from(event.length.toString(16) + '\r\n'), event, Buffer.from('\r\n0\r\n\r\n')])]
]) {
  test(`real ${name} stream still completes`, async () => {
    const f = fixture(response({ body, headers: [['Content-Type', 'text/event-stream'], ...headers] }));
    await f.run();
    const result = await f.done();
    assert.equal(result.ready, 1);
    assert.deepEqual(result.events.map(item => item.data), ['{"ok":true}']);
  });
}

test('fixed-length stream EOF with bytes still expected is a terminal failure', async () => {
  const result = await rejected(response({ headers: [['Content-Type', 'text/event-stream'], ['Content-Length', event.length + 20]] }), 'NETWORK_ERROR', 1, 1);
  assert.equal(result.records.at(-1).type, 'error');
});

test('a truncated final event is never dispatched as a complete event', async () => {
  const body = Buffer.from('data: {"partial":true}');
  await rejected(response({ body, headers: [['Content-Type', 'text/event-stream'], ['Content-Length', body.length + 20]] }), 'NETWORK_ERROR', 1, 0);
});

for (const status of [404, 410]) {
  test(`truncated HTTP ${status} cannot become ordinary stream absence`, async () => {
    const result = await rejected(response({ status, body: missing, headers: [['Content-Type', 'application/json'], ['Content-Length', missing.length + 20]] }));
    assert.ok(result.records.every(record => record.type !== 'response' && record.type !== 'error-body'));
  });

  test(`duplicate lengths on HTTP ${status} cannot become ordinary stream absence`, async () => {
    await rejected(response({ status, body: missing, headers: [['Content-Length', missing.length], ['Content-Length', missing.length]] }));
  });

  test(`complete HTTP ${status} still retains ordinary stream status`, async () => {
    const f = fixture(response({ status, body: missing }));
    await assert.rejects(f.run(), error => error.code === 'HTTP_ERROR' && error.details.status === status);
    const result = await f.done();
    assert.equal(result.ready, 0);
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.records.map(record => record.type), ['response', 'error-body']);
  });

  test(`bounded HTTP ${status} rejects a body larger than the error limit`, async () => {
    const body = Buffer.alloc(65537, 0x61);
    await rejected(response({ status, body }));
  });

  test(`truncated HTTP ${status} preserves a confirmed body challenge`, async () => {
    const body = Buffer.from('<script src="/cdn-cgi/challenge-platform/fixture"></script>');
    await rejected(response({ status, body, headers: [['Content-Type', 'text/html'], ['Content-Length', body.length + 20]] }), 'EDGE_CHALLENGE');
  });
}

for (const [status, type, code] of [[401, 'application/json', 'AUTH_REJECTED'], [403, 'application/json', 'FORBIDDEN'], [403, 'text/html', 'FORBIDDEN_HTML']]) {
  test(`ambiguous framing preserves known ${status} ${type} refusal`, async () => {
    await rejected(response({ status, body: missing, headers: [['Content-Type', type], ['Content-Length', '-1']] }), code);
  });
  test(`truncated framing preserves known ${status} ${type} refusal`, async () => {
    await rejected(response({ status, body: missing, headers: [['Content-Type', type], ['Content-Length', missing.length + 20]] }), code);
  });
}

for (const status of [200, 404]) {
  test(`a challenge header wins over ambiguous stream framing at HTTP ${status}`, async () => {
    await rejected(response({ status, headers: [['CF-Mitigated', 'challenge'], ['Content-Length', '-1'], ['Content-Encoding', 'gzip']] }), 'EDGE_CHALLENGE');
  });
}
