import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSaves, projectSaveCapabilities } from '../src/project-saves.mjs';
import { commands, createClient } from '../src/command-sets/project-saves.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct';
const projectId = 'g-p-abc';
const conversationId = 'conversation-1';
const messageId = 'message-assistant';
const saveId = 'save-1';
const scoped = { accountId, projectId };
const source = { ...scoped, conversationId, messageId };
const selected = { ...scoped, saveId };
const removed = { ...selected, confirm: saveId };
const renamed = { ...selected, title: 'New title' };
const membership = () => ({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } });
const authentication = (subject = 'user-1', account = accountId) => ({ accountId: account, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
function project(gizmo = {}, extra = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Project', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: 'user-1' }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global', ...gizmo }, files: [], ...extra };
}
const save = (extra = {}) => ({ id: saveId, title: 'Saved answer', conversation_id: conversationId, message_id: messageId, owner_id: 'user-1', ...extra });
const page = (items = [], cursor = null) => ({ items, cursor });
function conversation(extra = {}, assistant = {}, node = {}) {
  return { conversation_id: conversationId, gizmo_id: projectId, current_node: 'assistant-node', mapping: {
    'user-node': { id: 'user-node', parent: null, children: ['assistant-node'], message: { id: 'message-user', author: { role: 'user' }, channel: null, content: { content_type: 'text', parts: ['Private question, never in output.'] } } },
    'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: { id: messageId, author: { role: 'assistant' }, channel: 'final', recipient: 'all', status: 'finished_successfully', end_turn: true, metadata: { can_save: true }, content: { content_type: 'text', parts: ['Private answer, never in output.'] }, ...assistant }, ...node },
  }, ...extra };
}
function setup(...responses) {
  const calls = [];
  let auth = authentication(), member = membership();
  const transport = { authLoader: async () => auth, request: async (method, path, options) => {
    const call = { method, path, options }; calls.push(call);
    if (path === '/backend-api/accounts/check/v4-2023-04-27') return member;
    const response = responses.shift();
    if (typeof response === 'function') return response(call);
    if (response instanceof Error) throw response;
    return response;
  } };
  return { api: new ProjectSaves({ transport }), transport, calls, setAuth: value => { auth = value; }, setMembership: value => { member = value; }, get operations() { return calls.filter(call => !call.path.includes('/accounts/check/')); } };
}
const code = expected => error => error?.code === expected;
const writes = h => h.operations.filter(call => call.method !== 'GET');
const createSetup = (ack = save(), after = page([save()]), before = page()) => setup(project(), before, conversation(), project(), ack, after);
const renameSetup = (ack = save({ title: 'New title' }), after = page([save({ title: 'New title' })]), before = page([save()])) => setup(project(), before, ack, after);
const removeSetup = (ack = '', after = page(), before = page([save()])) => setup(project(), before, ack, after);
const unknown = () => new DotError('NETWORK_ERROR', 'Connection closed before acknowledgement.', { delivery: 'unknown' });

test('project saved-response API exposes only the five native metadata and mutation operations', () => {
  assert.throws(() => new ProjectSaves({}), TypeError);
  assert.ok(createClient({ transport: { request() {} } }) instanceof ProjectSaves);
  assert.deepEqual(projectSaveCapabilities().supported, ['list', 'get', 'create', 'rename', 'remove']);
  assert.deepEqual(projectSaveCapabilities().limits, { savedResponsesPerProject: 100, pageSize: 100 });
  assert.equal(projectSaveCapabilities().liveVerified, false);
  assert.deepEqual(Object.keys(commands), ['account projects saves list', 'account projects saves get', 'account projects saves create', 'account projects saves rename', 'account projects saves remove']);
  for (const definition of Object.values(commands)) {
    assert.equal(typeof setup().api[definition.method], 'function');
    assert.ok(definition.required.includes('accountId'));
    assert.equal(definition.flags['--account'].target, 'accountId');
  }
  assert.deepEqual(commands['account projects saves create'].positionals, ['projectId', 'conversationId', 'messageId']);
  assert.deepEqual(commands['account projects saves remove'].confirmMatch, [['confirm', 'saveId']]);
  assert.equal(commands['account projects saves list'].flags['--limit'], undefined);
});

