import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { CliError, readJsonObject } from './commands.mjs';
import { DotError } from './errors.mjs';

const s = target => ({ type: 'string', target });
const b = target => ({ type: 'boolean', target });
const n = target => ({ type: 'number', target });
const file = target => ({ type: 'file', target });
const common = { '--auth-file': file('authFile'), '--json': b('json') };
const dot = { '--dot': s('dotId') }, room = { '--room': s('roomId') }, thread = { '--thread': s('threadId') };
const paging = { '--limit': n('limit'), '--cursor': s('cursor') };
const confirmDot = { '--confirm': s('confirmDotId') };
const spec = (module, method, positionals = [], flags = {}, required = [], extra = {}) => ({ module, method, positionals, flags, required, ...extra });
const routes = {
  'room': spec('client', 'room', [], room),
  'typing': spec('client', 'typing', [], room),
  'prepare': spec('client', 'prepare', [], room),
  'task-subscription': spec('client', 'taskSubscription', ['taskId'], room),
  'dot create': spec('lifecycle', 'create', ['name'], { '--spec': file('specFile') }),
  'dot delete': spec('lifecycle', 'remove', ['dotId'], confirmDot, ['confirmDotId']),
  'dot primary': spec('lifecycle', 'setPrimary', ['dotId']),
  'dot clear-primary': spec('lifecycle', 'clearPrimary', [], { '--generation': s('generation'), '--confirm': b('confirm') }, ['generation', 'confirm']),
  'dot avatar': spec('lifecycle', 'avatar', ['dotId'], { '--spec': file('specFile') }, ['specFile']),
  'dot avatar-upload': spec('lifecycle', 'uploadAvatarSnapshot', ['file'], { '--manifest': file('manifestFile') }),
  'dot ensure-room': spec('lifecycle', 'ensureRoom', [], dot),
  'dot root': spec('lifecycle', 'rootThread', [], dot),
  'dot reboot': spec('lifecycle', 'reboot', [], { ...dot, ...confirmDot }, ['confirmDotId']),
  'environment status': spec('lifecycle', 'environmentStatus', [], { ...dot, ...thread }),
  'environment recreate': spec('lifecycle', 'recreateEnvironment', [], { ...dot, ...thread, ...confirmDot }, ['confirmDotId']),
  'computer list': spec('lifecycle', 'listComputers', [], { ...dot, ...thread }),
  'computer connect': spec('lifecycle', 'connectComputer', ['environmentId'], { ...dot, ...thread }),
  'computer replace': spec('lifecycle', 'replaceComputer', ['environmentId'], { ...dot, ...thread, '--confirm': s('confirmEnvironmentId') }, ['confirmEnvironmentId']),
  'computer disconnect': spec('lifecycle', 'disconnectComputer', ['environmentId'], { ...dot, ...thread, '--confirm': s('confirmEnvironmentId') }, ['confirmEnvironmentId']),
  'activity list': spec('lifecycle', 'activity', [], { ...dot, ...paging }),
  'activity watch': spec('live', 'activity', [], { ...dot, '--duration': n('duration'), '--no-reconnect': b('noReconnect') }, [], { stream: true }),
  'activity room': spec('live', 'roomLive', [], { ...room, '--duration': n('duration'), '--no-reconnect': b('noReconnect') }, [], { stream: true }),
  'events watch': spec('live', 'watch', [], { ...room, '--all': b('all'), '--task': s('taskId'), '--duration': n('duration'), '--no-reconnect': b('noReconnect') }, [], { stream: true }),
  'task-events watch': spec('live', 'taskEvents', [], { ...dot, '--task': s('taskId'), '--duration': n('duration'), '--no-reconnect': b('noReconnect') }, [], { stream: true }),
  'doctor check-in': spec('lifecycle', 'doctorCheckIn', [], thread, ['threadId']),
  'doctor setup': spec('lifecycle', 'doctorSetup', [], { ...thread, '--confirm': b('confirm') }, ['threadId', 'confirm']),
  'safety review': spec('lifecycle', 'safetyReview', [], dot),
  'safety resume': spec('lifecycle', 'resumeReviewed', [], { ...dot, ...thread, ...confirmDot, '--fingerprint': s('reviewFingerprint') }, ['reviewFingerprint', 'confirmDotId']),
  'email-channel status': spec('channels', 'emailStatus', [], dot),
  'email-channel options': spec('channels', 'emailOptions', [], dot),
  'email-channel claim': spec('channels', 'claimEmail', [], { ...dot, '--local-part': s('localPart'), '--domain': s('domain'), '--consent': b('acceptedConsent') }, ['localPart', 'domain', 'acceptedConsent']),
  'email-channel link': spec('channels', 'linkEmail', ['inboxId'], { ...dot, '--consent': b('acceptedConsent') }, ['acceptedConsent']),
  'email-channel unlink': spec('channels', 'removeEmail', [], { ...dot, '--confirm': b('confirm') }, ['confirm']),
  'meeting start': spec('channels', 'startMeeting', ['meetingUrl'], { ...dot, '--key': s('idempotencyKey') }, [], { key: 'idempotencyKey' }),
  'voice chat': spec('voice', 'runVoiceChat', [], { ...dot, '--root-thread': s('rootThreadId'), '--instant-connect': b('instantConnect'), '--listen-only': b('listenOnly'), '--no-open': b('noOpen') }, [], { stream: true }),
  'voice allocate': spec('voice', 'allocateVoiceCall', [], { ...dot, '--root-thread': s('rootThreadId'), '--sdp-file': file('sdpFile'), '--instant-connect': b('instantConnect') }, ['sdpFile']),
  'voice attach': spec('voice', 'attachVoiceCall', ['callId'], dot),
  'voice stop': spec('voice', 'stopVoiceCall', ['callId'], dot),
  'routine threads': spec('extras', 'executionThreads', ['routineId'], paging),
  'routine mark-read': spec('extras', 'markRunRead', ['routineId'], { '--run': s('runId') }, ['runId']),
  'routine latest': spec('extras', 'latestRun', ['routineId']),
  'routine batch': spec('extras', 'batchStatus', ['routineId']),
  'routine flush-batch': spec('extras', 'flushBatch', ['routineId'], { '--key': s('requestId') }, [], { key: 'requestId' }),
  'routine policy': spec('extras', 'schedulePolicy', [], { '--service-account': s('serviceAccountId') }),
  'connector info': spec('extras', 'connectorDetails', ['connectorId']),
  'connector health': spec('extras', 'connectorHealth', ['connectorId'], { '--link': s('linkId') }),
  'connection info': spec('connections', 'get', ['connectorId']),
  'connection status': spec('connections', 'status', ['connectorId'], { '--link': s('linkId') }),
  'connection oauth': spec('connections', 'startOAuth', ['connectorId'], { '--spec': file('specFile') }),
  'connection reauthorize': spec('connections', 'reauthorize', ['connectorId'], { '--link': s('linkId'), '--spec': file('specFile') }, ['linkId']),
  'connection complete': spec('connections', 'completeOAuth', ['connectorId'], { '--redirect-file': file('redirectFile') }, ['redirectFile']),
  'connection api-key': spec('connections', 'linkApiKey', ['connectorId'], { '--key-file': file('keyFile'), '--spec': file('specFile') }, ['keyFile']),
  'connection no-auth': spec('connections', 'linkNoAuth', ['connectorId']),
  'connection unlink': spec('connections', 'unlink', ['connectorId'], { '--link': s('linkId'), '--confirm': b('confirm') }, ['linkId', 'confirm']),
  'library browse': spec('library', 'browse', [], { '--directory': s('directoryId'), '--query': s('query'), '--cursor': s('cursor'), '--category': s('category'), '--folders-only': b('foldersOnly') }),
  'library search': spec('library', 'search', [], { '--query': s('query'), ...paging, '--category': s('category'), '--trash': b('trash') }),
  'library get': spec('library', 'get', ['fileId'], { '--include-trashed': b('includeTrashed') }),
  'library rename': spec('library', 'rename', ['fileId', 'name']),
  'library move': spec('library', 'move', ['fileId'], { '--directory': s('directoryId') }, ['directoryId']),
  'library trash': spec('library', 'trash', ['fileId'], { '--confirm': s('confirm') }, ['confirm']),
  'library restore': spec('library', 'restore', ['fileId']),
  'library versions': spec('library', 'versions', ['fileId'], paging),
  'library restore-version': spec('library', 'restoreVersion', ['fileId'], { '--version': n('version'), '--expected-version': n('expectedCurrentVersion'), '--confirm': s('confirm') }, ['version', 'expectedCurrentVersion', 'confirm']),
  'library favorites': spec('library', 'favorites', [], paging),
  'library favorite': spec('library', 'favorite', ['fileId']),
  'library unfavorite': spec('library', 'unfavorite', ['favoriteId']),
  'library favorite-status': spec('library', 'favoriteStatus', ['fileIds']),
  'library usage': spec('library', 'storageUsage'),
  'library directory-path': spec('library', 'directoryPath', ['directoryId']),
  'library rename-directory': spec('library', 'renameDirectory', ['directoryId', 'name']),
  'library move-directory': spec('library', 'moveDirectory', ['directoryId'], { '--parent': s('parentDirectoryId') }, ['parentDirectoryId']),
};
for (const [name, definition] of Object.entries(routes)) {
  if (name.startsWith('connection ')) definition.flags['--account'] = s('expectedAccountId');
}
const prefixes = new Set(Object.keys(routes).map(key => key.split(' ')[0]).filter(prefix => !['routine'].includes(prefix)));

