import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSharing, projectSharingCapabilities } from '../src/project-sharing.mjs';
import { commands, createClient } from '../src/command-sets/project-sharing.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct', projectId = 'g-p-sharing';
const options = { accountId, projectId, confirm: projectId };
const CHAT = { can_read: true, can_view_config: true, can_write: false, can_delete: false, can_export: false, can_share: false };
const EDIT = { ...CHAT, can_write: true };
const PRIVATE = { ...CHAT, can_view_config: false };
const user = (userId = 'collaborator', caps = CHAT, extra = {}) => ({ type: 1, user_id: userId, capabilities: caps, ...extra });
const group = (groupId = 'team', caps = CHAT) => ({ type: 2, group_id: groupId, capabilities: caps });
const invited = (address = 'person@example.com', caps = CHAT) => ({ type: 10, user_email: address, capabilities: caps });
const visibility = (type = 4) => ({ type, capabilities: CHAT });
function resource(subjects = [], overrides = {}, extra = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Sharing fixture', emoji: null, theme: null }, instructions: '', memory_scope: 'global', share_recipient: subjects.some(item => item.type === 4) ? 'link' : subjects.some(item => item.type === 3) ? 'workspace_link' : subjects.length ? 'user' : 'private', author: { user_id: 'owner', user_email: 'owner@example.com' }, current_user_permission: { can_read: true, can_write: true, can_share: true, can_delete: true }, sharing: { subjects }, ...overrides }, files: [], has_tpp_conversation: false, ...extra };
}
function setup(responses = [], { workspace = false, settings = { permissions: ['chatgpt.workspace.project.share', 'chatgpt.workspace.project.crud', 'chatgpt.workspace.project.share_workspace'] }, owner = 'owner__acct' } = {}) {
  let auth = { accountId, accessToken: `a.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.z` };
  const calls = [], account = { account_id: accountId, account_user_id: owner, structure: workspace ? 'workspace' : 'personal' };
  const transport = { authLoader: async () => auth, request: async (method, path, request) => {
    const call = { method, path, request }; calls.push(call);
    if (path.includes('/accounts/check/')) return { accounts: { [accountId]: { account, can_access_with_session: true } } };
    if (path === '/backend-api/accounts/acct/settings') return settings;
    const value = responses.shift(); if (value instanceof Error) throw value; if (typeof value === 'function') return value(call); return value;
  } };
  return { api: new ProjectSharing({ transport }), calls, transport, account, setAuth: value => { auth = value; }, get projectCalls() { return calls.filter(call => !call.path.includes('/accounts/')); }, get writes() { return calls.filter(call => call.method !== 'GET'); } };
}
const code = value => error => error.code === value;

test('sharing exposes five executable descriptors with explicit account and mutation confirmation', () => {
  assert.ok(createClient({ transport: { request() {} } }) instanceof ProjectSharing);
  assert.deepEqual(projectSharingCapabilities().supported, ['get', 'access', 'invite', 'role', 'remove']);
  assert.equal(Object.keys(commands).length, 5);
  for (const entry of Object.values(commands)) {
    assert.equal(typeof setup().api[entry.method], 'function');
    assert.ok(entry.required.includes('accountId'));
    if (entry.method !== 'get') assert.deepEqual(entry.confirmMatch, [['confirm', 'projectId']]);
  }
});

test('sharing read returns safe subjects, usable keys and native project URL', async () => {
  const value = resource([user('collaborator', CHAT, { access_token: 'sensitive', user_email: 'Person@Example.com' }), group(), invited(), visibility()]);
  value.gizmo.secret = 'sensitive';
  const h = setup([value]); const result = await h.api.get(options);
  assert.equal(result.access, 'link'); assert.equal(result.url, 'https://chatgpt.com/g/g-p-sharing/project');
  assert.deepEqual(result.subjects.map(item => item.key), ['user:collaborator', 'group:team', 'email:person@example.com', 'visibility:4']);
  assert.equal(result.subjects[0].email, 'person@example.com'); assert.doesNotMatch(JSON.stringify(result), /sensitive|owner@example/);
  assert.deepEqual(result.permissions, { canOpen: true, canInvite: true, canManage: true, canShareWorkspaceLink: false });
});

