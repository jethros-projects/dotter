import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LibraryProviders, libraryProviderCapabilities } from '../src/library-providers.mjs';
import { commands } from '../src/command-sets/library-providers.mjs';
import { v4Commands, v4Help } from '../src/v4-commands.mjs';
import { HELP, parseArgs, run } from '../src/cli.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { Transport } from '../src/transport.mjs';

test('retired save command is absent from declarations, generated registry and help',async()=>{
 assert.equal(Object.hasOwn(commands,'library save-chat-message'),false);
 assert.equal(Object.hasOwn(v4Commands,'library save-chat-message'),false);
 assert.doesNotMatch(HELP,/library save-chat-message/);assert.doesNotMatch(v4Help(),/library save-chat-message/);
 const registry=JSON.parse(await readFile(new URL('../src/v4-registry.json',import.meta.url),'utf8'));
 assert.equal(Object.hasOwn(registry,'library save-chat-message'),false);
});
test('provider capability list does not advertise saved-chat-message creation',()=>{
 assert.equal(libraryProviderCapabilities().supported.includes('saved-chat-messages'),false);
 for(const name of ['image-favorites','conversation-favorites','reference-images'])assert.ok(libraryProviderCapabilities().supported.includes(name));
});
for(const args of [
 ['library','save-chat-message','conversation','message'],
 ['library','save-chat-message','conversation','message','--json'],
 ['library','save-chat-message','--spec','/does-not-exist/private-spec.json'],
 ['library','save-chat-message','--help'],
])test(`retired CLI path ${args.at(-1)} rejects before client creation`,async()=>{
 let clients=0;await assert.rejects(run(args,{createClient:async()=>{clients++;throw new Error('client creation forbidden');},stdout:{write(){}},stderr:{write(){}}}),/Unknown library command/);assert.equal(clients,0);
 assert.throws(()=>parseArgs(args),/Unknown library command/);
});
for(const input of [undefined,null,{}, {conversationId:'conversation',messageId:'message'}, {conversationId:'../bad',messageId:'secret'}])test(`legacy library method is unsupported before auth for ${input===null?'null':typeof input}`,async()=>{
 let authCalls=0,fetchCalls=0;const transport=new Transport({authLoader:async()=>{authCalls++;throw new Error('auth forbidden');},fetchImpl:async()=>{fetchCalls++;throw new Error('network forbidden');}});
 const api=new LibraryProviders({transport});await assert.rejects(api.saveChatMessage(input),{code:'UNSUPPORTED'});assert.equal(authCalls,0);assert.equal(fetchCalls,0);
});
test('legacy method does not inspect input fields or expose their values',async()=>{
 let fieldReads=0;const input={get conversationId(){fieldReads++;throw new Error('private');},get messageId(){fieldReads++;throw new Error('private');}};
 const api=new LibraryProviders({transport:{request(){throw new Error('network forbidden');}}});
 await assert.rejects(api.saveChatMessage(input),e=>e.code==='UNSUPPORTED'&&!e.message.includes('private'));assert.equal(fieldReads,0);
});
test('FullDotClient legacy method is also unsupported without transport access',async()=>{
 let requests=0;const client=new FullDotClient({transport:{request(){requests++;throw new Error('request forbidden');}}});
 await assert.rejects(client.libraryProviders.saveChatMessage({conversationId:'conversation',messageId:'message'}),{code:'UNSUPPORTED'});assert.equal(requests,0);
});
test('conversation favorites and unrelated Library operations remain registered',()=>{
 for(const command of ['library conversation-favorites','library image-favorites add','library image-favorites status','library plan-summary','library deep-research','library delete-permanently','account projects saves create'])assert.ok(v4Commands[command],command);
});
