import test from 'node:test';
import assert from 'node:assert/strict';
import {LibraryProviders} from '../src/library-providers.mjs';
import {FullDotClient} from '../src/advanced.mjs';
import {run} from '../src/cli.mjs';

const nested={id:'nested-record-id',file_id:'file-underlying',library_item_id:'libfile-usable',kind:'library_file',name:'A snapshot',library_artifact_type:'chat_message_snapshot'};
const hit=payload=>({id:'outer-search-hit',title:'A snapshot',source_type:'library',payload});
const api=items=>new LibraryProviders({transport:{async request(){return{items,cursor:null,partial_results:false};}}});
test('nested global-search payload preserves its usable Library ID separately from hit and record IDs',async()=>{
 const out=await api([hit({library_file:nested})]).globalSearch({query:'snapshot'});
 assert.equal(out.items[0].id,'outer-search-hit');assert.equal(out.items[0].payload.library_file.library_item_id,'libfile-usable');
 assert.equal(out.items[0].payload.library_file.id,'nested-record-id');assert.equal(out.items[0].payload.library_file.file_id,'file-underlying');
});
test('preserving the nested Library ID does not spread private nested response fields',async()=>{
 const out=await api([hit({library_file:{...nested,token:'secret',signed_url:'https://private',content_url:'https://private',raw_messages:['private'],metadata:{internal:true}}})]).globalSearch({query:'snapshot'});
 assert.deepEqual(out.items[0].payload.library_file,nested);
});
test('flat and nested search payloads retain their respective Library IDs without conflation',async()=>{
 const out=await api([hit({library_item_id:'libfile-flat'}),{...hit({library_file:nested}),id:'outer-second'}]).globalSearch({query:'snapshot'});
 assert.equal(out.items[0].payload.library_item_id,'libfile-flat');assert.equal(out.items[0].payload.library_file,undefined);
 assert.equal(out.items[1].payload.library_file.library_item_id,'libfile-usable');assert.equal(out.items[1].payload.library_item_id,undefined);
});
test('an absent nested Library ID is not fabricated from another ID',async()=>{
 const {library_item_id,...other}=nested;const out=await api([hit({library_file:other})]).globalSearch({query:'snapshot'});
 assert.equal(Object.hasOwn(out.items[0].payload.library_file,'library_item_id'),false);
});
test('hidden nested payloads remain omitted entirely',async()=>{
 const out=await api([hit({library_file:{...nested,is_hidden:true}})]).globalSearch({query:'snapshot'});assert.deepEqual(out.items,[]);
});
test('oversized or structured nested ID fields are not exposed',async()=>{
 for(const library_item_id of ['x'.repeat(16385),{token:'private'},['private']]){const out=await api([hit({library_file:{...nested,library_item_id}})]).globalSearch({query:'snapshot'});assert.equal(Object.hasOwn(out.items[0].payload.library_file,'library_item_id'),false);}
});
test('actual global-search CLI JSON exposes only the distinct safe nested Library ID',async()=>{
 const client=new FullDotClient({transport:{async request(){return{items:[hit({library_file:{...nested,token:'secret'}})],cursor:null,partial_results:false};}}});let stdout='';
 const out=await run(['library','global-search','snapshot','--json'],{createClient:async()=>client,stdout:{write:x=>{stdout+=x;}},stderr:{write(){}}});
 assert.deepEqual(JSON.parse(stdout),out);assert.equal(out.items[0].id,'outer-search-hit');assert.equal(out.items[0].payload.library_file.library_item_id,'libfile-usable');assert.equal(out.items[0].payload.library_file.token,undefined);
});
