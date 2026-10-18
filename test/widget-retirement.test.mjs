import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.mjs';
import { HELP, parseArgs, run } from '../src/cli.mjs';
import { v4Commands, runV4Command, v4Help } from '../src/v4-commands.mjs';
import { commands } from '../src/command-sets/widgets.mjs';
import { actionManifest, listActions, unsupportedAction } from '../src/actions.mjs';

const retired = ['widgets list', 'widgets inspect', 'widgets tools', 'widgets resources',
  'widgets resource-templates', 'widgets prompts', 'widgets read-resource', 'widgets call'];
const buffer = () => ({ write() { throw new Error('Unexpected output'); } });

for (const name of retired) test(`${name} rejects before client creation or dispatch`, async () => {
  let clients = 0, invocations = 0;
  const deps = {
    createClient: async () => { clients++; throw new Error('Authentication must not start'); },
    v4Invoke: async () => { invocations++; throw new Error('Dispatch must not start'); },
    stdout: buffer(), stderr: buffer()
  };
  for (const tail of [[], ['--help'], ['--arguments-file', '/does-not-exist/private.json']]) {
    const argv = [...name.split(' '), ...tail];
    assert.throws(() => parseArgs(argv), /Unknown command/);
    await assert.rejects(run(argv, deps), /Unknown command/);
  }
  await assert.rejects(runV4Command({}, { command: 'v4', action: name }, deps), /Unknown command/);
  assert.equal(clients, 0);
  assert.equal(invocations, 0);
});

test('widget commands are absent from registration and generated help', () => {
  assert.deepEqual(commands, {});
  for (const name of retired) {
    assert.equal(Object.hasOwn(v4Commands, name), false);
    assert.equal(HELP.includes(`dotter ${name}`), false);
    assert.equal(v4Help().includes(`dotter ${name}`), false);
  }
});

test('public package and FullDotClient do not expose a widget client', () => {
  let requests = 0;
  const client = new api.FullDotClient({ transport: { request() { requests++; throw new Error('Unexpected request'); } } });
  assert.equal(Object.hasOwn(api, 'DotWidgets'), false);
  assert.equal('widgets' in client, false);
  assert.equal(requests, 0);
});

test('capabilities label widget responses unavailable without a command hint', () => {
  const capabilities = api.FullDotClient.capabilities();
  assert.equal(Object.hasOwn(capabilities, 'widgets'), false);
  assert.equal(capabilities.actions.widgetRespond.supported, false);
  assert.equal(Object.hasOwn(capabilities.actions.widgetRespond, 'command'), false);
  assert.throws(() => unsupportedAction('widgetRespond'), { code: 'UNSUPPORTED_ACTION' });
});

test('passive attachment discovery remains available without retired recommendations', async () => {
  const calls = [];
  const client = {
    resolveRoom: async value => value,
    transport: { request: async (...args) => {
      calls.push(args);
      return { items: [{ id: 'message-1', content: { attachments: [
        { type: 'widget', attachment_id: 'attachment-1', messages: [
          { author: { role: 'tool' }, metadata: { chatgpt_sdk: { resource_name: 'example', tool_title: 'Example' } } }
        ] }
      ] } }] };
    } }
  };
  const result = await listActions(client, { roomId: 'room-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'GET');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    type: 'widget', messageId: 'message-1', attachmentId: 'attachment-1', supported: false,
    resourceName: 'example', title: 'Example', reason: actionManifest.widgetRespond.reason
  });
});

test('unrelated connector operations and action clients remain public', () => {
  for (const name of ['toolList', 'resourceList', 'toolCall', 'resourceRead']) {
    assert.equal(typeof api.DotOperations.prototype[name], 'function', name);
  }
  for (const name of ['DotOperations', 'DotNativeActions', 'validateActionForm']) assert.equal(typeof api[name], 'function', name);
  assert.equal(actionManifest.elicitationRespond.supported, true);
  assert.deepEqual(api.FullDotClient.capabilities().connectorAdmin, ['metadata and policies', 'MCP create/update and action refresh', 'service-account links and settings']);
});
