import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseArgs, run } from '../src/cli.mjs';
import test from 'node:test';
import { CliError } from '../src/commands.mjs';
import { isV4Streaming, parseV4Args, prepareV4Options, runV4Command, v4Commands, v4Help } from '../src/v4-commands.mjs';

const KEY = 'bcd22c2c-481e-488b-aefa-c3bac9cc60e7';
const buffer = () => ({ text: '', write(value) { this.text += value; return true; } });
function setup(invoke = async () => ({ completed: true })) {
  const calls = [], clientCalls = [], signals = new EventEmitter();
  const deps = { createClient: async options => { clientCalls.push(options); return {}; }, stdout: buffer(), stderr: buffer(), stdin: Readable.from([]), uuid: () => KEY, signals,
    v4Invoke: async (set, method, args) => { calls.push({ set, method, args }); return invoke(set, method, args); } };
  return { calls, deps, signals, clientCalls };
}
async function temporary(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dot-v4-cli-'));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const parse = argv => parseV4Args(argv[0], argv.slice(1));
function sample(spec, target, directory) {
  if (spec.type === 'number') return { argument: '2', value: 2 };
  if (spec.type === 'boolean') return { value: Object.hasOwn(spec, 'value') ? spec.value : true };
  if (spec.type === 'list') return { argument: 'sample_one,sample_two', value: ['sample_one', 'sample_two'] };
  if (spec.type === 'json') return { argument: '{"sample":true}', value: { sample: true } };
  if (spec.type === 'jsonFile') return { argument: path.join(directory, 'object.json'), value: { sample: true } };
  if (spec.type === 'textFile') return { argument: path.join(directory, 'text.txt'), value: 'first line\nsecond line\n' };
  if (['path','secretPath'].includes(spec.type)) return { argument: path.join(directory, `${target}.private`), value: path.join(directory, `${target}.private`) };
  return { argument: `sample_${target}`, value: `sample_${target}` };
}
async function fixture(name, directory) {
  const d = v4Commands[name], argv = name.split(' '), expected = { ...(d.defaults ?? {}) }, used = new Set();
  for (const target of d.positionals) { argv.push(`sample_${target}`); expected[target] = `sample_${target}`; used.add(target); }
  const forced = new Map((d.confirmMatch ?? []).map(([confirm, target]) => [confirm, target]));
  for (const [flag, spec] of Object.entries(d.flags)) {
    if (used.has(spec.target) || spec.target === 'root' && ['directoryId','parentDirectoryId','projectId'].some(key => used.has(key))) continue;
    const item = spec.target === d.key ? { argument: KEY, value: KEY } : sample(spec, spec.target, directory);
    if (forced.has(spec.target)) { item.argument = expected[forced.get(spec.target)] ?? `sample_${forced.get(spec.target)}`; item.value = item.argument; }
    argv.push(flag); if (spec.type !== 'boolean') argv.push(item.argument);
    expected[spec.target] = item.value; used.add(spec.target);
  }
  const additions = {};
  for (const target of d.required ?? []) {
    if (expected[target] !== undefined) continue;
    assert.ok(d.specFields?.includes(target), `${name} cannot supply required ${target}`);
    additions[target] = `sample_${target}`; expected[target] = additions[target];
  }
  if (Object.keys(additions).length) {
    const filename = path.join(directory, 'spec.json'); await writeFile(filename, JSON.stringify(additions)); argv.push('--spec', filename);
  }
  return { argv, expected, definition: d };
}

// Checks the manifest against actual modules without making a network request.
// Read the first balanced argument expression, preserving defaults such as
// randomUUID(), then split the object pattern at top-level commas.
function objectArguments(method) {
  const source = method.toString(), start = source.indexOf('('); if (start < 0) return null;
  let depth = 0, end = start;
  for (; end < source.length; end++) { if (source[end] === '(') depth++; else if (source[end] === ')' && --depth === 0) break; }
  const argument = source.slice(start + 1, end).trim(); if (!argument.startsWith('{')) return null;
  let braces = 0, brackets = 0, parens = 0, quote = null, escaped = false, part = '', fields = [];
  for (const char of argument.slice(1)) {
    if (quote) { part += char; if (escaped) escaped=false; else if(char==='\\')escaped=true; else if(char===quote)quote=null; continue; }
    if (["'",'"','`'].includes(char)) { quote=char;part+=char;continue; }
    if(char==='{')braces++;if(char==='[')brackets++;if(char==='(')parens++;
    if(char==='}' && !braces && !brackets && !parens){fields.push(part);break;}
    if(char==='}')braces--;if(char===']')brackets--;if(char===')')parens--;
    if(char===','&&!braces&&!brackets&&!parens){fields.push(part);part='';}else part+=char;
  }
  if(fields.some(value=>value.trim().startsWith('...'))) return null;
  return new Set(fields.map(value=>value.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]).filter(Boolean));
}

