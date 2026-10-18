import test from 'node:test';
import assert from 'node:assert/strict';
import { LibrarySharing, sharingCapabilities } from '../src/sharing.mjs';
import { commands } from '../src/command-sets/sharing.mjs';

const S = { accountId: 'account-1', accountUserId: 'me', resourceId: 'file-1', resourceKind: 'file' };
const RES = { resource_type: 'library_file', resource_id: 'file-1' };
const ME = { principal_type: 'user', principal_id: 'me' };
const THEM = { principal_type: 'user', principal_id: 'them' };
const ROLE = 'role-library-file-viewer';
const CAPS = { direct_sharing_capabilities_version: 1, can_invite: true, can_manage_access: true, can_request_access: true, can_manage_access_requests: true };
const state = (extra = {}) => ({ resource: RES, owner: { principal: ME }, viewer: { principal: ME }, capabilities: CAPS, link_access: 'collaborators_only', ...extra });
const share = (extra = {}) => ({ share_id: 'share-1', resource: RES, recipient: { recipient_type: 'principal', ...THEM }, role_id: ROLE, status: 'accepted', ...extra });
const shares = (extra = {}) => ({ resource: RES, owner: ME, allowed_roles: [ROLE, 'role-library-file-editor'], shares: [], next_cursor: null, ...extra });
const effective = (extra = {}) => ({ resource: RES, owner: ME, complete: true, collaborators: [{ principal: ME }, { principal: THEM }], ...extra });
const preview = (extra = {}) => ({ resource: RES, recipient: THEM, current_role: 'editor', desired_role: 'viewer', fingerprint: 'fingerprint-1', ...extra });
const request = (extra = {}) => ({ resource: RES, resource_owner: ME, requester: ME, request_id: 'request-1', created_at: '2026-10-18T10:00:00Z',
  requested_role_id: ROLE, recipients: [THEM], decisions: [], ...extra });
const invitation = (extra = {}) => ({ resource: RES, invitation_id: 'invite-1', recipient: { recipient_type: 'principal', ...ME }, status: 'pending', expires_at: '2099-01-01T00:00:00Z', ...extra });
function mock(responses) {
  const calls = [];
  const transport = { async request(method, route, options) { calls.push({ method, route, options }); const next = responses.shift(); if (next instanceof Error) throw next; return structuredClone(next); } };
  return { api: new LibrarySharing({ transport }), calls, transport };
}
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);

