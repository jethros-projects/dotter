import test from 'node:test';
import assert from 'node:assert/strict';
import { LibrarySharing } from '../src/sharing.mjs';

// api-9ec852557889.js returns this plan, and dialog-c107c729f46e.js
// renders each mutation plus descendant/group impact before applying it.
const ME = { principal_type: 'user', principal_id: 'me-test' };
const THEM = { principal_type: 'user', principal_id: 'recipient-test' };
const GROUP = { principal_type: 'group', principal_id: 'group-test' };
function fixtures(kind) {
  const selected = { accountId: 'account-test', accountUserId: ME.principal_id, resourceId: `${kind}-test`, resourceKind: kind };
  const resource = { resource_type: `library_${kind}`, resource_id: selected.resourceId };
  const state = { resource, owner: { principal: ME }, viewer: { principal: ME }, capabilities: {
    direct_sharing_capabilities_version: 1, can_manage_access: true
  } };
  const effective = { resource, owner: ME, complete: true, collaborators: [] };
  const preview = { resource, recipient: THEM, desired_role: null, fingerprint: 'reviewed-fingerprint',
    affects_other_descendants: true, affects_other_group_members: false,
    mutations: [{ resource: { resource_type: 'library_folder', resource_id: 'parent-folder-test' },
      resource_display_name: 'Parent folder', principal: GROUP, invitation_id: 'invitation-test',
      old_role_id: 'role-library-folder-editor', new_role_id: null,
      affects_other_descendants: false, affects_other_group_members: true }]
  };
  return { selected, resource, state, effective, preview };
}
function mock(responses) {
  const calls = [];
  const api = new LibrarySharing({ transport: { async request(method, route, options) {
    calls.push({ method, route, options });
    assert.ok(responses.length, 'Unexpected request');
    return structuredClone(responses.shift());
  } } });
  return { api, calls };
}

for (const kind of ['file', 'folder']) {
  test(`${kind} preview preserves native parent/group mutation plan and impact flags`, async () => {
    const { selected, state, effective, preview } = fixtures(kind);
    const response = { ...preview, token: 'discard', profile_photo_url: 'https://private.invalid/top',
      mutations: preview.mutations.map(value => ({ ...value, private_field: 'discard',
        resource: { ...value.resource, profile_photo_url: 'https://private.invalid/resource' },
        principal: { ...value.principal, profile_photo_url: 'https://private.invalid/principal' } })) };
    const { api, calls } = mock([state, effective, response]);
    const out = await api.previewAccessChange({ ...selected, recipient: THEM, desiredRole: null });
    assert.deepEqual(out, preview);
    assert.notEqual(out.mutations, response.mutations);
    assert.deepEqual(calls.at(-1).options.body, { recipient: { recipient_type: 'principal', ...THEM }, desired_role: null });
    assert.equal(calls.filter(value => value.method === 'POST').length, 1);
    assert.ok(calls.at(-1).route.endsWith('/access-change/preview'));
  });

  for (const partial of [true, false]) {
    test(`${kind} apply exposes native ${partial ? 'partial' : 'complete'} completion without retrying`, async () => {
      const { selected, state, effective, preview } = fixtures(kind);
      const result = { partial_failure: partial, effective_access: { ...effective, complete: !partial }, token: 'discard' };
      const { api, calls } = mock([state, effective, preview, state, result]);
      const out = await api.applyAccessChange({ ...selected, preview, confirm: selected.resourceId });
      assert.deepEqual(out, { partial_failure: partial, effective_access: { ...effective, complete: !partial } });
      assert.equal(calls.length, 5);
      assert.equal(calls.filter(value => value.route.endsWith('/access-change/apply')).length, 1);
      assert.deepEqual(calls.at(-1).options.body, {
        recipient: { recipient_type: 'principal', ...THEM }, desired_role: null, fingerprint: preview.fingerprint
      });
    });
  }

  test(`${kind} native preview impact fields retain response size bounds`, async () => {
    const { selected, state, effective, preview } = fixtures(kind);
    preview.mutations[0].resource_display_name = 'x'.repeat(16385);
    const { api, calls } = mock([state, effective, preview]);
    await assert.rejects(api.previewAccessChange({ ...selected, recipient: THEM, desiredRole: null }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls.length, 3);
    assert.equal(calls.filter(value => value.route.endsWith('/access-change/apply')).length, 0);
  });
}
