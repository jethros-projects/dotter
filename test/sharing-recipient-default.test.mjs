import test from 'node:test';
import assert from 'node:assert/strict';
import { LibrarySharing } from '../src/sharing.mjs';

// api-9ec852557889.js explicitly defaults absent direct-share recipient
// principal_type to user when matching a committed createShare response.
const ME = { principal_type: 'user', principal_id: 'me-test' };
const THEM = { principal_type: 'user', principal_id: 'recipient-test' };
function fixtures(kind) {
  const selected = { accountId: 'account-test', accountUserId: ME.principal_id, resourceId: `${kind}-test`, resourceKind: kind };
  const resource = { resource_type: `library_${kind}`, resource_id: selected.resourceId };
  const role = `role-library-${kind}-viewer`;
  const state = { resource, owner: { principal: ME }, viewer: { principal: ME }, capabilities: {
    direct_sharing_capabilities_version: 1, can_invite: true
  } };
  const recipient = { recipient_type: 'principal', principal_id: THEM.principal_id };
  const share = { resource, recipient, share_id: 'share-test', role_id: role, status: 'active' };
  const shares = { resource, owner: ME, allowed_roles: [role], shares: [], next_cursor: null };
  const options = { ...selected, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: selected.resourceId };
  return { selected, resource, role, state, recipient, share, shares, options };
}
function mock(responses) {
  const calls = [];
  const api = new LibrarySharing({ transport: { async request(method, route, options) {
    calls.push({ method, route, options }); assert.ok(responses.length, 'Unexpected request');
    return structuredClone(responses.shift());
  } } });
  return { api, calls };
}
for (const kind of ['file', 'folder']) {
  test(`${kind} native implicit user recipient confirms a newly committed share`, async () => {
    const f = fixtures(kind); const { api, calls } = mock([f.state, f.shares, f.share]);
    assert.deepEqual(await api.createShare(f.options), f.share);
    assert.equal(calls.filter(value => value.method === 'POST').length, 1);
    assert.deepEqual(calls.at(-1).options.body.recipient, f.options.recipient);
  });
  test(`${kind} existing implicit user share requires its observed ID before any mutation`, async () => {
    const f = fixtures(kind); const { api, calls } = mock([f.state, { ...f.shares, shares: [f.share] }, { ...f.share, recipient: f.options.recipient }]);
    await assert.rejects(api.createShare(f.options), { code: 'SHARING_CONFLICT' });
    assert.equal(calls.length, 2); assert.equal(calls.filter(value => value.method !== 'GET').length, 0);
  });
  test(`${kind} existing implicit user share accepts only its matching observed ID`, async () => {
    const f = fixtures(kind); const { api, calls } = mock([f.state, { ...f.shares, shares: [f.share] }, f.share]);
    assert.deepEqual(await api.createShare({ ...f.options, expectedInvitationId: f.share.share_id }), f.share);
    assert.equal(calls.at(-1).options.body.expected_invitation_id, f.share.share_id);
    assert.equal(calls.filter(value => value.method === 'POST').length, 1);
  });
  test(`${kind} explicit group recipient with the same raw ID is distinct from implicit user`, async () => {
    const f = fixtures(kind);
    const groupShare = { ...f.share, recipient: { ...f.recipient, principal_type: 'group' }, share_id: 'group-share-test' };
    const { api, calls } = mock([f.state, { ...f.shares, shares: [groupShare] }, { ...f.share, recipient: f.options.recipient }]);
    await api.createShare(f.options);
    assert.equal(calls.at(-1).options.body.expected_invitation_id, undefined);
    assert.equal(calls.filter(value => value.method === 'POST').length, 1);
  });
}
