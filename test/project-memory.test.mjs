import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectMemory, projectMemoryCapabilities } from '../src/project-memory.mjs';
import { commands } from '../src/command-sets/project-memory.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct', projectId = 'g-p-test', options = { accountId, projectId };
function project(fields = {}, outer = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Memory test', emoji: null, theme: null },
    author: { user_id: 'user' }, current_user_permission: { can_read: true, can_write: true, can_delete: true },
    share_recipient: 'private', sharing: { subjects: [] }, memory_scope: 'global', instructions: 'Keep instructions', ...fields }, files: [], ...outer };
}
function setup(responses = [], structure = 'personal') {
  const calls = []; let subject = 'user';
  const transport = { authLoader: async () => ({ accountId, accessToken: `x.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.s` }),
    async request(method, path, request) {
      calls.push({ method, path, ...request });
      if (path.includes('/accounts/check/')) return { accounts: { acct: { can_access_with_session: true, account: { account_id: accountId, account_user_id: 'user__acct', structure } } } };
      const result = responses.shift();
      if (typeof result === 'function') return result({ method, path, ...request });
      if (result instanceof Error) throw result;
      return result;
    } };
  return { api: new ProjectMemory({ transport }), calls, rotate() { subject = 'other'; } };
}
const settings = { settings: { m3m: true, private_token: 'never-exposed' } };
const code = expected => error => error.code === expected;

test('memory commands expose typed get/set with exact project confirmation', () => {
  assert.deepEqual(projectMemoryCapabilities().supported, ['get', 'set']);
  assert.deepEqual(commands['account projects memory set'].confirmMatch, [['confirm', 'projectId']]);
  assert.deepEqual(commands['account projects memory set'].positionals, ['projectId', 'scope']);
});

test('memory eligibility projects only safe configuration and restrictions', async () => {
  const h = setup([project(), settings]);
  const result = await h.api.get(options);
  assert.equal(result.currentScope, 'global'); assert.equal(result.canChangeToProjectOnly, true);
  assert.deepEqual(result.unavailableReasons, { global: [], project_v2: [] });
  assert.doesNotMatch(JSON.stringify(result), /Keep instructions|private_token|never-exposed/);
  assert.ok(h.calls.every(call => call.expectedAccountId === accountId));
});

test('work conversations block only project-only memory', async () => {
  const h = setup([project({}, { has_tpp_conversation: true }), settings]);
  const result = await h.api.get(options);
  assert.equal(result.canChangeToGlobal, true); assert.equal(result.canChangeToProjectOnly, false);
  assert.deepEqual(result.unavailableReasons.project_v2, ['work_conversations_present']);
});