export const V3_HELP = `
Dot lifecycle and runtime:
  dotter dot create NAME [--spec JSON_FILE]
  dotter dot delete ID --confirm ID
  dotter dot primary ID
  dotter dot clear-primary --generation VALUE --confirm
  dotter dot avatar ID --spec JSON_FILE
  dotter dot avatar-upload FILE [--manifest JSON_FILE]
  dotter dot ensure-room|root [--dot ID]
  dotter dot reboot [--dot ID] --confirm ID
  dotter environment status [--dot ID] [--thread ID]
  dotter environment recreate [--dot ID] [--thread ID] --confirm ID
  dotter computer list [--dot ID] [--thread ID]
  dotter computer connect ENV_ID [--dot ID] [--thread ID]
  dotter computer replace|disconnect ENV_ID --confirm ENV_ID [--dot ID] [--thread ID]
  dotter doctor check-in --thread ID
  dotter doctor setup --thread ID --confirm
  dotter safety review [--dot ID]
  dotter safety resume [--dot ID] --fingerprint VALUE --confirm ID

Live events and room state:
  dotter room|typing|prepare [--room ID]
  dotter task-subscription TASK_ID [--room ID]
  dotter events watch [--room ID | --all] [--task ID] [--duration SECONDS] [--no-reconnect]
  dotter task-events watch [--dot ID] [--task ID] [--duration SECONDS] [--no-reconnect]
  dotter activity list [--dot ID] [--cursor CURSOR] [--limit N]
  dotter activity watch [--dot ID] [--duration SECONDS] [--no-reconnect]
  dotter activity room [--room ID] [--duration SECONDS] [--no-reconnect]

Email, meetings and voice:
  dotter email-channel status|options [--dot ID]
  dotter email-channel claim --local-part NAME --domain DOMAIN --consent [--dot ID]
  dotter email-channel link INBOX_ID --consent [--dot ID]
  dotter email-channel unlink --confirm [--dot ID]
  dotter meeting start GOOGLE_MEET_URL [--dot ID] [--key UUID]
  dotter voice chat [--dot ID] [--root-thread ID] [--listen-only] [--no-open]
  dotter voice allocate --sdp-file FILE [--dot ID] [--root-thread ID]
  dotter voice attach|stop CALL_ID [--dot ID]

More routines and connections:
  dotter routine threads ID [--cursor CURSOR] [--limit N]
  dotter routine mark-read ID --run RUN_ID
  dotter routine latest|batch ID
  dotter routine flush-batch ID [--key UUID]
  dotter routine policy [--service-account ID]
  dotter connector info|health ID [--link ID (health only)]
  dotter connection info ID
  dotter connection status ID [--link ID]
  dotter connection oauth ID [--spec JSON_FILE]
  dotter connection reauthorize ID --link ID [--spec JSON_FILE]
  dotter connection complete ID --redirect-file FILE_OR_DASH
  dotter connection api-key ID --key-file FILE_OR_DASH [--spec JSON_FILE]
  dotter connection no-auth ID
  dotter connection unlink ID --link ID --confirm

Account file library:
  dotter library browse [--directory ID] [--query TEXT] [--category TYPE] [--folders-only]
  dotter library search [--query TEXT] [--trash] [--limit N] [--cursor CURSOR]
  dotter library get FILE_ID [--include-trashed]
  dotter library rename FILE_ID NAME
  dotter library move FILE_ID --directory ID
  dotter library trash FILE_ID --confirm FILE_ID
  dotter library restore FILE_ID
  dotter library versions FILE_ID [--limit N] [--cursor CURSOR]
  dotter library restore-version FILE_ID --version N --expected-version N --confirm FILE_ID
  dotter library favorites|usage
  dotter library favorite FILE_ID
  dotter library unfavorite FAVORITE_ID
  dotter library favorite-status FILE_ID,FILE_ID
  dotter library directory-path DIRECTORY_ID
  dotter library rename-directory DIRECTORY_ID NAME
  dotter library move-directory DIRECTORY_ID --parent ID

Live commands emit NDJSON. task-events watches native task-state updates for
one Dot; events --task watches that task's room messages. A task-resync event
indicates that task-list reconciliation is needed, not an empty task list.
Explicit confirmation flags apply to the named
command only; they are not a global bypass. Connection secrets are read from
files or stdin, never passed as command arguments. All connection commands
accept --account ID to pin the account returned by the OAuth start command.
`;

