import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.mjs';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;


test('FullDotClient exposes every extended module on the same transport without making requests', () => {
  const transport = { request() { throw new Error('Construction must not perform I/O.'); } };
  const client = new api.FullDotClient({ transport });
  const modules = { account: 'DotAccount', conversations: 'ConversationClient', dotExtras: 'DotExtras',
    messageWorkflows: 'DotMessageWorkflows', mail: 'DotMail', libraryContent: 'LibraryContent',
    sharing: 'LibrarySharing', libraryProviders: 'LibraryProviders', libraryUpload: 'LibraryUpload', routineManagement: 'RoutineManagement',
    connectorAdmin: 'DotConnectorAdmin', plugins: 'DotPlugins', remoteControl: 'DotRemoteControl', browserAuth: 'DotBrowserAuth' };
  for (const [property, type] of Object.entries(modules)) assert.ok(client[property] instanceof api[type], `${property}: ${type}`);
  assert.equal(client.transport, transport);
  for (const name of ['negotiateRemoteControl', 'createRemoteControlServer', 'runRemoteControl']) assert.equal(typeof api[name], 'function');
});

test('offline capability output includes new API scope and explicit unresolved contracts', () => {
  const capabilities = api.FullDotClient.capabilities();
  assert.equal(capabilities.version, PACKAGE_VERSION);
  assert.equal(capabilities.liveMutationsTested, false);
  assert.equal(capabilities.conversations.liveVerified, false);
  assert.equal(capabilities.remoteControlLiveTested, false);
  assert.ok(capabilities.account.settings.includes('response_presentation'));
  assert.ok(capabilities.parityGaps.some(value => /onboarding/.test(value)));
  assert.ok(capabilities.parityGaps.some(value => /Event-trigger authoring was removed/.test(value)));
  assert.ok(!capabilities.accountLibrary.limitations.some(value => /Permanent deletion and empty-trash are not exposed/.test(value)));
});
