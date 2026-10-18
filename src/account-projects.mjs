import { DotError } from './errors.mjs';

// Native ChatGPT account projects, not custom GPTs or local Codex projects.
// Contracts: app-initial-90eb42395b7d.js n5r, w8r, Dga/p_a, h5r, Oga,
// pZi, and r3r. A project has a g-p- ID and a snorlax resource wrapper.
const ROOT = '/backend-api';
const PROJECT_ID = /^g-p-[A-Za-z0-9_-]{1,200}$/;
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
// 50 was accepted by the live sidebar endpoint; 100 returned validation 422.
// This is the verified CLI page-size bound, not a claim about its exact maximum.
const PROJECT_LIST_PAGE_SIZE = 50;
// The project-conversation endpoint returned an explicit query.limit <= 50
// validation error; a real 50-item request subsequently succeeded.
const PROJECT_CONVERSATIONS_PAGE_SIZE = 50;
// SymbolBrowser/IAs sends eDa(color): the light palette value, or null for black.
export const PROJECT_THEMES = Object.freeze({ black: null, blue: '#0285ff', green: '#04b84c', orange: '#fb6a22', pink: '#ff66ad', purple: '#924ff7', red: '#fa423e', yellow: '#ffc300' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
function id(value, label = 'accountId') {
  if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) fail('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function projectId(value) {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) fail('INVALID_ARGUMENT', 'projectId must be a native g-p- account project ID.');
  return value;
}
function text(value, label, max, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || (multiline ? /[\0]/ : /[\x00-\x1f\x7f]/).test(value)) fail('INVALID_ARGUMENT', `${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without ${multiline ? 'NUL bytes' : 'control characters'}.`);
  return value;
}
function count(value, label, max) { if (!Number.isInteger(value) || value < 1 || value > max) fail('INVALID_ARGUMENT', `${label} must be an integer from 1 to ${max}.`); return value; }
function cursor(value, response = false) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))('The project pagination cursor is invalid.');
  return value;
}
function boolean(value, label) { if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${label} must be true or false.`); return value; }
function nullableText(value, label, max) { return value === null ? null : text(value, label, max); }
function memoryScope(value) { if (!['unset', 'global', 'project_v2'].includes(value)) fail('INVALID_ARGUMENT', 'memoryScope must be unset, global or project_v2.'); return value; }
function projectTheme(value) { if (typeof value !== 'string' || !Object.hasOwn(PROJECT_THEMES, value)) fail('INVALID_ARGUMENT', `theme must be one of: ${Object.keys(PROJECT_THEMES).join(', ')}.`); return PROJECT_THEMES[value]; }
function safeText(value, max = 8192) { return typeof value === 'string' && value.length <= max ? value : null; }
function hidden(value, depth = 0) {
  return !record(value) || depth > 8 || value.hidden === true || value.is_hidden === true || value.is_visually_hidden_from_conversation === true || value.deleted_at != null || value.deletedAt != null
    || value.deleted === true || value.is_deleted === true || value.removed === true || value.is_removed === true || value.removed_at != null
    || value.visible === false || value.is_visible === false || value.user_visible === false || value.is_user_visible === false
    || typeof value.visibility === 'string' && ['hidden', 'internal', 'deleted', 'redacted'].includes(value.visibility.toLowerCase())
    || value.private === true || value.is_private === true || value.internal === true || value.is_internal === true || value.redacted === true || value.is_redacted === true
    || value.channel != null && !['final', 'commentary'].includes(value.channel) || value.recipient != null && value.recipient !== 'all'
    || record(value.metadata) && hidden(value.metadata, depth + 1);
}
function summary(resource, expectedId, membership, { detail = false } = {}) {
  const g = resource?.gizmo;
  if (!record(resource) || !record(g) || !PROJECT_ID.test(g.id ?? '') || expectedId !== undefined && g.id !== expectedId || g.gizmo_type !== 'snorlax' || !record(g.display) || typeof g.display.name !== 'string' || g.display.name.length > 1024 || hidden(g)) invalid('The response did not identify the requested visible account project.');
  if (!record(g.current_user_permission) || g.current_user_permission.can_read !== true) fail('NOT_VISIBLE', 'The project is not readable by the selected account.');
  if (g.sharing != null && (!record(g.sharing) || !Array.isArray(g.sharing.subjects))) invalid('The project returned invalid sharing metadata.');
  const sharing = g.sharing;
  const privateProject = g.share_recipient === 'private' && resource.hasSharingSubjects !== true && (sharing?.subjects.length ?? 0) === 0;
  const result = { id: g.id, name: g.display.name, owned: typeof g.author?.user_id === 'string' && g.author.user_id === membership.ownerId,
    private: privateProject, canWrite: g.current_user_permission.can_write === true, canDelete: g.current_user_permission.can_delete === true,
    emoji: safeText(g.display.emoji, 128), theme: safeText(g.display.theme, 128), memoryScope: safeText(g.memory_scope, 100),
    createdAt: safeText(g.created_at, 100), updatedAt: safeText(g.updated_at, 100) };
  if (detail) {
    if (!Array.isArray(resource.files) || resource.files.length > 10000) invalid('The project returned invalid file membership.');
    if (g.instructions != null && (typeof g.instructions !== 'string' || g.instructions.length > 262144)) invalid('The project instructions were invalid.');
    result.instructions = g.instructions ?? '';
    result.files = resource.files.map(file => {
      const fileId = file?.file_id || file?.id;
      if (!record(file) || typeof fileId !== 'string' || !ID.test(fileId)) invalid('The project returned invalid file metadata.');
      // The native source list also accepts opaque id-only records. Only the
      // full_file_response variant permits names or content metadata to leave.
      if (file.file_response_type !== 'full_file_response' || typeof file.file_id !== 'string' || file.file_id !== fileId) return { id: fileId, metadataAvailable: false };
      return { fileId: file.file_id, metadataAvailable: true, ...(safeText(file.library_file_id, 1024) ? { libraryFileId: file.library_file_id } : {}),
        ...(safeText(file.name, 4096) ? { name: file.name } : {}), ...(safeText(file.type, 256) ? { mimeType: file.type } : {}) };
    });
    result.fileCount = result.files.length;
  }
  return result;
}
function mutationGuard(resource, membership, permission, { ownPrivate = false } = {}) {
  const item = summary(resource, undefined, membership, { detail: true });
  const g = resource.gizmo;
  if (ownPrivate && !item.owned) fail('PROJECT_NOT_OWNED', 'The created project is not owned by the selected account.');
  if (ownPrivate && (!item.private || g.first_party_project_type != null || g.gizmo_snorlax_type != null || g.is_archived === true || g.archived_at != null)) fail('PROJECT_SCOPE_UNSUPPORTED', 'The created project must be an ordinary private account project without shared members.');
  if (permission === 'can_delete' && g.gizmo_snorlax_type != null) fail('PROJECT_SCOPE_UNSUPPORTED', 'This special project subtype does not support native project deletion.');
  if (g.current_user_permission[permission] !== true) fail('PROJECT_PERMISSION_DENIED', 'The project does not grant the required permission.');
  return item;
}
function conversation(item, expectedProjectId) {
  if (!record(item) || typeof item.id !== 'string' || !ID.test(item.id) || item.gizmo_id != null && item.gizmo_id !== expectedProjectId) invalid('The project conversation response contained an unrelated conversation.');
  const result = { id: item.id };
  for (const key of ['title', 'create_time', 'update_time', 'is_archived', 'is_starred', 'conversation_origin', 'async_status']) {
    const v = item[key]; if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 8192) result[key] = v;
  }
  return result;
}
function acknowledged(value) {
  if (typeof value === 'string') { if (value.trim() === '') return; try { value = JSON.parse(value); } catch { fail('MUTATION_UNCONFIRMED', 'The project mutation response was invalid. Inspect the project before retrying.', { delivery: 'unknown' }); } }
  if (!record(value) || value.error != null || value.success === false || value.completed === false) fail('MUTATION_UNCONFIRMED', 'The server did not acknowledge the project change. Inspect the project before retrying.', { delivery: 'unknown' });
}
function unverified(error, project, operation) {
  if (error?.code === 'MUTATION_UNCONFIRMED') return error;
  return new DotError('MUTATION_UNCONFIRMED', 'The project change was accepted, but its readback could not be verified. Inspect this exact project before retrying.',
    { projectId: project, operation, delivery: 'accepted', verificationCode: typeof error?.code === 'string' ? error.code : 'INVALID_RESPONSE' });
}

// Shared implementation contracts for the scoped project API modules. These
// are intentionally not re-exported from the package's public entry point.
export { projectId as validateProjectId, summary as projectSummary, mutationGuard as requireProjectPermission, unverified as projectMutationUnverified };

export async function requireProjectCrud(context) {
  await context.assert();
  if (context.account?.structure === 'personal') return;
  const settings = await context.request('GET', `/accounts/${encodeURIComponent(context.accountId)}/settings`);
  if (!record(settings) || !Object.hasOwn(settings, 'permissions') || settings.permissions === undefined) {
    fail('PROJECT_ELIGIBILITY_UNVERIFIED', 'Workspace project permissions could not be verified.');
  }
  const permissions = settings.permissions;
  if (permissions === null) return;
  if (!Array.isArray(permissions) || permissions.length > 10000 || permissions.some(value => typeof value !== 'string' || value.length > 512)) {
    invalid('Workspace project permissions were invalid.');
  }
  if (!permissions.includes('chatgpt.workspace.project.crud')) {
    fail('PROJECT_PERMISSION_DENIED', 'Workspace policy does not allow project changes.');
  }
}

export function accountProjectCapabilities() {
  return { scope: 'Native g-p- ChatGPT account projects, separate from Dot identities and local Codex projects.',
    supported: ['list', 'get', 'conversations', 'create', 'update', 'delete', 'pinned', 'pin', 'unpin'],
    mutationFields: ['name', 'emoji', 'theme', 'instructions'], creationMemoryScopes: ['unset', 'global', 'project_v2'], themes: Object.keys(PROJECT_THEMES),
    limitations: ['All requests require an explicit account and fresh authenticated membership.', 'Edits and deletion require fresh native permissions and workspace policy; pins require a readable project.', 'Creation verifies a private project owned by the selected account.', 'Deletion requests permanent removal of the project and its contained chats; saved Library or Space files are retained by the native service.', 'No write is automatically retried; accepted writes require exact readback.', 'Project files, sharing, sources, saved responses and memory have separate command groups and capability reports.'], liveVerified: false };
}

export class AccountProjects {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('AccountProjects requires a DotClient transport.'); this.transport = client.transport; }
  capabilities() { return accountProjectCapabilities(); }
  async _context(accountId, signal) {
    id(accountId); signal?.throwIfAborted();
    const load = async () => {
      if (typeof this.transport.authLoader !== 'function') fail('AUTH_IDENTITY_REQUIRED', 'Account projects require an authenticated Codex transport.');
      const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
      let subject; try { subject = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub; } catch {}
      if (auth?.accountId !== accountId) fail('ACCOUNT_CHANGED', 'The signed-in account differs from the selected account.');
      if (typeof subject !== 'string' || !subject) fail('AUTH_IDENTITY_REQUIRED', 'Account projects require a Codex login with an authenticated user identity.');
      this.transport.assertIdentity?.(auth); return { accountId, subject };
    };
    const identity = await load();
    const assert = async () => { signal?.throwIfAborted(); const current = await load(); if (current.subject !== identity.subject) fail('AUTH_IDENTITY_CHANGED', 'The signed-in user changed during the project operation.'); };
    const request = async (method, path, options = {}) => {
      await assert(); const value = await this.transport.request(method, `${ROOT}${path}`, { ...options, expectedAccountId: accountId, signal, maxBytes: options.maxBytes ?? 4 * 1024 * 1024 });
      try { await assert(); } catch (error) { if (method !== 'GET' && record(error.details)) error.details = { ...error.details, delivery: 'unknown', operation: 'project change' }; throw error; }
      return value;
    };
    const accounts = await request('GET', '/accounts/check/v4-2023-04-27');
    const membership = accounts?.accounts?.[accountId]; const account = membership?.account;
    if (!record(account) || account.account_id !== accountId || typeof account.account_user_id !== 'string' || !ID.test(account.account_user_id) || typeof account.structure !== 'string' || membership.can_access_with_session !== true) fail('ACCOUNT_MEMBERSHIP_UNVERIFIED', 'The service did not confirm accessible membership in the selected account.');
    const ownerId = account.structure === 'personal' ? account.account_user_id.split('__')[0] : account.account_user_id;
    if (!ownerId) invalid('The selected account returned an invalid owner identity.');
    // Keep only account facts consumed by native project permissions. The
    // full membership response can contain unrelated private account data.
    const projectAccount = Object.freeze({ account_id: accountId, account_user_id: account.account_user_id, structure: account.structure,
      ...(safeText(account.plan_type, 128) === null ? {} : { plan_type: account.plan_type }),
      ...(safeText(account.account_user_role, 128) === null ? {} : { account_user_role: account.account_user_role }) });
    return { accountId, ownerId, subject: identity.subject, account: projectAccount, request, assert };
  }
  async _get(context, selected) {
    const raw = await context.request('GET', `/gizmos/${encodeURIComponent(selected)}`, { query: { include_file_limits: true } });
    summary(raw, selected, context, { detail: true }); return raw;
  }
  async get({ projectId: selected, accountId, signal } = {}) {
    projectId(selected); const c = await this._context(accountId, signal);
    return { accountId, ...summary(await this._get(c, selected), selected, c, { detail: true }) };
  }
  async list({ accountId, limit = 20, pages = 1, cursor: initial, ownedOnly = true, signal } = {}) {
    count(limit, 'limit', PROJECT_LIST_PAGE_SIZE); count(pages, 'pages', 100); boolean(ownedOnly, 'ownedOnly'); let next = cursor(initial);
    const c = await this._context(accountId, signal), items = [], seen = new Set(), ids = new Set(); let pagesRead = 0;
    for (; pagesRead < pages;) {
      if (next !== null) { if (seen.has(next)) invalid('The project pagination cursor did not advance.'); seen.add(next); }
      const data = await c.request('GET', '/gizmos/snorlax/sidebar', { query: { conversations_per_gizmo: 0, cursor: next, limit, owned_only: ownedOnly } });
      if (!record(data) || !Array.isArray(data.items) || data.items.length > limit) invalid('The account project list was invalid.');
      for (const entry of data.items) {
        if (!record(entry) || !Object.hasOwn(entry, 'conversations')) invalid('The account project list entry was invalid.');
        const item = summary(entry.gizmo, undefined, c);
        if (ownedOnly && !item.owned) invalid('The owned-project list returned a project owned by another member.');
        if (!ids.has(item.id)) { ids.add(item.id); items.push(item); }
      }
      next = cursor(data.cursor, true); pagesRead++; if (next === null) break;
    }
    if (next !== null && seen.has(next)) invalid('The project pagination cursor did not advance.');
    return { accountId, items, cursor: next, pagesRead };
  }
  async conversations({ projectId: selected, accountId, limit = 20, pages = 1, cursor: initial, ownedOnly = false, signal } = {}) {
    projectId(selected); count(limit, 'limit', PROJECT_CONVERSATIONS_PAGE_SIZE); count(pages, 'pages', 100); boolean(ownedOnly, 'ownedOnly'); let next = cursor(initial);
    const c = await this._context(accountId, signal); await this._get(c, selected);
    const items = [], seen = new Set(), ids = new Set(); let pagesRead = 0;
    for (; pagesRead < pages;) {
      if (next !== null) { if (seen.has(next)) invalid('The project conversation cursor did not advance.'); seen.add(next); }
      const data = await c.request('GET', `/gizmos/${encodeURIComponent(selected)}/conversations`, { query: { cursor: next, limit, owned_only: ownedOnly } });
      if (!record(data) || !Array.isArray(data.items) || data.items.length > limit) invalid('The project conversation page was invalid.');
      for (const entry of data.items) { if (hidden(entry)) continue; const item = conversation(entry, selected); if (!ids.has(item.id)) { ids.add(item.id); items.push(item); } }
      next = cursor(data.cursor, true); pagesRead++; if (next === null) break;
    }
    if (next !== null && seen.has(next)) invalid('The project conversation cursor did not advance.');
    return { accountId, projectId: selected, items, cursor: next, pagesRead };
  }
  async create({ name, emoji = null, theme: selectedTheme = 'black', memoryScope: memory = 'unset', accountId, signal } = {}) {
    const theme = projectTheme(selectedTheme);
    name = text(name, 'name', 50).trim(); nullableText(emoji, 'emoji', 128); if (memory !== undefined) memoryScope(memory);
    const c = await this._context(accountId, signal);
    await requireProjectCrud(c);
    const value = await c.request('POST', '/projects', { body: { name, emoji, theme, instructions: '', memory_scope: memory } });
    if (!record(value) || value.error != null || !record(value.resource)) fail('MUTATION_UNCONFIRMED', 'The project creation did not return a confirmed resource. Inspect the project list before retrying.', { delivery: 'unknown' });
    const selected = value.resource.gizmo?.id;
    try {
      projectId(selected); const created = mutationGuard(value.resource, c, 'can_write', { ownPrivate: true });
      if (created.name !== name || created.emoji !== emoji || created.theme !== theme || memory !== 'unset' && created.memoryScope !== memory) invalid('The created project did not match the requested fields.');
      const raw = await this._get(c, selected), verified = mutationGuard(raw, c, 'can_write', { ownPrivate: true });
      if (verified.name !== name || verified.emoji !== emoji || verified.theme !== theme || verified.instructions !== '' || memory !== 'unset' && verified.memoryScope !== memory) invalid('The project creation did not persist the requested fields.');
      return { accountId, operation: 'create', confirmed: true, project: verified };
    } catch (error) { throw unverified(error, PROJECT_ID.test(selected ?? '') ? selected : undefined, 'create'); }
  }
  async update({ projectId: selected, accountId, name, emoji, theme, instructions, memoryScope: memory, clearEmoji = false, clearTheme = false, signal } = {}) {
    projectId(selected); boolean(clearEmoji, 'clearEmoji'); boolean(clearTheme, 'clearTheme');
    if (memory !== undefined) fail('UNSUPPORTED', 'Use the project memory commands for an eligibility-checked memory-scope change.');
    if (name !== undefined) name = text(name, 'name', 50).trim();
    if (instructions !== undefined) text(instructions, 'instructions', 8000, { empty: true, multiline: true });
    if (emoji !== undefined) nullableText(emoji, 'emoji', 128);
    if (theme !== undefined) theme = projectTheme(theme);
    if (clearEmoji && emoji !== undefined || clearTheme && theme !== undefined) fail('INVALID_ARGUMENT', 'Choose a field value or its clear flag, not both.');
    if (clearEmoji) emoji = null; if (clearTheme) theme = null;
    const changes = { ...(name === undefined ? {} : { name }), ...(emoji === undefined ? {} : { emoji }), ...(theme === undefined ? {} : { theme }), ...(instructions === undefined ? {} : { instructions }) };
    if (!Object.keys(changes).length) fail('INVALID_ARGUMENT', 'Provide at least one supported project field to update.');
    const c = await this._context(accountId, signal); const before = mutationGuard(await this._get(c, selected), c, 'can_write');
    const desired = { ...before, ...changes };
    if (Object.entries(changes).every(([key, value]) => before[key] === value)) return { accountId, projectId: selected, changed: false, confirmed: true, project: before };
    await requireProjectCrud(c);
    acknowledged(await c.request('PATCH', `/projects/${encodeURIComponent(selected)}`, { body: { name: desired.name, emoji: desired.emoji, theme: desired.theme, instructions: desired.instructions } }));
    try {
      const verified = mutationGuard(await this._get(c, selected), c, 'can_write');
      if (Object.entries(changes).some(([key, value]) => verified[key] !== value)) invalid('The project update did not persist the requested fields.');
      return { accountId, projectId: selected, changed: true, confirmed: true, project: verified };
    } catch (error) { throw unverified(error, selected, 'update'); }
  }
  async delete({ projectId: selected, accountId, confirm, deleteChats = false, signal } = {}) {
    projectId(selected); if (confirm !== selected || deleteChats !== true) fail('CONFIRMATION_REQUIRED', 'Deletion permanently removes this project and all its chats. Pass deleteChats: true and confirm the exact project ID.');
    const c = await this._context(accountId, signal); mutationGuard(await this._get(c, selected), c, 'can_delete');
    await requireProjectCrud(c);
    acknowledged(await c.request('DELETE', `/gizmos/${encodeURIComponent(selected)}`, { responseType: 'text' }));
    try { await this._get(c, selected); }
    catch (error) {
      if (error?.code === 'HTTP_ERROR' && error?.details?.status === 404) { await c.assert(); return { accountId, projectId: selected, deleted: true, projectAbsenceVerified: true, containedChatDeletionRequested: true, confirmed: true }; }
      throw unverified(error, selected, 'delete');
    }
    throw unverified(new DotError('PROJECT_STILL_PRESENT', 'The project remains visible.'), selected, 'delete');
  }
  async _pinned(c) {
    const data = await c.request('GET', '/pins', { query: { item_type: 'project' } });
    if (!Array.isArray(data) || data.length > 1000) invalid('The pinned project list was invalid.');
    const ids = new Set(); return data.map(row => {
      if (!record(row) || row.item_type !== 'project') invalid('The pinned project list returned a different item type.');
      const item = summary(row.item, undefined, c); if (ids.has(item.id)) invalid('The pinned project list repeated a project.'); ids.add(item.id); return item;
    });
  }
  async pinned({ accountId, signal } = {}) { const c = await this._context(accountId, signal); return { accountId, items: await this._pinned(c) }; }
  async _setPinned({ projectId: selected, accountId, pinned, signal } = {}) {
    projectId(selected); boolean(pinned, 'pinned'); const c = await this._context(accountId, signal);
    summary(await this._get(c, selected), selected, c);
    if ((await this._pinned(c)).some(item => item.id === selected) === pinned) return { accountId, projectId: selected, pinned, changed: false, confirmed: true };
    acknowledged(await c.request(pinned ? 'POST' : 'DELETE', `/pins/project/${encodeURIComponent(selected)}`, { responseType: 'text' }));
    try {
      if ((await this._pinned(c)).some(item => item.id === selected) !== pinned) invalid('The project pin change was not visible in the pinned list.');
      return { accountId, projectId: selected, pinned, changed: true, confirmed: true };
    } catch (error) { throw unverified(error, selected, pinned ? 'pin' : 'unpin'); }
  }
  pin(options) { return this._setPinned({ ...options, pinned: true }); }
  unpin(options) { return this._setPinned({ ...options, pinned: false }); }
}
