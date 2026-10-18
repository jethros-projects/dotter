import { DotError } from './errors.mjs';
import { AccountProjects, validateProjectId, projectSummary, projectMutationUnverified } from './account-projects.mjs';

// Installed native contracts: model-28ff576e37e6.js i/a/o/c/l/d and
// dialog-cf1117371731.js Mt. Sharing is an account-project operation.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const CAPABILITIES = ['can_read', 'can_view_config', 'can_write', 'can_delete', 'can_export', 'can_share'];
const CHAT = Object.freeze({ can_read: true, can_view_config: true, can_write: false, can_delete: false, can_export: false, can_share: false });
const EDIT = Object.freeze({ ...CHAT, can_write: true });
const PRIVATE = Object.freeze({ ...CHAT, can_view_config: false });
const baseUser = value => value.split('__')[0];
const accessOf = subjects => subjects.some(item => item.type === 4) ? 'link' : subjects.some(item => item.type === 3) ? 'workspace_link' : 'private';
function identifier(value, label, response = false) {
  if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))(`${label} must be a valid native identifier.`);
  return value;
}
function email(value, response = false) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))('A valid email address is required.');
  return value.trim().toLowerCase();
}
function capabilities(value) {
  if (!record(value) || CAPABILITIES.some(key => typeof value[key] !== 'boolean') || Object.keys(value).some(key => !CAPABILITIES.includes(key))) invalid('The project returned unsupported sharing capabilities.');
  return Object.fromEntries(CAPABILITIES.map(key => [key, value[key]]));
}
function subjectKey(item) {
  switch (item.type) {
    case 1: return `user:${baseUser(item.user_id)}`;
    case 2: return `group:${item.group_id}`;
    case 10: return `email:${item.user_email}`;
    case 3: case 4: return `visibility:${item.type}`;
    default: invalid('The project returned an unsupported sharing subject.');
  }
}
function readSubjects(resource) {
  if (!record(resource.gizmo.author)) invalid('The project returned invalid sharing ownership metadata.');
  identifier(resource.gizmo.author.user_id, 'ownerId', true);
  if (resource.has_tpp_conversation != null && typeof resource.has_tpp_conversation !== 'boolean') invalid('The project returned an invalid Work-conversation marker.');
  const raw = resource.gizmo.sharing?.subjects ?? [];
  if (!Array.isArray(raw) || raw.length > 10000) invalid('The project returned invalid sharing subjects.');
  const seen = new Set();
  return raw.map(item => {
    if (!record(item) || ![1, 2, 3, 4, 10].includes(item.type)) invalid('The project returned an unsupported sharing subject.');
    const result = { type: item.type, capabilities: capabilities(item.capabilities) };
    if (item.type === 1) {
      result.user_id = identifier(item.user_id, 'userId', true);
      if (item.user_email != null) result.user_email = email(item.user_email, true);
    }
    if (item.type === 2) result.group_id = identifier(item.group_id, 'groupId', true);
    if (item.type === 10) result.user_email = email(item.user_email, true);
    const key = subjectKey(result); if (seen.has(key)) invalid('The project returned duplicate sharing subjects.'); seen.add(key);
    return result;
  });
}
function policy(resource, context, settings) {
  const account = context.account;
  if (!record(account) || !['personal', 'workspace'].includes(account.structure)) fail('ACCOUNT_MEMBERSHIP_UNVERIFIED', 'Project sharing requires a supported account membership.');
  const workspace = account.structure === 'workspace';
  if (workspace && !record(settings)) invalid('The workspace did not return fresh sharing settings.');
  const permissions = settings?.permissions;
  if (permissions != null && (!Array.isArray(permissions) || permissions.length > 10000 || permissions.some(value => typeof value !== 'string' || value.length > 1024))) invalid('The workspace returned invalid permission settings.');
  if (settings?.beta_settings != null && !record(settings.beta_settings)) invalid('The workspace returned invalid project sharing settings.');
  const g = resource.gizmo, p = g.current_user_permission;
  const shareEnabled = !workspace || (permissions == null ? settings.beta_settings?.project_sharing === true : permissions.includes('chatgpt.workspace.project.share'));
  const canWrite = p?.can_write === true && (!workspace || permissions == null || permissions.includes('chatgpt.workspace.project.crud'));
  const shared = g.share_recipient !== 'private' || (g.sharing?.subjects.length ?? 0) > 0;
  const canShare = p?.can_share === true && (shareEnabled || workspace && shared);
  const owner = typeof g.author?.user_id === 'string' && baseUser(g.author.user_id) === baseUser(account.account_user_id);
  return {
    canOpen: p?.can_read === true && g.gizmo_snorlax_type == null && (!workspace || shared || shareEnabled),
    canInvite: canWrite && shareEnabled && (workspace || canShare),
    canManage: owner && canWrite && canShare,
    canShareWorkspaceLink: workspace && (permissions == null || permissions.includes('chatgpt.workspace.project.share_workspace')),
  };
}
function wire(item, context) {
  const cap = { ...item.capabilities };
  switch (item.type) {
    case 1: return { type: 'user', user_id: context.account.structure === 'workspace' && !item.user_id.includes('__') ? `${item.user_id}__${context.accountId}` : item.user_id, capabilities: cap };
    case 2: return { type: 'group', group_id: item.group_id, capabilities: cap };
    case 10: return { type: 'email', user_email: item.user_email, capabilities: cap };
    case 3: return { type: 'workspace_link', capabilities: cap };
    case 4: return { type: 'link', capabilities: cap };
  }
}
function inputRole(value) { if (!['chat', 'edit'].includes(value)) fail('INVALID_ARGUMENT', 'role must be chat or edit.'); return value; }
function inputSubject(value) {
  if (!record(value) || !['user', 'group', 'email'].includes(value.type)) fail('INVALID_ARGUMENT', 'Each recipient must have type user, group or email.');
  const field = { user: 'userId', group: 'groupId', email: 'email' }[value.type];
  if (Object.keys(value).some(key => !['type', field].includes(key))) fail('INVALID_ARGUMENT', 'Recipient fields must match their declared type.');
  if (value.type === 'user') return { type: 1, user_id: identifier(value.userId, 'userId') };
  if (value.type === 'group') return { type: 2, group_id: identifier(value.groupId, 'groupId') };
  return { type: 10, user_email: email(value.email) };
}
function keyArgument(value) {
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'subject must be a user:, group: or email: key returned by sharing get.');
  const index = value.indexOf(':'); const type = value.slice(0, index), id = value.slice(index + 1);
  if (type === 'user') return `user:${baseUser(identifier(id, 'subject'))}`;
  if (type === 'group') return `group:${identifier(id, 'subject')}`;
  if (type === 'email') return `email:${email(id)}`;
  fail('INVALID_ARGUMENT', 'subject must be a user:, group: or email: key returned by sharing get.');
}
function sameCapabilities(a, b) { return CAPABILITIES.every(key => a[key] === b[key]); }
function equivalentIdentity(a, b) { return subjectKey(a) === subjectKey(b) || a.user_email != null && b.user_email != null && a.user_email === b.user_email; }
function sameSubjects(actual, wanted) {
  if (actual.length !== wanted.length) return false;
  const remaining = [...actual];
  for (const item of wanted) {
    // Prefer exact identities before matching a pending email invitation to an
    // accepted user. A single returned subject must never verify two changes.
    let index = remaining.findIndex(value => subjectKey(value) === subjectKey(item) && sameCapabilities(value.capabilities, item.capabilities));
    if (index < 0 && item.type === 10) index = remaining.findIndex(value => value.type === 1 && value.user_email != null && value.user_email === item.user_email && sameCapabilities(value.capabilities, item.capabilities));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}
function expansion(before, after) {
  const ranks = { private: 0, workspace_link: 1, link: 2 };
  if (ranks[accessOf(after)] > ranks[accessOf(before)]) return true;
  return after.some(item => {
    const previous = before.find(value => subjectKey(value) === subjectKey(item));
    if (previous == null) return ![3, 4].includes(item.type);
    return CAPABILITIES.some(key => item.capabilities[key] && !previous.capabilities[key]);
  });
}
function projection(resource, context, settings) {
  projectSummary(resource, resource.gizmo.id, context, { detail: true });
  const subjects = readSubjects(resource);
  return {
    accountId: context.accountId, projectId: resource.gizmo.id, access: accessOf(subjects),
    shared: resource.gizmo.share_recipient !== 'private' || subjects.length > 0,
    url: `https://chatgpt.com/g/${encodeURIComponent(resource.gizmo.id)}/project`,
    containsWorkConversations: resource.has_tpp_conversation === true,
    permissions: policy(resource, context, settings),
    subjects: subjects.map(item => ({ key: subjectKey(item), type: { 1: 'user', 2: 'group', 3: 'workspace_link', 4: 'link', 10: 'email' }[item.type],
      ...([1, 2, 10].includes(item.type) ? { role: item.capabilities.can_write ? 'edit' : 'chat' } : {}),
      ...(item.type === 1 ? { userId: item.user_id } : {}), ...(item.type === 2 ? { groupId: item.group_id } : {}),
      ...(item.user_email ? { email: item.user_email } : {}), capabilities: { ...item.capabilities } })),
  };
}

export function projectSharingCapabilities() {
  return { supported: ['get', 'access', 'invite', 'role', 'remove'], access: ['private', 'link', 'workspace_link'], roles: ['chat', 'edit'],
    limitations: ['All operations use a fresh account membership and project; workspace actions also load fresh workspace permission settings.',
      'All writes require exact project confirmation. First sharing can detach Library or Space-backed sources, which requires a separate acknowledgment.',
      'Private access disables link joining; it retains individually invited collaborators.', 'Work conversations prevent access expansion, including new invitees and increased roles.',
      'External invitations are sent only when the invite command is explicitly invoked; no invitation delivery or recipient acceptance is claimed.',
      'No native project join, leave or ownership-transfer mutation was identified in the audited sharing workflow.', 'No write is retried automatically.'], liveVerified: false };
}

export class ProjectSharing extends AccountProjects {
  capabilities() { return projectSharingCapabilities(); }
  async _sharingContext(accountId, signal) {
    const context = await this._context(accountId, signal);
    const settings = context.account?.structure === 'workspace' ? await context.request('GET', `/accounts/${encodeURIComponent(accountId)}/settings`) : undefined;
    return { context, settings };
  }
  async get({ accountId, projectId, signal } = {}) {
    validateProjectId(projectId); const { context, settings } = await this._sharingContext(accountId, signal);
    return projection(await this._get(context, projectId), context, settings);
  }
  async _change({ accountId, projectId, confirm, detachLibraryFiles = false, signal }, change) {
    validateProjectId(projectId);
    if (confirm !== projectId) fail('CONFIRMATION_REQUIRED', 'Confirm the exact project ID before changing project access.');
    if (typeof detachLibraryFiles !== 'boolean') fail('INVALID_ARGUMENT', 'detachLibraryFiles must be true or false.');
    const { context, settings } = await this._sharingContext(accountId, signal);
    const resource = await this._get(context, projectId), before = readSubjects(resource), p = policy(resource, context, settings);
    if (!p.canOpen || !(change.type === 'invite' ? p.canInvite : p.canManage)) fail('PROJECT_PERMISSION_DENIED', 'Fresh project and workspace permissions do not permit this sharing change.');
    if (change.type === 'access' && (change.access === 'workspace_link' && !p.canShareWorkspaceLink || change.access === 'link' && context.account.structure === 'workspace')) fail('PROJECT_PERMISSION_DENIED', 'This account cannot use the selected project link audience.');
    let after = before, body = { project_id: projectId };
    if (change.type === 'access') {
      if (accessOf(before) === change.access) return { ...projection(resource, context, settings), changed: false, confirmed: true };
      after = before.filter(item => ![3, 4].includes(item.type));
      if (change.access !== 'private') after = [...after, { type: change.access === 'link' ? 4 : 3, capabilities: { ...CHAT } }];
      body.add_or_replace = [{ type: change.access, capabilities: { ...(change.access === 'private' ? PRIVATE : CHAT) } }];
    } else if (change.type === 'invite') {
      if (context.account.structure !== 'workspace' && change.subjects.some(item => item.type !== 10)) fail('INVALID_ARGUMENT', 'User and group recipients require a workspace account; personal accounts invite by email.');
      if (context.account.structure === 'workspace' && change.subjects.filter(item => item.type === 10).length > 5) fail('INVALID_ARGUMENT', 'The native workspace invitation flow permits at most five email recipients per invitation.');
      if (change.subjects.some(item => item.type === 1 && item.user_id.includes('__') && !item.user_id.endsWith(`__${context.accountId}`))) fail('INVALID_ARGUMENT', 'Workspace user identifiers must belong to the selected account.');
      const owner = baseUser(resource.gizmo.author.user_id);
      if (change.subjects.some(item => item.type === 1 && baseUser(item.user_id) === owner || item.user_email != null && typeof resource.gizmo.author.user_email === 'string' && item.user_email === resource.gizmo.author.user_email.trim().toLowerCase())) fail('INVALID_ARGUMENT', 'The project owner already has access and cannot be invited.');
      const added = change.subjects.filter(item => !before.some(existing => equivalentIdentity(existing, item)));
      if (!added.length) return { ...projection(resource, context, settings), changed: false, confirmed: true };
      after = [...before, ...added]; body.add_or_replace = added.map(item => wire(item, context));
    } else {
      const existing = before.find(item => subjectKey(item) === change.subject);
      if (existing == null) fail('PROJECT_SUBJECT_NOT_FOUND', 'The selected subject is not present in the fresh project sharing list.');
      if (change.type === 'remove') { after = before.filter(item => item !== existing); body.remove = [wire(existing, context)]; }
      else {
        const next = { ...existing, capabilities: { ...(change.role === 'edit' ? EDIT : CHAT) } };
        if (sameCapabilities(existing.capabilities, next.capabilities)) return { ...projection(resource, context, settings), changed: false, confirmed: true };
        after = before.map(item => item === existing ? next : item); body.add_or_replace = [wire(next, context)];
      }
    }
    if (change.type !== 'access') {
      const visibility = before.find(item => [3, 4].includes(item.type));
      body.add_or_replace = [...body.add_or_replace ?? [], visibility ? wire(visibility, context) : { type: 'private', capabilities: { ...PRIVATE } }];
    }
    if (resource.has_tpp_conversation === true && expansion(before, after)) fail('PROJECT_WORK_CONVERSATIONS', 'Remove Work conversations from this project before expanding its sharing access.');
    const detached = resource.gizmo.share_recipient === 'private' && before.length === 0 && after.length > 0
      ? resource.files.filter(item => item.file_response_type === 'full_file_response' && item.library_file_id).map(item => item.file_id || item.id) : [];
    if (detached.length && !detachLibraryFiles) fail('CONFIRMATION_REQUIRED', 'First sharing detaches Library or Space-backed source files from this project. They remain in the Library or Space. Pass detachLibraryFiles: true to acknowledge this consequence.', { libraryFilesToDetach: detached.length });
    const response = await context.request('POST', '/projects/share', { body });
    if (!record(response)) throw projectMutationUnverified(new DotError('INVALID_RESPONSE', 'The project sharing response was invalid.'), projectId, 'sharing');
    if (response.error != null) fail('PROJECT_PERMISSION_DENIED', 'The server rejected the project sharing change.', { delivery: 'rejected' });
    try {
      if (response.resource != null) projectSummary(response.resource, projectId, context, { detail: true });
      const verified = await this._get(context, projectId), actual = readSubjects(verified);
      if (accessOf(actual) !== accessOf(after) || !sameSubjects(actual, after)) invalid('The persisted project sharing state did not match the requested change.');
      if (detached.some(id => verified.files.some(item => (item.file_id || item.id) === id))) invalid('The sharing change did not confirm that Library-backed files were detached.');
      return { ...projection(verified, context, settings), changed: true, confirmed: true, ...(detached.length ? { detachedLibraryFileCount: detached.length } : {}) };
    } catch (error) { throw projectMutationUnverified(error, projectId, 'sharing'); }
  }
  access(options = {}) {
    if (!['private', 'link', 'workspace_link'].includes(options.access)) fail('INVALID_ARGUMENT', 'access must be private, link or workspace_link.');
    return this._change(options, { type: 'access', access: options.access });
  }
  invite(options = {}) {
    const role = inputRole(options.role ?? 'edit');
    if (!Array.isArray(options.subjects) || !options.subjects.length || options.subjects.length > 100) fail('INVALID_ARGUMENT', 'subjects must contain from 1 to 100 explicit recipients.');
    const subjects = options.subjects.map(item => ({ ...inputSubject(item), capabilities: { ...(role === 'edit' ? EDIT : CHAT) } }));
    const keys = subjects.map(subjectKey); if (new Set(keys).size !== keys.length) fail('INVALID_ARGUMENT', 'Recipient identities must not be duplicated.');
    return this._change(options, { type: 'invite', subjects });
  }
  role(options = {}) { return this._change(options, { type: 'role', subject: keyArgument(options.subject), role: inputRole(options.role) }); }
  remove(options = {}) { return this._change(options, { type: 'remove', subject: keyArgument(options.subject) }); }
}
