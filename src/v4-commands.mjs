import { readFileSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJsonObject } from './commands.mjs';
import { DotError } from './errors.mjs';
const registry = JSON.parse(readFileSync(new URL('./v4-registry.json', import.meta.url), 'utf8'));
const reserved = new Set(['command','action','definition','set','method','authFile','signal','onEvent','onReady','output','input','__proto__','constructor','prototype']);
const common = { '--auth-file': { target: 'authFile', type: 'path' }, '--json': { target: 'json', type: 'boolean' } };
const safe = (value, label) => { if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new CliError(`${label} requires a value without control characters.`); return value; };
function json(value) {
  if (Buffer.byteLength(value) > 256 * 1024) throw new CliError('JSON input exceeds 256 KiB.', 'INPUT_ERROR');
  try { return JSON.parse(value); } catch { throw new CliError('Input must be valid JSON.', 'INPUT_ERROR'); }
}
function valueOf(value, spec, label) {
  if (spec.type === 'json') return json(value);
  safe(value, label);
  if (spec.type === 'number') {
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER) throw new CliError(`${label} requires a nonnegative number.`);
    return Number(value);
  }
  if (spec.type === 'list') { const items = value.split(',').map(x=>x.trim()); if (items.some(x=>!x) || items.length > 1000) throw new CliError(`${label} requires a nonempty comma-separated list.`); return items; }
  if (['path','jsonFile','textFile','secretPath'].includes(spec.type)) return spec.type === 'secretPath' && value === '-' ? value : path.resolve(value);
  return value;
}
export function parseV4Args(first, rest) {
  const argv = [first, ...rest]; let name;
  for (let n = Math.min(argv.length, 6); n > 0; n--) { const key = argv.slice(0,n).join(' '); if (Object.hasOwn(registry,key)) { name = key; break; } }
  if (!name) return null;
  const definition = registry[name], args = argv.slice(name.split(' ').length);
  if (args.length === 1 && ['--help','-h'].includes(args[0])) return { command: 'v4-help', action: name };
  const flags = { ...definition.flags, ...common,
    ...(definition.specFields ? {'--spec':{target:'specFile',type:'jsonFile'}}:{}),
    ...(definition.stream ? {'--duration':{target:'duration',type:'number'}}:{}) };
  const result = { ...(definition.defaults ?? {}), command: 'v4', action: name };
  const positionals = [], deferred = [], seen = new Set(), provided = new Set();
  for (let i=0;i<args.length;i++) {
    const token=args[i];
    if (token==='--') { positionals.push(...args.slice(i+1)); break; }
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const eq=token.indexOf('='), key=eq<0?token:token.slice(0,eq), spec=flags[key];
    if (!spec) throw new CliError('Unknown option. Run this command with --help.');
    if (seen.has(key)) throw new CliError(`Pass ${key} only once.`); seen.add(key);
    if(provided.has(spec.target))throw new CliError(`Value provided more than once: ${spec.target}.`);provided.add(spec.target);
    if (spec.type==='boolean') {
      if(eq>=0) throw new CliError(`${key} takes no value.`);
      result[spec.target]=Object.hasOwn(spec,'value')?spec.value:true;
    } else {
      const value=eq<0?args[++i]:token.slice(eq+1);
      if (value===undefined || value.startsWith('--')) throw new CliError(`${key} requires a value.`);
      const parsed=valueOf(value,spec,key);
      if (['jsonFile','textFile'].includes(spec.type)) deferred.push({target:spec.target,type:spec.type,file:parsed});
      else result[spec.target]=parsed;
    }
  }
  const min = definition.minPositionals ?? definition.positionals.length;
  if (positionals.length<min || positionals.length>definition.positionals.length) throw new CliError(`${name} requires ${definition.positionals.length} positional argument(s).`);
  positionals.forEach((value,index)=>{const target=definition.positionals[index];if(provided.has(target))throw new CliError(`Value provided more than once: ${target}.`);result[target]=safe(value,'Argument');provided.add(target);});
  result.deferred=deferred;
  result.providedTargets=[...provided];
  for (const target of definition.required ?? []) {
    if (result[target]===undefined && !deferred.some(x=>x.target===target) && !(definition.specFields?.includes(target) && deferred.some(x=>x.target==='specFile'))) throw new CliError(`Missing required value: ${target}.`);
  }
  for(const [confirmation,target] of definition.confirmMatch??[]) if(result[confirmation]!==undefined && result[target]!==undefined && result[confirmation]!==result[target]) throw new CliError('Confirmation must exactly match the selected target.');
  if(result.duration!==undefined && (!Number.isFinite(result.duration)||result.duration<=0||result.duration>86400)) throw new CliError('--duration must be between 0 and 86400 seconds.');
  return result;
}
async function textFile(file) {
  let handle;
  try {
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=await handle.stat(); if(!info.isFile()||info.size>1024*1024) throw new CliError('Text input must be a regular file of at most 1 MiB.','INPUT_ERROR');
    const bytes=Buffer.alloc(1024*1024+1);let size=0;
    while(size<bytes.length){const r=await handle.read(bytes,size,bytes.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}
    if(size>1024*1024)throw new CliError('Text input exceeds 1 MiB.','INPUT_ERROR');
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));if(value.includes('\0'))throw new CliError('Text input cannot contain NUL.','INPUT_ERROR');return value;
  }catch(error){if(error instanceof CliError)throw error;throw new CliError('Could not read UTF-8 text input.','INPUT_ERROR');}
  finally{await handle?.close();}
}
export async function prepareV4Options(options) {
  if(options.command!=='v4')return options;
  const definition=registry[options.action], result={...options};delete result.deferred;delete result.providedTargets;
  for(const field of options.deferred??[]){
    const value=field.type==='jsonFile' ? field.target==='specFile' ? await readJsonObject(field.file) : json(await textFile(field.file)) : await textFile(field.file);
    if(field.target==='specFile'){
      if(Object.keys(value).some(key=>!definition.specFields.includes(key)||reserved.has(key)))throw new CliError('The spec contains an unsupported field.','INPUT_ERROR');
      for(const [key,item]of Object.entries(value)){if(options.providedTargets?.includes(key))throw new CliError(`Value provided more than once: ${key}.`);result[key]=item;}
    }else {if(result[field.target]!==undefined)throw new CliError(`Value provided more than once: ${field.target}.`);result[field.target]=value;}
  }
  for(const target of definition.required??[])if(result[target]===undefined)throw new CliError(`Missing required value: ${target}.`);
  for(const [confirmation,target]of definition.confirmMatch??[])if(result[confirmation]!==result[target])throw new CliError('Confirmation must exactly match the selected target.');
  return result;
}
export function v4Help(action) {
  const names=action?[action]:Object.keys(registry);
  return '\nExtended API commands:\n'+names.map(name=>{
    const d=registry[name], positionals=d.positionals.map((x,index)=>(d.minPositionals??d.positionals.length)<=index?`[${x.toUpperCase()}]`:x.toUpperCase()).join(' ');
    const flags=Object.entries(d.flags).map(([flag,item])=>`${flag}${item.type==='boolean'?'':` ${item.target.toUpperCase()}`}`).join(' | ');
    return `  dotter ${name}${positionals?' '+positionals:''}${d.specFields?' [--spec FILE]':''}\n    ${d.description??''}${flags?'\n    '+flags:''}${d.stream?'\n    --duration SECONDS':''}`;
  }).join('\n')+'\nCommon options: --auth-file PATH, --json.\n';
}
export function isV4Streaming(options){return Boolean(registry[options.action]?.stream);}
export async function runV4Command(client,options,deps={}) {
  const definition=registry[options.action];if(!definition)throw new CliError('Unknown command.');
  const {command,action,authFile,json,deferred,providedTargets,duration,noOpen,...args}=options;
  args.signal=deps.signal;args.input=deps.stdin;
  if(definition.key){
    args[definition.key]??=deps.uuid();
    if(typeof args[definition.key]!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args[definition.key]))throw new CliError('The request key must be a UUID.');
    deps.stderr.write(`Request key: ${args[definition.key]}\n`);
  }
  if(noOpen)args.openBrowser=false;
  const invoke=async()=>{
    if(deps.v4Invoke)return deps.v4Invoke(definition.set,definition.method,args);
    const set=await import(`./command-sets/${definition.set}.mjs`);
    const target=set.createClient(client);
    if(typeof target[definition.method]!=='function')throw new DotError('COMMAND_UNAVAILABLE','The installed command implementation is unavailable.');
    return target[definition.method](args);
  };
  if(!definition.stream)return invoke();
  const controller=new AbortController(),signals=deps.signals??process,abort=()=>controller.abort();
  signals.once('SIGINT',abort);signals.once('SIGTERM',abort);deps.signal?.addEventListener('abort',abort,{once:true});if(deps.signal?.aborted)abort();
  args.signal=controller.signal;args.output=deps.stdout;
  args.onEvent=value=>deps.stdout.write(`${JSON.stringify(value)}\n`);
  args.onReady=value=>deps.stderr.write(`${value?.ready===false?'Connected; waiting for state.':'Ready.'} Ctrl+C to stop.\n`);
  const timer=duration?setTimeout(abort,duration*1000):undefined;
  try{
    const result=await invoke();
    if(result?.stopError||result?.cleanupError)throw new DotError('SESSION_CLEANUP_UNCONFIRMED','The local session ended, but remote cleanup could not be confirmed.',{cleanup:'unconfirmed'});
    return result;
  }catch(error){if(!controller.signal.aborted || error?.name!=='AbortError' && error!==controller.signal.reason)throw error;}
  finally{clearTimeout(timer);signals.removeListener('SIGINT',abort);signals.removeListener('SIGTERM',abort);deps.signal?.removeEventListener('abort',abort);}
}
export const v4Commands=registry;