for (const [label, fields, outer, setting] of [
  ['read-only', { current_user_permission: { can_read: true, can_write: false } }, {}, settings],
  ['shared', { share_recipient: 'workspace' }, {}, settings],
  ['members present', { sharing: { subjects: [{}] } }, {}, settings],
  ['outer members present', {}, { hasSharingSubjects: true }, settings],
  ['special subtype', { gizmo_snorlax_type: 'potion' }, {}, settings],
  ['first-party subtype', { first_party_project_type: 'special' }, {}, settings],
  ['archived', { is_archived: true }, {}, settings],
  ['memory disabled', {}, {}, { settings: { m3m: false } }],
]) test(`memory writes reject ${label} projects without a PATCH`, async () => {
  const h = setup([project(fields, outer), setting]);
  await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('PROJECT_MEMORY_UNAVAILABLE'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('missing/malformed account memory configuration cannot authorize mutation', async () => {
  for (const value of [{}, { settings: {} }, { settings: { m3m: 1 } }]) {
    const h = setup([project(), value]);
    await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('PROJECT_ELIGIBILITY_UNVERIFIED'));
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('invalid scope or mismatched confirmation fails before loading credentials', async () => {
  const h = setup();
  await assert.rejects(h.api.set({ ...options, scope: 'unset', confirm: projectId }), code('INVALID_ARGUMENT'));
  await assert.rejects(h.api.set({ ...options, scope: 'global', confirm: 'g-p-other' }), code('CONFIRMATION_REQUIRED'));
  assert.equal(h.calls.length, 0);
});

test('same effective scope is a verified no-op, including native unset', async () => {
  for (const current of ['global', 'unset', null, undefined]) {
    const h = setup([project({ memory_scope: current }), settings]);
    const result = await h.api.set({ ...options, scope: 'global', confirm: projectId });
    assert.equal(result.changed, false); assert.equal(result.confirmed, true);
    assert.ok(h.calls.every(call => call.method === 'GET'));
  }
});

test('memory confirmation requires preserved project metadata as well as the requested mode', async () => {
  const h = setup([project(), settings, project(), {}, project({ memory_scope: 'project_v2', instructions: 'unexpected replacement' })]);
  await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('memory changes use native trimmed-name fallback and preserve other metadata', async () => {
  const original = project({ display: { name: ' Memory test ', emoji: null, theme: null } });
  const h = setup([original, settings, original, {}, project({ memory_scope: 'project_v2' })]);
  assert.equal((await h.api.set({ ...options, scope: 'project_v2', confirm: projectId })).confirmed, true);
  assert.equal(h.calls.find(call => call.method === 'PATCH').body.name, 'Memory test');
});

test('project-only transition rechecks Work state and preserves metadata in one PATCH', async () => {
  const original = project(), updated = project({ memory_scope: 'project_v2' });
  const h = setup([original, settings, original, {}, updated]);
  const result = await h.api.set({ ...options, scope: 'project_v2', confirm: projectId });
  assert.equal(result.confirmed, true); assert.equal(result.changed, true);
  const writes = h.calls.filter(call => call.method === 'PATCH');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { name: 'Memory test', emoji: null, theme: null, instructions: 'Keep instructions', memory_scope: 'project_v2' });
  assert.equal(h.calls.filter(call => call.path.includes('/gizmos/')).length, 3);
});

test('a new Work chat between eligibility and update prevents the write', async () => {
  const h = setup([project(), settings, project({}, { has_tpp_conversation: true })]);
  await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('PROJECT_MEMORY_UNAVAILABLE'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('changing to global does not falsely require no Work chats', async () => {
  const h = setup([project({ memory_scope: 'project_v2' }, { has_tpp_conversation: true }), settings, {}, project({}, { has_tpp_conversation: true })]);
  assert.equal((await h.api.set({ ...options, scope: 'global', confirm: projectId })).confirmed, true);
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('workspace policy is fresh and cannot be bypassed by project can_write', async () => {
  const h = setup([project(), settings, { permissions: [] }], 'workspace');
  await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('PROJECT_MEMORY_UNAVAILABLE'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('uncertain write is not replayed and accepted write retains readback uncertainty', async () => {
  const unknown = setup([project(), settings, project(), new DotError('NETWORK_ERROR', 'failure', { delivery: 'unknown' })]);
  await assert.rejects(unknown.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('NETWORK_ERROR'));
  assert.equal(unknown.calls.filter(call => call.method === 'PATCH').length, 1);
  const accepted = setup([project(), settings, project(), {}, new DotError('EDGE_CHALLENGE', 'edge')]);
  await assert.rejects(accepted.api.set({ ...options, scope: 'project_v2', confirm: projectId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted' && error.details.projectId === projectId);
  assert.equal(accepted.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('rejected or mismatched configuration is never reported as a completed change', async () => {
  for (const responses of [
    [project(), settings, project(), { error: 'denied' }],
    [project(), settings, project(), {}, project()],
  ]) {
    const h = setup(responses);
    await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('MUTATION_UNCONFIRMED'));
    assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
  }
});

test('identity rotation after eligibility stops before memory PATCH', async () => {
  const h = setup([project(), () => { h.rotate(); return settings; }]);
  await assert.rejects(h.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('AUTH_IDENTITY_CHANGED'));
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('malformed Work markers or metadata are not interpreted as safe defaults', async () => {
  const h = setup([project({}, { has_tpp_conversation: 'false' })]);
  await assert.rejects(h.api.get(options), code('INVALID_RESPONSE'));
  const bad = project({ display: { name: 'Memory test', emoji: { private: true }, theme: null } });
  const update = setup([bad, settings, bad]);
  await assert.rejects(update.api.set({ ...options, scope: 'project_v2', confirm: projectId }), code('INVALID_RESPONSE'));
  assert.ok(update.calls.every(call => call.method === 'GET'));
});