export function parseV3Args(first, rest) {
  let key = first, args = rest;
  if (!Object.hasOwn(routes, key)) { key = `${first} ${rest[0]}`; args = rest.slice(1); }
  if (!Object.hasOwn(routes, key)) {
    if (prefixes.has(first)) {
      if (rest.length === 1 && ['--help', '-h'].includes(rest[0])) return { command: 'help' };
      throw new CliError(`Unknown ${first} command. Run dotter --help.`);
    }
    return null;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  const definition = routes[key], flags = { ...common, ...definition.flags }, result = { command: 'v3', action: key }, positions = [], seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') { positions.push(...args.slice(index + 1)); break; }
    if (!token.startsWith('-')) { positions.push(token); continue; }
    const equals = token.indexOf('='), flag = equals < 0 ? token : token.slice(0, equals), definition = flags[flag];
    if (!definition) throw new CliError('Unknown option. Run dotter --help.');
    if (seen.has(flag)) throw new CliError(`Pass ${flag} only once.`);
    seen.add(flag);
    if (definition.type === 'boolean') {
      if (equals >= 0) throw new CliError(`${flag} takes no value.`);
      result[definition.target] = true;
    } else {
      let value = equals < 0 ? args[++index] : token.slice(equals + 1);
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new CliError(`${flag} requires a valid value.`);
      if (definition.type === 'number') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError(`${flag} requires a nonnegative integer.`);
        value = Number(value);
        if (definition.target === 'limit' && (value < 1 || value > 100)) throw new CliError('--limit must be from 1 to 100.');
        if (definition.target === 'duration' && (value < 1 || value > 86400)) throw new CliError('--duration must be from 1 to 86400 seconds.');
      }
      if (definition.type === 'file' && value !== '-') value = path.resolve(value);
      result[definition.target] = value;
    }
  }
  if (positions.length !== definition.positionals.length) throw new CliError(`${key} requires ${definition.positionals.length} positional arguments.`);
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i];
    if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new CliError('Invalid positional argument.');
    const name = definition.positionals[i];
    result[name] = name === 'file' ? path.resolve(value) : value;
  }
  for (const required of definition.required) if (result[required] === undefined) throw new CliError(`Missing required option: ${required}.`);
  if (['dot reboot', 'environment recreate', 'safety resume'].includes(key)) result.dotId ??= result.confirmDotId;
  if (result.all && (result.roomId || result.taskId)) throw new CliError('--all cannot be combined with --room or --task.');
  for (const name of ['idempotencyKey', 'requestId']) if (result[name] !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result[name])) throw new CliError('--key requires a UUID.');
  for (const name of ['confirmDotId', 'confirmEnvironmentId']) {
    const target = name === 'confirmDotId' ? result.dotId : result.environmentId;
    if (result[name] && target && result[name] !== target) throw new CliError('Confirmation must match the selected target ID.');
  }
  if (['library trash', 'library restore-version'].includes(key) && result.confirm !== result.fileId) throw new CliError('Confirmation must match the selected file ID.');
  return result;
}

