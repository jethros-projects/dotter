import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELP, parseArgs, run } from '../src/cli.mjs';
import { commandHelp } from '../src/help.mjs';

const entrypoint = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));

for (const flag of ['--help', '-h']) test(`canonical threads all ${flag} works through the actual binary without authentication`, async () => {
  const args = ['threads', 'all', flag];
  assert.deepEqual(parseArgs(args), { command: 'help', topic: 'threads all' });
  let stdout = '';
  await run(args, {
    stdout: { write(value) { stdout += value; } },
    createClient() { assert.fail('Help must not construct an authenticated client'); },
    authStatus() { assert.fail('Help must not inspect authentication'); },
  });
  assert.equal(stdout, commandHelp('threads all'));
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: '', CODEX_HOME: '/__dot_cli_help_missing_auth__' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, commandHelp('threads all'));
  assert.equal(result.stderr, '');
});

test('threads rejects unknown subcommands while explicit help can follow supplied arguments', () => {
  for (const args of [
    ['threads', 'other', '--help'],
    ['threads', 'all', 'extra'],
  ]) assert.throws(() => parseArgs(args), { code: 'USAGE_ERROR' });
  assert.deepEqual(parseArgs(['threads', 'all', 'extra', '--help']), { command: 'help', topic: 'threads all' });
  assert.deepEqual(parseArgs(['threads', 'all', '--help', '--json']), { command: 'help', topic: 'threads all' });
  assert.deepEqual(parseArgs(['threads', 'all', '--dot', 'dot_1', '--limit', '2']), { command: 'threads', dotId: 'dot_1', limit: 2 });
});
