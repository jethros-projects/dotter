import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Transport} from '../src/transport.mjs';
import {pythonFetch} from '../src/http.mjs';
import {DotLibrary} from '../src/library.mjs';

const helper=fileURLToPath(new URL('../src/http.py',import.meta.url));
const missing=Buffer.from('{"detail":"Not Found"}');
// Real HTTP bytes travel over loopback. Only HTTPSConnection's destination is
// replaced, after the production helper has checked the first-party URL.
const harness=String.raw`
import base64,contextlib,faulthandler,http.client,http.server,io,json,runpy,socketserver,sys,threading,urllib.request
c=json.loads(sys.argv[2]);calls=[]
# A loopback fixture must not discover OS or environment proxies.
urllib.request.getproxies=lambda:{}
faulthandler.dump_traceback_later(5)
# HTTPServer's default bind performs a reverse DNS lookup, even for loopback.
class LocalHTTPServer(http.server.HTTPServer):
 def server_bind(self):
  socketserver.TCPServer.server_bind(self)
  self.server_name,self.server_port='localhost',self.server_address[1]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):self.respond()
 def do_POST(self):self.respond()
 def respond(self):
  if self.headers.get('Content-Length'):self.rfile.read(int(self.headers['Content-Length']))
  calls.append({'method':self.command,'path':self.path})
  self.send_response(c['status'])
  for k,v in c['headers']:self.send_header(k,str(v))
  self.end_headers()
  try:self.wfile.write(base64.b64decode(c['body']))
  except (BrokenPipeError,ConnectionResetError):pass
server=LocalHTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=0.01),daemon=True);thread.start()
class LocalHTTPSConnection(http.client.HTTPConnection):
 def __init__(self,host,timeout=30,**kwargs):super().__init__('127.0.0.1',server.server_port,timeout=timeout)
http.client.HTTPSConnection=LocalHTTPSConnection
out=io.StringIO()
try:
 with contextlib.redirect_stdout(out):runpy.run_path(sys.argv[1],run_name='__main__')
finally:server.shutdown();server.server_close();thread.join()
faulthandler.cancel_dump_traceback_later()
sys.stdout.write(out.getvalue());sys.stderr.write(json.dumps(calls))
`;
const response=(headers,status=404,body=missing)=>({status,headers:[['Content-Type','application/json'],...headers],body:body.toString('base64')});
function client(responses){
 const pending=[],calls=[],wire=[];
 const transport=new Transport({authLoader:async()=>({accountId:'synthetic-account',accessToken:'synthetic-token'}),fetchImpl:(url,options)=>pythonFetch(url,options,{spawnImpl:(_cmd,_args,childOptions)=>{
  calls.push({method:options.method,path:new URL(url).pathname});assert.ok(responses.length,'Unexpected second request');
  const c=spawn('python3',['-I','-c',harness,helper,JSON.stringify(responses.shift())],{...childOptions,stdio:['pipe','pipe','pipe'],timeout:10000,killSignal:'SIGKILL'});let audit='';c.stderr.on('data',v=>{audit=(audit+v).slice(0,16384);});pending.push(new Promise((resolve,reject)=>c.once('close',(code,signal)=>{
   if(signal||audit.startsWith('Timeout ('))console.error(`Loopback Python fixture stopped (${signal??code}):\n${audit}`);
   try{wire.push(...JSON.parse(audit));resolve();}catch(e){reject(e);}
  })));return c;
 }} )});
 return{transport,calls,async done(expected=1){await Promise.all(pending);assert.equal(calls.length,expected);assert.equal(wire.length,expected);}};
}
const invalidHeaders=[
 ['duplicate-identical',[['Content-Length',missing.length],['Content-Length',missing.length]]],
 ['duplicate-conflicting',[['Content-Length',missing.length],['Content-Length',missing.length+99]]],
 ['comma-list',[['Content-Length',`${missing.length}, ${missing.length}`]]],
 ['negative',[['Content-Length','-1']]],
 ['noninteger',[['Content-Length','not-a-length']]],
 ['fraction',[['Content-Length','21.0']]],
 ['length-overflow',[['Content-Length','9'.repeat(5000)]]],
 ['length-and-transfer',[['Content-Length',missing.length],['Transfer-Encoding','chunked']]],
];
for(const status of [404,410])for(const[name,headers]of invalidHeaders)test(`real loopback ${status} rejects ${name} framing before absence`,async()=>{const body=name==='length-and-transfer'?Buffer.concat([Buffer.from(missing.length.toString(16)+'\r\n'),missing,Buffer.from('\r\n0\r\n\r\n')]):missing;const f=client([response(headers,status,body)]);await assert.rejects(f.transport.request('GET','/backend-api/framing'),{code:'NETWORK_ERROR'});await f.done();});
test('ambiguous404 cannot trigger the actual Library node fallback',async()=>{const f=client([response([['Content-Length',missing.length],['Content-Length',999]]),response([['Content-Length',2]],200,Buffer.from('{}'))]);await assert.rejects(new DotLibrary({transport:f.transport}).get({fileId:'synthetic-file'}),{code:'NETWORK_ERROR'});await f.done();});
for(const[status,code]of [[401,'AUTH_REJECTED'],[403,'FORBIDDEN']])test(`malformed framing preserves known auth ${status}`,async()=>{const f=client([response([['Content-Length','bad']],status)]);await assert.rejects(f.transport.request('GET','/backend-api/framing'),{code});await f.done();});
test('challenge header wins over duplicate Content-Length',async()=>{const f=client([response([['Content-Length',missing.length],['Content-Length',999],['CF-Mitigated','challenge']])]);await assert.rejects(f.transport.request('GET','/backend-api/framing'),{code:'EDGE_CHALLENGE'});await f.done();});
test('valid Content-Length with optional whitespace preserves binary bytes',async()=>{const b=Buffer.from([0,255,1,0,127]),f=client([response([['Content-Length',` ${b.length} `]],200,b)]);assert.deepEqual(await f.transport.requestBytes('GET','/backend-api/framing'),b);await f.done();});
test('valid chunked framing without Content-Length remains supported',async()=>{const json=Buffer.from('{"ok":true}'),body=Buffer.concat([Buffer.from(json.length.toString(16)+'\r\n'),json,Buffer.from('\r\n0\r\n\r\n')]),f=client([response([['Transfer-Encoding','chunked']],200,body)]);assert.deepEqual(await f.transport.request('GET','/backend-api/framing'),{ok:true});await f.done();});
test('close-delimited response without length stays valid',async()=>{const f=client([response([],200,Buffer.from('{"ok":true}'))]);assert.deepEqual(await f.transport.request('GET','/backend-api/framing'),{ok:true});await f.done();});
test('ambiguous write response keeps delivery unknown and is never retried',async()=>{const f=client([response([['Content-Length',missing.length],['Content-Length',missing.length]],200)]);await assert.rejects(f.transport.request('POST','/backend-api/framing',{body:{}}),e=>e.code==='NETWORK_ERROR'&&e.details.delivery==='unknown');await f.done();});
