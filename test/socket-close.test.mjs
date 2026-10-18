import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DotLive } from '../src/live.mjs';
import { createWebSocket, WEBSOCKET_CLOSE_GRACE_MS } from '../src/websocket.mjs';
import { socketServer, wsFrame } from './helpers/socket-server.mjs';

const fakeClient = () => ({transport:{authLoader:async()=>({accessToken:'synthetic',accountId:'account'}),request:async()=>({websocket_url:'wss://ws.chatgpt.com/synthetic'})},resolveRoom:async()=> 'room',history:async()=>({messages:[],newestItemId:null})});
async function child(url,mode='cancel') {
  const processHandle=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/socket-close-child.mjs',import.meta.url)),url,mode],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';processHandle.stdout.on('data',data=>stdout+=data);processHandle.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>processHandle.kill('SIGKILL'),4000);
  const result=await new Promise(resolve=>processHandle.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  assert.equal(result.code,0,stderr);assert.equal(result.signal,null);assert.equal(stderr,'');
  return stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

test('default factory is owned while injected WebSocket factories remain unchanged',()=>{
  assert.equal(new DotLive(fakeClient()).webSocketFactory,createWebSocket);
  const injected=()=>null;assert.equal(new DotLive(fakeClient(),{webSocketFactory:injected}).webSocketFactory,injected);
  assert.equal(WEBSOCKET_CLOSE_GRACE_MS,1000);
});

for(const kind of ['no-ack','slow-ack','normal-ack'])test(`cancelled child process closes TCP within grace for ${kind} peer`,{timeout:6000},async()=>{
  const server=await socketServer({onClose:({socket,payload,later})=>{if(kind==='normal-ack')socket.end(wsFrame(8,payload));if(kind==='slow-ack')later(()=>socket.end(wsFrame(8,payload)),2600);}});
  try {const records=await child(server.url);const closed=records.find(r=>r.event==='transport-closed');assert.ok(closed);assert.ok(closed.elapsed<2200,JSON.stringify(records));for(let n=0;n<20&&server.peers.size;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(server.peers.size,0);assert.ok(server.events.includes('client-close'));assert.equal(server.requests.length,1);}
  finally {await server.close();}
});

test('shutdown preserves an already received terminal callback before returning',async()=>{
  const server=await socketServer({onSubscribe:({socket,topic})=>socket.write(wsFrame(1,JSON.stringify([{type:'message',topic_id:topic,payload:{type:'calpico-room-read',payload:{room_id:'room',last_read_at:'now'}}}]))),onClose:({socket,payload})=>socket.end(wsFrame(8,payload))});
  try {const records=await child(server.url,'callback');const done=records.find(r=>r.event==='watch-finished');assert.ok(done.events.indexOf('callback-started')>=0);assert.ok(done.events.indexOf('callback-finished')>done.events.indexOf('callback-started'));assert.ok(records.some(r=>r.event==='transport-closed'));}
  finally {await server.close();}
});

for(const [status,headers,code] of [[401,{},'AUTH_REJECTED'],[403,{},'FORBIDDEN'],[403,{'content-type':'text/html'},'FORBIDDEN_HTML'],[503,{'cf-mitigated':'challenge'},'EDGE_CHALLENGE'],[302,{location:'http://127.0.0.1:1/SHOULD_NOT_FOLLOW'},'REDIRECT_BLOCKED']])test(`handshake ${status}/${code} is typed and not reconnected`,async()=>{
  const server=await socketServer({reject:()=>({status,headers})});let factories=0,sleeps=0;
  try {const live=new DotLive(fakeClient(),{webSocketFactory:()=>{factories++;return createWebSocket(server.url+'?token=SYNTHETIC_SECRET');},sleep:async()=>{sleeps++;throw Error('must not retry');}});
    await assert.rejects(live.watch({roomId:'room'}),error=>error.code===code&&!JSON.stringify(error.toJSON()).includes('SYNTHETIC_SECRET'));
    assert.equal(factories,1);assert.equal(sleeps,0);assert.equal(server.requests.length,1);
  }finally {await server.close();}
});

test('genuine handshake connection loss can reconnect and still cancels cleanly',async()=>{
  let attempts=0;const server=await socketServer({onUpgrade:(_req,socket)=>{if(++attempts===1){socket.destroy();return false;}},onClose:({socket,payload})=>socket.end(wsFrame(8,payload))});let sleeps=0;const controller=new AbortController();
  try {const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url),sleep:async()=>{sleeps++;}});
    await live.watch({roomId:'room',signal:controller.signal,onReady:()=>controller.abort()});assert.equal(attempts,2);assert.equal(sleeps,1);
  }finally {await server.close();}
});

test('oversized native frame is bounded before delivery and does not reconnect',async()=>{
  const server=await socketServer({onSubscribe:({socket})=>socket.write(wsFrame(1,'x'.repeat(1024*1024+1))),onClose:({socket,payload})=>socket.end(wsFrame(8,payload))});let sleeps=0;
  try {const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url),sleep:async()=>{sleeps++;}});
    await assert.rejects(live.watch({roomId:'room'}),{code:'INVALID_STREAM'});assert.equal(sleeps,0);assert.equal(server.requests.length,1);
  }finally {await server.close();}
});

