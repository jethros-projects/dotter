import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, parseAdvancedArgs, prepareAdvancedOptions, runAdvancedCommand, readJsonObject } from './commands.mjs';
import { parseV3Args, prepareV3Options, runV3Command, isV3Streaming } from './v3-commands.mjs';
import { parseV4Args, prepareV4Options, runV4Command, isV4Streaming, v4Commands, v4Help } from './v4-commands.mjs';

export { CliError } from './commands.mjs';
import { HELP, FULL_HELP, commandHelp, requestedHelp } from './help.mjs';
import { basicCommandOptions } from './cli-options.mjs';
export { HELP, FULL_HELP } from './help.mjs';

const MAX_TEXT_CHARS = 64_000;
const MAX_TEXT_BYTES = MAX_TEXT_CHARS * 4;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new CliError(`${name} requires a nonempty value without control characters.`);
  }
  return value;
}

function positiveNumber(value, name, maximum, integer = false) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new CliError(`${name} requires a positive ${integer ? 'integer' : 'number'}.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > maximum || (integer && !Number.isSafeInteger(number))) {
    throw new CliError(`${name} must be ${integer ? 'an integer ' : ''}from 1 to ${maximum}.`);
  }
  return number;
}

export function validateText(text, allowEmpty = false) {
  if (typeof text !== 'string' || !allowEmpty && !text.trim()) throw new CliError('Message text must not be empty.');
  if (text.includes('\0')) throw new CliError('Message text must not contain NUL characters.');
  if (text.length > MAX_TEXT_CHARS) throw new CliError('Message text must be at most 64,000 characters.');
  return text;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new CliError('Arguments must be strings.');
  if (argv.length === 0) return { command: 'help' };
  const [first, ...rest] = argv;
  if (first === 'help' && rest.length) {
    const topic = rest.join(' ');
    commandHelp(topic);
    return { command: 'help', topic };
  }
  if (['help', '--help', '-h', '--help-all', '--version', '-v'].includes(first)) {
    if (rest.length) throw new CliError('Help and version take no arguments.');
    if (first === '--help-all') return { command: 'help', all: true };
    return { command: ['--version', '-v'].includes(first) ? 'version' : 'help' };
  }
  const topic = requestedHelp(argv);
  if (topic) return Object.hasOwn(v4Commands, topic) ? { command: 'v4-help', action: topic } : { command: 'help', topic };
  let command = first, args = rest;
  if (first === 'auth') {
    const [action, ...options] = rest;
    if (!['status', 'login', 'logout', 'refresh'].includes(action)) throw new CliError('Use auth status, auth login, auth logout, or auth refresh.');
    command = `auth-${action}`;
    args = options;
  }
  const v4 = parseV4Args(command, args);
  if (v4) return v4;
  const v3 = parseV3Args(command, args);
  if (v3) return v3;
  const advanced = parseAdvancedArgs(command, args);
  if (advanced) return advanced;
  if (!['auth-status', 'auth-login', 'auth-logout', 'auth-refresh', 'status', 'dots', 'history', 'watch', 'send'].includes(command)) {
    throw new CliError('Unknown command. Run dotter --help.');
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };

  const spec = basicCommandOptions[command.startsWith('auth-') ? command.replace('-', ' ') : command];
  const options = {}, positionals = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') { positionals.push(...args.slice(index + 1)); break; }
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const equal = token.indexOf('='), option = equal === -1 ? token : token.slice(0, equal);
    if (!Object.hasOwn(spec, option)) throw new CliError(`Unknown option: ${stripTerminalControls(option)}.`);
    if (Object.hasOwn(options, option) && spec[option] !== 'repeat') throw new CliError(`Pass ${option} only once.`);
    if (spec[option] === 'boolean') {
      if (equal !== -1) throw new CliError(`${option} does not take a value.`);
      options[option] = true;
    } else {
      const value = equal === -1 ? args[++index] : token.slice(equal + 1);
      if (value === undefined || value.startsWith('--')) throw new CliError(`${option} requires a value.`);
      if (spec[option] === 'repeat') (options[option] ??= []).push(nonempty(value, option));
      else options[option] = nonempty(value, option);
    }
  }

  const result = { command };
  if (options['--auth-file'] !== undefined) result.authFile = path.resolve(options['--auth-file']);
  if (options['--json']) result.json = true;
  if (options['--room'] !== undefined) result.roomId = options['--room'];
  if (command === 'auth-login' && result.authFile !== undefined) throw new CliError('auth login uses the Codex-managed login; --auth-file applies to API reads and sends.');
  if (command === 'auth-logout' && result.authFile !== undefined) throw new CliError('auth logout signs out the shared Codex CLI session; it does not accept --auth-file.');
  if (command !== 'send' && positionals.length) throw new CliError(`${first} takes no positional arguments.`);

  if (command === 'history') {
    if (['--before', '--after', '--around'].filter(key => options[key] !== undefined).length > 1) throw new CliError('Use only one of --before, --after, or --around.');
    result.limit = options['--limit'] === undefined ? 20 : positiveNumber(options['--limit'], '--limit', 20, true);
    if (options['--before'] !== undefined) result.before = options['--before'];
    if (options['--after'] !== undefined) result.after = options['--after'];
    if (options['--around'] !== undefined) result.around = options['--around'];
    if (options['--task'] !== undefined) result.taskId = options['--task'];
    if (result.around && options['--pages'] !== undefined) throw new CliError('--around selects one page and cannot be combined with --pages.');
    if (options['--pages'] !== undefined) result.pages = positiveNumber(options['--pages'], '--pages', 100, true);
  } else if (command === 'watch') {
    if (options['--all'] && (options['--room'] !== undefined || options['--cursor-file'] !== undefined)) throw new CliError('watch --all cannot be combined with --room or --cursor-file.');
    if (options['--all']) result.all = true;
    result.intervalMs = (options['--interval'] === undefined ? 3 : positiveNumber(options['--interval'], '--interval', 3600)) * 1000;
    result.fromStart = Boolean(options['--from-start']);
    if (options['--duration'] !== undefined) result.duration = positiveNumber(options['--duration'], '--duration', Number.MAX_SAFE_INTEGER / 1000);
    if (options['--cursor-file'] !== undefined) result.cursorFile = path.resolve(options['--cursor-file']);
  } else if (command === 'send') {
    if ((options['--attach']?.length ?? 0) + (options['--attachment-id']?.length ?? 0) > 10) throw new CliError('Send accepts at most ten attachments.');
    const hasAttachments = Boolean(options['--attach']?.length || options['--attachment-id']?.length);
    const sources = Number(positionals.length > 0) + Number(options['--file'] !== undefined) + Number(Boolean(options['--stdin']));
    if (positionals.length > 1 || sources > 1 || sources === 0 && !hasAttachments) throw new CliError('Provide exactly one text source: quoted message text, --file FILE, or --stdin; attachment-only sends may omit text.');
    if (positionals.length === 1) result.text = validateText(positionals[0], hasAttachments);
    if (sources === 0 && hasAttachments) result.text = '';
    if (options['--file'] !== undefined) result.file = path.resolve(options['--file']);
    if (options['--stdin']) result.stdin = true;
    if (options['--attach']?.length) result.files = options['--attach'].map(file => path.resolve(file));
    if (options['--attachment-id']?.length) result.attachmentIds = options['--attachment-id'];
    if (options['--reply-to'] !== undefined) result.replyTo = options['--reply-to'];
    if (options['--task'] !== undefined) result.taskId = options['--task'];
    if (options['--page'] !== undefined) result.pageContext = { page_id: options['--page'] };
    if (options['--page-thread'] !== undefined) {
      if (!result.pageContext) throw new CliError('--page-thread requires --page.');
      result.pageContext.thread_id = options['--page-thread'];
    }
    if (options['--metadata-file']) result.metadataFile = path.resolve(options['--metadata-file']);
    if (options['--annotations-file']) result.annotationsFile = path.resolve(options['--annotations-file']);
    if (result.metadataFile && result.annotationsFile) throw new CliError('Use --metadata-file or --annotations-file, not both.');
    if (options['--wait'] !== undefined) {
      const wait = options['--wait'];
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(wait) || !Number.isFinite(Number(wait)) || Number(wait) > 300) throw new CliError('--wait must be from 0 to 300 seconds.');
      result.waitSeconds = Number(wait);
    }
    if (options['--key'] !== undefined) {
      if (!UUID.test(options['--key'])) throw new CliError('--key must be a UUID.');
      result.idempotencyKey = options['--key'];
    }
  }
  return result;
}

export function stripTerminalControls(value) {
  return String(value ?? '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}

export function formatMessage(message) {
  const scalar = value => stripTerminalControls(value).replace(/\n/g, ' ');
  const role = scalar(message?.role ?? 'message');
  const id = scalar(message?.id ?? '');
  const timestamp = scalar(message?.createdAt ?? message?.created_at ?? '');
  const label = [timestamp, role, id ? `[${id}]` : ''].filter(Boolean).join(' ');
  const text = stripTerminalControls(typeof message?.text === 'string' ? message.text : '');
  return `${label}\n${text}\n`;
}

function printJSON(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readUtf8Input(options, stdin) {
  let handle;
  const chunks = [];
  let size = 0;
  try {
    let stream = stdin;
    if (options.file) {
      handle = await open(options.file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new CliError('The message file must be a regular file.');
      if (stat.size > MAX_TEXT_BYTES) throw new CliError('Message text must be at most 64,000 characters.');
      stream = handle.createReadStream({ autoClose: false });
    }
    if (!stream?.[Symbol.asyncIterator]) throw new CliError('Could not read message input.', 'INPUT_ERROR');
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_TEXT_BYTES) throw new CliError('Message text must be at most 64,000 characters.');
      chunks.push(bytes);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new CliError('Message input must contain valid UTF-8 text.', 'INPUT_ERROR'); }
    return validateText(text, Boolean(options.files?.length || options.attachmentIds?.length));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Could not read the message input. Check the file and its permissions.', 'INPUT_ERROR');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function defaultLogin() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['login'], { stdio: 'inherit', shell: false });
    child.once('error', () => reject(new CliError('Could not start codex login. Check that Codex is installed and on PATH.', 'LOGIN_ERROR')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ completed: true });
      else reject(new CliError(signal ? 'Codex login was interrupted.' : 'Codex login did not complete successfully.', 'LOGIN_ERROR'));
    });
  });
}

async function defaultLogout() {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['logout'], { stdio: 'inherit', shell: false });
    child.once('error', () => reject(new CliError('Could not start codex logout. Check that Codex is installed and on PATH.', 'AUTH_LOGOUT_ERROR')));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ completed: true, loggedOut: true, sharedCodexSession: true });
      else reject(new CliError(signal ? 'Codex logout was interrupted.' : 'Codex logout did not complete successfully.', 'AUTH_LOGOUT_ERROR'));
    });
  });
}

export async function run(argv, deps = {}) {
  const options = parseArgs(argv);
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (options.command === 'help') {
    const topic = options.topic ?? (argv.length > 1 && ['--help', '-h'].includes(argv.at(-1)) ? argv.slice(0, -1).join(' ') : null);
    stdout.write(options.all ? FULL_HELP : topic ? commandHelp(topic) : HELP);
    return;
  }
  if (options.command === 'v4-help') { stdout.write(v4Help(options.action)); return; }
  if (options.command === 'version') {
    const version = deps.version ?? JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    stdout.write(`${version}\n`);
    return version;
  }
  if (options.command === 'auth-login') {
    const result = await (deps.login ?? defaultLogin)();
    printJSON(stdout, result ?? { completed: true });
    return result;
  }
  if (options.command === 'auth-logout') {
    stderr.write('Signing out the shared Codex CLI session. Codex will require login again.\n');
    const result = await (deps.logout ?? defaultLogout)();
    printJSON(stdout, result ?? { completed: true, loggedOut: true, sharedCodexSession: true });
    return result;
  }
  if (options.command === 'auth-status') {
    const status = deps.authStatus ?? (await import('./auth.mjs')).authStatus;
    const result = await status({ authFile: options.authFile });
    printJSON(stdout, result);
    return result;
  }
  if (options.command === 'auth-refresh') {
    const refresh = deps.refreshLogin ?? (await import('./auth-actions.mjs')).refreshLogin;
    const result = await refresh({ authFile: options.authFile });
    printJSON(stdout, result);
    return result;
  }
  if (options.command === 'capabilities') {
    const capabilities = deps.capabilities ?? (await import('./advanced.mjs')).FullDotClient.capabilities;
    const result = await capabilities();
    printJSON(stdout, result);
    return result;
  }

  // Validate all message input before opening an authenticated client.
  const text = options.command === 'send' ? options.text ?? await readUtf8Input(options, deps.stdin ?? process.stdin) : undefined;
  const prepared = options.command === 'v4' ? await prepareV4Options(options) : options.command === 'v3' ? await prepareV3Options(options) : await prepareAdvancedOptions(options);
  if (options.command === 'send') {
    if (options.metadataFile) prepared.messageMetadata = await readJsonObject(options.metadataFile);
    if (options.annotationsFile) prepared.browserAnnotations = await readJsonObject(options.annotationsFile);
    const { validateSendContext } = await import('./client.mjs');
    validateSendContext(prepared);
  }
  const createClient = deps.createClient ?? (async config => {
    const { FullDotClient } = await import('./advanced.mjs');
    return new FullDotClient(config);
  });
  const client = await createClient({ authFile: options.authFile });
  if (options.command === 'status' || options.command === 'dots') {
    const result = await (options.command === 'status' ? client.primary() : client.listDots());
    printJSON(stdout, result);
    return result;
  }
  if (options.command === 'history') {
    const args = { roomId: options.roomId, limit: options.limit, before: options.before, after: options.after, signal: deps.signal };
    for (const key of ['around', 'taskId']) if (options[key] !== undefined) args[key] = options[key];
    if (options.pages !== undefined) args.pages = options.pages;
    const result = await client[options.pages === undefined ? 'history' : 'historyPages'](args);
    if (options.json) printJSON(stdout, result);
    else for (const message of result.messages ?? []) stdout.write(formatMessage(message));
    return result;
  }
  if (options.command === 'send') {
    const idempotencyKey = options.idempotencyKey ?? (deps.uuid ?? randomUUID)();
    stderr.write(`Request key: ${idempotencyKey}\n`);
    const args = { roomId: options.roomId, text, idempotencyKey, signal: deps.signal };
    for (const key of ['files', 'attachmentIds', 'replyTo', 'waitSeconds', 'taskId', 'pageContext', 'messageMetadata', 'browserAnnotations']) if (Object.hasOwn(prepared, key)) args[key] = prepared[key];
    const controller = options.waitSeconds > 0 ? new AbortController() : null;
    const signals = deps.signals ?? process, interrupt = () => controller.abort();
    if (controller) {
      args.signal = controller.signal;
      signals.once('SIGINT', interrupt); signals.once('SIGTERM', interrupt);
      deps.signal?.addEventListener('abort', interrupt, { once: true });
      if (deps.signal?.aborted) interrupt();
    }
    try {
      const result = await client.send(args);
      printJSON(stdout, result);
      return result;
    } finally {
      if (controller) {
        signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt);
        deps.signal?.removeEventListener('abort', interrupt);
      }
    }
  }
  if (options.command === 'watch') {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    const signals = deps.signals ?? process;
    signals.once('SIGINT', interrupt);
    signals.once('SIGTERM', interrupt);
    deps.signal?.addEventListener('abort', interrupt, { once: true });
    if (deps.signal?.aborted) interrupt();
    let timer;
    if (options.duration !== undefined) {
      const deadline = Date.now() + options.duration * 1000;
      const arm = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) interrupt();
        else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      arm();
    }
    try {
      return await client[options.all ? 'watchAll' : 'watch']({
        roomId: options.roomId,
        intervalMs: options.intervalMs,
        fromStart: options.fromStart,
        ...(options.cursorFile ? { cursorFile: options.cursorFile } : {}),
        signal: controller.signal,
        onMessage: message => stdout.write(options.json ? `${JSON.stringify(message)}\n` : formatMessage(message)),
        onReady: value => {
          if (!options.json) {
            const room = stripTerminalControls(value?.roomId ?? options.roomId ?? (options.all ? 'all Dot rooms' : 'primary Dot')).replace(/\n/g, ' ');
            stderr.write(`Watching ${room}. Ctrl+C to stop.\n`);
          }
        },
      });
    } catch (error) {
      if (!controller.signal.aborted || error?.name !== 'AbortError' && error !== controller.signal.reason) throw error;
    } finally {
      clearTimeout(timer);
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', interrupt);
      deps.signal?.removeEventListener('abort', interrupt);
    }
    return;
  }
  const runner = prepared.command === 'v4' ? runV4Command : prepared.command === 'v3' ? runV3Command : runAdvancedCommand;
  const result = await runner(client, prepared, { ...deps, stdout, stderr, stdin: deps.stdin ?? process.stdin, uuid: deps.uuid ?? randomUUID });
  if (options.command !== 'chat' && !isV3Streaming(prepared) && !isV4Streaming(prepared)) printJSON(stdout, result);
  return result;
}
