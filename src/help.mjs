import { ADVANCED_HELP, CliError, advancedCommandOptions } from './commands.mjs';
import { V3_HELP, v3CommandOptions } from './v3-commands.mjs';
import { v4Commands, v4Help } from './v4-commands.mjs';
import { basicCommandOptions } from './cli-options.mjs';

export const HELP = `Dotter — your Dot, from the terminal

Usage: dotter <command> [options]

Start here:
  auth status       Check your shared Codex login
  auth login        Sign in through Codex
  auth logout       Sign out the shared Codex CLI session
  status            Show your primary Dot
  dots              List your Dots
  send "Hello"      Send a message
  history           Read recent messages
  chat              Start an interactive conversation
  watch             Follow new messages

Explore:
  dotter help <command>     Help for a command or group
  dotter library --help     Browse Library commands
  dotter --help-all         Show the complete command reference
  dotter --version          Print the installed version

Groups: auth, dot, account, activity, actions, browser, computer, connection,
        connector, conversation, library, mail, plugin, remote, routine, voice.

Common options: --json, --auth-file PATH. Message commands accept --room ID;
otherwise they use your primary Dot. Quote message text as one argument.
Requires Node.js 22+, Python 3, and Codex. Uses an internal API that may change.
`;

export const FULL_HELP = `Dotter — Node.js 22+, Python 3

Usage:
  dotter auth status [--auth-file PATH] [--json]
  dotter auth login
  dotter auth logout
  dotter auth refresh [--auth-file PATH] [--json]
  dotter status [--json]
  dotter dots [--json]
  dotter history [--room ID] [--task ID] [--limit 1..20] [--pages 1..100] [--before CURSOR | --after CURSOR | --around MESSAGE_ID] [--json]
  dotter watch [--room ID | --all] [--interval SECONDS] [--duration SECONDS] [--from-start] [--cursor-file PATH] [--json]
  dotter send TEXT [--room ID] [--key UUID] [--json]
  dotter send --file FILE | --stdin [--room ID] [--key UUID] [--json]
  dotter send [TEXT] --attach FILE [--attach FILE...] [--reply-to ID] [--wait 0..300] [--room ID] [--key UUID]
  dotter send [TEXT] [--attachment-id ID...] [--task ID] [--page PAGE_ID [--page-thread THREAD_ID]] [--metadata-file JSON | --annotations-file JSON]
  dotter --help | --version

Quote message text as one argument. Use -- before text beginning with a dash.
All API commands accept --auth-file PATH; otherwise they reuse the Codex login.
Omitting --room selects the primary Dot. History defaults to 20 messages.
Watch defaults to a 3-second poll interval and new messages only; --from-start
includes available history. JSON watch output is one message per line (NDJSON).
Ctrl+C stops watching. Authentication credentials are never printed.

This uses an internal API which may change. Sending is explicit and is never
automatically retried. Keep the printed request key when checking an uncertain
send result. auth login runs the installed codex login command.
auth logout runs codex logout and signs out the shared Codex CLI session.
watch --all watches every discovered Dot room; it cannot use --room or --cursor-file.
${ADVANCED_HELP}
${V3_HELP}
${v4Help()}`;

// Derive discovery from the same command definitions as dispatch and the
// complete reference, so adding a command cannot make it invisible to help.
const established = [];
for (const line of FULL_HELP.split('\nExtended API commands:\n')[0].split('\n')) {
  if (line.startsWith('  dotter ')) established.push(line);
  else if (line.startsWith('    ') && established.length) established[established.length - 1] += `\n${line}`;
}

const commandOptions = { ...basicCommandOptions, ...advancedCommandOptions, ...v3CommandOptions,
  ...Object.fromEntries(Object.entries(v4Commands).map(([name, definition]) => [name, {
    '--auth-file': 'value', '--json': 'boolean', ...definition.flags,
    ...(definition.specFields ? { '--spec': 'value' } : {}),
    ...(definition.stream ? { '--duration': 'value' } : {}),
  }])) };
const commandNames = Object.keys(commandOptions).sort((a, b) => b.split(' ').length - a.split(' ').length);

/** Find real help flags without interpreting option values or text after --. */
export function requestedHelp(argv) {
  if (argv.length < 2 || !argv.some(word => ['--help', '-h'].includes(word))) return null;
  const name = commandNames.find(candidate => argv.slice(0, candidate.split(' ').length).join(' ') === candidate);
  if (!name) {
    if (!['--help', '-h'].includes(argv.at(-1)) || !argv.slice(0, -1).every(word => /^[a-z][a-z0-9-]*$/.test(word))) return null;
    const topic = argv.slice(0, -1).join(' ');
    try { commandHelp(topic); return topic; }
    catch (error) { if (error instanceof CliError) return null; throw error; }
  }
  const flags = commandOptions[name];
  for (let index = name.split(' ').length; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--') break;
    if (['--help', '-h'].includes(word)) return name;
    const equals = word.indexOf('='), key = equals < 0 ? word : word.slice(0, equals), spec = flags[key];
    if (spec && equals < 0 && (typeof spec === 'string' ? spec : spec.type) !== 'boolean') index++;
  }
  return null;
}

function matchesSynopsis(line, topic) {
  // Older definitions combine equivalent verbs, for example attach|stop.
  const synopsis = line.slice('  dotter '.length).split(' ');
  return topic.split(' ').every((word, index) => synopsis[index]?.split('|').includes(word));
}

export function commandHelp(topic) {
  if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(topic)) {
    throw new CliError('Use dotter help followed by a command or group.');
  }
  const extended = Object.keys(v4Commands).filter(name => name === topic || name.startsWith(`${topic} `));
  const lines = established.filter(line => matchesSynopsis(line, topic));
  // Extended definitions take precedence over older synopses of the same leaf.
  const unique = lines.filter(line => !extended.some(name => line.startsWith(`  dotter ${name} `) || line === `  dotter ${name}`));
  if (!unique.length && !extended.length) throw new CliError(`Unknown command or group: ${topic}. Run dotter --help.`);
  const details = extended.map(name => v4Help(name).replace('\nExtended API commands:\n', '')).join('\n');
  const common = ['auth login', 'auth logout'].includes(topic) ? 'Options: --json. Uses the shared Codex session.' :
    topic === 'auth' ? '--auth-file PATH applies to status and refresh. Login/logout use the shared Codex session.' :
    'Common options: --auth-file PATH, --json.';
  return `Dotter · ${topic}\n\n${unique.length ? unique.join('\n') + '\n' : ''}${details}\n${common}\nUse dotter --help-all for all commands and input conventions.\n`;
}