test('workspace sharing reads fresh policy each call and binds every request to account', async () => {
  const h = setup([resource(), resource()], { workspace: true });
  await h.api.get(options); await h.api.get(options);
  assert.equal(h.calls.filter(call => call.path.endsWith('/settings')).length, 2);
  assert.equal(h.calls.filter(call => call.path.includes('/accounts/check/')).length, 2);
  assert.ok(h.calls.every(call => call.request.expectedAccountId === accountId));
});

test('workspace policy falls back to beta project sharing only when permissions are absent', async () => {
  for (const [settings, expected] of [[{ beta_settings: { project_sharing: true } }, true], [{ beta_settings: { project_sharing: false } }, false], [{ permissions: [], beta_settings: { project_sharing: true } }, false]]) {
    const h = setup([resource()], { workspace: true, settings });
    assert.equal((await h.api.get(options)).permissions.canManage, expected);
  }
});

test('native owner sharing comparison strips account suffixes in a workspace', async () => {
  const h = setup([resource([], { author: { user_id: 'owner__other' } })], { workspace: true });
  assert.equal((await h.api.get(options)).permissions.canManage, true);
});

test('shared workspace owner can reduce access after new invitations are disabled by policy', async () => {
  const h = setup([resource([visibility()]), {}, resource()], { workspace: true, settings: { permissions: ['chatgpt.workspace.project.crud'] } });
  const result = await h.api.access({ ...options, access: 'private' });
  assert.equal(result.changed, true); assert.equal(result.permissions.canInvite, false);
});

test('workspace collaborator can invite with write and workspace permissions but cannot manage', async () => {
  const before = resource([], { author: { user_id: 'someone_else' }, current_user_permission: { can_read: true, can_write: true, can_share: false } });
  const after = resource([invited('person@example.com', EDIT)], { author: before.gizmo.author, current_user_permission: before.gizmo.current_user_permission });
  const h = setup([before, {}, after], { workspace: true });
  assert.equal((await h.api.invite({ ...options, subjects: [{ type: 'email', email: 'person@example.com' }] })).changed, true);
  const denied = setup([before], { workspace: true });
  await assert.rejects(denied.api.access({ ...options, access: 'workspace_link' }), code('PROJECT_PERMISSION_DENIED')); assert.equal(denied.writes.length, 0);
});

test('personal sharing changes one native access subject and preserves collaborators', async () => {
  const h = setup([resource([user()]), {}, resource([user(), visibility()])]);
  const result = await h.api.access({ ...options, access: 'link' });
  assert.equal(result.changed, true); assert.equal(result.confirmed, true);
  assert.deepEqual(h.writes[0].request.body, { project_id: projectId, add_or_replace: [{ type: 'link', capabilities: CHAT }] });
  assert.equal(h.writes.length, 1); assert.equal(h.projectCalls.length, 3);
});

test('private means invited-only and retains existing members while removing link subject', async () => {
  const h = setup([resource([user(), visibility()]), {}, resource([user()])]);
  const result = await h.api.access({ ...options, access: 'private' });
  assert.equal(result.access, 'private'); assert.equal(result.shared, true);
  assert.deepEqual(h.writes[0].request.body.add_or_replace, [{ type: 'private', capabilities: PRIVATE }]);
});

test('workspace cannot publish a public link, and workspace-link permission is checked', async () => {
  for (const [access, settings] of [['link', undefined], ['workspace_link', { permissions: ['chatgpt.workspace.project.share', 'chatgpt.workspace.project.crud'] }]]) {
    const h = setup([resource()], { workspace: true, ...(settings ? { settings } : {}) });
    await assert.rejects(h.api.access({ ...options, access }), code('PROJECT_PERMISSION_DENIED')); assert.equal(h.writes.length, 0);
  }
});

test('owner, current write/share capability and supported project subtype guard management', async () => {
  for (const override of [{ author: { user_id: 'other' } }, { current_user_permission: { can_read: true, can_write: false, can_share: true } }, { current_user_permission: { can_read: true, can_write: true, can_share: false } }, { gizmo_snorlax_type: 'potion' }]) {
    const h = setup([resource([], override)]);
    await assert.rejects(h.api.access({ ...options, access: 'link' }), code('PROJECT_PERMISSION_DENIED')); assert.equal(h.writes.length, 0);
  }
});

