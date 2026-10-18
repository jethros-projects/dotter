import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { DotConnectorAdmin } from '../src/connectors-admin.mjs';
import { commands } from '../src/command-sets/connectors-admin.mjs';
import { DotPlugins } from '../src/plugins.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { Transport } from '../src/transport.mjs';
import { v4Commands, v4Help } from '../src/v4-commands.mjs';
import { HELP, parseArgs, run } from '../src/cli.mjs';

test('retired MCP delete is absent from command declarations, registry and help', async () => {
  assert.equal(Object.hasOwn(commands, 'connector admin mcp-delete'), false);
  assert.equal(Object.hasOwn(v4Commands, 'connector admin mcp-delete'), false);
  const registry = JSON.parse(await readFile(new URL('../src/v4-registry.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(registry, 'connector admin mcp-delete'), false);
  assert.doesNotMatch(HELP, /connector admin mcp-delete/);
  assert.doesNotMatch(v4Help(), /connector admin mcp-delete/);
});

test('legacy MCP delete spelling fails before client creation', async () => {
  for (const suffix of [[], ['--confirm', 'connector-1', '--json'], ['--help']]) {
    const args = ['connector', 'admin', 'mcp-delete', 'connector-1', ...suffix];
    let clients = 0;
    assert.throws(() => parseArgs(args), /Unknown connector command/);
    await assert.rejects(run(args, {
      createClient: async () => { clients++; throw new Error('client creation forbidden'); },
      stdout: { write() {} }, stderr: { write() {} }
    }), /Unknown connector command/);
    assert.equal(clients, 0);
  }
});

test('binary rejects retired MCP delete before loading an auth file', () => {
  const result = spawnSync(process.execPath, [
    new URL('../bin/dotter.mjs', import.meta.url).pathname,
    'connector', 'admin', 'mcp-delete', 'connector-1', '--confirm', 'connector-1',
    '--auth-file', '/__dot_cli_retired_mcp_delete_missing_auth__/auth.json', '--json'
  ], { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'USAGE_ERROR', message: 'Unknown connector command. Run dotter --help.' } });
  assert.doesNotMatch(result.stdout, /AUTH_|ENOENT|missing_auth|auth\.json/);
  assert.equal(result.stderr, '');
});

test('legacy MCP delete always reports unsupported before auth or network', async () => {
  let authCalls = 0, requests = 0;
  const transport = new Transport({
    authLoader: async () => { authCalls++; throw new Error('auth forbidden'); },
    fetchImpl: async () => { requests++; throw new Error('network forbidden'); }
  });
  const admin = new DotConnectorAdmin({ transport });
  for (const input of [undefined, null, {}, { connectorId: 'connector-1', confirmConnectorId: 'connector-1' }, { connectorId: '../private', confirmConnectorId: 'other' }]) {
    await assert.rejects(admin.deleteMcp(input), error => error.code === 'UNSUPPORTED' && /canonical app dependency/.test(error.message));
  }
  assert.equal(authCalls, 0);
  assert.equal(requests, 0);
});

test('legacy MCP delete does not read input fields or reveal input values', async () => {
  let fields = 0;
  const input = { get connectorId() { fields++; throw new Error('private'); }, get confirmConnectorId() { fields++; throw new Error('private'); } };
  const admin = new DotConnectorAdmin({ transport: { request() { throw new Error('network forbidden'); } } });
  await assert.rejects(admin.deleteMcp(input), error => error.code === 'UNSUPPORTED' && !error.message.includes('private'));
  assert.equal(fields, 0);
});

test('FullDotClient legacy MCP delete is unsupported without transport access', async () => {
  let calls = 0;
  const client = new FullDotClient({ transport: { request() { calls++; throw new Error('network forbidden'); }, authLoader() { calls++; throw new Error('auth forbidden'); } } });
  await assert.rejects(client.connectorAdmin.deleteMcp({ connectorId: 'connector-1', confirmConnectorId: 'connector-1' }), { code: 'UNSUPPORTED' });
  assert.equal(calls, 0);
});

test('retained MCP and ordinary plugin commands remain registered', () => {
  for (const name of ['connector admin get', 'connector admin mcp-create', 'connector admin mcp-update', 'connector admin refresh-actions', 'connector admin unlink-all', 'plugin delete']) {
    assert.ok(v4Commands[name], name);
  }
});

test('ordinary owned single-skill plugin delete still uses its confirmed native route', async () => {
  const calls = [];
  const transport = {
    authLoader: async () => ({ accountId: 'account-1' }),
    request: async (method, route, options) => {
      calls.push({ method, route, options });
      return method === 'GET' ? { id: 'plugin-1', scope: 'USER', discoverability: 'PRIVATE', canonical_app_id: null, apps: [], skills: [{ name: 'one-skill' }] } : {};
    }
  };
  const plugin = new DotPlugins({ transport });
  await assert.rejects(plugin.delete({ pluginId: 'plugin-1', confirmPluginId: 'other' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await plugin.delete({ pluginId: 'plugin-1', confirmPluginId: 'plugin-1' }), { status: 'deleted', pluginId: 'plugin-1' });
  assert.deepEqual(calls.map(({ method, route }) => ({ method, route })), [
    { method: 'GET', route: '/backend-api/ps/plugins/plugin-1' },
    { method: 'DELETE', route: '/backend-api/ps/plugins/plugin-1' }
  ]);
  assert.ok(calls.every(call => call.options.expectedAccountId === 'account-1'));
  assert.equal(calls[1].options.body, undefined);
  assert.equal(calls[1].options.query, undefined);
});
