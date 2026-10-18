import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ConversationClient, conversationCapabilities } from '../src/conversations.mjs';
import { commands } from '../src/command-sets/conversations.mjs';
import { run } from '../src/cli.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';

const message = (id, role, text, extra = {}) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 10, ...extra });
const conversation = (extra = {}) => ({ conversation_id: 'c1', title: 'A conversation', current_node: 'a1', mapping: {
  root: { id: 'root', parent: null, message: message('system', 'system', 'secret system') },
  u1: { id: 'u1', parent: 'root', message: message('u1', 'user', 'Hello') },
  think: { id: 'think', parent: 'u1', message: message('think', 'assistant', 'private reasoning', { channel: 'analysis' }) },
  a1: { id: 'a1', parent: 'think', message: message('a1', 'assistant', 'Visible response') },
  alt: { id: 'alt', parent: 'u1', message: message('alt', 'assistant', 'Other visible response') },
}, ...extra });
function harness(responses = []) {
  const calls = []; const auth = { accountId: 'acct' };
  const transport = { authLoader: async () => ({ ...auth }), request: async (method, path, options) => {
    calls.push({ method, path, ...options });
    const response = responses.shift(); if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(calls.at(-1)) : response ?? { success: true };
  } };
  return { client: new ConversationClient({ transport }), calls, auth };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('capabilities and command manifest are concrete account-scope methods', () => {
  assert.match(conversationCapabilities().scope, /separate from Dot/);
  for (const entry of Object.values(commands)) assert.equal(typeof ConversationClient.prototype[entry.method], 'function');
  assert.deepEqual(commands['conversation delete'].confirmMatch, [['confirm', 'conversationId']]);
});
test('list sends native filters and keeps only safe metadata', async () => {
  const h = harness([{ items: [{ id: 'c1', title: 'one', mapping: { hidden: 'no' }, summary: 'secret' }, { id: 'c2', hidden: true }], total: 2 }]);
  assert.deepEqual(await h.client.list({ archived: true, starred: false, conversationOrigin: 'tpp', excludeConversationOrigin: 'flora', expand: true, hideSnorlax: false, offset: 3 }), { items: [{ id: 'c1', title: 'one' }], total: 2 });
  assert.deepEqual(h.calls[0].query, { limit: 20, offset: 3, order: 'updated', expand: true, conversation_origin: 'tpp', exclude_conversation_origin: 'flora', hide_snorlax: false, is_archived: true, is_starred: false });
});
test('search discards match snippets and arbitrary nested values', async () => {
  const h = harness([{ items: [{ conversation_id: 'c1', title: 'found', highlight: '<private>', snippet: 'internal text', messages: [message('z','assistant','private')] }], cursor: 'next' }]);
  const r = await h.client.search({ query: 'hello', cursor: 'prev' });
  assert.deepEqual(r, { items: [{ id: 'c1', conversation_id: 'c1', title: 'found' }], cursor: 'next' });
  assert.deepEqual(h.calls[0].query, { query: 'hello', cursor: 'prev' });
});
test('batch uses exact IDs and rejects a mismatched result', async () => {
  const h = harness([[{ id: 'c1', title: 'a' }], [{ id: 'other' }]]);
  assert.deepEqual(await h.client.batch({ conversationIds: ['c1'] }), { items: [{ id: 'c1', title: 'a' }] });
  assert.deepEqual(h.calls[0].body, { conversation_ids: ['c1'] });
  await rejects(h.client.batch({ conversationIds: ['c1'] }), 'INVALID_RESPONSE');
});
test('get follows only selected branch and strips all internal messages', async () => {
  const h = harness([conversation()]); const r = await h.client.get({ conversationId: 'c1' });
  assert.deepEqual(r.messages.map(m => m.id), ['u1', 'a1']);
  assert.equal(JSON.stringify(r).includes('private'), false);
  assert.equal(JSON.stringify(r).includes('Other visible'), false);
});
for (const [name, flags] of Object.entries({ hidden: { hidden: true }, visuallyHidden: { is_visually_hidden_from_conversation: true }, metadataHidden: { metadata: { is_hidden: true } }, metadataAnalysis: { metadata: { channel: 'analysis' } }, recipient: { recipient: 'python' }, tool: { author: { role: 'tool' } }, deleted: { deleted_at: 'now' } })) {
  test(`history strips ${name} messages before JSON output`, async () => {
    const h = harness([{ conversation_id: 'c1', messages: [message('visible','assistant','fine'), message('bad','assistant','private',flags)], page_info: { has_previous_page: false } }]);
    const r = await h.client.history({ conversationId: 'c1' }); assert.deepEqual(r.messages.map(m => m.id), ['visible']);
  });
}
test('history safely projects multimodal text without signed URLs or raw attachments', async () => {
  const h = harness([{ conversation_id: 'c1', messages: [message('m','user','unused', { content: { content_type: 'multimodal_text', parts: ['hi', '::SKIP_COMPLETION::', { content_type: 'image_asset_pointer', file_id: 'file1', asset_pointer: 'https://secret' }, { content_type: 'audio', transcription: 'private'}] } })], page_info: {} }]);
  const result = await h.client.history({ conversationId: 'c1' });
  assert.deepEqual(result.messages[0].files, [{ file_id: 'file1', content_type: 'image_asset_pointer' }]);
  assert.equal(result.messages[0].text, 'hi'); assert.ok(!JSON.stringify(result).includes('secret'));
});
test('history requests native before/num_turns and aggregates without duplicates', async () => {
  const h = harness([
    { conversation_id: 'c1', messages: [message('m2','assistant','two')], page_info: { has_previous_page: true, start_cursor: 'older' } },
    { conversation_id: 'c1', messages: [message('m1','user','one'),message('m2','assistant','two')], page_info: { has_previous_page: false } },
  ]);
  const r = await h.client.historyPages({ conversationId: 'c1', pages: 2, numTurns: 5 });
  assert.deepEqual(r.messages.map(m=>m.id), ['m1','m2']); assert.equal(r.cursor, null);
  assert.equal(h.calls[1].path, '/backend-api/conversations/c1/messages');
  assert.deepEqual(h.calls[1].query, { before: 'older', num_turns: 5, include_has_versions: true });
});
test('secondary history binds an identity-free native message page to its requested conversation', async () => {
  const h = harness([{ messages: [message('older', 'user', 'Earlier message'), message('private', 'assistant', 'Hidden', { channel: 'analysis' })], page_info: { has_previous_page: false } }]);
  const result = await h.client.history({ conversationId: 'c1', before: 'older-cursor', numTurns: 3 });
  assert.deepEqual(result.conversation, { id: 'c1', conversation_id: 'c1' });
  assert.deepEqual(result.messages.map(item => [item.id, item.text]), [['older', 'Earlier message']]);
  assert.equal(result.cursor, null);
  assert.equal(h.calls[0].path, '/backend-api/conversations/c1/messages');
  assert.deepEqual(h.calls[0].query, { before: 'older-cursor', num_turns: 3, include_has_versions: true });
  assert.equal(h.calls[0].expectedAccountId, 'acct');
});
for (const identity of [{ id: 'c1' }, { conversation_id: 'c1' }, { id: 'c1', conversation_id: 'c1' }]) {
  test(`secondary history accepts matching explicit identity ${JSON.stringify(identity)}`, async () => {
    const h = harness([{ ...identity, messages: [message('m1', 'user', 'one')], page_info: { has_previous_page: false } }]);
    const result = await h.client.history({ conversationId: 'c1', before: 'older' });
    assert.equal(result.conversation.id, 'c1');
    assert.deepEqual(result.messages.map(item => item.id), ['m1']);
  });
}
for (const [name, request] of [
  ['initial history', client => client.history({ conversationId: 'c1' })],
  ['initial history with null cursor', client => client.history({ conversationId: 'c1', before: null })],
  ['get', client => client.get({ conversationId: 'c1' })],
]) {
  test(`${name} still requires an explicit conversation identity`, async () => {
    const h = harness([{ messages: [], page_info: { has_previous_page: false } }]);
    await rejects(request(h.client), 'INVALID_RESPONSE');
    assert.equal(h.calls.length, 1);
  });
}
test('history and get reject every explicit mismatched or malformed identity instead of using request binding', async () => {
  const identities = [
    { id: 'other' }, { conversation_id: 'other' },
    { id: 'c1', conversation_id: 'other' }, { id: 'other', conversation_id: 'c1' },
    { id: null }, { conversation_id: null },
    { id: null, conversation_id: 'c1' }, { id: 'c1', conversation_id: null },
    { id: 1 }, { conversation_id: false }, { id: {} }, { conversation_id: [] },
    { id: '' }, { conversation_id: undefined },
  ];
  const requests = [
    client => client.history({ conversationId: 'c1', before: 'older' }),
    client => client.history({ conversationId: 'c1' }),
    client => client.get({ conversationId: 'c1' }),
  ];
  for (const identity of identities) for (const request of requests) {
    const h = harness([{ ...identity, messages: [], page_info: { has_previous_page: false } }]);
    await rejects(request(h.client), 'INVALID_RESPONSE');
    assert.equal(h.calls.length, 1);
  }
});
test('secondary identity omission is not accepted for a missing or malformed message-page envelope', async () => {
  const branch = conversation(); delete branch.conversation_id;
  for (const value of [branch, { messages: [] }, { messages: [], page_info: null }, { messages: [], page_info: [] }, { messages: {}, page_info: {} }]) {
    const h = harness([value]);
    await rejects(h.client.history({ conversationId: 'c1', before: 'older' }), 'INVALID_RESPONSE');
  }
});
test('historyPages retains initial safe metadata and current node when older pages omit them', async () => {
  const h = harness([
    { conversation_id: 'c1', title: 'Keep this title', create_time: 10, update_time: 20, is_archived: false, current_node: 'm2', internal_summary: 'private', messages: [message('m2', 'assistant', 'two')], page_info: { has_previous_page: true, start_cursor: 'older' } },
    { messages: [message('m1', 'user', 'one'), message('m2', 'assistant', 'two'), message('hidden', 'assistant', 'private', { recipient: 'python' })], page_info: { has_previous_page: false } },
  ]);
  const result = await h.client.historyPages({ conversationId: 'c1', pages: 2 });
  assert.deepEqual(result.conversation, { id: 'c1', conversation_id: 'c1', title: 'Keep this title', create_time: 10, update_time: 20, is_archived: false });
  assert.equal(result.currentNodeId, 'm2');
  assert.deepEqual(result.messages.map(item => item.id), ['m1', 'm2']);
  assert.equal(result.cursor, null);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('historyPages clears the current node when an identity-free secondary page explicitly returns null', async () => {
  const h = harness([
    { conversation_id: 'c1', current_node: 'm2', messages: [message('m2', 'assistant', 'two')], page_info: { has_previous_page: true, start_cursor: 'older' } },
    { current_node: null, messages: [message('m1', 'user', 'one')], page_info: { has_previous_page: false } },
  ]);
  const result = await h.client.historyPages({ conversationId: 'c1', pages: 2 });
  assert.equal(result.currentNodeId, null);
  assert.deepEqual(result.messages.map(item => item.id), ['m1', 'm2']);
});
test('historyPages lets explicit later safe metadata and current-node values override earlier ones', async () => {
  const h = harness([
    { conversation_id: 'c1', title: 'Old title', create_time: 10, update_time: 20, is_archived: true, current_node: 'm2', messages: [message('m2', 'assistant', 'two')], page_info: { has_previous_page: true, start_cursor: 'older' } },
    { id: 'c1', title: null, create_time: 0, update_time: 30, is_archived: false, current_node: 'm1', internal_summary: 'private', messages: [message('m1', 'user', 'one')], page_info: { has_previous_page: false } },
  ]);
  const result = await h.client.historyPages({ conversationId: 'c1', pages: 2 });
  assert.deepEqual(result.conversation, { id: 'c1', conversation_id: 'c1', title: null, create_time: 0, update_time: 30, is_archived: false });
  assert.equal(result.currentNodeId, 'm1');
  assert.deepEqual(result.messages.map(item => item.id), ['m1', 'm2']);
});
test('historyPages can start at an explicit cursor with an identity-free secondary page', async () => {
  const h = harness([{ messages: [message('m1', 'user', 'one')], page_info: { has_previous_page: false } }]);
  const result = await h.client.historyPages({ conversationId: 'c1', before: 'older', pages: 2 });
  assert.deepEqual(result.conversation, { id: 'c1', conversation_id: 'c1' });
  assert.equal(result.currentNodeId, null);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/backend-api/conversations/c1/messages');
});
test('identity-free secondary pages still reject malformed pagination cursors', async () => {
  for (const cursor of ['', 1, {}, []]) {
    const h = harness([{ messages: [], page_info: { has_previous_page: true, start_cursor: cursor } }]);
    await rejects(h.client.history({ conversationId: 'c1', before: 'older' }), 'INVALID_RESPONSE');
  }
});
test('history detects repeated page cursor', async () => {
  const page = { conversation_id:'c1', messages:[], page_info:{has_previous_page:true,start_cursor:'same'} };
  const h = harness([page,page]); await rejects(h.client.historyPages({ conversationId:'c1', pages:3 }), 'INVALID_RESPONSE');
  assert.equal(h.calls.length, 2);
});
test('history rejects a mismatched conversation and malformed/cyclic branch', async () => {
  let h = harness([conversation({conversation_id:'c2'})]); await rejects(h.client.get({conversationId:'c1'}), 'INVALID_RESPONSE');
  const value=conversation();value.mapping.root.parent='a1';h=harness([value]);await rejects(h.client.get({conversationId:'c1'}),'INVALID_RESPONSE');
});
test('account is pinned across multi-step calls and checks explicit account', async () => {
  const h=harness([conversation()]);await h.client.get({conversationId:'c1'});h.auth.accountId='other';
  await rejects(h.client.rename({conversationId:'c1',title:'change'}),'ACCOUNT_CHANGED');assert.equal(h.calls.length,1);
  const h2=harness();await rejects(h2.client.list({expectedAccountId:'other'}),'ACCOUNT_CHANGED');assert.equal(h2.calls.length,0);
});
test('account selector is mandatory even when a token could be present', async()=>{
 const h=harness();h.auth.accountId=null;await rejects(h.client.list(),'AUTH_ACCOUNT_REQUIRED');assert.equal(h.calls.length,0);
});
test('each request gets the pinned expectedAccountId',async()=>{
 const h=harness([{items:[]}]);await h.client.list();assert.equal(h.calls[0].expectedAccountId,'acct');
});
test('rename/archive/unarchive/delete use verified native contracts',async()=>{
 const h=harness();await h.client.rename({conversationId:'c1',title:' New '});await h.client.archive({conversationId:'c1'});await h.client.unarchive({conversationId:'c1'});await h.client.delete({conversationId:'c1',confirm:'c1'});
 assert.deepEqual(h.calls.map(c=>[c.method,c.path,c.body]),[
 ['POST','/backend-api/conversation/id/c1/rename',{title:'New'}],['PATCH','/backend-api/conversation/c1',{is_archived:true}],['PATCH','/backend-api/conversation/c1',{is_archived:false}],['DELETE','/backend-api/conversation/id/c1',undefined]]);
});
test('delete requires exact confirmation before any API call',async()=>{
 const h=harness();await rejects(h.client.delete({conversationId:'c1',confirm:true}),'CONFIRMATION_REQUIRED');assert.equal(h.calls.length,0);
});
test('unconfirmed mutation does not claim success or retry',async()=>{
 const h=harness([{}]);await rejects(h.client.rename({conversationId:'c1',title:'New'}),'MUTATION_UNCONFIRMED');assert.equal(h.calls.length,1);
});
test('unpersisted native branch preparation is not offered as a CLI feature',async()=>{
 assert.equal(ConversationClient.prototype.branch,undefined);
 assert.equal(commands['conversation branch'],undefined);
 assert.equal(conversationCapabilities().supported.includes('branch'),false);
 let created=false;
 await assert.rejects(run(['conversation','branch','c1','u1'],{createClient:async()=>{created=true;throw new Error('No API access expected');}}),{code:'USAGE_ERROR'});
 assert.equal(created,false);
});
test('select response verifies an alternate visible assistant node',async()=>{
 const h=harness([conversation(),{success:true}]);const r=await h.client.selectResponse({conversationId:'c1',nodeId:'alt'});
 assert.equal(r.currentNodeId,'alt');assert.deepEqual(h.calls[1].body,{current_node_id:'alt'});
});
test('select response refuses hidden analysis/user nodes before mutation',async()=>{
 for(const nodeId of ['think','u1']){const h=harness([conversation()]);await rejects(h.client.selectResponse({conversationId:'c1',nodeId}),'NOT_VISIBLE');assert.equal(h.calls.length,1);}
});
test('inbox and mark-read expose safe fields and native contracts',async()=>{
 const h=harness([{items:[{id:'i1',conversation_id:'c1',title:'done',raw_messages:['secret']}],cursor:'x'},{success:true},{success:true}]);
 assert.deepEqual(await h.client.inbox({unreadOnly:false,limit:3}),{items:[{id:'i1',conversation_id:'c1',title:'done'}],cursor:'x'});
 await h.client.markRead({itemIds:['i1']});await h.client.clearAsyncStatus({conversationId:'c1'});
 assert.deepEqual(h.calls[1].body,{item_ids:['i1']});assert.deepEqual(h.calls[2].body,{status:null});
});
test('share create validates snapshot and requires confirmation before publication',async()=>{
 const h=harness([conversation(),{share_id:'s1',conversation_id:'c1',current_node_id:'a1',share_url:'https://chatgpt.com/share/s1',mapping:{secret:'no'}}]);
 await rejects(h.client.shareCreate({conversationId:'c1',nodeId:'a1'}),'CONFIRMATION_REQUIRED');assert.equal(h.calls.length,0);
 const r=await h.client.shareCreate({conversationId:'c1',nodeId:'a1',publish:true,confirm:'c1'});
 assert.equal(r.id,'s1');assert.equal(r.publicationRequested,true);assert.ok(!('mapping'in r));
 assert.equal(h.calls[1].path,'/backend-api/share/v2/create');assert.deepEqual(h.calls[1].body,{conversation_id:'c1',current_node_id:'a1',is_anonymous:true});
});
test('draft share uses legacy create and does not silently publish',async()=>{
 const h=harness([conversation(),{share_id:'s1'}]);await h.client.shareCreate({conversationId:'c1',nodeId:'a1',confirm:'c1'});assert.equal(h.calls[1].path,'/backend-api/share/create');
});
test('share create refuses hidden snapshot and moderation denial',async()=>{
 let h=harness([conversation()]);await rejects(h.client.shareCreate({conversationId:'c1',nodeId:'think',confirm:'c1'}),'NOT_VISIBLE');assert.equal(h.calls.length,1);
 h=harness([conversation(),{share_id:'s1',moderation_state:'blocked'}]);await rejects(h.client.shareCreate({conversationId:'c1',nodeId:'a1',confirm:'c1'}),'SHARE_BLOCKED');
});
test('share list/get project only metadata and validate URL',async()=>{
 const h=harness([{items:[{id:'s1',title:'Share',mapping:{secret:'no'}}]},{share_id:'s1',share_url:'https://evil.test/share/s1'}]);
 assert.deepEqual(await h.client.shareList(),{items:[{id:'s1',title:'Share'}]});assert.deepEqual(h.calls[0].query,{order:'created'});
 await rejects(h.client.shareGet({shareId:'s1'}),'INVALID_RESPONSE');
});
test('live owner share snapshot maps the share and backing conversation identities without transcript leakage',async()=>{
 const snapshot=JSON.parse(readFileSync(new URL('./fixtures/live-share-snapshot.redacted.json',import.meta.url),'utf8'));
 const h=harness([snapshot]);
 const value=await h.client.shareGet({shareId:'shared-conversation-1'});
 assert.equal(value.id,'shared-conversation-1');
 assert.equal(value.conversation_id,'source-conversation-1');
 assert.equal(value.current_node_id,'shared-node-1');
 for(const key of ['mapping','linear_conversation','og_description','continue_conversation_url'])assert.equal(key in value,false,key);
 assert.equal(JSON.stringify(value).includes('private fixture'),false);
});
test('owner share snapshot rejects a different share identity',async()=>{
 const h=harness([{conversation_id:'other-share',backing_conversation_id:'source'}]);
 await rejects(h.client.shareGet({shareId:'expected-share'}),'INVALID_RESPONSE');
});
test('owned share rejects source identity disagreement between listing and snapshot',async()=>{
 const h=harness([{items:[{id:'s1',conversation_id:'source-one'}]},{conversation_id:'s1',backing_conversation_id:'source-two'}]);
 await rejects(h.client.shareRevoke({shareId:'s1',confirm:'s1'}),'INVALID_RESPONSE');
 assert.equal(h.calls.every(call=>call.method==='GET'),true);
});
test('share update verifies ownership/source and preserves native snapshot fields',async()=>{
 const h=harness([{items:[{id:'s1'}]},{share_id:'s1',conversation_id:'c1',highlighted_message_id:'u1',is_anonymous:true,is_public:true,is_visible:true,title:'old'},conversation(),{success:true},{share_id:'s1',conversation_id:'c1',current_node_id:'a1',title:'new',is_public:true,is_visible:true}]);
 await h.client.shareUpdate({shareId:'s1',nodeId:'a1',title:'new',confirm:'s1'});
 assert.deepEqual(h.calls[3].body,{current_node_id:'a1',highlighted_message_id:'u1',is_anonymous:true,is_public:true,is_visible:true,title:'new'});
});
test('share mutations never write a link outside the account owned list',async()=>{
 for(const method of ['shareUpdate','shareRevoke']){const h=harness([{items:[]}]);await rejects(h.client[method]({shareId:'s1',nodeId:'a1',confirm:'s1'}),'SHARE_NOT_OWNED');assert.equal(h.calls.length,1);}
});
test('share revoke checks exact confirmation and ownership then deletes once',async()=>{
 const h=harness([{items:[{id:'s1'}]},{share_id:'s1'},'null',new DotError('HTTP_ERROR','Missing',{status:404})]);
 const r=await h.client.shareRevoke({shareId:'s1',confirm:'s1'});assert.equal(r.revoked,true);assert.equal(h.calls[2].method,'DELETE');assert.equal(h.calls[2].path,'/backend-api/share/s1');
 assert.equal(h.calls[2].responseType,'text');assert.equal(h.calls.filter(call=>call.method==='DELETE').length,1);assert.equal(h.calls[3].method,'GET');
});
test('share revoke requires disappearance and preserves uncertain verification without replay',async()=>{
 for(const response of [{share_id:'s1'},new DotError('EDGE_CHALLENGE','Blocked',{status:403})]){
  const h=harness([{items:[{id:'s1'}]},{share_id:'s1'},'',response]);
  await assert.rejects(h.client.shareRevoke({shareId:'s1',confirm:'s1'}),error=>error.code==='MUTATION_UNCONFIRMED'&&error.details.delivery==='unknown');
  assert.equal(h.calls.filter(call=>call.method==='DELETE').length,1);
 }
});
for(const options of [{limit:0},{limit:101},{offset:-1},{order:'invalid'},{expand:'true'},{conversationOrigin:'a\n'}]){
 test(`list validation before auth ${JSON.stringify(options)}`,async()=>{const h=harness();await rejects(h.client.list(options),'INVALID_ARGUMENT');assert.equal(h.calls.length,0);});
}
test('rejects path injection, duplicate ids, malformed counts before requests',async()=>{
 const h=harness();for(const call of [()=>h.client.get({conversationId:'../x'}),()=>h.client.batch({conversationIds:['c1','c1']}),()=>h.client.markRead({itemIds:[]}),()=>h.client.history({conversationId:'c1',numTurns:0}),()=>h.client.search({query:''})])await rejects(call(),'INVALID_ARGUMENT');assert.equal(h.calls.length,0);
});
test('sharing recognizes the native moderation state object',async()=>{
 for (const field of ['has_been_auto_blocked','has_been_auto_moderated','has_been_blocked']) {
  const h=harness([conversation(),{share_id:'s1',moderation_state:{[field]:true}}]);
  await rejects(h.client.shareCreate({conversationId:'c1',nodeId:'a1',confirm:'c1'}),'SHARE_BLOCKED');
 }
});
test('response versions list only visible assistant variants without hidden messages',async()=>{
 const h=harness([conversation()]);const result=await h.client.responses({conversationId:'c1'});
 assert.deepEqual(result.items.map(m=>[m.id,m.selected]),[['a1',true],['alt',false]]);
});
test('response selection follows the first descendant continuation as the native UI does',async()=>{
 const value=conversation();value.mapping.alt.children=['later'];value.mapping.later={id:'later',parent:'alt',message:message('later','user','continue')};
 const h=harness([value,{success:true}]);const result=await h.client.selectResponse({conversationId:'c1',nodeId:'alt'});
 assert.equal(result.currentNodeId,'later');assert.deepEqual(h.calls[1].body,{current_node_id:'later'});
});
test('pin and project moves retain account scope and exact native fields',async()=>{
 const h=harness();await h.client.pin({conversationId:'c1'});await h.client.unpin({conversationId:'c1'});await h.client.moveProject({conversationId:'c1',projectId:'g1'});await h.client.moveProject({conversationId:'c1',root:true});
 assert.deepEqual(h.calls.map(v=>v.body),[{is_starred:true},{is_starred:false},{gizmo_id:'g1'},{gizmo_id:''}]);
 await rejects(h.client.moveProject({conversationId:'c1',root:true,projectId:'g1'}),'INVALID_ARGUMENT');
});

test('share metadata-only update preserves private and hidden state',async()=>{
 const h=harness([{items:[{id:'s1'}]},{share_id:'s1',conversation_id:'c1',is_public:false,is_visible:false,title:'old'},conversation(),{success:true},{share_id:'s1',conversation_id:'c1',current_node_id:'a1',title:'new',is_public:false,is_visible:false}]);
 const result=await h.client.shareUpdate({shareId:'s1',nodeId:'a1',title:'new',confirm:'s1'});
 assert.equal(h.calls[3].body.is_public,false);assert.equal(h.calls[3].body.is_visible,false);
 assert.equal(result.publicationRequested,false);assert.equal(result.visibilityRequested,false);
});
test('explicit share state permits the live owner snapshot to omit visibility without guessing defaults',async()=>{
 const h=harness([{items:[{id:'s1'}]},{share_id:'s1',conversation_id:'c1',is_public:true,title:'old'},conversation(),{success:true},{share_id:'s1',conversation_id:'c1',current_node_id:'a1',title:'new',is_public:true}]);
 const value=await h.client.shareUpdate({shareId:'s1',nodeId:'a1',title:'new',publish:true,visible:true,confirm:'s1'});
 assert.equal(h.calls[3].body.is_public,true);assert.equal(h.calls[3].body.is_visible,true);
 assert.equal(value.publicationRequested,true);assert.equal(value.visibilityRequested,true);
});
test('share update never confuses a successful acknowledgement with verified state',async()=>{
 for(const response of [new DotError('EDGE_CHALLENGE','Blocked',{status:403}),{share_id:'s1',conversation_id:'other',current_node_id:'a1',title:'new',is_public:true}]){
  const h=harness([{items:[{id:'s1'}]},{share_id:'s1',conversation_id:'c1',is_public:true,is_visible:true,title:'old'},conversation(),{success:true},response]);
  await assert.rejects(h.client.shareUpdate({shareId:'s1',nodeId:'a1',title:'new',confirm:'s1'}),error=>error.code==='MUTATION_UNCONFIRMED'&&error.details.delivery==='unknown');
  assert.equal(h.calls.filter(call=>call.method==='PATCH').length,1);
 }
});
test('real transport handles native share PATCH acknowledgement and scalar DELETE body',async()=>{
 const requests=[], snapshot=title=>({conversation_id:'s1',backing_conversation_id:'c1',current_node:'a1',title,is_public:true});
 const responses=[{items:[{id:'s1'}]},snapshot('old'),conversation(),{},snapshot('new'),
  {items:[{id:'s1'}]},snapshot('new'),null,{missing:true}];
 const token=`header.${Buffer.from(JSON.stringify({sub:'user'})).toString('base64url')}.signature`;
 const transport=new Transport({authLoader:async()=>({accountId:'acct',accessToken:token}),fetchImpl:async(url,options)=>{
  requests.push({path:url.pathname,method:options.method,body:options.body});const value=responses.shift();
  return new Response(JSON.stringify(value),{status:responses.length===0?404:200,headers:{'content-type':'application/json'}});
 }});
 const client=new ConversationClient({transport});
 const changed=await client.shareUpdate({shareId:'s1',nodeId:'a1',title:'new',publish:true,visible:true,confirm:'s1'});
 assert.equal(changed.title,'new');assert.equal(changed.publicationRequested,true);
 assert.deepEqual(await client.shareRevoke({shareId:'s1',confirm:'s1'}),{shareId:'s1',revoked:true,confirmed:true});
 assert.equal(requests.filter(x=>x.method==='PATCH').length,1);assert.equal(requests.filter(x=>x.method==='DELETE').length,1);
 assert.equal(responses.length,0);
});
test('share update requires known current visibility and exposes explicit inverse CLI flags',async()=>{
 const h=harness([{items:[{id:'s1'}]},{share_id:'s1',conversation_id:'c1'},conversation()]);
 await rejects(h.client.shareUpdate({shareId:'s1',nodeId:'a1',confirm:'s1'}),'INVALID_RESPONSE');assert.equal(h.calls.length,3);
 assert.deepEqual(commands['conversation shares update'].flags['--unpublish'],{target:'publish',type:'boolean',value:false});
 assert.deepEqual(commands['conversation shares update'].flags['--hide'],{target:'visible',type:'boolean',value:false});
});