test('first sharing requires explicit Library detachment acknowledgment and verifies absence', async () => {
  const file = { file_response_type: 'full_file_response', file_id: 'file-source', library_file_id: 'library-source', name: 'Source' };
  const h = setup([resource([], {}, { files: [file] })]);
  await assert.rejects(h.api.access({ ...options, access: 'link' }), error => error.code === 'CONFIRMATION_REQUIRED' && error.details.libraryFilesToDetach === 1);
  assert.equal(h.writes.length, 0);
  const successful = setup([resource([], {}, { files: [file] }), {}, resource([visibility()])]);
  assert.equal((await successful.api.access({ ...options, access: 'link', detachLibraryFiles: true })).detachedLibraryFileCount, 1);
  const retained = setup([resource([], {}, { files: [file] }), {}, resource([visibility()], {}, { files: [file] })]);
  await assert.rejects(retained.api.access({ ...options, access: 'link', detachLibraryFiles: true }), code('MUTATION_UNCONFIRMED'));
  assert.equal(retained.writes.length, 1);
});

test('first-sharing detachment verifies id-only Library sources by their native fallback ID', async () => {
  for (const file of [{ file_response_type: 'full_file_response', id: 'opaque-file', library_file_id: 'library-source' }, { file_response_type: 'full_file_response', file_id: '', id: 'opaque-file', library_file_id: 'library-source' }]) {
    const h = setup([resource([], {}, { files: [file] }), {}, resource([visibility()], {}, { files: [file] })]);
    await assert.rejects(h.api.access({ ...options, access: 'link', detachLibraryFiles: true }), code('MUTATION_UNCONFIRMED'));
    assert.equal(h.writes.length, 1);
  }
});

test('Work projects reject link expansion, new invitations and role increases', async () => {
  const extra = { has_tpp_conversation: true };
  for (const [method, fields, subjects] of [['access', { access: 'link' }, []], ['invite', { subjects: [{ type: 'email', email: 'person@example.com' }] }, []], ['role', { subject: 'user:collaborator', role: 'edit' }, [user()]]]) {
    const h = setup([resource(subjects, {}, extra)]);
    await assert.rejects(h.api[method]({ ...options, ...fields }), code('PROJECT_WORK_CONVERSATIONS')); assert.equal(h.writes.length, 0);
  }
});

test('Work projects permit removing a collaborator and downgrading a role', async () => {
  const extra = { has_tpp_conversation: true };
  const h = setup([resource([user()], {}, extra), {}, resource([], {}, extra)]);
  assert.equal((await h.api.remove({ ...options, subject: 'user:collaborator' })).changed, true);
  const r = setup([resource([user('collaborator', EDIT)], {}, extra), {}, resource([user()], {}, extra)]);
  assert.equal((await r.api.role({ ...options, subject: 'user:collaborator', role: 'chat' })).changed, true);
});

test('invitation uses native email shape, preserves current visibility and verifies converted recipient', async () => {
  const h = setup([resource([visibility()]), {}, resource([visibility(), user('new-user', EDIT, { user_email: 'person@example.com' })])]);
  const result = await h.api.invite({ ...options, subjects: [{ type: 'email', email: 'Person@Example.com' }] });
  assert.equal(result.confirmed, true);
  assert.deepEqual(h.writes[0].request.body, { project_id: projectId, add_or_replace: [{ type: 'email', user_email: 'person@example.com', capabilities: EDIT }, { type: 'link', capabilities: CHAT }] });
});

test('workspace invitation qualifies user IDs once and carries explicit group identity', async () => {
  const subjects = [{ type: 'user', userId: 'member' }, { type: 'user', userId: 'member2__acct' }, { type: 'group', groupId: 'team' }];
  const h = setup([resource(), {}, resource([user('member__acct'), user('member2__acct'), group()])], { workspace: true });
  await h.api.invite({ ...options, subjects, role: 'chat' });
  assert.deepEqual(h.writes[0].request.body.add_or_replace.map(item => [item.type, item.user_id ?? item.group_id]), [['user', 'member__acct'], ['user', 'member2__acct'], ['group', 'team'], ['private', undefined]]);
});

test('duplicate and owner invitations do not send a mutation', async () => {
  const existing = setup([resource([invited('person@example.com', CHAT)])]);
  assert.equal((await existing.api.invite({ ...options, subjects: [{ type: 'email', email: 'person@example.com' }] })).changed, false);
  assert.equal(existing.writes.length, 0);
  const owner = setup([resource()]);
  await assert.rejects(owner.api.invite({ ...options, subjects: [{ type: 'email', email: 'owner@example.com' }] }), code('INVALID_ARGUMENT'));
  assert.equal(owner.writes.length, 0);
});