test('v4 registry definitions match concrete client methods and option interfaces', async () => {
  assert.ok(Object.keys(v4Commands).length >= 170);
  const cache = new Map();
  for (const [name, d] of Object.entries(v4Commands)) {
    if (!cache.has(d.set)) cache.set(d.set, (await import(`../src/command-sets/${d.set}.mjs`)).createClient({ transport: { request() { throw new Error('Network request during construction'); } } }));
    const target = cache.get(d.set), method = target[d.method];
    assert.equal(typeof method, 'function', `${name} refers to missing ${d.set}.${d.method}`);
    const accepted = objectArguments(method);
    if (accepted) for (const key of [...d.positionals, ...Object.values(d.flags).map(v=>v.target), ...(d.specFields ?? [])]) assert.ok(accepted.has(key), `${name}: ${d.method} does not accept manifest option ${key}`);
  }
});

for (const [name, definition] of Object.entries(v4Commands)) {
  test(`v4 parses and dispatches: ${name}`, async () => temporary(async directory => {
    await writeFile(path.join(directory,'object.json'), '{"sample":true}');
    await writeFile(path.join(directory,'text.txt'), 'first line\nsecond line\n');
    const { argv, expected } = await fixture(name, directory);
    const fullArgv = [...argv, '--auth-file', './auth.json', '--json'];
    assert.deepEqual(parseArgs(fullArgv), parse(fullArgv));
    const options = await prepareV4Options(parse(fullArgv));
    assert.equal(options.command, 'v4'); assert.equal(options.action, name);
    assert.equal(options.authFile, path.resolve('./auth.json')); assert.equal(options.json, true);
    const { calls, deps, signals, clientCalls } = setup(); deps.signal = new AbortController().signal;
    const result = await run(fullArgv, deps);
    assert.deepEqual(clientCalls, [{ authFile: path.resolve('./auth.json') }]);
    if (!definition.stream) assert.deepEqual(JSON.parse(deps.stdout.text), result);
    assert.deepEqual(result, { completed: true }); assert.equal(calls.length, 1);
    assert.equal(calls[0].set, definition.set); assert.equal(calls[0].method, definition.method);
    const actual = { ...calls[0].args }; assert.equal(actual.input, deps.stdin); delete actual.input;
    if (definition.stream) {
      assert.ok(actual.signal instanceof AbortSignal); assert.equal(actual.output, deps.stdout);
      assert.equal(typeof actual.onEvent, 'function'); assert.equal(typeof actual.onReady, 'function');
      delete actual.signal;delete actual.output;delete actual.onEvent;delete actual.onReady;
      assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
      assert.equal(getEventListeners(deps.signal,'abort').length,0);
    } else { assert.equal(actual.signal,deps.signal);delete actual.signal; }
    if (expected.noOpen === true) { delete expected.noOpen; expected.openBrowser=false; }
    else delete expected.noOpen;
    if(definition.key)expected[definition.key]??=KEY;
    assert.deepEqual(actual, expected);
    assert.equal(isV4Streaming(options),Boolean(definition.stream));
  }));
}

