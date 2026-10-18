import test from 'node:test';
import assert from 'node:assert/strict';
import { LibrarySharing } from '../src/sharing.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { Transport } from '../src/transport.mjs';
import { run } from '../src/cli.mjs';

const ME={principal_type:'user',principal_id:'viewer-test'},OWNER={principal_type:'user',principal_id:'owner-test'};
const accountId='account-test';
const selected=kind=>({accountId,accountUserId:ME.principal_id,resourceId:`${kind}-test`,resourceKind:kind});
const resource=kind=>({resource_type:`library_${kind}`,resource_id:`${kind}-test`});
const caps={direct_sharing_capabilities_version:1,can_manage_access:false,can_request_access:true};
const state=(kind,changes={})=>({resource:resource(kind),owner:{principal:OWNER},viewer:{principal:ME},capabilities:{...caps},...changes});
const request=kind=>({request_id:'request-test',resource:resource(kind),requester:ME,resource_owner:OWNER,recipients:[ME],decisions:[]});
function fixture(responses){const calls=[];const transport={async request(method,route,options){calls.push({method,route,options});const r=responses.shift();if(r instanceof Error)throw r;return structuredClone(r);}};return{api:new LibrarySharing({transport}),calls};}
const blocked=[
 ['owner with otherwise eligible flags',kind=>state(kind,{owner:{principal:ME}})],
 ['observed private owner fixture',kind=>state(kind,{owner:{principal:ME},capabilities:{...caps,can_manage_access:true,can_request_access:false}})],
 ['access manager',kind=>state(kind,{capabilities:{...caps,can_manage_access:true}})],
 ['null manager flag',kind=>state(kind,{capabilities:{...caps,can_manage_access:null}})],
 ['numeric manager flag',kind=>state(kind,{capabilities:{...caps,can_manage_access:0}})],
 ['cannot request access',kind=>state(kind,{capabilities:{...caps,can_request_access:false}})],
 ['missing request flag',kind=>state(kind,{capabilities:{direct_sharing_capabilities_version:1,can_manage_access:false}})],
 ['null request flag',kind=>state(kind,{capabilities:{...caps,can_request_access:null}})],
 ['string request flag',kind=>state(kind,{capabilities:{...caps,can_request_access:'true'}})],
 ['unsupported capability version',kind=>state(kind,{capabilities:{...caps,direct_sharing_capabilities_version:2}})],
 ['missing capability version',kind=>state(kind,{capabilities:{can_manage_access:false,can_request_access:true}})],
 ['missing capabilities',kind=>state(kind,{capabilities:undefined})],
];
for(const kind of ['file','folder']){
 for(const [label,make] of blocked)test(`${kind} requester history blocks ${label} before endpoint`,async()=>{
  const{api,calls}=fixture([make(kind),{requests:[]}]);
  await assert.rejects(api.accessRequests({...selected(kind),side:'requester'}),{code:'SHARING_NOT_PERMITTED'});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.match(calls[0].route,/\/sharing-state$/);
 });
 for (const manager of ['omitted', 'undefined']) test(`${kind} native optional manager flag ${manager} permits eligible requester`,async()=>{
  const capabilities={direct_sharing_capabilities_version:1,can_request_access:true};
  if(manager==='undefined')capabilities.can_manage_access=undefined;
  const{api,calls}=fixture([state(kind,{capabilities}),{requests:[],next_cursor:null}]);
  assert.deepEqual(await api.accessRequests({...selected(kind),side:'requester'}),{requests:[],next_cursor:null});assert.equal(calls.length,2);assert.match(calls[1].route,/\/access-requests\/mine$/);
 });
 test(`${kind} eligible nonowner requester still receives exact history`,async()=>{
  const body={requests:[request(kind)],next_cursor:null};const{api,calls}=fixture([state(kind),body]);
  assert.deepEqual(await api.accessRequests({...selected(kind),side:'requester',cursor:'cursor-test'}),body);
  assert.equal(calls.length,2);assert.equal(calls[1].route,`/backend-api/files/library/${kind==='file'?'files':'directories'}/${kind}-test/access-requests/mine`);
  assert.deepEqual(calls[1].options.query,{cursor:'cursor-test',include_profile_photos:false});assert.equal(calls[1].options.expectedAccountId,accountId);
 });
}
test('fresh state is checked for every requester page after eligibility changes',async()=>{
 const{api,calls}=fixture([state('file'),{requests:[],next_cursor:'next'},state('file',{owner:{principal:ME}}),{requests:[]}]);
 assert.equal((await api.accessRequests({...selected('file'),side:'requester'})).next_cursor,'next');
 await assert.rejects(api.accessRequests({...selected('file'),side:'requester',cursor:'next'}),{code:'SHARING_NOT_PERMITTED'});
 assert.equal(calls.length,3);assert.equal(calls.filter(x=>x.route.endsWith('/mine')).length,1);
});
test('owner-side history keeps its independent capability and owner guard',async()=>{
 const current=state('file',{owner:{principal:ME},capabilities:{direct_sharing_capabilities_version:1,can_manage_access_requests:true}});
 const{api,calls}=fixture([current,{requests:[],next_cursor:null}]);
 assert.deepEqual(await api.accessRequests(selected('file')),{requests:[],next_cursor:null});assert.equal(calls.length,2);assert.match(calls[1].route,/\/access-requests$/);
});
for(const allowed of [true,false])test(`actual CLI requester ${allowed?'dispatches eligible history':'stops ineligible owner'} through production transport`,async()=>{
 const raw=allowed?state('file'):state('file',{owner:{principal:ME},capabilities:{...caps,can_manage_access:true,can_request_access:false}});
 const calls=[];const transport=new Transport({authLoader:async()=>({accountId,accessToken:'test-token'}),fetchImpl:async(url,options)=>{
  calls.push({url:String(url),method:options.method});return new Response(JSON.stringify(calls.length===1?raw:{requests:[],next_cursor:null}),{headers:{'content-type':'application/json'}});
 }});
 const argv=['library','sharing','requests','file-test','--account',accountId,'--user',ME.principal_id,'--side','requester','--json'];
 const client=new FullDotClient({transport});let stdout='';const action=run(argv,{createClient:async()=>client,stdout:{write:x=>{stdout+=x;}},stderr:{write(){}}});
 if(allowed){assert.deepEqual(await action,{requests:[],next_cursor:null});assert.equal(JSON.parse(stdout).requests.length,0);assert.equal(calls.length,2);}
 else{await assert.rejects(action,{code:'SHARING_NOT_PERMITTED'});assert.equal(calls.length,1);assert.equal(stdout,'');}
 assert.ok(calls.every(x=>x.method==='GET'));
});
test('a genuine eligible requester404 remains an error and is not treated as empty',async()=>{
 const error=Object.assign(new Error('not found'),{code:'HTTP_ERROR',details:{status:404}});const{api,calls}=fixture([state('file'),error]);
 await assert.rejects(api.accessRequests({...selected('file'),side:'requester'}),e=>e===error);assert.equal(calls.length,2);
});
test('different response viewer is rejected before any requester-history request',async()=>{
 const{api,calls}=fixture([state('file',{viewer:{principal:OWNER}}),{requests:[]}]);
 await assert.rejects(api.accessRequests({...selected('file'),side:'requester'}),{code:'ACCOUNT_CHANGED'});assert.equal(calls.length,1);
});
