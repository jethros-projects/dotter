import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountProjects, accountProjectCapabilities, PROJECT_THEMES } from '../src/account-projects.mjs';
import { commands, createClient } from '../src/command-sets/account-projects.mjs';
import { Transport } from '../src/transport.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct';
const projectId = 'g-p-abc';
const scoped = { accountId, projectId };
const membership = () => ({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } });
const authentication = (subject = 'user-1', selected = accountId) => ({ accountId: selected, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
function resource(overrides = {}, other = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'X', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: 'user-1' }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global', ...overrides }, files: [], ...other };
}
const entry = value => ({ gizmo: value, conversations: {} });
const pin = value => ({ item_type: 'project', item: value });
const code = expected => error => error.code === expected;
function setup(...responses) {
  const calls = [];
  let currentAuth = authentication(), currentMembership = membership();
  const transport = {
    authLoader: async () => currentAuth,
    request: async (method, path, options) => {
      const call = { method, path, options }; calls.push(call);
      if (path === '/backend-api/accounts/check/v4-2023-04-27') return currentMembership;
      const result = responses.shift();
      if (typeof result === 'function') return result(call);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { api: new AccountProjects({ transport }), transport, calls, setAuth: value => { currentAuth = value; }, setMembership: value => { currentMembership = value; }, get operations() { return calls.filter(call => !call.path.includes('/accounts/check/')); } };
}

test('project capability and manifest expose the nine native operations with explicit accounts', () => {
  assert.throws(() => new AccountProjects({}), TypeError);
  assert.ok(createClient({ transport: { request() {} } }) instanceof AccountProjects);
  assert.equal(Object.keys(commands).length, 9);
  const api = setup().api;
  assert.deepEqual(accountProjectCapabilities().supported, ['list', 'get', 'conversations', 'create', 'update', 'delete', 'pinned', 'pin', 'unpin']);
  for (const definition of Object.values(commands)) {
    assert.equal(typeof api[definition.method], 'function');
    assert.ok(definition.required.includes('accountId'));
    assert.equal(definition.flags['--account'].target, 'accountId');
  }
  assert.deepEqual(commands['account projects delete'].required, ['accountId', 'confirm', 'deleteChats']);
  assert.deepEqual(commands['account projects delete'].confirmMatch, [['confirm', 'projectId']]);
  assert.equal(commands['account projects delete'].flags['--delete-chats'].type, 'boolean');
});

test('all network operations reject absent accounts before any request', async () => {
  const h = setup();
  for (const method of ['list', 'get', 'conversations', 'create', 'update', 'delete', 'pinned', 'pin', 'unpin']) {
    await assert.rejects(h.api[method]({ projectId, name: 'New', confirm: projectId, deleteChats: true }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('project read pins account and requires fresh membership on every invocation', async () => {
  const h = setup(resource(), resource());
  await h.api.get(scoped); await h.api.get(scoped);
  assert.equal(h.calls.filter(call => call.path.includes('/accounts/check/')).length, 2);
  for (const call of h.calls) assert.equal(call.options.expectedAccountId, accountId);
  assert.deepEqual(h.operations[0], { method: 'GET', path: '/backend-api/gizmos/g-p-abc', options: { query: { include_file_limits: true }, expectedAccountId: accountId, signal: undefined, maxBytes: 4194304 } });
});

for (const [label, value] of [
  ['missing membership', {}],
  ['mismatched account', { accounts: { acct: { account: { account_id: 'other', account_user_id: 'user-1', structure: 'personal' }, can_access_with_session: true } } }],
  ['inaccessible account', { accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1', structure: 'personal' }, can_access_with_session: false } } }],
  ['missing owner', { accounts: { acct: { account: { account_id: accountId, structure: 'personal' }, can_access_with_session: true } } }],
]) test(`project reads reject ${label} before reading a resource`, async () => {
  const h = setup(); h.setMembership(value);
  await assert.rejects(h.api.get(scoped), code('ACCOUNT_MEMBERSHIP_UNVERIFIED'));
  assert.equal(h.operations.length, 0);
});

test('project reads reject missing identity, malformed JWT and changed account before HTTP', async () => {
  for (const value of [{ accountId, accessToken: 'invalid' }, authentication('user-1', 'other')]) {
    const h = setup(); h.setAuth(value);
    await assert.rejects(h.api.get(scoped), code(value.accountId === accountId ? 'AUTH_IDENTITY_REQUIRED' : 'ACCOUNT_CHANGED'));
    assert.equal(h.calls.length, 0);
  }
  const h = setup(); delete h.transport.authLoader;
  await assert.rejects(h.api.get(scoped), code('AUTH_IDENTITY_REQUIRED'));
  assert.equal(h.calls.length, 0);
});

test('real transport rejects a subject rotation before its first request', async () => {
  let loads = 0, requests = 0;
  const transport = new Transport({ authLoader: async () => authentication(++loads === 1 ? 'user-1' : 'user-2'), fetchImpl: async () => { requests++; return Response.json(membership()); } });
  await assert.rejects(new AccountProjects({ transport }).get(scoped), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(requests, 0);
});

test('subject rotation during fresh membership prevents the following project read', async () => {
  const h = setup(); const request = h.transport.request;
  h.transport.request = async (...args) => { const result = await request(...args); h.setAuth(authentication('user-2')); return result; };
  await assert.rejects(h.api.get(scoped), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.calls.length, 1);
});

test('same-subject token refresh is accepted without caching account membership', async () => {
  const h = setup(resource()); const request = h.transport.request;
  h.transport.request = async (...args) => { const value = await request(...args); h.setAuth({ ...authentication(), accessToken: `${authentication().accessToken}-refreshed` }); return value; };
  assert.equal((await h.api.get(scoped)).id, projectId);
});

test('detail projection keeps useful fields and excludes user email, tokens, URLs and opaque payloads', async () => {
  const h = setup(resource({ instructions: 'Useful instructions', author: { user_id: 'user-1', email: 'secret@example.com' }, signed_url: 'https://secret.invalid', access_token: 'private-token' }, { files: [{ file_response_type: 'full_file_response', file_id: 'file-1', library_file_id: 'lib-1', name: 'example.txt', type: 'text/plain', download_url: 'https://secret.invalid', access_token: 'private-token' }], token: 'private-token' }));
  const result = await h.api.get(scoped), output = JSON.stringify(result);
  assert.deepEqual(result.files, [{ fileId: 'file-1', metadataAvailable: true, libraryFileId: 'lib-1', name: 'example.txt', mimeType: 'text/plain' }]);
  assert.equal(result.fileCount, 1); assert.equal(result.instructions, 'Useful instructions'); assert.equal(result.owned, true);
  assert.doesNotMatch(output, /secret@example|secret\.invalid|private-token/);
});

for (const [label, value, errorCode] of [
  ['another project', resource({ id: 'g-p-other' }), 'INVALID_RESPONSE'],
  ['custom GPT', resource({ gizmo_type: 'gpt' }), 'INVALID_RESPONSE'],
  ['nonnative ID', resource({ id: 'g-abc' }), 'INVALID_RESPONSE'],
  ['hidden project', resource({ hidden: true }), 'INVALID_RESPONSE'],
  ['deleted project', resource({ deleted_at: 'now' }), 'INVALID_RESPONSE'],
  ['unreadable project', resource({ current_user_permission: { can_read: false } }), 'NOT_VISIBLE'],
  ['malformed files', resource({}, { files: {} }), 'INVALID_RESPONSE'],
  ['malformed file ID', resource({}, { files: [{ file_id: '../escape' }] }), 'INVALID_RESPONSE'],
  ['malformed sharing', resource({ sharing: { subjects: null } }), 'INVALID_RESPONSE'],
]) test(`detail rejects ${label}`, async () => {
  const h = setup(value); await assert.rejects(h.api.get(scoped), code(errorCode));
});

test('project list uses native sidebar pagination and deduplicates projects across pages', async () => {
  const other = resource({ id: 'g-p-other' });
  const h = setup({ items: [entry(resource())], cursor: 'page+1/=' }, { items: [entry(resource()), entry(other)], cursor: null });
  const result = await h.api.list({ accountId, limit: 2, pages: 3 });
  assert.deepEqual(result.items.map(item => item.id), [projectId, 'g-p-other']); assert.equal(result.pagesRead, 2); assert.equal(result.cursor, null);
  assert.deepEqual(h.operations.map(call => call.options.query), [{ conversations_per_gizmo: 0, cursor: null, limit: 2, owned_only: true }, { conversations_per_gizmo: 0, cursor: 'page+1/=', limit: 2, owned_only: true }]);
  assert.ok(h.operations.every(call => call.path === '/backend-api/gizmos/snorlax/sidebar'));
});

test('project list preserves a continuation cursor at its page bound', async () => {
  const h = setup({ items: [], cursor: 'next' });
  assert.deepEqual(await h.api.list({ accountId, cursor: 'start' }), { accountId, items: [], cursor: 'next', pagesRead: 1 });
});

test('owned-only list rejects foreign owners while accessible list projects them explicitly', async () => {
  const value = { items: [entry(resource({ author: { user_id: 'another' } }))], cursor: null };
  await assert.rejects(setup(value).api.list({ accountId }), code('INVALID_RESPONSE'));
  const h = setup(value); const result = await h.api.list({ accountId, ownedOnly: false });
  assert.equal(result.items[0].owned, false); assert.equal(h.operations[0].options.query.owned_only, false);
});

test('sidebar cursor cycles and malformed page shapes cannot produce unbounded requests', async () => {
  const cycle = setup({ items: [], cursor: 'loop' }, { items: [], cursor: 'loop' });
  await assert.rejects(cycle.api.list({ accountId, pages: 100 }), code('INVALID_RESPONSE')); assert.equal(cycle.operations.length, 2);
  for (const value of [{ items: [], cursor: '\n' }, { items: [entry(resource()), entry(resource())] }, { items: [{}] }, {}]) {
    await assert.rejects(setup(value).api.list({ accountId, limit: 1 }), code('INVALID_RESPONSE'));
  }
});

test('conversation pagination skips hidden/deleted records, deduplicates IDs and strips payload data', async () => {
  const h = setup(resource(), { items: [{ id: 'c-1', gizmo_id: projectId, title: 'First', messages: ['secret'], token: 'secret' }, { id: 'hidden', hidden: true }, { id: 'deleted', deleted_at: 'now' }], cursor: 'next' }, { items: [{ id: 'c-1', title: 'Duplicate' }, { id: 'c-2', title: 'Second', is_archived: true }], cursor: null });
  const result = await h.api.conversations({ ...scoped, limit: 3, pages: 2 });
  assert.deepEqual(result.items, [{ id: 'c-1', title: 'First' }, { id: 'c-2', title: 'Second', is_archived: true }]); assert.equal(result.pagesRead, 2);
  assert.equal(h.operations[1].path, '/backend-api/gizmos/g-p-abc/conversations');
  assert.deepEqual(h.operations[1].options.query, { cursor: null, limit: 3, owned_only: false });
});

test('conversation listing requires a visible project and rejects cross-project data and cursor cycles', async () => {
  const hidden = setup(resource({ hidden: true }));
  await assert.rejects(hidden.api.conversations(scoped), code('INVALID_RESPONSE')); assert.equal(hidden.operations.length, 1);
  await assert.rejects(setup(resource(), { items: [{ id: 'c-1', gizmo_id: 'g-p-other' }] }).api.conversations(scoped), code('INVALID_RESPONSE'));
  const cycle = setup(resource(), { items: [], cursor: 'next' }, { items: [], cursor: 'next' });
  await assert.rejects(cycle.api.conversations({ ...scoped, pages: 100 }), code('INVALID_RESPONSE')); assert.equal(cycle.operations.length, 3);
});

test('create sends native fields once and verifies exact persisted resource', async () => {
  const value = resource({ display: { name: 'New', emoji: '🌿', theme: '#04b84c' }, memory_scope: 'project_v2' });
  const h = setup({ resource: value }, value);
  const result = await h.api.create({ accountId, name: ' New ', emoji: '🌿', theme: 'green', memoryScope: 'project_v2' });
  assert.equal(result.confirmed, true); assert.equal(result.project.id, projectId);
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['POST', '/backend-api/projects'], ['GET', '/backend-api/gizmos/g-p-abc']]);
  assert.deepEqual(h.operations[0].options.body, { name: 'New', emoji: '🌿', theme: '#04b84c', instructions: '', memory_scope: 'project_v2' });
});

test('create does not replay unknown writes or silently accept a mismatched persisted name', async () => {
  for (const responses of [[new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' })], [{ resource: resource() }, resource({ display: { name: 'Wrong', emoji: null, theme: null } })], [{}]]) {
    const h = setup(...responses);
    await assert.rejects(h.api.create({ accountId, name: 'X' }), error => ['NETWORK_ERROR', 'MUTATION_UNCONFIRMED'].includes(error.code));
    assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
  }
});

for (const [label, overrides, other, expected] of [
  ['foreign owner', { author: { user_id: 'other' } }, {}, 'PROJECT_NOT_OWNED'],
  ['shared recipient', { share_recipient: 'workspace' }, {}, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['shared members', { sharing: { subjects: [{}] } }, {}, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['outer sharing subjects', {}, { hasSharingSubjects: true }, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['first-party project', { first_party_project_type: 'special' }, {}, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['special project', { gizmo_snorlax_type: 'special' }, {}, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['archived project', { is_archived: true }, {}, 'PROJECT_SCOPE_UNSUPPORTED'],
  ['missing write permission', { current_user_permission: { can_read: true, can_write: false, can_delete: true } }, {}, 'PROJECT_PERMISSION_DENIED'],
  ['nonboolean write permission', { current_user_permission: { can_read: true, can_write: 'yes', can_delete: true } }, {}, 'PROJECT_PERMISSION_DENIED'],
]) test(`creation cannot claim a confirmed private owned project from ${label}`, async () => {
  const h = setup({ resource: resource(overrides, other) });
  await assert.rejects(h.api.create({ accountId, name: 'X' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.verificationCode === expected && error.details.delivery === 'accepted');
  assert.deepEqual(h.operations.map(call => call.method), ['POST']);
});

test('update requires strictly true native write permission even for owned private projects', async () => {
  for (const can_write of [false, 'yes', 1, null, undefined]) {
    const h = setup(resource({ current_user_permission: { can_read: true, can_write, can_delete: true } }));
    await assert.rejects(h.api.update({ ...scoped, name: 'New' }), code('PROJECT_PERMISSION_DENIED'));
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('native write permission permits editing a shared project owned by another member', async () => {
  const shared = { author: { user_id: 'other' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'collaborator' }] }, current_user_permission: { can_read: true, can_write: true, can_delete: false } };
  const h = setup(resource(shared), {}, resource({ ...shared, display: { name: 'New', emoji: null, theme: null } }));
  const result = await h.api.update({ ...scoped, name: 'New' });
  assert.equal(result.confirmed, true); assert.equal(result.project.owned, false); assert.equal(result.project.private, false);
  assert.equal(h.operations.filter(call => call.method === 'PATCH').length, 1);
});

test('update merges untouched fields, supports clear flags and checks persisted changes', async () => {
  const before = resource({ display: { name: 'X', emoji: '🌿', theme: 'green' }, instructions: 'keep' });
  const after = resource({ display: { name: 'New', emoji: null, theme: 'green' }, instructions: 'keep' });
  const h = setup(before, {}, after);
  const result = await h.api.update({ ...scoped, name: 'New', clearEmoji: true });
  assert.equal(result.changed, true); assert.equal(result.confirmed, true);
  assert.deepEqual(h.operations[1].options.body, { name: 'New', emoji: null, theme: 'green', instructions: 'keep' });
  assert.equal(h.operations[1].path, '/backend-api/projects/g-p-abc'); assert.equal(h.operations[1].method, 'PATCH');
});

test('unchanged update reads fresh resource and does not write', async () => {
  const h = setup(resource()); const result = await h.api.update({ ...scoped, name: 'X' });
  assert.equal(result.changed, false); assert.equal(result.confirmed, true); assert.equal(h.operations.length, 1);
});

test('update readback mismatch preserves accepted outcome and never retries', async () => {
  const h = setup(resource(), {}, resource());
  await assert.rejects(h.api.update({ ...scoped, name: 'New' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted' && error.details.projectId === projectId);
  assert.equal(h.operations.filter(call => call.method === 'PATCH').length, 1);
});

test('update rejects a negative mutation acknowledgement before requesting readback', async () => {
  const h = setup(resource(), { success: false });
  await assert.rejects(h.api.update({ ...scoped, name: 'New' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
  assert.equal(h.operations.length, 2);
});

test('identity change after accepted write is surfaced as unknown delivery without a replay', async () => {
  const h = setup(resource(), () => { h.setAuth(authentication('other-user')); return {}; });
  await assert.rejects(h.api.update({ ...scoped, name: 'New' }), error => error.code === 'AUTH_IDENTITY_CHANGED' && error.details.delivery === 'unknown');
  assert.equal(h.operations.filter(call => call.method === 'PATCH').length, 1); assert.equal(h.operations.length, 2);
});

test('delete requires exact confirmation and an explicit acknowledgement that chats are deleted', async () => {
  const h = setup();
  for (const options of [{}, { confirm: 'other', deleteChats: true }, { confirm: projectId }, { confirm: projectId, deleteChats: 'true' }]) await assert.rejects(h.api.delete({ ...scoped, ...options }), code('CONFIRMATION_REQUIRED'));
  assert.equal(h.calls.length, 0);
});

test('delete requires delete permission and confirms absence only through the exact project 404', async () => {
  const h = setup(resource(), '', new DotError('HTTP_ERROR', 'missing', { status: 404 }));
  assert.deepEqual(await h.api.delete({ ...scoped, confirm: projectId, deleteChats: true }), { accountId, projectId, deleted: true, projectAbsenceVerified: true, containedChatDeletionRequested: true, confirmed: true });
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', '/backend-api/gizmos/g-p-abc'], ['DELETE', '/backend-api/gizmos/g-p-abc'], ['GET', '/backend-api/gizmos/g-p-abc']]);
  const denied = setup(resource({ current_user_permission: { can_read: true, can_write: true, can_delete: false } }));
  await assert.rejects(denied.api.delete({ ...scoped, confirm: projectId, deleteChats: true }), code('PROJECT_PERMISSION_DENIED'));
  assert.ok(denied.calls.every(call => call.method === 'GET'));
});

test('delete never treats an edge failure or a still-visible resource as confirmed absence', async () => {
  for (const after of [resource(), new DotError('EDGE_CHALLENGE', 'edge', { status: 403 })]) {
    const h = setup(resource(), '', after);
    await assert.rejects(h.api.delete({ ...scoped, confirm: projectId, deleteChats: true }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
    assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
  }
});

test('pinned list validates native item types and refuses duplicate project IDs', async () => {
  const h = setup([pin(resource())]); const result = await h.api.pinned({ accountId });
  assert.equal(result.items[0].id, projectId); assert.deepEqual(h.operations[0].options.query, { item_type: 'project' }); assert.equal(h.operations[0].path, '/backend-api/pins');
  for (const value of [[{ item_type: 'conversation', item: resource() }], [pin(resource()), pin(resource())], {}]) await assert.rejects(setup(value).api.pinned({ accountId }), code('INVALID_RESPONSE'));
});

for (const [method, before, after, verb, pinned] of [['pin', [], [pin(resource())], 'POST', true], ['unpin', [pin(resource())], [], 'DELETE', false]]) {
  test(`${method} reads fresh permissions, writes once and verifies exact pin membership`, async () => {
    const h = setup(resource(), before, '', after);
    assert.deepEqual(await h.api[method](scoped), { accountId, projectId, pinned, changed: true, confirmed: true });
    assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', '/backend-api/gizmos/g-p-abc'], ['GET', '/backend-api/pins'], [verb, '/backend-api/pins/project/g-p-abc'], ['GET', '/backend-api/pins']]);
  });
  test(`${method} avoids unnecessary writes when the requested state already exists`, async () => {
    const h = setup(resource(), after); const result = await h.api[method](scoped);
    assert.equal(result.changed, false); assert.equal(result.pinned, pinned); assert.ok(h.calls.every(call => call.method === 'GET'));
  });
  test(`${method} mismatch is unconfirmed and cannot replay the accepted write`, async () => {
    const h = setup(resource(), before, '', before);
    await assert.rejects(h.api[method](scoped), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
    assert.equal(h.operations.filter(call => call.method === verb && call.path.includes('/pins/project/')).length, 1);
  });
}

test('argument validation and abort prevent all authentication and requests', async () => {
  const h = setup(); let loads = 0; h.transport.authLoader = async () => { loads++; return authentication(); };
  for (const options of [{ projectId: '../escape' }, { projectId: 'g-abc' }, { projectId: 'g-p-' }]) await assert.rejects(h.api.get({ accountId, ...options }), code('INVALID_ARGUMENT'));
  for (const options of [{ limit: 0 }, { pages: 101 }, { cursor: '\n' }, { ownedOnly: 'true' }]) await assert.rejects(h.api.list({ accountId, ...options }), code('INVALID_ARGUMENT'));
  for (const options of [{}, { clearEmoji: true, emoji: 'x' }, { clearTheme: true, theme: 'green' }, { instructions: '\0' }, { instructions: 'x'.repeat(8001) }, { name: ' ' }, { name: 'x'.repeat(51) }]) await assert.rejects(h.api.update({ ...scoped, ...options }), code('INVALID_ARGUMENT'));
  await assert.rejects(h.api.update({ ...scoped, memoryScope: 'project_v2' }), code('UNSUPPORTED'));
  await assert.rejects(h.api.create({ accountId, name: 'X', memoryScope: 'invalid' }), code('INVALID_ARGUMENT'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.get({ ...scoped, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(loads, 0); assert.equal(h.calls.length, 0);
});

test('project themes map all native symbolic palette names to their wire values', async () => {
  assert.deepEqual(PROJECT_THEMES, { black: null, blue: '#0285ff', green: '#04b84c', orange: '#fb6a22', pink: '#ff66ad', purple: '#924ff7', red: '#fa423e', yellow: '#ffc300' });
  for (const [theme, wire] of Object.entries(PROJECT_THEMES)) {
    const value = resource({ display: { name: 'New', emoji: null, theme: wire } });
    const h = setup({ resource: value }, value);
    const result = await h.api.create({ accountId, name: 'New', theme });
    assert.equal(h.operations[0].options.body.theme, wire);
    assert.equal(result.project.theme, wire);
  }
  const h = setup();
  for (const theme of ['constructor', '#04b84c', 'GREEN', '', null]) await assert.rejects(h.api.create({ accountId, name: 'New', theme }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('update serializes selected themes and explicit clears without changing memory scope', async () => {
  const blue = resource({ display: { name: 'X', emoji: null, theme: '#0285ff' } });
  const h = setup(resource(), {}, blue, blue, {}, resource());
  assert.equal((await h.api.update({ ...scoped, theme: 'blue' })).project.theme, '#0285ff');
  assert.equal((await h.api.update({ ...scoped, clearTheme: true })).project.theme, null);
  const writes = h.operations.filter(call => call.method === 'PATCH');
  assert.equal(writes[0].options.body.theme, '#0285ff'); assert.equal(writes[1].options.body.theme, null);
  assert.ok(writes.every(call => !Object.hasOwn(call.options.body, 'memory_scope')));
});

test('private or internal conversation metadata cannot leak through an account project listing', async () => {
  const inaccessible = [
    { metadata: { is_hidden: true } }, { metadata: { visibility: 'HIDDEN' } },
    { is_private: true }, { channel: 'analysis' }, { channel: 'commentary', recipient: 'python' },
    { is_visually_hidden_from_conversation: true }, { metadata: { metadata: { hidden: true } } },
  ].map((fields, index) => ({ id: `hidden-${index}`, title: 'private payload', ...fields }));
  const h = setup(resource(), { items: [...inaccessible, { id: 'visible', title: 'Visible', channel: 'final', recipient: 'all', metadata: {} }], cursor: null });
  const result = await h.api.conversations({ ...scoped, limit: 20 });
  assert.deepEqual(result.items, [{ id: 'visible', title: 'Visible' }]);
});

test('nonboolean deletion permissions never authorize a destructive request', async () => {
  const h = setup(resource({ current_user_permission: { can_read: true, can_write: true, can_delete: 1 } }));
  await assert.rejects(h.api.delete({ ...scoped, confirm: projectId, deleteChats: true }), code('PROJECT_PERMISSION_DENIED'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('creation sends explicit unset memory scope by default and accepts its server-resolved scope', async () => {
  const h = setup({ resource: resource() }, resource());
  const result = await h.api.create({ accountId, name: 'X' });
  assert.equal(h.operations[0].options.body.memory_scope, 'unset');
  assert.equal(result.project.memoryScope, 'global');
  assert.deepEqual(accountProjectCapabilities().creationMemoryScopes, ['unset', 'global', 'project_v2']);
});

test('creation checks explicit global and project scopes on both acknowledgement and readback', async () => {
  for (const memoryScope of ['global', 'project_v2']) {
    const value = resource({ memory_scope: memoryScope }), h = setup({ resource: value }, value);
    assert.equal((await h.api.create({ accountId, name: 'X', memoryScope })).project.memoryScope, memoryScope);
    assert.equal(h.operations[0].options.body.memory_scope, memoryScope);
    const mismatch = setup({ resource: value }, resource({ memory_scope: memoryScope === 'global' ? 'project_v2' : 'global' }));
    await assert.rejects(mismatch.api.create({ accountId, name: 'X', memoryScope }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
    assert.equal(mismatch.operations.filter(call => call.method === 'POST').length, 1);
  }
});

test('deletion uses native delete permission for a shared nonowned project', async () => {
  const shared = resource({ author: { user_id: 'other' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'collaborator' }] }, current_user_permission: { can_read: true, can_write: false, can_delete: true } });
  const h = setup(shared, '', new DotError('HTTP_ERROR', 'missing', { status: 404 }));
  assert.equal((await h.api.delete({ ...scoped, confirm: projectId, deleteChats: true })).deleted, true);
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('special project subtype cannot be deleted even if native delete permission is true', async () => {
  const h = setup(resource({ gizmo_snorlax_type: 'special' }));
  await assert.rejects(h.api.delete({ ...scoped, confirm: projectId, deleteChats: true }), code('PROJECT_SCOPE_UNSUPPORTED'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('pin and unpin need readable access without ownership, private scope or write permission', async () => {
  const shared = resource({ author: { user_id: 'other' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'collaborator' }] }, current_user_permission: { can_read: true, can_write: false, can_delete: false } });
  const h = setup(shared, [], '', [pin(shared)], shared, [pin(shared)], '', []);
  assert.equal((await h.api.pin(scoped)).pinned, true);
  assert.equal((await h.api.unpin(scoped)).pinned, false);
  assert.deepEqual(h.operations.filter(call => call.method !== 'GET').map(call => call.method), ['POST', 'DELETE']);
});

test('pin cannot mutate an unreadable project even when write permission is true', async () => {
  const h = setup(resource({ current_user_permission: { can_read: false, can_write: true, can_delete: true } }));
  await assert.rejects(h.api.pin(scoped), code('NOT_VISIBLE'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('instructions accept the native 8000-character boundary and preserve multiline text', async () => {
  const instructions = `Line one\n${'x'.repeat(7991)}`;
  assert.equal(instructions.length, 8000);
  const h = setup(resource(), {}, resource({ instructions }));
  assert.equal((await h.api.update({ ...scoped, instructions })).project.instructions, instructions);
  assert.equal(h.operations[1].options.body.instructions, instructions);
});

test('opaque native project file variants expose only their identifier', async () => {
  const h = setup(resource({}, { files: [
    { id: 'file-id-only' },
    { file_id: 'file-not-full', name: 'private-name', type: 'private-mime', signed_url: 'https://private.invalid', contents: 'private-content' },
    { file_response_type: 'future_variant', id: 'file-future', name: 'private-name' },
    { file_response_type: 'full_file_response', id: 'file-without-native-file-id', name: 'private-name' },
    { file_response_type: 'full_file_response', file_id: '', id: 'file-with-empty-native-file-id', name: 'private-name' },
  ] }));
  const result = await h.api.get(scoped);
  assert.deepEqual(result.files, [
    { id: 'file-id-only', metadataAvailable: false },
    { id: 'file-not-full', metadataAvailable: false },
    { id: 'file-future', metadataAvailable: false },
    { id: 'file-without-native-file-id', metadataAvailable: false },
    { id: 'file-with-empty-native-file-id', metadataAvailable: false },
  ]);
  assert.equal(result.fileCount, 5);
  assert.doesNotMatch(JSON.stringify(result), /private-name|private-mime|private\.invalid|private-content/);
});

test('visibility and removal flags exclude private conversation records at every metadata level', async () => {
  const flags = [
    ...['visible', 'is_visible', 'user_visible', 'is_user_visible'].map(key => ({ [key]: false })),
    ...['deleted', 'is_deleted', 'removed', 'is_removed', 'private', 'is_private', 'internal', 'is_internal', 'redacted', 'is_redacted'].map(key => ({ [key]: true })),
    ...['hidden', 'INTERNAL', 'deleted', 'Redacted'].map(visibility => ({ visibility })),
    { deletedAt: '2026-10-18' }, { removed_at: '2026-10-18' },
  ];
  const rows = flags.flatMap((flag, index) => [
    { id: `direct-${index}`, title: 'private-title', ...flag },
    { id: `metadata-${index}`, title: 'private-title', metadata: flag },
    { id: `nested-${index}`, title: 'private-title', metadata: { metadata: flag } },
  ]);
  const h = setup(resource(), { items: rows.slice(0, 50), cursor: 'next' }, { items: [...rows.slice(50), { id: 'visible', title: 'Visible' }], cursor: null });
  assert.deepEqual((await h.api.conversations({ ...scoped, limit: 50, pages: 2 })).items, [{ id: 'visible', title: 'Visible' }]);
});

test('sidebar limit accepts the verified 50 boundary and rejects larger limits before authentication', async () => {
  const allowed = setup({ items: [], cursor: null });
  assert.equal((await allowed.api.list({ accountId, limit: 50 })).pagesRead, 1);
  assert.equal(allowed.operations[0].options.query.limit, 50);
  for (const limit of [51, 100]) {
    const h = setup(); let loads = 0;
    h.transport.authLoader = async () => { loads++; return authentication(); };
    await assert.rejects(h.api.list({ accountId, limit }), code('INVALID_ARGUMENT'));
    assert.equal(loads, 0); assert.equal(h.calls.length, 0);
  }
});

test('conversation pagination honors the independently verified 50 boundary', async () => {
  const h = setup(resource(), { items: [], cursor: null });
  assert.equal((await h.api.conversations({ ...scoped, limit: 50 })).pagesRead, 1);
  assert.equal(h.operations[1].options.query.limit, 50);
  for (const limit of [51, 100]) {
    const invalid = setup();
    await assert.rejects(invalid.api.conversations({ ...scoped, limit }), code('INVALID_ARGUMENT'));
    assert.equal(invalid.calls.length, 0);
  }
});

test('sidebar accepts present unused conversation fields without requiring an object', async () => {
  for (const conversations of [null, [], [{ id: 'unused', contents: 'private payload' }]]) {
    const h = setup({ items: [{ gizmo: resource(), conversations }], cursor: null });
    const result = await h.api.list({ accountId });
    assert.equal(result.items[0].id, projectId);
    assert.doesNotMatch(JSON.stringify(result), /private payload|unused/);
  }
  const missing = setup({ items: [{ gizmo: resource() }], cursor: null });
  await assert.rejects(missing.api.list({ accountId }), code('INVALID_RESPONSE'));
});

test('workspace policy denial prevents every project lifecycle mutation', async () => {
  const workspaceMembership = membership();
  workspaceMembership.accounts.acct.account.structure = 'workspace';
  for (const [method, options, responses] of [
    ['create', { accountId, name: 'New' }, [{ permissions: [] }]],
    ['update', { ...scoped, name: 'New' }, [resource(), { permissions: [] }]],
    ['delete', { ...scoped, confirm: projectId, deleteChats: true }, [resource(), { permissions: [] }]],
  ]) {
    const h = setup(...responses); h.setMembership(workspaceMembership);
    await assert.rejects(h.api[method](options), code('PROJECT_PERMISSION_DENIED'));
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('workspace policy must be available and typed before editing a project', async () => {
  const workspaceMembership = membership(); workspaceMembership.accounts.acct.account.structure = 'workspace';
  for (const settings of [{}, { permissions: undefined }, { permissions: true }, { permissions: [1] }]) {
    const h = setup(resource(), settings); h.setMembership(workspaceMembership);
    await assert.rejects(h.api.update({ ...scoped, name: 'New' }), error => ['PROJECT_ELIGIBILITY_UNVERIFIED', 'INVALID_RESPONSE'].includes(error.code));
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('workspace project CRUD accepts native null or explicit permission and keeps account scope', async () => {
  for (const permissions of [null, ['chatgpt.workspace.project.crud']]) {
    const workspaceMembership = membership(); workspaceMembership.accounts.acct.account.structure = 'workspace';
    const updated = resource({ display: { name: 'New', emoji: null, theme: null } });
    const h = setup(resource(), { permissions }, {}, updated); h.setMembership(workspaceMembership);
    assert.equal((await h.api.update({ ...scoped, name: 'New' })).confirmed, true);
    const check = h.operations.find(call => call.path === '/backend-api/accounts/acct/settings');
    assert.equal(check.method, 'GET'); assert.equal(check.options.expectedAccountId, accountId);
    assert.equal(h.operations.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('shared project context exposes only the bounded account facts used by native gates', async () => {
  const value = membership();
  Object.assign(value.accounts.acct.account, { plan_type: 'plus', account_user_role: 'owner', access_token: 'private', billing: { secret: true } });
  const h = setup(); h.setMembership(value);
  const context = await h.api._context(accountId);
  assert.deepEqual(context.account, { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal', plan_type: 'plus', account_user_role: 'owner' });
  assert.ok(Object.isFrozen(context.account));
  assert.doesNotMatch(JSON.stringify(context.account), /private|secret|billing/);
});