test('all saved-response operations reject an absent account before HTTP', async () => {
  const h = setup();
  for (const [method, options] of [['list', scoped], ['get', selected], ['create', source], ['rename', renamed], ['remove', removed]]) {
    const { accountId: omitted, ...missing } = options;
    await assert.rejects(h.api[method](missing), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('invalid IDs, pagination, rename titles, and deletion confirmation are rejected before authentication', async () => {
  const h = setup(); let loads = 0;
  h.transport.authLoader = async () => { loads++; return authentication(); };
  for (const value of ['', '../outside', '.', '..', 'contains/slash', 'x\0y']) {
    await assert.rejects(h.api.get({ ...selected, saveId: value }), code('INVALID_ARGUMENT'));
    await assert.rejects(h.api.create({ ...source, conversationId: value }), code('INVALID_ARGUMENT'));
    await assert.rejects(h.api.create({ ...source, messageId: value }), code('INVALID_ARGUMENT'));
  }
  for (const value of ['g-other', 'g-p-', '../project']) await assert.rejects(h.api.list({ ...scoped, projectId: value }), code('INVALID_ARGUMENT'));
  for (const options of [{ limit: 0 }, { limit: 1 }, { limit: 99 }, { limit: 101 }, { limit: 1.5 }, { pages: 0 }, { pages: 101 }, { cursor: '' }, { cursor: {} }, { cursor: '\u0085' }]) await assert.rejects(h.api.list({ ...scoped, ...options }), code('INVALID_ARGUMENT'));
  for (const value of ['', ' ', 'x'.repeat(201), 'Line\nbreak', 'x\u0085y']) await assert.rejects(h.api.rename({ ...selected, title: value }), code('INVALID_ARGUMENT'));
  for (const value of [undefined, 'other', true]) await assert.rejects(h.api.remove({ ...selected, confirm: value }), code('CONFIRMATION_REQUIRED'));
  assert.equal(loads, 0); assert.equal(h.calls.length, 0);
});

test('aborted operations do not load credentials or issue requests', async () => {
  const h = setup(); let loads = 0;
  h.transport.authLoader = async () => { loads++; return authentication(); };
  const controller = new AbortController(); controller.abort();
  for (const [method, options] of [['list', scoped], ['get', selected], ['create', source], ['rename', renamed], ['remove', removed]]) await assert.rejects(h.api[method]({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(loads, 0); assert.equal(h.calls.length, 0);
});

test('list pins every request to the explicit account and refreshes membership for each invocation', async () => {
  const h = setup(project(), page([save()]), project(), page());
  const result = await h.api.list(scoped); await h.api.list(scoped);
  assert.equal(result.items[0].id, saveId);
  assert.equal(h.calls.filter(call => call.path.includes('/accounts/check/')).length, 2);
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
  assert.equal(h.operations[1].path, '/backend-api/projects/g-p-abc/saves');
  assert.deepEqual(h.operations[1].options.query, { cursor: null, limit: 100 });
});

test('missing membership, changed account and missing user identity fail without source access', async () => {
  const membershipFailure = setup(); membershipFailure.setMembership({});
  await assert.rejects(membershipFailure.api.list(scoped), code('ACCOUNT_MEMBERSHIP_UNVERIFIED'));
  assert.equal(membershipFailure.operations.length, 0);
  for (const [auth, expected] of [[authentication('user-1', 'other'), 'ACCOUNT_CHANGED'], [{ accountId, accessToken: 'invalid' }, 'AUTH_IDENTITY_REQUIRED']]) {
    const h = setup(); h.setAuth(auth); await assert.rejects(h.api.list(scoped), code(expected)); assert.equal(h.calls.length, 0);
  }
});

test('identity rotation between the project and list request blocks collection access', async () => {
  const h = setup(() => { h.setAuth(authentication('another-user')); return project(); });
  await assert.rejects(h.api.list(scoped), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.operations.length, 1);
});

test('list returns bounded metadata only, preserving an empty auto-generated title', async () => {
  const h = setup(project(), page([save({ title: '', created_at: '2026-10-18T09:00:00Z', create_time: 1, update_time: 2, content: 'Private answer', signed_url: 'https://private.invalid', metadata: { private_token: 'secret' }, owner_email: 'private@example.com' })]));
  const result = await h.api.list(scoped);
  assert.deepEqual(result.items, [{ id: saveId, title: '', conversationId, messageId, ownerId: 'user-1', createdAt: '2026-10-18T09:00:00Z', createTime: 1, updateTime: 2 }]);
  assert.doesNotMatch(JSON.stringify(result), /Private answer|private\.invalid|secret|private@example/);
});

test('list can return a continuation, or consume bounded pages while deduplicating exact records', async () => {
  const next = save({ id: 'save-2', message_id: 'message-2' });
  const h = setup(project(), page([save()], 'opaque+/='), page([save(), next]));
  const result = await h.api.list({ ...scoped, pages: 2, cursor: 'initial' });
  assert.deepEqual(result.items.map(item => item.id), [saveId, 'save-2']); assert.equal(result.pagesRead, 2); assert.equal(result.cursor, null);
  assert.deepEqual(h.operations.filter(call => call.path.endsWith('/saves')).map(call => call.options.query), [{ cursor: 'initial', limit: 100 }, { cursor: 'opaque+/=', limit: 100 }]);
  const bounded = setup(project(), page([], 'next'));
  assert.equal((await bounded.api.list(scoped)).cursor, 'next');
});

test('get resolves an exact save from paginated metadata without a fabricated leaf GET', async () => {
  const h = setup(project(), page([save({ id: 'save-other', message_id: 'message-other' })], 'next'), page([save()]));
  const result = await h.api.get(selected);
  assert.equal(result.save.id, saveId);
  assert.equal(h.operations.length, 3);
  assert.ok(h.operations.slice(1).every(call => call.path === '/backend-api/projects/g-p-abc/saves' && call.method === 'GET'));
  const absent = setup(project(), page()); await assert.rejects(absent.api.get(selected), code('PROJECT_SAVE_NOT_FOUND'));
});

for (const [label, value] of [
  ['unreadable', project({ current_user_permission: { can_read: false, can_write: true } })],
  ['hidden', project({ hidden: true })],
  ['wrong identity', project({ id: 'g-p-other' })],
  ['wrong kind', project({ gizmo_type: 'gpt' })],
]) test(`collection access rejects an ${label} project before listing saved responses`, async () => {
  const h = setup(value); await assert.rejects(h.api.list(scoped)); assert.equal(h.operations.length, 1);
});

for (const [label, value] of [
  ['missing items', {}], ['nonarray items', { items: {}, cursor: null }], ['oversized page', page(Array.from({ length: 101 }, (_, i) => save({ id: `save-${i}` })))],
  ['wrong save ID', page([save({ id: '../escape' })])], ['missing conversation ID', page([save({ conversation_id: undefined })])],
  ['wrong message ID', page([save({ message_id: {} })])], ['nonstring title', page([save({ title: null })])],
  ['control title', page([save({ title: 'x\u0085y' })])], ['oversized title', page([save({ title: 'x'.repeat(8193) })])],
  ['malformed owner ID', page([save({ owner_id: '../user' })])], ['malformed timestamp', page([save({ created_at: {} })])],
  ['invalid cursor', page([], { private: 'payload' })], ['control cursor', page([], '\u0085')],
  ['hidden source', page([save({ hidden: true })])], ['nested private source', page([save({ metadata: { is_private: true } })])],
]) test(`saved-response list rejects ${label} without copying the bad value into its error`, async () => {
  const h = setup(project(), value);
  await assert.rejects(h.api.list(scoped), error => error.code === 'INVALID_RESPONSE' && !/payload|escape|x\u0085y/.test(error.message));
});

test('pagination rejects cycles and conflicting repeated identities', async () => {
  const cycle = setup(project(), page([], 'loop'), page([], 'loop'));
  await assert.rejects(cycle.api.list({ ...scoped, pages: 100 }), code('INVALID_RESPONSE')); assert.equal(cycle.operations.length, 3);
  for (const changed of [save({ title: 'Changed' }), save({ conversation_id: 'other-chat' }), save({ message_id: 'other-message' })]) {
    const h = setup(project(), page([save()], 'next'), page([changed]));
    await assert.rejects(h.api.list({ ...scoped, pages: 2 }), code('INVALID_RESPONSE'));
  }
});

test('a full-source lookup refuses an incomplete 100-page collection', async () => {
  const h = setup(project(), ...Array.from({ length: 100 }, (_, i) => page([], `cursor-${i}`)));
  await assert.rejects(h.api.get(selected), code('PROJECT_SAVES_INCOMPLETE'));
  assert.equal(h.operations.length, 101);
});

test('create validates the selected project conversation, sends only source IDs, and verifies the returned saved source', async () => {
  const h = createSetup(save({ title: '' }), page([save({ title: '' })]));
  const result = await h.api.create(source);
  assert.equal(result.save.title, ''); assert.equal(result.changed, true); assert.equal(result.confirmed, true);
  assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
  assert.deepEqual(writes(h).map(call => [call.method, call.path, call.options.body]), [['POST', '/backend-api/projects/g-p-abc/saves', { conversation_id: conversationId, message_id: messageId }]]);
  const sourceRead = h.operations.find(call => call.path === `/backend-api/conversation/${conversationId}`);
  assert.equal(sourceRead.options.maxBytes, 16 * 1024 * 1024);
  assert.equal(h.operations.filter(call => call.path === '/backend-api/gizmos/g-p-abc').length, 2);
  assert.doesNotMatch(JSON.stringify(result), /Private question|Private answer/);
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
});

test('create returns an existing save without source hydration or another write, even at the cap', async () => {
  const existing = Array.from({ length: 100 }, (_, i) => save({ id: `save-${i + 1}`, message_id: i === 0 ? messageId : `other-${i}` }));
  const h = setup(project(), page(existing));
  const result = await h.api.create(source);
  assert.equal(result.changed, false); assert.equal(result.save.id, saveId); assert.equal(result.requestAcknowledged, false);
  assert.equal(writes(h).length, 0); assert.equal(h.operations.length, 2);
});

test('new saves are refused at 100 existing sources and conflicting source duplicates are ambiguous', async () => {
  const existing = Array.from({ length: 100 }, (_, i) => save({ id: `save-${i}`, message_id: `other-${i}` }));
  const capped = setup(project(), page(existing)); await assert.rejects(capped.api.create(source), code('PROJECT_SAVE_LIMIT')); assert.equal(capped.operations.length, 2);
  const duplicates = setup(project(), page([save(), save({ id: 'another-save' })]));
  await assert.rejects(duplicates.api.create(source), code('INVALID_RESPONSE')); assert.equal(writes(duplicates).length, 0);
});

test('a selected earlier assistant response can be saved but an unselected sibling cannot', async () => {
  const value = conversation();
  value.mapping['later-user'] = { id: 'later-user', parent: 'assistant-node', children: [], message: { id: 'later-user-message', author: { role: 'user' }, content: { content_type: 'text', parts: ['Private follow-up'] } } };
  value.current_node = 'later-user';
  const h = setup(project(), page(), value, project(), save(), page([save()]));
  assert.equal((await h.api.create(source)).confirmed, true);
  const sibling = conversation(); sibling.current_node = 'user-node';
  const notSelected = setup(project(), page(), sibling);
  await assert.rejects(notSelected.api.create(source), code('PROJECT_RESPONSE_NOT_SAVEABLE')); assert.equal(writes(notSelected).length, 0);
});

for (const [label, value] of [
  ['other project', conversation({ gizmo_id: 'g-p-other' })], ['missing project binding', conversation({ gizmo_id: undefined })],
  ['other conversation', conversation({ conversation_id: 'other-conversation' })], ['conflicting conversation IDs', conversation({ id: 'other-conversation' })],
  ['hidden conversation', conversation({ metadata: { hidden: true } })], ['missing selected branch', conversation({ current_node: 'missing' })],
  ['incomplete mapping', conversation({ mapping: {} })], ['malformed mapping', conversation({ mapping: [] })],
  ['cyclic parent chain', conversation({}, {}, { parent: 'assistant-node' })], ['wrong node identity', conversation({}, {}, { id: 'another-node' })],
]) test(`create refuses ${label} before sending a save request`, async () => {
  const h = setup(project(), page(), value); await assert.rejects(h.api.create(source)); assert.equal(writes(h).length, 0);
});

for (const [label, assistant, node] of [
  ['user message', { author: { role: 'user' } }], ['tool message', { author: { role: 'tool' } }],
  ['analysis channel', { channel: 'analysis' }], ['commentary channel', { channel: 'commentary' }], ['tool recipient', { recipient: 'python' }],
  ['missing save permission', { metadata: {} }], ['false save permission', { metadata: { can_save: false } }], ['truthy save permission', { metadata: { can_save: 'true' } }],
  ['message fragment', { metadata: { can_save: true, is_message_fragment: true } }], ['hidden message', { hidden: true }],
  ['hidden metadata', { metadata: { can_save: true, metadata: { hidden: true } } }], ['private author', { author: { role: 'assistant', private: true } }],
  ['hidden node', {}, { hidden: true }], ['skip completion marker', { content: { content_type: 'text', parts: ['::SKIP_COMPLETION::'] } }],
  ['whitespace-padded skip marker', { content: { content_type: 'text', parts: ['  ::SKIP_COMPLETION::  '] } }],
  ['fragmented skip marker', { content: { content_type: 'text', parts: [' ::', 'SKIP_', 'COMPLETION::\n'] } }],
  ['direct-text skip marker', { content: { content_type: 'text', text: ' ::SKIP_COMPLETION:: ', parts: ['Safe-looking fallback'] } }],
  ['active response', { status: 'in_progress' }],
]) test(`create refuses a ${label} before mutation`, async () => {
  const h = setup(project(), page(), conversation({}, assistant, node));
  await assert.rejects(h.api.create(source), code('PROJECT_RESPONSE_NOT_SAVEABLE')); assert.equal(writes(h).length, 0);
});

test('a null channel is accepted for a visible canonical assistant response', async () => {
  const h = setup(project(), page(), conversation({}, { channel: null }), project(), save(), page([save()]));
  assert.equal((await h.api.create(source)).confirmed, true);
});

test('native can_save permission accepts a visible partial response without inventing wire completion gates', async () => {
  const h = setup(project(), page(), conversation({}, { status: 'finished_partial', end_turn: false }), project(), save(), page([save()]));
  assert.equal((await h.api.create(source)).confirmed, true);
  assert.equal(writes(h).length, 1);
});

test('duplicate message identities on the selected branch cannot make an ambiguous source saveable', async () => {
  const value = conversation(); value.mapping['user-node'].message.id = messageId;
  const h = setup(project(), page(), value);
  await assert.rejects(h.api.create(source), code('INVALID_RESPONSE')); assert.equal(writes(h).length, 0);
});

test('create rechecks native write permission after conversation hydration', async () => {
  const h = setup(project(), page(), conversation(), project({ current_user_permission: { can_read: true, can_write: false } }));
  await assert.rejects(h.api.create(source), code('PROJECT_PERMISSION_DENIED')); assert.equal(writes(h).length, 0);
});

for (const [method, options] of [['create', source], ['rename', renamed], ['remove', removed]]) {
  test(`${method} uses native permission rather than save ownership, but requires a writable eligible project`, async () => {
    for (const value of [false, 'yes', 1, null, undefined]) {
      const h = setup(project({ current_user_permission: { can_read: true, can_write: value } }));
      await assert.rejects(h.api[method](options), code('PROJECT_PERMISSION_DENIED')); assert.equal(writes(h).length, 0);
    }
    for (const subtype of ['potion', 'locked_chats']) {
      const h = setup(project({ gizmo_snorlax_type: subtype })); await assert.rejects(h.api[method](options), code('PROJECT_SCOPE_UNSUPPORTED')); assert.equal(writes(h).length, 0);
    }
  });
  test(`${method} requires fresh workspace project CRUD permission before mutation`, async () => {
    const h = setup({ permissions: [] }); const member = membership(); member.accounts.acct.account.structure = 'workspace'; h.setMembership(member);
    await assert.rejects(h.api[method](options), code('PROJECT_PERMISSION_DENIED'));
    assert.equal(h.operations[0].path, '/backend-api/accounts/acct/settings'); assert.equal(writes(h).length, 0);
  });
}

test('shared-project editors can rename and remove another member’s save', async () => {
  const shared = project({ author: { user_id: 'other-owner' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'other-owner' }] }, current_user_permission: { can_read: true, can_write: true, can_delete: false } });
  const other = save({ owner_id: 'other-owner' });
  const h = setup(shared, page([other]), { ...other, title: 'New title' }, page([{ ...other, title: 'New title' }]), shared, page([other]), '', page());
  assert.equal((await h.api.rename(renamed)).confirmed, true); assert.equal((await h.api.remove(removed)).confirmed, true);
  assert.deepEqual(writes(h).map(call => call.method), ['PATCH', 'DELETE']);
});

test('workspace CRUD approval uses fresh native settings and permits a writable collaborator save', async () => {
  for (const permissions of [null, ['chatgpt.workspace.project.crud']]) {
    const shared = project({ author: { user_id: 'other-owner' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'other-owner' }] }, current_user_permission: { can_read: true, can_write: true, can_delete: false } });
    const h = setup({ permissions }, shared, page(), conversation(), shared, save(), page([save()]));
    const member = membership(); member.accounts.acct.account.structure = 'workspace'; h.setMembership(member);
    assert.equal((await h.api.create(source)).confirmed, true);
    assert.equal(h.operations[0].path, '/backend-api/accounts/acct/settings');
    assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
    assert.equal(writes(h).length, 1);
  }
});

test('malformed workspace policy cannot authorize a saved-response mutation', async () => {
  for (const value of [{}, { permissions: undefined }, { permissions: true }, { permissions: [1] }]) {
    const h = setup(value), member = membership(); member.accounts.acct.account.structure = 'workspace'; h.setMembership(member);
    await assert.rejects(h.api.create(source), error => ['PROJECT_ELIGIBILITY_UNVERIFIED', 'INVALID_RESPONSE'].includes(error.code));
    assert.equal(writes(h).length, 0);
  }
});

test('rename trims a title, preserves source identity, and sends only the native title field', async () => {
  const h = renameSetup(); const result = await h.api.rename({ ...selected, title: '  New title  ' });
  assert.equal(result.save.title, 'New title'); assert.equal(result.confirmed, true); assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
  assert.deepEqual(writes(h).map(call => [call.method, call.path, call.options.body]), [['PATCH', '/backend-api/projects/g-p-abc/saves/save-1', { title: 'New title' }]]);
});

test('rename accepts exactly 200 characters and avoids an unchanged title write', async () => {
  const title = 'x'.repeat(200), h = renameSetup(save({ title }), page([save({ title })]));
  assert.equal((await h.api.rename({ ...selected, title })).save.title, title);
  const unchanged = setup(project(), page([save({ title: ' New title ' })]));
  assert.equal((await unchanged.api.rename(renamed)).changed, false); assert.equal(writes(unchanged).length, 0);
});

test('rename and remove reject missing saves before mutation', async () => {
  for (const [method, options] of [['rename', renamed], ['remove', removed]]) {
    const h = setup(project(), page()); await assert.rejects(h.api[method](options), code('PROJECT_SAVE_NOT_FOUND')); assert.equal(writes(h).length, 0);
  }
});

test('remove deletes only project membership and confirms exact collection absence', async () => {
  const other = save({ id: 'untouched', message_id: 'other-message' });
  const h = removeSetup('', page([other]), page([save(), other]));
  const result = await h.api.remove(removed);
  assert.equal(result.removedFromProject, true); assert.equal(result.confirmed, true); assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
  assert.deepEqual(writes(h).map(call => [call.method, call.path]), [['DELETE', '/backend-api/projects/g-p-abc/saves/save-1']]);
  assert.equal(writes(h)[0].options.body, undefined); assert.equal(writes(h)[0].options.responseType, 'text');
});

test('remove does not mistake malformed or negative responses for acknowledged deletion', async () => {
  for (const invalidAck of ['not JSON', 'false', 'null', '{"success":false}', '{"completed":false}', '{"error":"denied"}', false, null, { success: false }, { error: 'denied' }]) {
    const h = removeSetup(invalidAck);
    const result = await h.api.remove(removed);
    assert.equal(result.removedFromProject, true); assert.equal(result.requestAcknowledged, false); assert.equal(result.reconciled, true);
    assert.equal(writes(h).length, 1);
    const unresolved = removeSetup(invalidAck, page([save()]));
    await assert.rejects(unresolved.api.remove(removed), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
    assert.equal(writes(unresolved).length, 1);
  }
});

test('remove still independently verifies absence after a structured acknowledgement', async () => {
  for (const acknowledgement of ['{"success":true}', '{"completed":true}', {}, { success: true }]) {
    const h = removeSetup(acknowledgement), result = await h.api.remove(removed);
    assert.equal(result.confirmed, true); assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
    assert.equal(h.operations.at(-1).method, 'GET');
  }
});

for (const [method, options, factory] of [['create', source, createSetup], ['rename', renamed, renameSetup], ['remove', removed, removeSetup]]) {
  test(`${method} can reconcile one uncertain write through exact readback without resending`, async () => {
    const h = factory(unknown()); const result = await h.api[method](options);
    assert.equal(result.confirmed, true); assert.equal(result.requestAcknowledged, false); assert.equal(result.reconciled, true);
    assert.equal(writes(h).length, 1);
  });
  test(`${method} preserves an unresolved delivery outcome when write and readback both fail`, async () => {
    const h = factory(unknown(), new DotError('EDGE_CHALLENGE', 'edge', { status: 403 }));
    await assert.rejects(h.api[method](options), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
    assert.equal(writes(h).length, 1);
  });
  test(`${method} revalidates identity after a write and never switches account for reconciliation`, async () => {
    const h = factory(() => { h.setAuth(authentication('different')); return method === 'remove' ? '' : save({ title: method === 'rename' ? 'New title' : 'Saved answer' }); });
    await assert.rejects(h.api[method](options), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.verificationCode === 'AUTH_IDENTITY_CHANGED' && error.details.delivery === 'unknown');
    assert.equal(writes(h).length, 1);
    assert.equal(h.operations.at(-1).method, method === 'create' ? 'POST' : method === 'rename' ? 'PATCH' : 'DELETE');
  });
}

test('create requires the acknowledged save identity to appear in exact source readback', async () => {
  const h = createSetup(save(), page([save({ id: 'different-save' })]));
  await assert.rejects(h.api.create(source), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted'); assert.equal(writes(h).length, 1);
});

test('create consumes the complete collection both before mutation and when finding its saved response afterward', async () => {
  const other = save({ id: 'untouched', message_id: 'other-message' });
  const h = setup(project(), page([other], 'before-next'), page(), conversation(), project(), save(), page([other], 'after-next'), page([save()]));
  const result = await h.api.create(source);
  assert.equal(result.save.id, saveId); assert.equal(result.confirmed, true);
  assert.deepEqual(h.operations.filter(call => call.path.endsWith('/saves') && call.method === 'GET').map(call => call.options.query.cursor), [null, 'before-next', null, 'after-next']);
  assert.equal(writes(h).length, 1);
});

test('a malformed acknowledgement may be reconciled only by the exact saved source', async () => {
  for (const invalidAck of [null, { success: true }, save({ conversation_id: 'wrong-conversation' })]) {
    const h = createSetup(invalidAck);
    const result = await h.api.create(source);
    assert.equal(result.reconciled, true); assert.equal(result.requestAcknowledged, false); assert.equal(result.save.id, saveId);
    assert.equal(writes(h).length, 1);
    const missing = createSetup(invalidAck, page());
    await assert.rejects(missing.api.create(source), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
    assert.equal(writes(missing).length, 1);
  }
});

test('rename cannot accept changed source identity or a different persisted title', async () => {
  for (const after of [save({ conversation_id: 'other-chat', title: 'New title' }), save({ message_id: 'other-message', title: 'New title' }), save()]) {
    const h = renameSetup(save({ title: 'New title' }), page([after]));
    await assert.rejects(h.api.rename(renamed), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted'); assert.equal(writes(h).length, 1);
  }
});

test('remove cannot report success while its exact save is still present', async () => {
  const h = removeSetup('', page([save()]));
  await assert.rejects(h.api.remove(removed), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted'); assert.equal(writes(h).length, 1);
});

test('all mutations detect lost or rebound unrelated saved sources in readback', async () => {
  const other = save({ id: 'untouched', message_id: 'other-message' });
  for (const rebound of [undefined, { ...other, conversation_id: 'unrelated-chat' }]) {
    const suffix = rebound ? [rebound] : [];
    const cases = [
      ['create', source, createSetup(save(), page([save(), ...suffix]), page([other]))],
      ['rename', renamed, renameSetup(save({ title: 'New title' }), page([save({ title: 'New title' }), ...suffix]), page([save(), other]))],
      ['remove', removed, removeSetup('', page(suffix), page([save(), other]))],
    ];
    for (const [method, options, h] of cases) { await assert.rejects(h.api[method](options), code('MUTATION_UNCONFIRMED')); assert.equal(writes(h).length, 1); }
  }
});