test('personal account rejects workspace-only user/group recipient constructors', async () => {
  for (const recipient of [{ type: 'user', userId: 'member' }, { type: 'group', groupId: 'team' }]) {
    const h = setup([resource()]); await assert.rejects(h.api.invite({ ...options, subjects: [recipient] }), code('INVALID_ARGUMENT')); assert.equal(h.writes.length, 0);
  }
});

test('workspace invitations enforce five-email batch bound and selected-account user suffix', async () => {
  const subjects = Array.from({ length: 6 }, (_, index) => ({ type: 'email', email: `person${index}@example.com` }));
  const h = setup([resource()], { workspace: true });
  await assert.rejects(h.api.invite({ ...options, subjects }), code('INVALID_ARGUMENT')); assert.equal(h.writes.length, 0);
  const wrong = setup([resource()], { workspace: true });
  await assert.rejects(wrong.api.invite({ ...options, subjects: [{ type: 'user', userId: 'member__other' }] }), code('INVALID_ARGUMENT')); assert.equal(wrong.writes.length, 0);
});

test('role and removal target freshly returned subjects, preserving native visibility', async () => {
  const h = setup([resource([group(), visibility(3)]), {}, resource([group('team', EDIT), visibility(3)])], { workspace: true });
  await h.api.role({ ...options, subject: 'group:team', role: 'edit' });
  assert.deepEqual(h.writes[0].request.body.add_or_replace, [{ type: 'group', group_id: 'team', capabilities: EDIT }, { type: 'workspace_link', capabilities: CHAT }]);
  const removal = setup([resource([user('collaborator__acct'), visibility(3)]), {}, resource([visibility(3)])], { workspace: true });
  await removal.api.remove({ ...options, subject: 'user:collaborator' });
  assert.deepEqual(removal.writes[0].request.body.remove, [{ type: 'user', user_id: 'collaborator__acct', capabilities: CHAT }]);
});

test('missing targets, unchanged role and unchanged access avoid all writes', async () => {
  const missing = setup([resource()]); await assert.rejects(missing.api.remove({ ...options, subject: 'user:absent' }), code('PROJECT_SUBJECT_NOT_FOUND')); assert.equal(missing.writes.length, 0);
  const role = setup([resource([user()])]); assert.equal((await role.api.role({ ...options, subject: 'user:collaborator', role: 'chat' })).changed, false); assert.equal(role.writes.length, 0);
  const access = setup([resource()]); assert.equal((await access.api.access({ ...options, access: 'private' })).changed, false); assert.equal(access.writes.length, 0);
});

test('writes require exact project confirmation before auth or HTTP', async () => {
  for (const [method, fields] of [['access', { access: 'link' }], ['invite', { subjects: [{ type: 'email', email: 'person@example.com' }] }], ['role', { subject: 'group:team', role: 'edit' }], ['remove', { subject: 'group:team' }]]) {
    const h = setup(); await assert.rejects(h.api[method]({ ...options, ...fields, confirm: 'other' }), code('CONFIRMATION_REQUIRED')); assert.equal(h.calls.length, 0);
  }
});

test('malformed input recipients, duplicate identities and capability injection fail before HTTP', () => {
  for (const subjects of [[], [{ type: 'email', email: 'invalid' }], [{ type: 'email', email: 'x@example.com', capabilities: EDIT }], [{ type: 'user', userId: '../bad' }], [{ type: 'email', email: 'x@example.com' }, { type: 'email', email: 'X@example.com' }], [{ type: 'admin', userId: 'x' }]]) {
    const h = setup(); assert.throws(() => h.api.invite({ ...options, subjects }), code('INVALID_ARGUMENT')); assert.equal(h.calls.length, 0);
  }
});

test('unsafe subject shapes and unknown capability schema fail closed before mutation', async () => {
  for (const subjects of [[{ type: 9, capabilities: CHAT }], [user('../bad')], [user('member', { ...CHAT, can_admin: true })], [user('member', { can_write: true })], [group(), group()]]) {
    const h = setup([resource(subjects)]); await assert.rejects(h.api.access({ ...options, access: 'link' }), code('INVALID_RESPONSE')); assert.equal(h.writes.length, 0);
  }
});

test('sharing ownership and Work markers must have their native types', async () => {
  for (const value of [resource([], { author: null }), resource([], { author: { user_id: '../bad' } }), resource([], {}, { has_tpp_conversation: 'false' })]) {
    const h = setup([value]); await assert.rejects(h.api.access({ ...options, access: 'link' }), code('INVALID_RESPONSE')); assert.equal(h.writes.length, 0);
  }
});

