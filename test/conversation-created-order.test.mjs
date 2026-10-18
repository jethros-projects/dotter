import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConversationClient } from '../src/conversations.mjs';
import { commands } from '../src/command-sets/conversations.mjs';
import { run } from '../src/cli.mjs';

const entrypoint = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));
const unsupportedMessage = 'Created-time conversation ordering is unavailable in this CLI. Use order=updated or omit order.';
function noIoClient() {
  const calls = { auth: 0, request: 0 };
  const client = { transport: {
    async authLoader() { calls.auth++; assert.fail('Rejected ordering must not inspect authentication'); },
    async request() { calls.request++; assert.fail('Rejected ordering must not make a request'); },
  } };
  return { client, calls };
}

test('created conversation order is a removed feature, rejected before auth or requests', async () => {
  const h = noIoClient();
  await assert.rejects(new ConversationClient(h.client).list({ order: 'created' }), { code: 'UNSUPPORTED', message: unsupportedMessage });
  assert.deepEqual(h.calls, { auth: 0, request: 0 });
});

test('other unsupported conversation order values remain invalid arguments before auth', async () => {
  for (const order of ['invalid', 'CREATED', 'updated-desc', '', null, 0, false, {}, []]) {
    const h = noIoClient();
    await assert.rejects(new ConversationClient(h.client).list({ order }), { code: 'INVALID_ARGUMENT', message: 'order must be updated.' });
    assert.deepEqual(h.calls, { auth: 0, request: 0 });
  }
});

for (const options of [{}, { order: 'updated' }]) test(`updated conversation order preserves native paging and row order ${JSON.stringify(options)}`, async () => {
  const calls = [];
  const response = { items: [{ id: 'first', create_time: 20, update_time: 1 }, { id: 'second', create_time: 10, update_time: 99 }], total: 29, offset: 3, limit: 2, has_missing_conversations: false };
  const client = new ConversationClient({ transport: {
    async authLoader() { return { accountId: 'fixture-account' }; },
    async request(method, route, args) { calls.push({ method, route, args }); return response; },
  } });
  assert.deepEqual(await client.list({ ...options, limit: 2, offset: 3, expectedAccountId: 'fixture-account' }), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].route, '/backend-api/conversations');
  assert.equal(calls[0].args.expectedAccountId, 'fixture-account');
  assert.deepEqual(calls[0].args.query, { limit: 2, offset: 3, order: 'updated', expand: false, conversation_origin: undefined, exclude_conversation_origin: undefined, hide_snorlax: undefined, is_archived: undefined, is_starred: undefined });
});

test('CLI dispatch rejects both created-order flag forms without authentication or transport', async () => {
  for (const flags of [['--order', 'created'], ['--order=created']]) {
    const h = noIoClient();
    let output = '';
    await assert.rejects(run(['conversation', 'list', ...flags, '--json'], {
      createClient: async () => h.client,
      stdout: { write(value) { output += value; } },
      stderr: { write() { assert.fail('Validation must not print a success or request receipt'); } },
    }), { code: 'UNSUPPORTED', message: unsupportedMessage });
    assert.deepEqual(h.calls, { auth: 0, request: 0 });
    assert.equal(output, '');
  }
});

test('actual CLI reports removed created order before missing auth and reports unknown order separately', () => {
  for (const [flags, code, message] of [
    [['--order', 'created'], 'UNSUPPORTED', unsupportedMessage],
    [['--order=created'], 'UNSUPPORTED', unsupportedMessage],
    [['--order', 'other'], 'INVALID_ARGUMENT', 'order must be updated.'],
  ]) {
    const result = spawnSync(process.execPath, [entrypoint, 'conversation', 'list', ...flags, '--auth-file', '/__dot_cli_order_missing_auth__/auth.json', '--json'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { error: { code, message } });
  }
});

test('conversation list help documents updated-only ordering without accessing a client', async () => {
  assert.match(commands['conversation list'].description, /--order accepts updated only/);
  assert.equal(commands['conversation list'].flags['--order'].target, 'order');
  let output = '';
  await run(['conversation', 'list', '--help'], {
    createClient() { assert.fail('Help must not construct an authenticated client'); },
    stdout: { write(value) { output += value; } },
  });
  assert.match(output, /--order accepts updated only/);
});

test('owned share listing retains its distinct created-order contract', async () => {
  const calls = [];
  const client = new ConversationClient({ transport: {
    async authLoader() { return { accountId: 'fixture-account' }; },
    async request(method, route, args) {
      calls.push({ method, route, args });
      return { items: [{ id: 'share-1', title: 'Fixture', mapping: { omitted: true } }] };
    },
  } });
  assert.deepEqual(await client.shareList({ expectedAccountId: 'fixture-account' }), { items: [{ id: 'share-1', title: 'Fixture' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].route, '/backend-api/shared_conversations');
  assert.deepEqual(calls[0].args.query, { order: 'created' });
});