test('v4 help is available without auth, file reads, or calls',async()=>{
 assert.equal(parse(['made-up','thing']),null);
 for(const name of Object.keys(v4Commands)){
  assert.deepEqual(parse([...name.split(' '),'--help']),{command:'v4-help',action:name});
  assert.match(v4Help(name),new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const {deps,calls,clientCalls}=setup(); await run([...name.split(' '),'--help'],deps);
  assert.equal(calls.length,0);assert.equal(clientCalls.length,0);assert.equal(deps.stdout.text,v4Help(name));
 }
});
test('v4 parsing rejects malformed flags and confirmation before invoking',async()=>{
 const invalid=[
 ['conversation','get'],['conversation','get','one','two'],['conversation','get','id','--unknown','secret'],
 ['conversation','get','id','--json=true'],['conversation','get','id','--account'],['conversation','get','id','--account','one','--account','two'],
 ['conversation','get','bad\0id'],['conversation','get','id','--account','bad\nvalue'],
 ['conversation','list','--limit','-1'],['conversation','list','--limit','NaN'],['conversation','list','--limit','Infinity'],['conversation','list','--limit','9007199254740992'],
 ['conversation','delete','id'],['conversation','delete','id','--confirm','other'],['conversation','batch','--ids','one,,two'],
 ['remote','browser','id','--duration','0'],['remote','browser','id','--duration','86401'],
 ['account','notifications','update','--account','a','--updates','invalid-json'],
 ];
 for(const argv of invalid)assert.throws(()=>parse(argv),CliError,JSON.stringify(argv));
});
test('v4 supports equals syntax and literal option-shaped arguments after --',()=>{
 assert.equal(parse(['conversation','list','--limit=3']).limit,3);
 assert.equal(parse(['conversation','get','--','--literal']).conversationId,'--literal');
 assert.throws(()=>parse(['conversation','get','id','--private=do-not-print']),e=>e instanceof CliError&&!e.message.includes('do-not-print'));
});
test('v4 rejects duplicate aliases after deferred JSON preparation',async()=>temporary(async directory=>{
 const file=path.join(directory,'data.json');await writeFile(file,'{"safe":true}');
 await assert.rejects(async()=>prepareV4Options(parse(['account','notifications','update','--account','a','--updates','{}','--file',file])),CliError);
}));
test('v4 validates JSON files, rejects symlinks, and keeps error text private',async()=>temporary(async directory=>{
 const file=path.join(directory,'data.json'),link=path.join(directory,'link.json');await writeFile(file,'{"safe":true}');await symlink(file,link);
 for(const content of ['secret-invalid-json','{"value":"'+ 'x'.repeat(256*1024)+'"}']){
  await writeFile(file,content);
  await assert.rejects(prepareV4Options(parse(['account','notifications','update','--account','a','--file',file])),e=>e instanceof CliError&&!e.message.includes('secret-invalid-json'));
 }
 await writeFile(file,'{"safe":true}');await assert.rejects(prepareV4Options(parse(['account','notifications','update','--account','a','--file',link])),CliError);
 await writeFile(file,'[{"category":"updates"}]');
 assert.deepEqual((await prepareV4Options(parse(['account','notifications','update','--account','a','--file',file]))).updates,[{category:'updates'}]);
}));
test('v4 bounds inline JSON and does not include the rejected content in errors',()=>{
 const content='{"secret":"'+'x'.repeat(256*1024)+'"}';
 assert.throws(()=>parse(['account','notifications','update','--account','a','--updates',content]),e=>e instanceof CliError&&!e.message.includes('secret'));
});
test('v4 spec rejects unsupported control fields and required values remain mandatory',async()=>temporary(async directory=>{
 const file=path.join(directory,'spec.json');
 for(const data of [{method:'delete'},{authFile:'private'},{signal:'replace'},{notSupported:true},{}]){
  await writeFile(file,JSON.stringify(data));
  await assert.rejects(prepareV4Options(parse(['connector','admin','mcp-create','--spec',file])),CliError);
 }
}));
test('v4 text files preserve multiline text and reject invalid UTF-8, NUL, oversized files and symlinks',async()=>temporary(async directory=>{
 const file=path.join(directory,'body.txt'),link=path.join(directory,'link.txt');await writeFile(file,'Hello\nthere\n');await symlink(file,link);
 const argv=filename=>['mail','send','--provider','gmail','--link','link','--subject','subject','--body-file',filename];
 assert.equal((await prepareV4Options(parse(argv(file)))).body,'Hello\nthere\n');
 for(const content of [Buffer.from([0xff]),'bad\0text','x'.repeat(1024*1024+1)]){
  await writeFile(file,content);await assert.rejects(prepareV4Options(parse(argv(file))),CliError);
 }
 await assert.rejects(prepareV4Options(parse(argv(link))),CliError);
}));
test('v4 secretPath options are passed privately and never pre-read by parser or dispatcher',async()=>{
 const filename=path.resolve('missing-credential-do-not-read');
 for(const candidate of ['- ',filename]){
  const secret=candidate.trim();const options=await prepareV4Options(parse(['connector','service-account','api-key','service','connector','--key-file',secret]));
  const {deps,calls}=setup();await runV4Command({},options,deps);
  assert.equal(calls[0].args.keyFile,secret);assert.equal(deps.stderr.text,'');assert.equal(deps.stdout.text,'');
 }
});
test('v4 never retries an uncertain mutation; generated keys are announced first',async()=>{
 const candidates=Object.entries(v4Commands).filter(([,d])=>d.key);
 assert.ok(candidates.length>0);
 for(const [name,d]of candidates)await temporary(async directory=>{
  await writeFile(path.join(directory,'object.json'),'{}');await writeFile(path.join(directory,'text.txt'),'body');
  const {argv}=await fixture(name,directory);
  const keyFlag=Object.entries(d.flags).find(([,f])=>f.target===d.key)?.[0];
  if(keyFlag){const index=argv.indexOf(keyFlag);if(index>=0)argv.splice(index,2);}
  const options=await prepareV4Options(parse(argv));
  let deps,calls;({deps,calls}=setup(async()=>{assert.equal(deps.stderr.text,`Request key: ${KEY}\n`);throw new Error('uncertain delivery');}));
  await assert.rejects(runV4Command({},options,deps),/uncertain delivery/);assert.equal(calls.length,1);assert.equal(calls[0].args[d.key],KEY);
 });
});
test('v4 stream abort removes listeners and emits no invented completion',async()=>{
 const parent=new AbortController();let active;
 const {deps,signals,calls}=setup(async(set,method,args)=>{
  active=args;args.onReady({ready:false});args.onEvent({type:'update',value:1});
  await new Promise(resolve=>args.signal.addEventListener('abort',resolve,{once:true}));throw new DOMException('Aborted','AbortError');
 });deps.signal=parent.signal;
 const running=runV4Command({},parse(['remote','browser','conversation']),deps);
 await new Promise(resolve=>setImmediate(resolve));assert.ok(active);signals.emit('SIGINT');await running;
 assert.equal(calls.length,1);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(getEventListeners(parent.signal,'abort').length,0);
 assert.equal(deps.stdout.text,'{"type":"update","value":1}\n');assert.match(deps.stderr.text,/waiting for state/);
});
test('v4 stream preserves cleanup failures and removes listeners',async()=>{
 for(const result of [{stopError:new Error('stop')},{cleanupError:new Error('cleanup')}]){
  const {deps,signals}=setup(async()=>result);await assert.rejects(runV4Command({},parse(['remote','browser','conversation']),deps),e=>e.code==='SESSION_CLEANUP_UNCONFIRMED');assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
 }
});
test('v4 stream time limit aborts, settles, and clears listeners',async()=>{
 const {deps,signals}=setup(async(set,method,args)=>{await new Promise(resolve=>args.signal.addEventListener('abort',resolve,{once:true}));});
 await runV4Command({},parse(['remote','browser','conversation','--duration','0.005']),deps);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);
});