test('wrong project or hidden read cannot be used as sharing preflight', async () => {
  for (const override of [{ id: 'g-p-other' }, { hidden: true }, { current_user_permission: { can_read: false } }]) {
    const h = setup([resource([], override)]); await assert.rejects(h.api.access({ ...options, access: 'link' })); assert.equal(h.writes.length, 0);
  }
});

test('malformed or unreadable workspace policy cannot authorize a write', async () => {
  for (const settings of [null, { permissions: 'allow' }, { permissions: [true] }, { beta_settings: 'allow' }]) {
    const h = setup([resource()], { workspace: true, settings }); await assert.rejects(h.api.access({ ...options, access: 'workspace_link' }), code('INVALID_RESPONSE')); assert.equal(h.writes.length, 0);
  }
});

test('accepted mutations with mismatched state or failed verification are never replayed', async () => {
  for (const after of [resource(), new DotError('EDGE_BLOCKED', 'challenge'), resource([visibility(), user()])]) {
    const h = setup([resource(), {}, after]); await assert.rejects(h.api.access({ ...options, access: 'link' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted'); assert.equal(h.writes.length, 1);
  }
});

test('one returned subject cannot verify two expected subjects that share an email', async () => {
  const before = resource([user('one', CHAT, { user_email: 'same@example.com' }), user('two', CHAT, { user_email: 'same@example.com' })]);
  const after = resource([user('one', CHAT, { user_email: 'same@example.com' }), user('unrelated'), visibility()]);
  const h = setup([before, {}, after]);
  await assert.rejects(h.api.access({ ...options, access: 'link' }), code('MUTATION_UNCONFIRMED'));
  assert.equal(h.writes.length, 1);
});

test('a different existing user ID cannot satisfy readback merely by sharing an email', async () => {
  const h = setup([resource([user('one', CHAT, { user_email: 'same@example.com' })]), {}, resource([user('other', CHAT, { user_email: 'same@example.com' }), visibility()])]);
  await assert.rejects(h.api.access({ ...options, access: 'link' }), code('MUTATION_UNCONFIRMED'));
  assert.equal(h.writes.length, 1);
});

test('explicit server rejection is not success; wrong mutation resource does not read back another project', async () => {
  const rejected = setup([resource(), { error: 'not_allowed' }]); await assert.rejects(rejected.api.access({ ...options, access: 'link' }), code('PROJECT_PERMISSION_DENIED')); assert.equal(rejected.writes.length, 1);
  const wrong = setup([resource(), { resource: resource([], { id: 'g-p-other' }) }]); await assert.rejects(wrong.api.access({ ...options, access: 'link' }), code('MUTATION_UNCONFIRMED')); assert.equal(wrong.projectCalls.length, 2);
});

test('unknown write delivery is preserved without automatic retry', async () => {
  const failure = new DotError('NETWORK_ERROR', 'Disconnected', { delivery: 'unknown' });
  const h = setup([resource(), failure]); await assert.rejects(h.api.access({ ...options, access: 'link' }), error => error === failure); assert.equal(h.writes.length, 1);
});

test('authentication changes after membership, project preflight and write stop the workflow', async () => {
  for (const changedAt of ['/accounts/check/', '/gizmos/', '/projects/share']) {
    const h = setup([resource(), {}, resource([visibility()])]); const request = h.transport.request;
    h.transport.request = async (...args) => { const value = await request(...args); if (args[1].includes(changedAt)) h.setAuth({ accountId: 'other', accessToken: 'invalid' }); return value; };
    await assert.rejects(h.api.access({ ...options, access: 'link' }), error => ['ACCOUNT_CHANGED', 'MUTATION_UNCONFIRMED'].includes(error.code));
    assert.equal(h.writes.length, changedAt === '/projects/share' ? 1 : 0);
  }
});

test('cancellation prevents network access and no raw account policy is leaked', async () => {
  const controller = new AbortController(); controller.abort(); const h = setup();
  await assert.rejects(h.api.get({ ...options, signal: controller.signal }), error => error.name === 'AbortError'); assert.equal(h.calls.length, 0);
  const live = setup([resource()], { workspace: true, settings: { permissions: ['chatgpt.workspace.project.share'], token: 'secret-token' } });
  assert.doesNotMatch(JSON.stringify(await live.api.get(options)), /secret-token/);
});
