import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Transport } from '../src/transport.mjs';
import { pythonFetch } from '../src/http.mjs';
import { pythonStream, streamSSE } from '../src/stream-http.mjs';
import { DotLibrary } from '../src/library.mjs';
import { LibraryContent } from '../src/library-content.mjs';
const helper = fileURLToPath(new URL('../src/http.py', import.meta.url));
const streamHelper = fileURLToPath(new URL('../src/stream-http.py', import.meta.url));
const route = '/backend-api/offline-encoding', marker = Buffer.from('<script src="/cdn-cgi/challenge-platform/x"></script>');
const missing = Buffer.from('{"detail":"Not Found"}'), json = Buffer.from('{"ok":true}');
const encoded = (body = marker, patch = {}) => { const bytes = gzipSync(body); return { status: 404, body: bytes.toString('base64'), headers: [['Content-Type', 'text/html'], ['Content-Encoding', 'gzip'], ['Content-Length', bytes.length]], ...patch }; };
const identity = (body = json, status = 200) => ({ status, body: body.toString('base64'), headers: [['Content-Type', 'application/json'], ['Content-Length', body.length]] });
// Only HTTPSConnection is redirected after the helper's destination checks.
// urllib/http.client use a real loopback socket; no external API is contacted.
const harness = String.raw`
import base64,contextlib,http.client,http.server,io,json,runpy,sys,threading
config=json.loads(sys.argv[2]); calls=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self): self.respond()
 def do_POST(self): self.respond()
 def do_PUT(self): self.respond()
 def do_DELETE(self): self.respond()
 def respond(self):
  if self.headers.get('Content-Length'): self.rfile.read(int(self.headers['Content-Length']))
  calls.append({'method':self.command,'path':self.path})
  self.send_response(config['status'])
  for k,v in config['headers']: self.send_header(k,str(v))
  self.end_headers()
  try: self.wfile.write(base64.b64decode(config['body']))
  except (BrokenPipeError,ConnectionResetError): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=0.01),daemon=True);thread.start()
class LocalHTTPSConnection(http.client.HTTPConnection):
 def __init__(self,host,timeout=30,**kwargs): super().__init__('127.0.0.1',server.server_port,timeout=timeout)
http.client.HTTPSConnection=LocalHTTPSConnection
output=io.StringIO()
try:
 with contextlib.redirect_stdout(output): runpy.run_path(sys.argv[1],run_name='__main__')
finally: server.shutdown();server.server_close();thread.join()
sys.stderr.write(json.dumps(calls));sys.stderr.flush()
sys.stdout.write(output.getvalue());sys.stdout.flush()
`;
const authLoader = async () => ({ accountId: 'fixture-account', accessToken: 'synthetic-token' });
function fixture(responses) {
 const calls = [], pending = [], audits = [];
 function child(selectedHelper, options) {
  return (_cmd, _args, childOptions) => {
   calls.push({ method: options.method, path: new URL(options.url).pathname }); assert.ok(responses.length, 'Unexpected request after terminal response');
   const process = spawn('python3', ['-I', '-c', harness, selectedHelper, JSON.stringify(responses.shift())], { ...childOptions, stdio: ['pipe','pipe','pipe'] });
   let audit = ''; process.stderr.on('data', chunk => { audit += chunk; });
   pending.push(new Promise((resolve,reject) => process.once('close', () => { try { if(audit)audits.push(...JSON.parse(audit)); resolve(); } catch(error) {reject(error);} }))); return process;
  };
 }
 const transport = new Transport({ authLoader, fetchImpl: (url, options) => pythonFetch(url, options, { spawnImpl: child(helper, { ...options, url }) }) });
 const streamImpl = (url, options) => pythonStream(url, options, { spawnImpl: child(streamHelper, { ...options, url }) });
 return { transport, streamImpl, calls, async done(expected = calls.length) { await Promise.all(pending); assert.equal(audits.length, expected); assert.equal(calls.length, expected); } };
}
const invalid = error => error.code === 'INVALID_RESPONSE' && !String(error.message).includes('/cdn-cgi/');
for (const status of [404,410]) test(`real gzip challenge HTTP ${status} cannot become ordinary absence`, async () => { const f=fixture([encoded(marker,{status})]); await assert.rejects(f.transport.request('GET',route),invalid); await f.done(1); });
test('real gzip ordinary404 remains indeterminate', async () => { const f=fixture([encoded(missing)]); await assert.rejects(f.transport.request('GET',route),invalid); await f.done(1); });
test('complete identity404 retains absence classification', async () => { const f=fixture([identity(missing,404)]); await assert.rejects(f.transport.request('GET',route),error=>error.code==='HTTP_ERROR'&&error.details.status===404); await f.done(1); });
for(const encoding of ['br','deflate','GZip','identity, gzip']) test(`opaque ${encoding} errors fail closed`,async()=>{const v=encoded();v.headers[1][1]=encoding;const f=fixture([v]);await assert.rejects(f.transport.request('GET',route),invalid);await f.done(1);});
test('duplicate encoding values cannot hide gzip behind identity',async()=>{const v=encoded();v.headers.splice(1,1,['Content-Encoding','identity'],['Content-Encoding','gzip']);const f=fixture([v]);await assert.rejects(f.transport.request('GET',route),invalid);await f.done(1);});
for(const [status,type,code] of [[401,'application/json','AUTH_REJECTED'],[403,'application/json','FORBIDDEN'],[403,'text/html','FORBIDDEN_HTML']]) test(`known ${status} ${type} refusal wins over encoding`,async()=>{const v=encoded(missing,{status});v.headers[0][1]=type;const f=fixture([v]);await assert.rejects(f.transport.request('GET',route),e=>e.code===code&&e.details.status===status);await f.done(1);});
for(const status of [200,404]) test(`challenge header wins over encoding at ${status}`,async()=>{const v=encoded(marker,{status});v.headers.push(['CF-Mitigated','challenge']);const f=fixture([v]);await assert.rejects(f.transport.request('GET',route),{code:'EDGE_CHALLENGE'});await f.done(1);});
for(const responseType of ['json','text']) test(`encoded successful ${responseType} is not parsed as wire text`,async()=>{const f=fixture([encoded(json,{status:200})]);await assert.rejects(f.transport.request('GET',route,{responseType}),invalid);await f.done(1);});
test('encoded binary success preserves exact bytes and metadata',async()=>{const v=encoded(Buffer.from([0,255,128,0,17]),{status:200}),f=fixture([v]);const r=await f.transport.requestBytes('GET',route,{includeResponse:true});await f.done(1);assert.deepEqual(r.body,Buffer.from(v.body,'base64'));assert.equal(r.headers.get('content-encoding'),'gzip');assert.equal(r.headers.get('content-length'),String(r.body.length));});
test('bodyless204 preserves success with representation encoding metadata',async()=>{const f=fixture([{status:204,body:'',headers:[['Content-Encoding','gzip']]}]);assert.deepEqual(await f.transport.request('POST',route,{body:{}}),{completed:true});await f.done(1);});
test('truncated encoded404 fails wire framing first',async()=>{const v=encoded();v.headers[2][1]+=20;const f=fixture([v]);await assert.rejects(f.transport.request('GET',route),{code:'NETWORK_ERROR'});await f.done(1);});
test('wire size limit still bounds encoded bytes',async()=>{const f=fixture([encoded()]);await assert.rejects(f.transport.request('GET',route,{maxBytes:5}),{code:'RESPONSE_TOO_LARGE'});await f.done(1);});
test('encoded write failure remains unknown and is not retried',async()=>{const f=fixture([encoded()]);await assert.rejects(f.transport.request('POST',route,{body:{}}),e=>invalid(e)&&e.details.delivery==='unknown');await f.done(1);});
test('encoded404 never enters Library node or trash fallback',async()=>{const f=fixture([encoded()]);await assert.rejects(new DotLibrary({transport:f.transport}).get({fileId:'file:fixture',includeTrashed:true}),invalid);await f.done(1);});
test('snapshot refresh encoded404 prevents node fallback and deletion',async()=>{const raw={id:'file:fixture',kind:'file',library_artifact_type:'chat_message_snapshot'},f=fixture([identity(Buffer.from(JSON.stringify(raw))),encoded()]);await assert.rejects(new LibraryContent({transport:f.transport}).permanentDelete({fileId:raw.id,confirm:raw.id}),invalid);await f.done(2);assert.ok(f.calls.every(c=>c.method==='GET'));});
test('signed download preserves binary encoding bytes and metadata',async()=>{const v=encoded(Buffer.from('binary'),{status:200}),f=fixture([v]);const r=await f.transport.fetchSigned('https://files.oaiusercontent.com/fixture?sig=synthetic',{includeResponse:true});await f.done(1);assert.deepEqual(r.body,Buffer.from(v.body,'base64'));assert.equal(r.headers.get('content-encoding'),'gzip');});
test('signed download encoded error cannot become ordinary404',async()=>{const f=fixture([encoded()]);await assert.rejects(f.transport.fetchSigned('https://files.oaiusercontent.com/fixture?sig=synthetic'),invalid);await f.done(1);});
test('signed upload challenge header wins over encoding',async()=>{const v=encoded();v.headers.push(['CF-Mitigated','challenge']);const f=fixture([v]);await assert.rejects(f.transport.uploadSigned('https://files.oaiusercontent.com/fixture?sig=synthetic',{bytes:Buffer.from('upload')}),e=>e.code==='EDGE_CHALLENGE'&&e.details.delivery==='unknown');await f.done(1);});
test('adapters retaining encoding metadata cannot silently claim decoded data',async()=>{const t=new Transport({authLoader,fetchImpl:async()=>Response.json({ok:true},{headers:{'Content-Encoding':'gzip'}})});await assert.rejects(t.request('GET',route),invalid);});
for(const status of [200,500]) test(`real encoded stream ${status} emits neither ready nor events`,async()=>{const v=encoded(Buffer.from('data: {"ok":true}\n\n'),{status});v.headers[0][1]='text/event-stream';const f=fixture([v]);let ready=0,events=0;await assert.rejects(streamSSE(f.transport,'GET',route,{streamImpl:f.streamImpl,onReady:()=>{ready++},onEvent:()=>{events++}}),invalid);await f.done(1);assert.equal(ready,0);assert.equal(events,0);});
for(const [status,code] of [[401,'AUTH_REJECTED'],[403,'FORBIDDEN']]) test(`encoded stream ${status} preserves auth refusal`,async()=>{const v=encoded(missing,{status});v.headers[0][1]='application/json';const f=fixture([v]);await assert.rejects(streamSSE(f.transport,'GET',route,{streamImpl:f.streamImpl}),{code});await f.done(1);});
test('encoded stream challenge header takes precedence',async()=>{const v=encoded(marker,{status:200});v.headers.push(['CF-Mitigated','challenge']);const f=fixture([v]);await assert.rejects(streamSSE(f.transport,'GET',route,{streamImpl:f.streamImpl}),{code:'EDGE_CHALLENGE'});await f.done(1);});
test('duplicate stream encoding cannot hide gzip',async()=>{const v=encoded(json,{status:200});v.headers[0][1]='text/event-stream';v.headers.splice(1,1,['Content-Encoding','gzip'],['Content-Encoding','identity']);const f=fixture([v]);await assert.rejects(streamSSE(f.transport,'GET',route,{streamImpl:f.streamImpl}),invalid);await f.done(1);});
test('ordinary stream still emits one event',async()=>{const v=identity(Buffer.from('data: {"ok":true}\n\n'));v.headers[0][1]='text/event-stream';const f=fixture([v]);let ready=0,events=0;await streamSSE(f.transport,'GET',route,{streamImpl:f.streamImpl,onReady:()=>{ready++},onEvent:()=>{events++}});await f.done(1);assert.equal(ready,1);assert.equal(events,1);});