test('v4 opposite aliases cannot silently override the same field',()=>{
 for(const argv of [
  ['conversation','shares','update','share','node','--confirm','share','--publish','--unpublish'],
  ['conversation','list','--archived','--not-archived'],
  ['conversation','list','--starred','--not-starred'],
  ['conversation','list','--hide-snorlax','--show-snorlax'],
  ['conversation','inbox','list','--unread-only','--all-items'],
 ]) assert.throws(()=>parse(argv),CliError);
});
test('v4 inverse aliases remain false through parsing and dispatch',async()=>{
 for(const [argv,field]of [
 [['conversation','shares','update','share','node','--confirm','share','--unpublish'],'publish'],
 [['conversation','shares','update','share','node','--confirm','share','--hide'],'visible'],
 [['conversation','list','--not-archived'],'archived'],
 [['conversation','list','--not-starred'],'starred'],
 [['conversation','list','--show-snorlax'],'hideSnorlax'],
 [['conversation','inbox','list','--all-items'],'unreadOnly'],
 ]){const {deps,calls}=setup();await run(argv,deps);assert.equal(calls[0].args[field],false);}
});
test('v4 validates local input and required flags before creating an authenticated client',async()=>temporary(async directory=>{
 const file=path.join(directory,'bad.json');await writeFile(file,'bad JSON');
 for(const argv of [
  ['conversation','delete','c1'],
  ['conversation','delete','c1','--confirm','other'],
  ['account','notifications','update','--account','a','--file',file],
 ]){const {deps,calls,clientCalls}=setup();await assert.rejects(run(argv,deps),CliError);assert.equal(clientCalls.length,0);assert.equal(calls.length,0);}
}));