test('capabilities distinguish roles and expose only audited link modes', () => {
  assert.equal(sharingCapabilities().roles.folder.editor, 'role-library-folder-editor');
  assert.ok(sharingCapabilities().constraints.some(value => value.includes('Public links')));
});
test('all sharing command descriptors dispatch to real methods', () => {
  for (const entry of Object.values(commands)) assert.equal(typeof LibrarySharing.prototype[entry.method], 'function');
});
test('identity discovery returns the server viewer under a pinned account without requiring an OAuth-sub guess', async () => {
  const { api, calls } = mock([state()]);
  const { accountUserId, ...selection } = S;
  assert.deepEqual(await api.identity(selection), S);
  assert.equal(calls[0].options.expectedAccountId, S.accountId);
  assert.equal(calls[0].method, 'GET');
  await fails(mock([state({ resource: { ...RES, resource_id: 'other' } })]).api.identity(selection), 'RESOURCE_CHANGED');
  await fails(mock([state({ viewer: { principal: { principal_type: 'group', principal_id: 'group' } } })]).api.identity(selection), 'INVALID_RESPONSE');
});
test('state is scoped and drops private photo URL and arbitrary server fields', async () => {
  const { api, calls } = mock([state({ profile_photo_url: 'https://secret', token: 'secret' })]);
  const out = await api.state(S);
  assert.equal(out.token, undefined); assert.equal(out.profile_photo_url, undefined);
  assert.equal(calls[0].options.expectedAccountId, S.accountId);
  assert.deepEqual(calls[0].options.query, { include_profile_photos: false });
});
test('state rejects a different resource or viewer', async () => {
  await fails(mock([state({ resource: { ...RES, resource_id: 'other' } })]).api.state(S), 'RESOURCE_CHANGED');
  await fails(mock([state({ viewer: { principal: THEM } })]).api.state(S), 'ACCOUNT_CHANGED');
});
test('invalid scope is rejected before network access', async () => {
  for (const value of [{ ...S, resourceId: '../bad' }, { ...S, accountId: '' }, { ...S, resourceKind: 'page' }]) {
    const { api, calls } = mock([]); await fails(api.state(value), 'INVALID_ARGUMENT'); assert.equal(calls.length, 0);
  }
});
test('auth account changes during a call are rejected', async () => {
  const { api, transport } = mock([state()]); let n = 0;
  transport.authLoader = async () => ({ accountId: n++ === 0 ? S.accountId : 'other-account' });
  await fails(api.state(S), 'ACCOUNT_CHANGED');
});
test('shares consume all pages and validate owner/resource', async () => {
  const { api, calls } = mock([state(), shares({ shares: [share()], next_cursor: 'c1' }), shares({ shares: [share({ share_id: 'share-2' })] })]);
  const out = await api.shares(S); assert.equal(out.shares.length, 2); assert.equal(calls[2].options.query.cursor, 'c1');
  await fails(mock([state(), shares({ owner: THEM })]).api.shares(S), 'RESOURCE_CHANGED');
});
test('repeated share pagination fails instead of looping', async () => {
  const { api } = mock([state(), shares({ next_cursor: 'same' }), shares({ next_cursor: 'same' })]);
  await fails(api.shares(S), 'INVALID_RESPONSE');
});
test('collaborators bound, sort and deduplicate access-request context', async () => {
  const { api, calls } = mock([state(), effective()]);
  await api.collaborators({ ...S, accessRequestIds: ['z', 'a'] });
  assert.deepEqual(calls[1].options.headers, { 'x-oai-library-access-request-ids': 'a,z' });
  await fails(mock([]).api.collaborators({ ...S, accessRequestIds: ['a', 'b', 'c'] }), 'INVALID_ARGUMENT');
});
test('recipient resolution stays scoped and validates email before requests', async () => {
  const { api, calls } = mock([{ principal: THEM, token: 'drop' }]);
  assert.deepEqual(await api.resolveRecipient({ ...S, email: 'a@example.com' }), { principal: THEM });
  assert.deepEqual(calls[0].options.body, { email: 'a@example.com' });
  const other = mock([]); await fails(other.api.resolveRecipient({ ...S, email: 'bad\naddress' }), 'INVALID_ARGUMENT'); assert.equal(other.calls.length, 0);
});
test('grant requires confirmation, matching kind role and permission before write', async () => {
  const target = { recipient_type: 'principal', ...THEM };
  const missing = mock([]); await fails(missing.api.createShare({ ...S, recipient: target, role: 'viewer' }), 'INVALID_ARGUMENT'); assert.equal(missing.calls.length, 0);
  const wrongRole = mock([]); await fails(wrongRole.api.createShare({ ...S, recipient: target, role: 'role-library-folder-viewer', confirm: S.resourceId }), 'INVALID_ARGUMENT');
  const blocked = mock([state({ capabilities: { ...CAPS, can_invite: false } })]);
  await fails(blocked.api.createShare({ ...S, recipient: target, role: 'viewer', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED'); assert.equal(blocked.calls.length, 1);
});
test('grant sends the exact verified body, with allowed-role and response checks', async () => {
  const { api, calls } = mock([state(), shares(), share()]);
  await api.createShare({ ...S, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: S.resourceId });
  assert.equal(calls[2].route, '/backend-api/files/library/files/file-1/shares');
  assert.deepEqual(calls[2].options.body, { expected_invitation_id: undefined, recipient: { recipient_type: 'principal', ...THEM }, role_id: ROLE });
  const bad = mock([state(), shares({ allowed_roles: [] })]);
  await fails(bad.api.createShare({ ...S, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
});
test('existing grant requires its current share ID before updating', async () => {
  const opts = { ...S, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: S.resourceId };
  await fails(mock([state(), shares({ shares: [share()] })]).api.createShare(opts), 'SHARING_CONFLICT');
  const { api, calls } = mock([state(), shares({ shares: [share()] }), share()]);
  await api.createShare({ ...opts, expectedInvitationId: 'share-1' }); assert.equal(calls[2].options.body.expected_invitation_id, 'share-1');
});
test('grant errors are not retried', async () => {
  const { api, calls } = mock([state(), shares(), new Error('network failed')]);
  await assert.rejects(api.createShare({ ...S, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: S.resourceId }));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
test('revoke uses fresh status, role and principal preconditions', async () => {
  const { api, calls } = mock([state(), shares({ shares: [share()] }), { completed: true }]);
  await api.removeShare({ ...S, shareId: 'share-1', confirm: S.resourceId });
  assert.deepEqual(calls[2].options.query, { recipient_principal_type: 'user', recipient_principal_id: 'them', expected_status: 'accepted', expected_role_id: ROLE });
});
test('missing share and owner self-removal are refused', async () => {
  await fails(mock([state(), shares()]).api.removeShare({ ...S, shareId: 'unknown', confirm: S.resourceId }), 'SHARING_CONFLICT');
  await fails(mock([state(), shares({ shares: [share({ recipient: { recipient_type: 'principal', ...ME } })] })]).api.removeShare({ ...S, shareId: 'share-1', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
});
test('workspace link stays within account and rejects public/commenter links', async () => {
  for (const extra of [{ mode: 'public' }, { mode: 'workspace', role: 'commenter' }, { mode: 'workspace', role: 'viewer', workspaceId: 'other' }]) {
    const { api, calls } = mock([]); await fails(api.updateLinkAccess({ ...S, confirm: S.resourceId, ...extra }), 'INVALID_ARGUMENT'); assert.equal(calls.length, 0);
  }
});
test('workspace link mutation uses observed invitation and verifies final state', async () => {
  const before = state({ link_access: 'workspace', workspace_invitation_id: 'link-1', role_id: 'role-library-file-editor' });
  const after = state({ link_access: 'workspace', workspace_id: S.accountId, role_id: ROLE });
  const { api, calls } = mock([before, shares(), after]);
  await api.updateLinkAccess({ ...S, mode: 'workspace', role: 'viewer', confirm: S.resourceId });
  assert.deepEqual(calls[2].options.body, { expected_invitation_id: 'link-1', link_access: 'workspace', workspace_id: S.accountId, role_id: ROLE });
});
test('collaborators-only change includes observed role and does not invent public access', async () => {
  const before = state({ link_access: 'workspace', workspace_invitation_id: 'link-1', role_id: ROLE });
  const { api, calls } = mock([before, state()]);
  await api.updateLinkAccess({ ...S, mode: 'collaborators_only', confirm: S.resourceId });
  assert.deepEqual(calls[1].options.body, { expected_invitation_id: 'link-1', expected_role_id: ROLE, link_access: 'collaborators_only' });
});
test('already-satisfied link modes return a fresh guarded state without a PATCH', async () => {
  for (const kind of ['file', 'folder']) {
    const selected = { ...S, resourceKind: kind };
    const current = state({ resource: { ...RES, resource_type: `library_${kind}` } });
    const { api, calls } = mock([current]);
    const result = await api.updateLinkAccess({ ...selected, mode: 'collaborators_only', confirm: S.resourceId });
    assert.equal(result.changed, false); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
  }
  const current = state({ link_access: 'workspace', workspace_id: S.accountId, role_id: ROLE });
  const { api, calls } = mock([current, shares()]);
  assert.equal((await api.updateLinkAccess({ ...S, mode: 'workspace', role: 'viewer', confirm: S.resourceId })).changed, false);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('unchanged link modes still require confirmation, ownership, capability and allowed role', async () => {
  await fails(mock([]).api.updateLinkAccess({ ...S, mode: 'collaborators_only', confirm: 'wrong' }), 'INVALID_ARGUMENT');
  await fails(mock([state({ owner: { principal: THEM } })]).api.updateLinkAccess({ ...S, mode: 'collaborators_only', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
  await fails(mock([state({ capabilities: { ...CAPS, can_manage_access: false } })]).api.updateLinkAccess({ ...S, mode: 'collaborators_only', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
  const current = state({ link_access: 'workspace', workspace_id: S.accountId, role_id: ROLE });
  await fails(mock([current, shares({ allowed_roles: [] })]).api.updateLinkAccess({ ...S, mode: 'workspace', role: 'viewer', confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
});
test('preview requires complete effective access and matching fingerprint scope', async () => {
  const { api, calls } = mock([state(), effective(), shares(), preview()]);
  assert.equal((await api.previewAccessChange({ ...S, recipient: THEM, desiredRole: 'viewer' })).fingerprint, 'fingerprint-1');
  assert.deepEqual(calls[3].options.body, { recipient: { recipient_type: 'principal', ...THEM }, desired_role: 'viewer' });
  await fails(mock([state(), effective({ complete: false })]).api.previewAccessChange({ ...S, recipient: THEM, desiredRole: null }), 'SHARING_NOT_PERMITTED');
});
test('apply re-previews and refuses stale fingerprints without applying', async () => {
  const { api, calls } = mock([state(), effective(), shares(), preview({ fingerprint: 'changed' })]);
  await fails(api.applyAccessChange({ ...S, preview: preview(), confirm: S.resourceId }), 'SHARING_CONFLICT');
  assert.equal(calls.filter(call => call.route.endsWith('/apply')).length, 0);
});
test('apply uses only verified preview fields and validates resulting owner', async () => {
  const { api, calls } = mock([state(), effective(), shares(), preview(), state(), { effective_access: effective() }]);
  await api.applyAccessChange({ ...S, preview: { ...preview(), malicious: 'ignored' }, confirm: S.resourceId });
  assert.deepEqual(calls.at(-1).options.body, { recipient: { recipient_type: 'principal', ...THEM }, desired_role: 'viewer', fingerprint: 'fingerprint-1' });
});
test('folder sharing uses folder route and folder role IDs', async () => {
  const options = { ...S, resourceKind: 'folder', resourceId: 'folder-1' };
  const resource = { resource_type: 'library_folder', resource_id: 'folder-1' };
  const { api, calls } = mock([state({ resource }), shares({ resource, allowed_roles: ['role-library-folder-viewer'] }), share({ resource, role_id: 'role-library-folder-viewer' })]);
  await api.createShare({ ...options, recipient: { recipient_type: 'principal', ...THEM }, role: 'viewer', confirm: 'folder-1' });
  assert.equal(calls[2].route, '/backend-api/files/library/directories/folder-1/shares');
});
test('access request creation validates recipients and verifies actor/role', async () => {
  const { api, calls } = mock([state(), request()]);
  await api.createAccessRequest({ ...S, role: 'viewer', recipients: [{ recipient_type: 'principal', ...THEM }], confirm: S.resourceId });
  assert.equal(calls[1].options.body.requested_role_id, ROLE);
  await fails(mock([]).api.createAccessRequest({ ...S, role: 'viewer', recipients: [], confirm: S.resourceId }), 'INVALID_ARGUMENT');
});
test('request history rejects mismatched actors and duplicate terminal recipients', async () => {
  await fails(mock([state(), { requests: [request({ resource_owner: THEM })] }]).api.accessRequests(S), 'ACCOUNT_CHANGED');
  await fails(mock([state(), { requests: [request({ decisions: [{ recipient: THEM, decision: 'approved' }], already_satisfied_recipients: [THEM] })] }]).api.accessRequests(S), 'INVALID_RESPONSE');
});
test('request decisions act once on a currently pending recipient and verify generation', async () => {
  const decided = request({ decisions: [{ recipient: THEM, decision: 'approved', decided_by: ME }] });
  const { api, calls } = mock([state(), state(), { requests: [request()], next_cursor: null }, decided]);
  await api.decideAccessRequest({ ...S, requestId: 'request-1', recipient: THEM, decision: 'approve', confirm: S.resourceId });
  assert.equal(calls.at(-1).route, '/backend-api/files/library/files/file-1/access-requests/request-1/approve');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
test('already decided requests are not submitted a second time', async () => {
  const { api, calls } = mock([state(), state(), { requests: [request({ already_satisfied_recipients: [THEM] })] }]);
  await fails(api.decideAccessRequest({ ...S, requestId: 'request-1', recipient: THEM, decision: 'decline', confirm: S.resourceId }), 'SHARING_CONFLICT');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
test('invitation list and inspect remain account and resource scoped', async () => {
  const { api, calls } = mock([{ invitations: [invitation()], next_cursor: null }, invitation()]);
  await api.invitations({ ...S, limit: 4 });
  await api.invitation({ ...S, invitationId: 'invite-1' });
  assert.equal(calls[0].options.query.resource_type, 'library_file');
  await fails(mock([invitation({ recipient: { recipient_type: 'principal', ...THEM } })]).api.invitation({ ...S, invitationId: 'invite-1' }), 'ACCOUNT_CHANGED');
});
test('invitation acceptance requires exact confirmation and a fresh pending invitation', async () => {
  const { api, calls } = mock([invitation(), { completed: true }]);
  const result = await api.acceptInvitation({ ...S, invitationId: 'invite-1', confirm: 'invite-1' });
  assert.equal(result.decision, 'accept'); assert.equal(calls[1].route, '/backend-api/sharing/invitations/invite-1/accept');
  const blocked = mock([invitation({ status: 'accepted' })]); await fails(blocked.api.acceptInvitation({ ...S, invitationId: 'invite-1', confirm: 'invite-1' }), 'SHARING_CONFLICT');
  assert.equal(blocked.calls.length, 1);
});
test('expired invitations never trigger mutation', async () => {
  const { api, calls } = mock([invitation({ expires_at: '2000-01-01T00:00:00Z' })]);
  await fails(api.declineInvitation({ ...S, invitationId: 'invite-1', confirm: 'invite-1' }), 'SHARING_CONFLICT'); assert.equal(calls.length, 1);
});
test('received direct share removal validates current node without owner share enumeration', async () => {
  const { api, calls } = mock([state({ owner: { principal: THEM } }), { id: S.resourceId, is_shared: true, direct_share_id: 'direct-1' }, { completed: true }]);
  const out = await api.removeReceivedShare({ ...S, shareId: 'direct-1', confirm: S.resourceId });
  assert.equal(out.effect, 'leave-direct-share'); assert.equal(calls[1].route, '/backend-api/files/library/files/file-1/node');
  assert.equal(calls[2].route, '/backend-api/files/library/files/file-1/shares/direct-1');
});
test('received workspace entry removal does not claim to revoke workspace access', async () => {
  const { api, calls } = mock([state({ owner: { principal: THEM } }), { completed: true }]);
  const out = await api.removeReceivedShare({ ...S, confirm: S.resourceId });
  assert.equal(out.effect, 'remove-from-shared-with-me'); assert.equal(calls[1].route, '/backend-api/files/library/files/file-1/shared-with-me');
});
test('owner received-share removal and stale direct IDs are refused', async () => {
  await fails(mock([state()]).api.removeReceivedShare({ ...S, confirm: S.resourceId }), 'SHARING_NOT_PERMITTED');
  await fails(mock([state({ owner: { principal: THEM } }), { id: S.resourceId, is_shared: true, direct_share_id: 'other' }]).api.removeReceivedShare({ ...S, shareId: 'direct-1', confirm: S.resourceId }), 'SHARING_CONFLICT');
});
