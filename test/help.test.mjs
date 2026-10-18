import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { run, parseArgs, HELP, FULL_HELP } from '../src/cli.mjs';
import { commandHelp, requestedHelp } from '../src/help.mjs';
import { v4Commands } from '../src/v4-commands.mjs';
import { v3CommandNames } from '../src/v3-commands.mjs';

test('first-run help stays short while the full reference remains discoverable', async () => {
  assert.ok(HELP.split('\n').length <= 40);
  assert.match(HELP, /dotter help <command>/);
  assert.match(HELP, /--help-all/);
  let printed = '';
  await run(['--help-all'], { stdout: { write(value) { printed += value; } }, createClient() { assert.fail('Help accessed authentication'); } });
  assert.equal(printed, FULL_HELP);
});

test('help follows declared options without consuming their values or literal text', () => {
  for (const argv of [
    ['send', 'hello', '--help'], ['send', '--file', 'message.txt', '-h'],
    ['history', '--limit', '2', '--help'], ['auth', '--help'],
    ['library', 'browse', '--directory', 'folder', '--help'],
  ]) assert.ok(requestedHelp(argv), argv.join(' '));
  assert.equal(requestedHelp(['send', '--', '--help']), null);
  assert.equal(requestedHelp(['send', '--file', '-h']), null);
  assert.equal(requestedHelp(['send', '--room', '--help']), null);
  assert.equal(parseArgs(['send', '--', '--help']).text, '--help');
  assert.equal(parseArgs(['send', '--file', '-h']).file, path.resolve('-h'));
});

test('command help keeps multiline flags and shared-session auth constraints', () => {
  assert.match(commandHelp('action respond'), /--content-file JSON/);
  assert.match(commandHelp('send'), /--annotations-file JSON/);
  assert.doesNotMatch(commandHelp('auth login'), /--auth-file/);
  assert.match(commandHelp('auth logout'), /shared Codex session/);
  assert.throws(() => parseArgs(['help', 'unknown']), { code: 'USAGE_ERROR' });
  assert.throws(() => parseArgs(['library', 'unknown', '--help']), { code: 'USAGE_ERROR' });
});

test('all declared command help stays offline and names the selected command', async () => {
  const fail = () => assert.fail('Help read credentials or constructed a client');
  for (const name of new Set([...v3CommandNames, ...Object.keys(v4Commands)])) {
    let printed = '';
    await run([...name.split(' '), '--help'], {
      stdout: { write(value) { printed += value; } }, createClient: fail, createV3Client: fail,
      createV4Client: fail, authStatus: fail, login: fail,
    });
    assert.ok(printed.includes(`dotter ${name}`) || name.split(' ').every(word => printed.includes(word)), name);
  }
});