test('v4 rejects invalid request keys before printing or invoking a mutation',async()=>{
 for(const [name,d] of Object.entries(v4Commands).filter(([,definition])=>definition.key)) await temporary(async directory=>{
  await writeFile(path.join(directory,'object.json'),'{}');await writeFile(path.join(directory,'text.txt'),'body');
  const {argv}=await fixture(name,directory);
  const keyFlag=Object.entries(d.flags).find(([,field])=>field.target===d.key)?.[0];
  assert.ok(keyFlag,`${name} exposes its request key`);
  const index=argv.indexOf(keyFlag);assert.ok(index>=0);
  argv[index+1]='malicious-request-key-do-not-print';
  const {deps,calls}=setup();
  await assert.rejects(run(argv,deps),error=>error instanceof CliError&&!error.message.includes('malicious-request-key-do-not-print'));
  assert.equal(calls.length,0);assert.equal(deps.stderr.text,'');assert.equal(deps.stdout.text,'');
  argv.splice(index,2);
  deps.uuid=()=> 'bad-generated-key-do-not-print';
  await assert.rejects(run(argv,deps),CliError);
  assert.equal(calls.length,0);assert.equal(deps.stderr.text,'');assert.equal(deps.stdout.text,'');
 });
});

test('QR CLI commands preserve exact request-card context without accepting raw payloads', async () => {
 for (const action of ['status', 'open']) {
  const { deps, calls } = setup();
  await run(['remote', 'auth', 'qr', action, 'conversation-1', 'challenge-1', '--room', 'room-1', '--message', 'message-1', '--fingerprint', 'fingerprint-1', ...(action === 'open' ? ['--no-open'] : [])], deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].set, 'browser-extras');
  assert.equal(calls[0].method, action === 'open' ? 'qrOpen' : 'qrStatus');
  assert.equal(calls[0].args.roomId, 'room-1');
  assert.equal(calls[0].args.messageId, 'message-1');
  assert.equal(calls[0].args.requestFingerprint, 'fingerprint-1');
  assert.equal(calls[0].args.conversationId, 'conversation-1');
  assert.equal(calls[0].args.challengeId, 'challenge-1');
  if (action === 'open') assert.equal(calls[0].args.openBrowser, false);
  assert.throws(() => parse(['remote', 'auth', 'qr', action, 'conversation-1', 'challenge-1', '--initial-payload', 'private']), CliError);
 }
});