async function textFile(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024) throw new CliError('SDP input must be a regular file of 1 byte to 256 KiB.', 'INPUT_ERROR');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) { const r = await handle.read(buffer, length, buffer.length - length, length); if (!r.bytesRead) break; length += r.bytesRead; }
    if (length > 256 * 1024) throw new CliError('SDP input is too large.', 'INPUT_ERROR');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    if (!value.startsWith('v=0') || value.includes('\0')) throw new CliError('Input must contain an SDP offer.', 'INPUT_ERROR');
    return value;
  } catch (error) { if (error instanceof CliError) throw error; throw new CliError('Could not read SDP input.', 'INPUT_ERROR'); }
  finally { await handle?.close(); }
}
export async function prepareV3Options(options) {
  if (options.command !== 'v3') return options;
  const result = { ...options };
  if (result.specFile) {
    const value = await readJsonObject(result.specFile);
    const allowed = result.action === 'dot create' ? ['avatar','avatarType','avatarManifest','avatarUrl','createThread','createAdditional','shouldInitialize']
      : result.action === 'dot avatar' ? ['avatar','avatarType','avatarManifest','avatarUrl','name']
      : result.action === 'connection reauthorize' ? ['requestedScopes']
      : result.action === 'connection api-key' ? ['actionNames','linkParams']
      : ['actionNames','requestedScopes','linkParams'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new CliError('The spec includes an unknown field.', 'INPUT_ERROR');
    Object.assign(result, value);
  }
  if (result.manifestFile) result.avatarManifest = await readJsonObject(result.manifestFile);
  if (result.sdpFile) result.sdp = await textFile(result.sdpFile);
  if (result.category) result.categories = [result.category];
  if (result.action === 'library favorite-status') result.fileIds = result.fileIds.split(',').map(id => id.trim());
  return result;
}
const moduleConstructors = {
  lifecycle: async () => (await import('./lifecycle.mjs')).DotLifecycle,
  channels: async () => (await import('./channels.mjs')).DotChannels,
  extras: async () => (await import('./routine-extras.mjs')).RoutineExtras,
  live: async () => (await import('./live.mjs')).DotLive,
  connections: async () => (await import('./connections.mjs')).DotConnections,
  library: async () => (await import('./library.mjs')).DotLibrary,
};
export async function runV3Command(client, options, deps = {}) {
  const definition = routes[options.action];
  if (!definition) throw new CliError('Unknown v3 command.');
  const { command, action, authFile, json, specFile, manifestFile, sdpFile, category, noReconnect, noOpen, duration, ...args } = options;
  args.signal = deps.signal;
  if (noReconnect) args.reconnect = false;
  if (definition.key) {
    args[definition.key] ??= deps.uuid();
    deps.stderr.write(`Request key: ${args[definition.key]}\n`);
  }
  if (definition.module === 'connections') args.input = deps.stdin;
  if (definition.module === 'voice') {
    if (noOpen) args.openBrowser = false;
    args.output = deps.stdout;
  }
  const invoke = async () => {
    if (deps.v3Invoke) return deps.v3Invoke(definition.module, definition.method, args);
    if (definition.module === 'client') return client[definition.method](args);
    if (definition.module === 'voice') return (await import('./voice.mjs'))[definition.method](client, args);
    const Constructor = await moduleConstructors[definition.module]();
    return new Constructor(client)[definition.method](args);
  };
  if (!definition.stream) return invoke();
  const controller = new AbortController(), signals = deps.signals ?? process;
  const abort = () => controller.abort();
  signals.once('SIGINT', abort); signals.once('SIGTERM', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  args.signal = controller.signal;
  if (definition.module === 'live') {
    args.onEvent = value => deps.stdout.write(`${JSON.stringify(value)}\n`);
    args.onReady = value => deps.stderr.write(`${value?.ready === false ? 'Live connection established; waiting for state' : 'Live connection ready'}${value?.roomId ? ` for ${value.roomId}` : ''}. Ctrl+C to stop.\n`);
  }
  const timer = duration ? setTimeout(abort, duration * 1000) : undefined;
  try {
    const result = await invoke();
    if (definition.module === 'voice' && result?.stopError) throw new DotError('VOICE_CLEANUP_UNCONFIRMED', 'The local voice session stopped, but the remote call could not be confirmed stopped. Use voice stop with the call ID after restoring the original account.', { dotId: result.dotId, callId: result.callId, cleanup: 'unconfirmed', cause: result.stopError.code });
    return result;
  }
  catch (error) { if (!controller.signal.aborted || error?.name !== 'AbortError' && error !== controller.signal.reason) throw error; }
  finally {
    clearTimeout(timer); signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
export function isV3Streaming(options) { return Boolean(routes[options.action]?.stream); }
export const v3CommandNames = Object.freeze(Object.keys(routes));
export const v3CommandOptions = Object.freeze(Object.fromEntries(
  Object.entries(routes).map(([name, definition]) => [name, Object.freeze({ ...common, ...definition.flags })]),
));
