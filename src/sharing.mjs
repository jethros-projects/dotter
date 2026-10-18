import { DotError } from './errors.mjs';

// Verified in api-9ec852557889.js, model-445896910ae7.js, and
// self-removal-7f69ee12b439.js in the installed ChatGPT client (2026-10-18).
// These routes change account-wide Library access. Nothing is retried.
const BASE = '/backend-api/files/library';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const ROLES = Object.freeze(Object.fromEntries(['file', 'folder'].map(kind => [kind,
  Object.freeze(Object.fromEntries(['viewer', 'commenter', 'editor'].map(role => [role, `role-library-${kind}-${role}`])))])));
const PUBLIC_KEYS = new Set(['resource', 'resource_type', 'resource_id', 'owner', 'viewer', 'principal', 'principal_type',
  'principal_id', 'recipient', 'recipient_type', 'display_name', 'name', 'email', 'role_id', 'direct_role_id', 'effective_role_id',
  'allowed_roles', 'capabilities', 'direct_sharing_capabilities_version', 'can_invite', 'can_manage_access', 'can_request_access',
  'can_manage_access_requests', 'link_access', 'workspace_id', 'workspace_invitation_id', 'share_id', 'invitation_id', 'status',
  'created_at', 'updated_at', 'expires_at', 'accepted_at', 'declined_at', 'inviter_name', 'inviter_email', 'inviter', 'shares',
  'next_cursor', 'collaborators', 'complete', 'source', 'group_source', 'sources', 'direct', 'inherited', 'request_id', 'requester',
  'resource_owner', 'recipients', 'decisions', 'decision', 'decided_by', 'decided_at', 'already_satisfied_recipients',
  'requested_role_id', 'requests', 'invitations', 'fingerprint', 'desired_role', 'current_role', 'effective_access', 'changes',
  'before', 'after', 'warnings', 'reason', 'can_edit', 'can_view', 'can_comment', 'role', 'type', 'kind', 'availability',
  'resolved', 'match', 'matches', 'success', 'completed', 'principal_identities', 'recipient_email',
  'recipient_display_name', 'resource_display_name', 'mutations', 'old_role_id', 'new_role_id',
  'affects_other_descendants', 'affects_other_group_members', 'partial_failure']);