test('owned transport requests no compression and redirects remain disabled',async()=>{
  const server=await socketServer({onClose:({socket,payload})=>socket.end(wsFrame(8,payload))});const controller=new AbortController();
  try {await new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url)}).watch({roomId:'room',signal:controller.signal,onReady:()=>controller.abort()});
    assert.equal(server.requests[0].headers['sec-websocket-extensions'],undefined);
  }finally {await server.close();}
});


test('body-only edge challenge during upgrade stops reconnects without exposing response or URL',async()=>{
  const server=await socketServer({reject:()=>({status:503,headers:{'content-type':'text/html'},body:'<script src="/cdn-cgi/challenge-platform/check.js"></script> SECRET_BODY'})});let sleeps=0;
  try{const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url+'?token=SECRET_URL'),sleep:async()=>{sleeps++;}});
    await assert.rejects(live.watch({roomId:'room'}),error=>error.code==='EDGE_CHALLENGE'&&!JSON.stringify(error.toJSON()).includes('SECRET'));
    assert.equal(sleeps,0);assert.equal(server.requests.length,1);
  }finally{await server.close();}
});

test('oversized upgrade refusal is bounded and is not retried',async()=>{
  const server=await socketServer({reject:()=>({status:503,headers:{'content-type':'text/html'},body:'x'.repeat(65537)})});let sleeps=0;
  try{const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url),sleep:async()=>{sleeps++;}});
    await assert.rejects(live.watch({roomId:'room'}),{code:'INVALID_STREAM'});assert.equal(sleeps,0);assert.equal(server.requests.length,1);
  }finally{await server.close();}
});


test('stalled upgrade refusal times out and destroys its transport without retry',async()=>{
  const server=await socketServer({onUpgrade:(_request,socket)=>{socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\nContent-Length: 999\r\n\r\npartial');return false;}});let sleeps=0;
  try{const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url),sleep:async()=>{sleeps++;}});
    await assert.rejects(live.watch({roomId:'room'}),{code:'INVALID_STREAM'});assert.equal(sleeps,0);assert.equal(server.requests.length,1);
  }finally{await server.close();}
});

test('cancelling the owned socket during connection setup has no unhandled error',async()=>{
  const server=await socketServer({onUpgrade:()=>false});
  try{const socket=createWebSocket(server.url);const closed=new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));socket.close();await closed;assert.equal(socket.readyState,3);}
  finally{await server.close();}
});


test('an ordinary HTTP503 handshake can retry while edge403 remains terminal',async()=>{
  let attempts=0,sleeps=0;const server=await socketServer({reject:()=>++attempts===1?{status:503,headers:{'content-type':'text/plain'},body:'Temporarily unavailable'}:null,onClose:({socket,payload})=>socket.end(wsFrame(8,payload))});
  const controller=new AbortController();
  try{const live=new DotLive(fakeClient(),{webSocketFactory:()=>createWebSocket(server.url),sleep:async()=>{sleeps++;}});
    await live.watch({roomId:'room',signal:controller.signal,onReady:()=>controller.abort()});assert.equal(attempts,2);assert.equal(sleeps,1);
  }finally{await server.close();}
});


test('close during a stalled refusal preserves the actual native close event',async()=>{
  const server=await socketServer({onUpgrade:(_request,socket)=>{socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\nContent-Length: 999\r\n\r\npartial');return false;}});
  try{const socket=createWebSocket(server.url),seen=[];socket.addEventListener('error',event=>seen.push(event.error.code));
    const closed=new Promise(resolve=>socket.addEventListener('close',event=>{seen.push('close');resolve(event);},{once:true}));
    await new Promise(resolve=>setTimeout(resolve,25));socket.close();
    const result=await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(null),1500))]);
    assert.ok(result,'Native close event must survive delayed refusal classification');assert.equal(socket.readyState,3);assert.equal(typeof result.code,'number');
    assert.deepEqual(seen,['INVALID_STREAM','close']);
  }finally{await server.close();}
});


for (const [status, extra, code] of [
  [503, {}, 'INVALID_RESPONSE'],
  [401, {}, 'AUTH_REJECTED'],
  [403, {}, 'FORBIDDEN_HTML'],
  [503, { 'cf-mitigated': 'challenge' }, 'EDGE_CHALLENGE'],
  [503, { 'content-encoding': 'identity, gzip' }, 'INVALID_RESPONSE'],
]) test(`encoded upgrade refusal ${status}/${code} is never parsed or reconnected`, async () => {
  const server = await socketServer({ reject: () => ({ status,
    headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', ...extra },
    body: gzipSync('<script src="/cdn-cgi/challenge-platform/check.js"></script> SECRET_BODY'),
  }) });
  let sleeps = 0;
  try {
    const live = new DotLive(fakeClient(), { webSocketFactory: () => createWebSocket(server.url + '?token=SECRET_URL'), sleep: async () => { sleeps++; } });
    await assert.rejects(live.watch({ roomId: 'room' }), error => error.code === code && !JSON.stringify(error.toJSON()).includes('SECRET'));
    assert.equal(sleeps, 0); assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});
