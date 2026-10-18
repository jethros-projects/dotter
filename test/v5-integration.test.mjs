import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.mjs';
import { parseArgs, run } from '../src/cli.mjs';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;


const auth = async () => ({ accountId: 'account_1', accessToken: 'synthetic-access' });
const buffer = () => ({ text: '', write(text) { this.text += text; } });
const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('Page-comment CLI passes the native page and thread together in one message request', async () => {
  const calls = [], transport = new api.Transport({ authLoader: auth, fetchImpl: async (url, options) => {
    calls.push([url.pathname, options]);
    assert.deepEqual(JSON.parse(options.body).page_context, { page_id: 'page_1', thread_id: 'page_thread_1' });
    return Response.json({ id: 'message_1' });
  } });
  await run(['send','A reply','--room','room_1','--page','page_1','--page-thread','page_thread_1','--key',key], {
    createClient: async () => new api.FullDotClient({ transport }), stdout: buffer(), stderr: buffer()
  });
  assert.equal(calls.length, 1);
  assert.throws(() => parseArgs(['send','reply','--page-thread','thread_1']), /requires --page/);
});
test('native widget SKU and no-store headers are constrained to their exact endpoints', async () => {
  const calls = [], transport = new api.Transport({ authLoader: auth, fetchImpl: async (url, options) => { calls.push([url.pathname, options]); return Response.json({}); } });
  await transport.request('POST','/backend-api/ecosystem/call_mcp',{ headers:{'OAI-Product-Sku':'aeon'}, body:{} });
  await transport.request('GET','/backend-api/flora/browser/qr-code',{ headers:{'Cache-Control':'no-store'} });
  for (const [route, headers] of [
    ['/backend-api/tbo',{'OAI-Product-Sku':'aeon'}],
    ['/backend-api/ecosystem/call_mcp/other',{'OAI-Product-Sku':'aeon'}],
    ['/backend-api/flora/browser/config',{'Cache-Control':'no-store'}],
    ['/backend-api/flora/browser/qr-code',{'Cache-Control':'no-cache'}]
  ]) await assert.rejects(transport.request('GET',route,{headers}),{code:'INVALID_HEADERS'});
  assert.equal(calls.length,2);
});
test('onboarding can use the bounded native timeout and invalid overrides never reach the network', async () => {
  const calls = [], transport = new api.Transport({ authLoader: auth, fetchImpl: async (_url, options) => { calls.push(options); return Response.json({}); } });
  await transport.request('POST','/backend-api/tbo',{body:{},timeoutMs:540000});
  assert.equal(calls[0].timeoutMs,540000);
  for(const timeoutMs of [0,-1,600001,NaN,Infinity,1.5,'540000']) await assert.rejects(transport.request('GET','/backend-api/tbo',{timeoutMs}),{code:'INVALID_ARGUMENT'});
  assert.equal(calls.length,1);
});
test('the real Python helper applies the timeout and rejects invalid values before opening a URL', () => {
  const script = `import contextlib,io,json,runpy,sys,urllib.request
from email.message import Message
request=json.loads(sys.stdin.read()); calls=[]
class Response:
 code=200
 headers=Message()
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,n):return b'{}'
class Opener:
 def open(self,req,timeout):
  calls.append(timeout);return Response()
urllib.request.build_opener=lambda *args:Opener()
sys.stdin=io.StringIO(json.dumps(request)); out=io.StringIO()
with contextlib.redirect_stdout(out):runpy.run_path(sys.argv[1],run_name='__main__')
print(json.dumps({'calls':calls,'envelope':json.loads(out.getvalue())}))`;
  const invoke = timeoutMs => {
    const result=spawnSync('python3',['-I','-c',script,fileURLToPath(new URL('../src/http.py',import.meta.url))],{
      input:JSON.stringify({url:'https://chatgpt.com/backend-api/tbo',method:'POST',headers:{},body:'{}',timeoutMs}),encoding:'utf8',timeout:10000
    });
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  assert.deepEqual(invoke(540000).calls,[540]);
  for(const value of [0,600001,1.5,'540000',true]){const result=invoke(value);assert.deepEqual(result.calls,[]);assert.equal(result.envelope.error,'NETWORK_ERROR');}
});
test('all new workflow clients are exported and constructed without account or network access', () => {
  const client = new api.FullDotClient({ transport:{ request(){throw new Error('Unexpected network');} } });
  for(const [property,type] of Object.entries({onboarding:'DotOnboarding',nativeActions:'DotNativeActions',browserExtras:'DotBrowserExtras',browserAuthNative:'DotBrowserAuthNative'})) assert.ok(client[property] instanceof api[type]);
  assert.equal(typeof api.validateActionForm,'function');
  assert.equal(client.capabilities().version,PACKAGE_VERSION);
});
