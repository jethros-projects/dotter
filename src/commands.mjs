import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export class CliError extends Error {
  constructor(message, code = 'USAGE_ERROR') {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

const MAX_JSON_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const VALUE = 'value', FLAG = 'boolean';
const common = { '--auth-file': VALUE, '--json': FLAG };
const room = { '--room': VALUE };
const paging = { '--limit': VALUE, '--cursor': VALUE };
const history = { ...room, '--pages': VALUE };
const dot = { '--dot': VALUE };

export const ADVANCED_HELP = `
History and files:
  dotter history [--room ID] [--pages 1..100] [--json]
  dotter search --query TEXT [--room ID | --all] [--pages N] [--since ISO] [--until ISO]
  dotter thread MESSAGE_ID [--room ID] [--pages N]
  dotter outline [--room ID] [--pages N]
  dotter export --output FILE [--format json|md] [--room ID] [--pages N] [--overwrite]
  dotter upload FILE [--room ID] [--state-file FILE]
  dotter download FILE_ID --output FILE [--room ID] [--overwrite]
  dotter artifacts [--room ID] [--pages N]
  dotter chat [--room ID] [--interval SECONDS]

Actions and Dot management:
  dotter actions [--room ID] [--limit 1..20] [--before CURSOR | --after CURSOR]
  dotter action inspect MESSAGE_ID [--room ID]
  dotter action respond MESSAGE_ID --request-id ID --fingerprint FP --action accept|decline|cancel
    [--content-file JSON] [--persist session|always] [--room ID]
  dotter react MESSAGE_ID (--emoji EMOJI | --clear) [--room ID]
  dotter read MESSAGE_ID [--room ID]
  dotter email MESSAGE_ID [--room ID]
  dotter profile [--dot ID]
  dotter rename NAME --dot ID
  dotter pause --dot ID
  dotter resume --dot ID
  dotter tasks [--dot ID] [--limit N] [--cursor CURSOR]
  dotter task ID [--dot ID]
  dotter threads all [--dot ID] [--limit N] [--cursor CURSOR]

Routines and connected apps:
  dotter routine list [--dot ID | --all] [--filter scheduled|paused|finished] [--limit N] [--cursor CURSOR]
  dotter routine get ID
  dotter routine create --spec FILE
  dotter routine update ID --spec FILE
  dotter routine enable|disable|delete ID
  dotter routine run ID [--key UUID]
  dotter routine runs ID [--limit N] [--cursor CURSOR]
  dotter routine result ID --run RUN_ID (RUN_ID from routine runs, not the run receipt)
  dotter connectors list [--connector ID]
  dotter tools CONNECTOR [--link ID] [--cursor CURSOR]
  dotter tool-call CONNECTOR NAME (--args JSON | --args-file FILE) [--link ID]
  dotter connector-actions CONNECTOR
  dotter resources CONNECTOR [--link ID] [--cursor CURSOR]
  dotter resource CONNECTOR URI [--link ID]
  dotter resource-templates CONNECTOR [--link ID] [--cursor CURSOR]
  dotter prompts CONNECTOR [--link ID] [--cursor CURSOR]
  dotter capabilities
  dotter auth refresh [--auth-file PATH]

These commands print JSON, except interactive chat. JSON input files must be
UTF-8 objects no larger than 256 KiB. Mutation commands execute only when
explicitly invoked. capabilities works offline without credentials.
`;

const specs = {
  capabilities: {},
  search: { ...history, '--query': VALUE, '--all': FLAG, '--since': VALUE, '--until': VALUE },
  thread: history, outline: history, artifacts: history,
  export: { ...history, '--output': VALUE, '--format': VALUE, '--overwrite': FLAG },
  upload: { ...room, '--state-file': VALUE },
  download: { ...room, '--output': VALUE, '--overwrite': FLAG },
  chat: { ...room, '--interval': VALUE },
  actions: { ...room, '--limit': VALUE, '--before': VALUE, '--after': VALUE },
  'action-inspect': room,
  'action-respond': { ...room, '--request-id': VALUE, '--fingerprint': VALUE, '--action': VALUE, '--content-file': VALUE, '--persist': VALUE },
  react: { ...room, '--emoji': VALUE, '--clear': FLAG },
  read: room, email: room,
  profile: dot, rename: dot, pause: dot, resume: dot,
  tasks: { ...dot, ...paging }, task: dot, threads: { ...dot, ...paging },
  'routine-list': { ...dot, ...paging, '--all': FLAG, '--filter': VALUE },
  'routine-get': {}, 'routine-create': { '--spec': VALUE }, 'routine-update': { '--spec': VALUE },
  'routine-enable': {}, 'routine-disable': {}, 'routine-delete': {}, 'routine-run': { '--key': VALUE },
  'routine-runs': paging, 'routine-result': { '--run': VALUE },
  'connectors-list': { '--connector': VALUE },
  tools: { '--cursor': VALUE, '--link': VALUE }, 'tool-call': { '--args': VALUE, '--args-file': VALUE, '--link': VALUE },
  'connector-actions': {}, resources: { '--cursor': VALUE, '--link': VALUE }, resource: { '--link': VALUE },
  'resource-templates': { '--cursor': VALUE, '--link': VALUE }, prompts: { '--cursor': VALUE, '--link': VALUE },
};

export const advancedCommandOptions = Object.freeze(Object.fromEntries(
  Object.entries(specs).map(([name, flags]) => [name === 'threads' ? 'threads all' :
    /^(?:action|routine|connectors)-/.test(name) ? name.replace('-', ' ') : name,
  Object.freeze({ ...common, ...flags })]),
));

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new CliError(`${name} requires a nonempty value without control characters.`);
  return value;
}

function number(value, name, max, integer = true) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new CliError(`${name} requires a positive ${integer ? 'integer' : 'number'}.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 1 || result > max || integer && !Number.isSafeInteger(result)) throw new CliError(`${name} must be ${integer ? 'an integer ' : ''}from 1 to ${max}.`);
  return result;
}

function choice(value, values, name) {
  if (!values.includes(value)) throw new CliError(`${name} must be ${values.join(', ')}.`);
  return value;
}

function required(options, key) {
  if (options[key] === undefined) throw new CliError(`${key} is required.`);
  return options[key];
}

function timestamp(value, name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) throw new CliError(`${name} requires an ISO date or timestamp with a time zone.`);
  const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth() + 1 !== Number(match[2]) || day.getUTCDate() !== Number(match[3])) throw new CliError(`${name} must be a valid calendar date.`);
  return value;
}

/** Return null for a basic command, keeping its original parsing contract. */
export function parseAdvancedArgs(first, originalArgs) {
  let command = first, args = originalArgs;
  if (['action', 'routine', 'connectors'].includes(first) && args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  if (['action', 'routine', 'connectors'].includes(first)) {
    command = `${first}-${args[0]}`;
    args = args.slice(1);
    if (!Object.hasOwn(specs, command)) throw new CliError(`Unknown ${first} command. Run dotter --help.`);
  }
  if (!Object.hasOwn(specs, command)) return null;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  if (command === 'threads' && args.length === 2 && args[0] === 'all' && ['--help', '-h'].includes(args[1])) return { command: 'help' };
  const spec = { ...common, ...specs[command] }, values = {}, positions = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') { positions.push(...args.slice(index + 1)); break; }
    if (!token.startsWith('-')) { positions.push(token); continue; }
    const equal = token.indexOf('='), option = equal === -1 ? token : token.slice(0, equal);
    if (!Object.hasOwn(spec, option)) throw new CliError('Unknown option. Run dotter --help.');
    if (Object.hasOwn(values, option)) throw new CliError(`Pass ${option} only once.`);
    if (spec[option] === FLAG) {
      if (equal !== -1) throw new CliError(`${option} does not take a value.`);
      values[option] = true;
    } else {
      const value = equal === -1 ? args[++index] : token.slice(equal + 1);
      if (value === undefined || value.startsWith('--')) throw new CliError(`${option} requires a value.`);
      // JSON can include tabs and newlines, unlike IDs and path flags.
      values[option] = option === '--args' ? value : text(value, option);
    }
  }
  const result = { command };
  for (const [key, target] of Object.entries({ '--auth-file': 'authFile', '--room': 'roomId', '--dot': 'dotId', '--output': 'output', '--cursor': 'cursor', '--before': 'before', '--after': 'after', '--request-id': 'requestId', '--fingerprint': 'requestFingerprint', '--run': 'runId', '--connector': 'connectorId', '--link': 'linkId', '--state-file': 'stateFile' })) {
    if (values[key] !== undefined) result[target] = ['authFile', 'output', 'stateFile'].includes(target) ? path.resolve(values[key]) : values[key];
  }
  if (values['--json']) result.json = true;
  if (values['--pages'] !== undefined) result.pages = number(values['--pages'], '--pages', 100);
  if (values['--overwrite']) result.overwrite = true;
  const arity = (count, example = command) => {
    if (positions.length !== count) throw new CliError(`${example} requires ${count} positional argument${count === 1 ? '' : 's'}.`);
    positions.forEach(value => text(value, 'Argument'));
  };
  if (['thread', 'upload', 'download', 'action-inspect', 'action-respond', 'react', 'read', 'email', 'rename', 'task'].includes(command) || command.startsWith('routine-') && !['routine-list', 'routine-create'].includes(command) || ['tools', 'connector-actions', 'resources', 'resource-templates', 'prompts'].includes(command)) arity(1);
  else if (['tool-call', 'resource'].includes(command)) arity(2);
  else if (command === 'threads') {
    if (positions.length !== 1 || positions[0] !== 'all') throw new CliError('Use threads all to list the selected Dot’s visible threads.');
  } else arity(0);
  if (['thread', 'action-inspect', 'action-respond', 'react', 'read', 'email'].includes(command)) result.messageId = positions[0];
  if (command === 'upload') result.file = path.resolve(positions[0]);
  if (command === 'download') result.fileId = positions[0];
  if (['download', 'export'].includes(command)) required(values, '--output');
  if (command === 'export') result.format = choice(values['--format'] ?? 'json', ['json', 'md'], '--format');
  if (command === 'search') {
    result.query = required(values, '--query');
    if (result.query.length > 4096) throw new CliError('Search query must be at most 4096 characters.');
    if (values['--all']) result.all = true;
    if (result.all && result.roomId) throw new CliError('Use --all or --room, not both.');
    if (values['--since']) result.since = timestamp(values['--since'], '--since');
    if (values['--until']) result.until = timestamp(values['--until'], '--until');
    if (result.since && result.until && Date.parse(result.since) > Date.parse(result.until)) throw new CliError('--since must be before or equal to --until.');
  }
  if (command === 'actions') {
    if (result.before && result.after) throw new CliError('Use --before or --after, not both.');
    result.limit = values['--limit'] === undefined ? 20 : number(values['--limit'], '--limit', 20);
  }
  if (command === 'action-respond') {
    result.requestId = required(values, '--request-id');
    result.requestFingerprint = required(values, '--fingerprint');
    result.action = choice(required(values, '--action'), ['accept', 'decline', 'cancel'], '--action');
    if (values['--content-file']) result.contentFile = path.resolve(values['--content-file']);
    if (values['--persist']) result.persist = choice(values['--persist'], ['session', 'always'], '--persist');
    if (result.action !== 'accept' && (result.contentFile || result.persist)) throw new CliError('Only accept can include response content or persistence.');
  }
  if (command === 'react') {
    if (Number(values['--emoji'] !== undefined) + Number(Boolean(values['--clear'])) !== 1) throw new CliError('Use exactly one of --emoji or --clear.');
    result.reaction = values['--clear'] ? null : values['--emoji'];
  }
  if (command === 'rename') result.name = positions[0];
  if (['rename', 'pause', 'resume'].includes(command)) required(values, '--dot');
  if (command === 'task') result.taskId = positions[0];
  if (['tasks', 'threads', 'routine-list', 'routine-runs'].includes(command)) result.limit = values['--limit'] === undefined ? command === 'threads' ? 100 : 25 : number(values['--limit'], '--limit', 100);
  if (command.startsWith('routine-')) {
    if (!['routine-list', 'routine-create'].includes(command)) result.routineId = positions[0];
    if (['routine-create', 'routine-update'].includes(command)) result.specFile = path.resolve(required(values, '--spec'));
    if (command === 'routine-list') {
      if (values['--all']) result.all = true;
      if (result.all && result.dotId) throw new CliError('Use --all or --dot, not both.');
      if (values['--filter']) {
        result.filter = choice(values['--filter'], ['scheduled', 'paused', 'finished'], '--filter');
        if (!result.all) throw new CliError('--filter requires --all.');
      }
    }
    if (command === 'routine-run' && values['--key'] !== undefined) {
      if (!UUID.test(values['--key'])) throw new CliError('--key must be a UUID.');
      result.idempotencyKey = values['--key'];
    }
    if (command === 'routine-result') required(values, '--run');
  }
  if (['tools', 'tool-call', 'connector-actions', 'resources', 'resource', 'resource-templates', 'prompts'].includes(command)) result.connectorId = positions[0];
  if (command === 'resource') result.uri = positions[1];
  if (command === 'tool-call') {
    result.name = positions[1];
    if (Number(values['--args'] !== undefined) + Number(values['--args-file'] !== undefined) !== 1) throw new CliError('Use exactly one of --args JSON or --args-file FILE.');
    if (values['--args'] !== undefined) result.arguments = parseJsonObject(values['--args'], '--args');
    if (values['--args-file'] !== undefined) result.argsFile = path.resolve(values['--args-file']);
  }
  if (command === 'chat') result.intervalMs = values['--interval'] === undefined ? 5000 : number(values['--interval'], '--interval', 3600, false) * 1000;
  return result;
}

function parseJsonObject(value, label) {
  if (Buffer.byteLength(value, 'utf8') > MAX_JSON_BYTES) throw new CliError(`${label} must be at most 256 KiB.`, 'INPUT_ERROR');
  let result;
  try { result = JSON.parse(value); } catch { throw new CliError(`${label} must contain valid JSON.`, 'INPUT_ERROR'); }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new CliError(`${label} must contain a JSON object.`, 'INPUT_ERROR');
  return result;
}

export async function readJsonObject(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CliError('JSON input must be a regular file.', 'INPUT_ERROR');
    if (stat.size > MAX_JSON_BYTES) throw new CliError('JSON input must be at most 256 KiB.', 'INPUT_ERROR');
    // A bounded read also protects against a file growing after stat().
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_JSON_BYTES) throw new CliError('JSON input must be at most 256 KiB.', 'INPUT_ERROR');
    let decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)); }
    catch { throw new CliError('JSON input must contain valid UTF-8.', 'INPUT_ERROR'); }
    return parseJsonObject(decoded, 'JSON input');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Could not read the JSON input file. Check its path and permissions.', 'INPUT_ERROR');
  } finally { await handle?.close().catch(() => {}); }
}

/** Validate local JSON before obtaining an authenticated client. */
export async function prepareAdvancedOptions(options) {
  const result = { ...options };
  if (result.contentFile) result.content = await readJsonObject(result.contentFile);
  if (result.argsFile) result.arguments = await readJsonObject(result.argsFile);
  if (result.specFile) {
    result.spec = await readJsonObject(result.specFile);
    if (Object.hasOwn(result.spec, 'triggers')) throw new CliError('Event-trigger authoring is unavailable: the live service does not retain native trigger requests. Existing trigger data remains readable.', 'UNSUPPORTED');
    const allowed = ['title', 'prompt', 'schedule', 'timeZone', 'enabled', 'notificationsEnabled', 'emailEnabled', 'timingMode', 'model', 'reasoningEffort', 'emoji', 'threadMode', 'teamId'];
    if (Object.keys(result.spec).some(key => !allowed.includes(key))) throw new CliError('Routine spec contains an unknown field. Use the documented routine fields.', 'INPUT_ERROR');
    if (result.command === 'routine-create' && (['title', 'prompt'].some(key => typeof result.spec[key] !== 'string' || !result.spec[key].trim()) || typeof result.spec.schedule !== 'string' || !result.spec.schedule.trim())) throw new CliError('Routine creation requires title, prompt, and a schedule.', 'INPUT_ERROR');
    if (result.command === 'routine-update' && Object.keys(result.spec).length === 0) throw new CliError('Routine update requires at least one field.', 'INPUT_ERROR');
  }
  return result;
}

/** Single dispatch table: each explicit command invokes one public operation. */
export async function runAdvancedCommand(client, options, deps = {}) {
  const { command, authFile, json, contentFile, argsFile, specFile, spec, ...args } = options;
  const config = { ...args, signal: deps.signal };
  if (command === 'upload' && config.stateFile) return (await import('./uploads.mjs')).uploadRecoverable(client, config);
  const clientMethods = {
    search: 'search', thread: 'thread', outline: 'outline', export: 'exportHistory',
    upload: 'upload', download: 'download', artifacts: 'artifacts',
    actions: 'actions', 'action-inspect': 'elicitation', 'action-respond': 'respond',
    react: 'react', read: 'markRead', email: 'email',
    profile: 'profile', rename: 'renameDot', pause: 'pauseDot', resume: 'resumeDot',
  };
  if (Object.hasOwn(clientMethods, command)) return client[clientMethods[command]](config);
  const operationMethods = {
    tasks: 'listTasks', task: 'getTask', threads: 'listThreads',
    'routine-list': 'listRoutines', 'routine-get': 'getRoutine',
    'routine-create': 'createRoutine', 'routine-update': 'updateRoutine',
    'routine-enable': 'setRoutineEnabled', 'routine-disable': 'setRoutineEnabled',
    'routine-delete': 'deleteRoutine', 'routine-run': 'runRoutine',
    'routine-runs': 'routineRuns', 'routine-result': 'routineRun',
    tools: 'toolList', 'tool-call': 'toolCall', 'connector-actions': 'connectorActions',
    'connectors-list': 'listConnectors',
    resources: 'resourceList', resource: 'resourceRead', 'resource-templates': 'resourceTemplates', prompts: 'promptList',
  };
  if (command === 'routine-create' || command === 'routine-update') Object.assign(config, spec, { signal: deps.signal });
  if (command === 'routine-enable' || command === 'routine-disable') config.enabled = command === 'routine-enable';
  if (command === 'routine-run') {
    config.idempotencyKey ??= deps.uuid();
    deps.stderr.write(`Request key: ${config.idempotencyKey}\n`);
  }
  if (Object.hasOwn(operationMethods, command)) return client.operations[operationMethods[command]](config);
  if (command === 'chat') {
    const runChat = deps.chat ?? (await import('./chat.mjs')).runChat;
    return runChat(client, { ...config, input: deps.stdin, output: deps.stdout, error: deps.stderr });
  }
  throw new CliError('Unknown command. Run dotter --help.');
}