function error(code, message) { throw new DotError(code, message); }
function invalid(message) { error('INVALID_ARGUMENT', message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${label} must be an ID returned by the API.`);
  return value;
}
function email(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) invalid('email must be a valid email address.');
  return value;
}
function clean(value, depth = 0) {
  if (depth > 12) error('INVALID_RESPONSE', 'The sharing response exceeds the nesting limit.');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    if (value.length > 16384) error('INVALID_RESPONSE', 'The sharing response contains an oversized field.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) error('INVALID_RESPONSE', 'The sharing response contains an oversized list.');
    return value.map(item => clean(item, depth + 1));
  }
  if (!record(value)) error('INVALID_RESPONSE', 'The sharing response is not a JSON object.');
  return Object.fromEntries(Object.entries(value).filter(([key]) => PUBLIC_KEYS.has(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
}
function scope(options) {
  const { accountId, accountUserId, resourceId, resourceKind } = options;
  id(accountId, 'accountId'); id(accountUserId, 'accountUserId'); id(resourceId, 'resourceId');
  if (!['file', 'folder'].includes(resourceKind)) invalid('resourceKind must be file or folder.');
  return { accountId, accountUserId, resourceId, resourceKind };
}
function account(options) { id(options.accountId, 'accountId'); id(options.accountUserId, 'accountUserId'); return options; }
function resource(value, selected) {
  if (!record(value) || value.resource_type !== `library_${selected.resourceKind}` || value.resource_id !== selected.resourceId) {
    error('RESOURCE_CHANGED', 'The sharing response does not match the selected Library resource.');
  }
}
function principal(value, label = 'principal') {
  if (!record(value) || !['user', 'group'].includes(value.principal_type)) invalid(`${label} must be a user or group principal.`);
  return { principal_type: value.principal_type, principal_id: id(value.principal_id, `${label}.principal_id`) };
}
function principalKey(value) { return `${value?.principal_type}:${value?.principal_id}`; }
function owner(value, expected) {
  if (!record(value) || value.principal_type !== 'user' || !ID.test(value.principal_id ?? '')
      || (expected && principalKey(value) !== principalKey(expected))) error('RESOURCE_CHANGED', 'The Library owner changed or is invalid.');
}
function recipient(value) {
  if (!record(value)) invalid('recipient must be a JSON object.');
  if (value.recipient_type === 'email') return { recipient_type: 'email', email: email(value.email) };
  if (value.recipient_type !== 'principal') invalid('recipient.recipient_type must be principal or email.');
  return { recipient_type: 'principal', ...principal({ ...value, principal_type: value.principal_type ?? 'user' }, 'recipient') };
}
function recipientKey(value) {
  return value?.recipient_type === 'email' ? `email:${value.email?.toLowerCase()}`
    : value?.recipient_type === 'principal' ? `${value.principal_type ?? 'user'}:${value.principal_id}` : principalKey(value);
}
function roleId(value, selected) {
  const role = ROLES[selected.resourceKind][value] ?? value;
  if (!Object.values(ROLES[selected.resourceKind]).includes(role)) invalid(`role must be viewer, commenter, editor, or an exact ${selected.resourceKind} role ID.`);
  return role;
}
function desiredRole(value) {
  if (value !== null && !['viewer', 'commenter', 'editor'].includes(value)) invalid('desiredRole must be viewer, commenter, editor, or null to remove access.');
  return value;
}
function confirm(options, key = 'resourceId') { if (options.confirm !== options[key]) invalid(`confirm must exactly match ${key} for this access change.`); }
function pageOptions({ cursor, limit = 100 } = {}) {
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 8192 || /[\0\r\n]/.test(cursor))) invalid('cursor must be a bounded single-line string.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be from 1 to 100.');
  return { cursor, limit };
}
function validateCursor(value) {
  if (value != null && (typeof value !== 'string' || value.length > 8192 || !value)) error('INVALID_RESPONSE', 'The sharing response contains an invalid cursor.');
}
function state(value, selected) {
  resource(value?.resource, selected); owner(value.owner?.principal);
  if (value.viewer?.principal?.principal_type !== 'user' || value.viewer.principal.principal_id !== selected.accountUserId) {
    error('ACCOUNT_CHANGED', 'The sharing viewer does not match the selected account user.');
  }
  return value;
}
function capability(current, name, requireOwner = false) {
  if (current.capabilities?.direct_sharing_capabilities_version !== 1 || current.capabilities[name] !== true) {
    error('SHARING_NOT_PERMITTED', `The current resource does not grant ${name}.`);
  }
  if (requireOwner && principalKey(current.owner.principal) !== principalKey(current.viewer.principal)) {
    error('SHARING_NOT_PERMITTED', 'Only the resource owner can perform this access change.');
  }
}
function allowedRole(list, role) {
  if (!Array.isArray(list) || !list.includes(role)) error('SHARING_NOT_PERMITTED', 'The requested role is not currently allowed for this resource.');
}
function requestRecord(value, selected, actor) {
  resource(value?.resource, selected);
  if (value?.[actor]?.principal_type !== 'user' || value[actor].principal_id !== selected.accountUserId) error('ACCOUNT_CHANGED', 'The access request belongs to another account user.');
  if (!ID.test(value?.request_id ?? '') || !Array.isArray(value.recipients) || !Array.isArray(value.decisions)) error('INVALID_RESPONSE', 'The API returned an invalid access request.');
  const recipients = new Set(value.recipients.map(principalKey));
  const decided = new Set();
  for (const decision of value.decisions) {
    const key = principalKey(decision.recipient);
    if (!recipients.has(key) || decided.has(key)) error('INVALID_RESPONSE', 'The access request contains invalid decision history.');
    decided.add(key);
  }
  for (const satisfied of value.already_satisfied_recipients ?? []) {
    const key = principalKey(satisfied);
    if (!recipients.has(key) || decided.has(key)) error('INVALID_RESPONSE', 'The access request contains invalid terminal history.');
    decided.add(key);
  }
  return value;
}

export function sharingCapabilities() {
  return { scope: 'Account-wide Library file and folder permissions.', roles: ROLES,
    supported: ['sharing-state', 'shares', 'effective-access', 'collaborators', 'recipient-resolution', 'direct-invitations',
      'workspace-links', 'access-change-preview-and-apply', 'access-requests', 'invitation-accept-decline', 'received-share-removal'],
    permissionChanges: 'Require explicit confirm equal to the resource ID; invitation decisions require the invitation ID.',
    constraints: ['Fresh viewer, owner, resource and capability checks precede changes.', 'Public links are not supported by the audited Library sharing contract.',
      'No automatic retries, batch decisions, or automatic invitation acceptance.'], liveVerified: false };
}

export class LibrarySharing {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('LibrarySharing requires a DotClient.');
    this.transport = client.transport;
  }
  capabilities() { return sharingCapabilities(); }
  async identity(options = {}) {
    const selected = { accountId: id(options.accountId, 'accountId'), resourceId: id(options.resourceId, 'resourceId'), resourceKind: options.resourceKind };
    if (!['file', 'folder'].includes(selected.resourceKind)) invalid('resourceKind must be file or folder.');
    const current = await this._call('GET', `${this._base(selected)}/sharing-state`, selected, { query: { include_profile_photos: false }, signal: options.signal });
    resource(current.resource, selected); owner(current.owner?.principal);
    const viewer = current.viewer?.principal;
    if (viewer?.principal_type !== 'user' || !ID.test(viewer.principal_id ?? '')) error('INVALID_RESPONSE', 'The Library did not return a valid current user principal.');
    return { ...selected, accountUserId: viewer.principal_id };
  }
  async _call(method, route, selected, options = {}) {
    const assertAccount = async () => {
      if (typeof this.transport.authLoader === 'function') {
        const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
        if (auth.accountId !== selected.accountId) error('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
      }
    };
    await assertAccount();
    const result = await this.transport.request(method, route, { ...options, expectedAccountId: selected.accountId, maxBytes: 2 * 1024 * 1024 });
    await assertAccount();
    if (!record(result)) error('INVALID_RESPONSE', 'The sharing endpoint returned an invalid object.');
    return result;
  }
  _base(selected) { return `${BASE}/${selected.resourceKind === 'file' ? 'files' : 'directories'}/${encodeURIComponent(selected.resourceId)}`; }
  async _state(selected, signal) { return state(await this._call('GET', `${this._base(selected)}/sharing-state`, selected, { query: { include_profile_photos: false }, signal }), selected); }
  async _shares(selected, current, signal) {
    const shares = []; const seen = new Set(); let cursor; let data;
    do {
      if (seen.size >= 100) error('PAGINATION_LIMIT', 'The shares list exceeded 100 pages.');
      data = await this._call('GET', `${this._base(selected)}/shares`, selected, { query: { cursor, include_profile_photos: false }, signal });
      resource(data.resource, selected); owner(data.owner, current.owner.principal);
      if (!Array.isArray(data.shares)) error('INVALID_RESPONSE', 'The sharing endpoint returned an invalid share list.');
      for (const share of data.shares) { resource(share.resource, selected); id(share.share_id, 'share_id'); shares.push(share); }
      validateCursor(data.next_cursor); cursor = data.next_cursor;
      if (cursor != null) { if (seen.has(cursor)) error('INVALID_RESPONSE', 'The shares endpoint repeated a cursor.'); seen.add(cursor); }
    } while (cursor != null);
    return { ...data, shares, next_cursor: null };
  }
  async _effective(selected, current, signal) {
    const result = await this._call('GET', `${this._base(selected)}/effective-access`, selected, { query: { include_profile_photos: false }, signal });
    resource(result.resource, selected); owner(result.owner, current.owner.principal);
    if (!Array.isArray(result.collaborators)) error('INVALID_RESPONSE', 'The effective-access response has no collaborator list.');
    return result;
  }
  async state(options = {}) { const selected = scope(options); return clean(await this._state(selected, options.signal)); }
  async shares(options = {}) { const selected = scope(options); const current = await this._state(selected, options.signal); return clean(await this._shares(selected, current, options.signal)); }
  async effectiveAccess(options = {}) { const selected = scope(options); const current = await this._state(selected, options.signal); return clean(await this._effective(selected, current, options.signal)); }
  async collaborators(options = {}) {
    const selected = scope(options);
    const ids = options.accessRequestIds ?? [];
    if (!Array.isArray(ids) || ids.length > 2) invalid('accessRequestIds accepts at most two request IDs.');
    const unique = [...new Set(ids.map(value => id(value, 'accessRequestId')))].sort();
    const current = await this._state(selected, options.signal);
    const result = await this._call('GET', `${this._base(selected)}/collaborators`, selected, { query: { include_profile_photos: false },
      ...(unique.length ? { headers: { 'x-oai-library-access-request-ids': unique.join(',') } } : {}), signal: options.signal });
    resource(result.resource, selected); owner(result.owner, current.owner.principal);
    if (!Array.isArray(result.collaborators)) error('INVALID_RESPONSE', 'The collaborators response is not a list.');
    return clean(result);
  }
  async resolveRecipient(options = {}) {
    const selected = account(options); const address = email(options.email);
    return clean(await this._call('POST', '/backend-api/sharing/recipients/resolve', selected, { body: { email: address }, signal: options.signal }));
  }
  async createShare(options = {}) {
    const selected = scope(options); confirm(options); const target = recipient(options.recipient); const role = roleId(options.role, selected);
    if (options.expectedInvitationId !== undefined) id(options.expectedInvitationId, 'expectedInvitationId');
    const current = await this._state(selected, options.signal); capability(current, 'can_invite');
    const listing = await this._shares(selected, current, options.signal); allowedRole(listing.allowed_roles, role);
    const existing = listing.shares.find(share => recipientKey(share.recipient) === recipientKey(target));
    if (existing && existing.share_id !== options.expectedInvitationId) error('SHARING_CONFLICT', 'This recipient already has a share; provide its current share ID as expectedInvitationId.');
    if (!existing && options.expectedInvitationId !== undefined) error('SHARING_CONFLICT', 'The expected share no longer exists for this recipient.');
    const result = await this._call('POST', `${this._base(selected)}/shares`, selected,
      { body: { expected_invitation_id: options.expectedInvitationId, recipient: target, role_id: role }, signal: options.signal });
    resource(result.resource, selected);
    if (result.role_id !== role || recipientKey(result.recipient) !== recipientKey(target) || !ID.test(result.share_id ?? '')) error('MUTATION_UNCONFIRMED', 'The invitation response did not confirm the requested recipient and role.');
    return clean(result);
  }
  async removeShare(options = {}) {
    const selected = scope(options); confirm(options); id(options.shareId, 'shareId');
    const current = await this._state(selected, options.signal); capability(current, 'can_manage_access');
    const listing = await this._shares(selected, current, options.signal);
    const share = listing.shares.find(item => item.share_id === options.shareId);
    if (!share) error('SHARING_CONFLICT', 'The requested share is no longer present.');
    const target = recipient(share.recipient);
    if (target.recipient_type === 'principal' && target.principal_type === 'user' && target.principal_id === current.owner.principal.principal_id) error('SHARING_NOT_PERMITTED', 'The owner cannot be removed.');
    await this._call('DELETE', `${this._base(selected)}/shares/${encodeURIComponent(options.shareId)}`, selected, { query: target.recipient_type === 'principal'
      ? { recipient_principal_type: target.principal_type, recipient_principal_id: target.principal_id, expected_status: share.status, expected_role_id: share.role_id } : undefined, signal: options.signal });
    return { resource: current.resource, share_id: options.shareId, status: 'accepted' };
  }
  async updateLinkAccess(options = {}) {
    const selected = scope(options); confirm(options);
    if (!['workspace', 'collaborators_only'].includes(options.mode)) invalid('mode must be workspace or collaborators_only.');
    const role = options.mode === 'workspace' ? roleId(options.role, selected) : undefined;
    if (role && ![ROLES[selected.resourceKind].viewer, ROLES[selected.resourceKind].editor].includes(role)) invalid('Workspace links support viewer or editor roles.');
    if (options.workspaceId !== undefined && options.workspaceId !== selected.accountId) invalid('workspaceId must match accountId.');
    const current = await this._state(selected, options.signal); capability(current, 'can_manage_access', true);
    if (role) { const listing = await this._shares(selected, current, options.signal); allowedRole(listing.allowed_roles, role); }
    // The native dialog does not submit unchanged access. The service rejects
    // a collaborators-only PATCH when there is no workspace share to remove.
    if (current.link_access === options.mode && (options.mode === 'collaborators_only'
      || current.workspace_id === selected.accountId && current.role_id === role)) {
      return { ...clean(current), changed: false };
    }
    const result = state(await this._call('PATCH', `${this._base(selected)}/sharing-state`, selected, { body: options.mode === 'workspace'
      ? { expected_invitation_id: current.link_access === 'workspace' ? current.workspace_invitation_id : undefined, link_access: 'workspace', workspace_id: selected.accountId, role_id: role }
      : { expected_invitation_id: current.link_access === 'workspace' ? current.workspace_invitation_id : undefined,
        expected_role_id: current.link_access === 'workspace' ? current.role_id : undefined, link_access: 'collaborators_only' }, signal: options.signal }), selected);
    owner(result.owner.principal, current.owner.principal);
    if (result.link_access !== options.mode || (role && (result.role_id !== role || result.workspace_id !== selected.accountId))) error('MUTATION_UNCONFIRMED', 'The Library did not confirm the requested link access.');
    return clean(result);
  }
  async previewAccessChange(options = {}) {
    const selected = scope(options); const target = principal(options.recipient, 'recipient'); const desired = desiredRole(options.desiredRole);
    const current = await this._state(selected, options.signal); capability(current, 'can_manage_access');
    const effective = await this._effective(selected, current, options.signal);
    if (effective.complete !== true) error('SHARING_NOT_PERMITTED', 'Effective access must be complete before access can be changed.');
    if (principalKey(target) === principalKey(current.owner.principal)) error('SHARING_NOT_PERMITTED', 'The owner access cannot be changed.');
    if (desired !== null) { const listing = await this._shares(selected, current, options.signal); allowedRole(listing.allowed_roles, roleId(desired, selected)); }
    const result = await this._call('POST', `${this._base(selected)}/access-change/preview`, selected,
      { body: { recipient: { recipient_type: 'principal', ...target }, desired_role: desired }, signal: options.signal });
    resource(result.resource, selected);
    if (principalKey(result.recipient) !== principalKey(target) || result.desired_role !== desired || typeof result.fingerprint !== 'string' || !result.fingerprint || result.fingerprint.length > 16384) error('INVALID_RESPONSE', 'The access preview did not match the requested change.');
    return clean(result);
  }
  async applyAccessChange(options = {}) {
    const selected = scope(options); confirm(options);
    if (!record(options.preview)) invalid('preview must be an access-change preview from this resource.');
    resource(options.preview.resource, selected); const target = principal(options.preview.recipient, 'preview.recipient'); desiredRole(options.preview.desired_role);
    if (typeof options.preview.fingerprint !== 'string' || !options.preview.fingerprint) invalid('preview must include its fingerprint.');
    const latest = await this.previewAccessChange({ ...selected, recipient: target, desiredRole: options.preview.desired_role, signal: options.signal });
    if (latest.fingerprint !== options.preview.fingerprint) error('SHARING_CONFLICT', 'Access changed since the preview. Review a new preview before applying.');
    const current = await this._state(selected, options.signal); capability(current, 'can_manage_access');
    const result = await this._call('POST', `${this._base(selected)}/access-change/apply`, selected,
      { body: { recipient: { recipient_type: 'principal', ...target }, desired_role: latest.desired_role, fingerprint: latest.fingerprint }, signal: options.signal });
    resource(result.effective_access?.resource, selected); owner(result.effective_access.owner, current.owner.principal);
    return clean(result);
  }
  async accessRequests(options = {}) {
    const selected = scope(options); const { cursor } = pageOptions(options); const side = options.side ?? 'owner';
    if (!['owner', 'requester'].includes(side)) invalid('side must be owner or requester.');
    const current = await this._state(selected, options.signal);
    if (side === 'owner') capability(current, 'can_manage_access_requests', true);
    else {
      // Native dialog Kn/En exposes requester history only to eligible
      // nonowner, nonmanager collaborators. An owner has no requester-share
      // context, and the service can return 404 for that otherwise valid file.
      capability(current, 'can_request_access');
      // Version 1 treats an omitted optional management flag as false.
      // Present malformed values are not valid permission evidence.
      const canManage = current.capabilities.can_manage_access;
      if (principalKey(current.owner.principal) === principalKey(current.viewer.principal)
        || canManage !== undefined && canManage !== false) {
        error('SHARING_NOT_PERMITTED', 'Requester history requires a nonowner collaborator without manage-access permission.');
      }
    }
    const result = await this._call('GET', `${this._base(selected)}/access-requests${side === 'requester' ? '/mine' : ''}`, selected,
      { query: { cursor, include_profile_photos: false }, signal: options.signal });
    if (!Array.isArray(result.requests)) error('INVALID_RESPONSE', 'The API returned an invalid access-request list.');
    for (const item of result.requests) requestRecord(item, selected, side === 'owner' ? 'resource_owner' : 'requester');
    validateCursor(result.next_cursor); return clean(result);
  }
  async createAccessRequest(options = {}) {
    const selected = scope(options); confirm(options); const role = roleId(options.role, selected);
    if (!Array.isArray(options.recipients) || options.recipients.length < 1 || options.recipients.length > 100) invalid('recipients must contain 1 to 100 recipients.');
    const recipients = options.recipients.map(recipient);
    if (new Set(recipients.map(recipientKey)).size !== recipients.length) invalid('recipients must be unique.');
    const current = await this._state(selected, options.signal); capability(current, 'can_request_access');
    const result = requestRecord(await this._call('POST', `${this._base(selected)}/access-requests`, selected,
      { body: { recipients, requested_role_id: role }, signal: options.signal }), selected, 'requester');
    if (result.requested_role_id !== role || recipients.some(item => item.recipient_type === 'principal' && !result.recipients.some(other => principalKey(other) === principalKey(item)))) error('MUTATION_UNCONFIRMED', 'The access request did not confirm the requested role or recipients.');
    return clean(result);
  }
  async decideAccessRequest(options = {}) {
    const selected = scope(options); confirm(options); id(options.requestId, 'requestId'); const target = principal(options.recipient, 'recipient');
    if (!['approve', 'decline'].includes(options.decision)) invalid('decision must be approve or decline.');
    const current = await this._state(selected, options.signal); capability(current, 'can_manage_access_requests', true);
    if (options.decision === 'approve') capability(current, 'can_invite');
    let found; let cursor; const seen = new Set();
    do {
      const result = await this.accessRequests({ ...selected, side: 'owner', cursor, signal: options.signal });
      found = result.requests.find(item => item.request_id === options.requestId);
      if (found) break;
      cursor = result.next_cursor;
      if (cursor != null) { if (seen.has(cursor) || seen.size >= 100) error('INVALID_RESPONSE', 'Access-request pagination repeated or exceeded 100 pages.'); seen.add(cursor); }
    } while (cursor != null);
    const key = principalKey(target);
    if (!found || !found.recipients.some(item => principalKey(item) === key) || found.decisions.some(item => principalKey(item.recipient) === key)
        || found.already_satisfied_recipients?.some(item => principalKey(item) === key)) error('SHARING_CONFLICT', 'The selected recipient no longer has a pending access request.');
    const result = requestRecord(await this._call('POST', `${this._base(selected)}/access-requests/${encodeURIComponent(options.requestId)}/${options.decision}`, selected,
      { body: { recipient: { recipient_type: 'principal', ...target } }, signal: options.signal }), selected, 'resource_owner');
    if (result.request_id !== found.request_id || result.created_at !== found.created_at || principalKey(result.requester) !== principalKey(found.requester)
        || !result.decisions.some(item => principalKey(item.recipient) === key && item.decision === (options.decision === 'approve' ? 'approved' : 'declined')
          && item.decided_by?.principal_type === 'user' && item.decided_by.principal_id === selected.accountUserId)) error('MUTATION_UNCONFIRMED', 'The access-request decision was not confirmed.');
    return clean(result);
  }
  async invitations(options = {}) {
    const selected = account(options); const query = pageOptions(options);
    const resourceKind = options.resourceKind ?? 'file';
    if (!['file', 'folder'].includes(resourceKind)) invalid('resourceKind must be file or folder.'); query.resource_type = `library_${resourceKind}`;
    const result = await this._call('GET', '/backend-api/sharing/invitations', selected, { query, signal: options.signal });
    if (!Array.isArray(result.invitations)) error('INVALID_RESPONSE', 'The invitation endpoint returned an invalid list.');
    for (const item of result.invitations) this._invitation(item, resourceKind);
    validateCursor(result.next_cursor); return clean(result);
  }
  _invitation(value, kind) {
    if (!ID.test(value?.invitation_id ?? '') || !['library_file', 'library_folder'].includes(value.resource?.resource_type)
        || !ID.test(value.resource?.resource_id ?? '') || (kind && value.resource.resource_type !== `library_${kind}`)) error('INVALID_RESPONSE', 'The invitation did not match a Library resource.');
    return value;
  }
  async invitation(options = {}) {
    const selected = account(options); id(options.invitationId, 'invitationId');
    const result = this._invitation(await this._call('GET', `/backend-api/sharing/invitations/${encodeURIComponent(options.invitationId)}`, selected, { signal: options.signal }), options.resourceKind);
    if (result.invitation_id !== options.invitationId || (options.resourceId && result.resource.resource_id !== options.resourceId)) error('RESOURCE_CHANGED', 'The invitation does not match the requested invitation or resource.');
    if (result.recipient?.recipient_type === 'principal' && result.recipient.principal_type === 'user' && result.recipient.principal_id !== selected.accountUserId) {
      error('ACCOUNT_CHANGED', 'The invitation recipient does not match the selected account user.');
    }
    return clean(result);
  }
  async _decideInvitation(options, decision) {
    const selected = account(options); id(options.invitationId, 'invitationId'); confirm(options, 'invitationId');
    const current = await this.invitation(options);
    if (current.status !== 'pending' || (current.expires_at != null && (!Number.isFinite(Date.parse(current.expires_at)) || Date.parse(current.expires_at) <= Date.now()))) error('SHARING_CONFLICT', 'The invitation is not pending or has expired.');
    await this._call('POST', `/backend-api/sharing/invitations/${encodeURIComponent(options.invitationId)}/${decision}`, selected, { signal: options.signal });
    return { invitation_id: options.invitationId, resource: current.resource, status: 'request-accepted', decision };
  }
  acceptInvitation(options = {}) { return this._decideInvitation(options, 'accept'); }
  declineInvitation(options = {}) { return this._decideInvitation(options, 'decline'); }
  async removeReceivedShare(options = {}) {
    const selected = scope(options); confirm(options); const current = await this._state(selected, options.signal);
    if (principalKey(current.owner.principal) === principalKey(current.viewer.principal)) error('SHARING_NOT_PERMITTED', 'Owners cannot remove their own received share.');
    let suffix = '/shared-with-me';
    if (options.shareId !== undefined) {
      id(options.shareId, 'shareId');
      // A recipient may not enumerate the owner's shares. The browser uses the
      // received node's direct_share_id for self-removal instead.
      const metadata = selected.resourceKind === 'file'
        ? await this._call('GET', `${this._base(selected)}/node`, selected, { signal: options.signal })
        : await this._call('GET', `${BASE}/directories/path`, selected, { query: { directory_id: selected.resourceId }, signal: options.signal });
      const node = selected.resourceKind === 'file' ? metadata : metadata.items?.find(item => item.id === selected.resourceId);
      if (node?.id !== selected.resourceId || node.direct_share_id !== options.shareId || node.is_shared !== true) error('SHARING_CONFLICT', 'The selected direct share does not belong to the current received item.');
      suffix = `/shares/${encodeURIComponent(options.shareId)}`;
    }
    await this._call('DELETE', `${this._base(selected)}${suffix}`, selected, { signal: options.signal });
    return { resource: current.resource, ...(options.shareId ? { share_id: options.shareId } : {}), status: 'accepted', effect: options.shareId ? 'leave-direct-share' : 'remove-from-shared-with-me' };
  }
}
