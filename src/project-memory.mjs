import { DotError } from './errors.mjs';
import { AccountProjects, validateProjectId, projectSummary, requireProjectCrud, projectMutationUnverified } from './account-projects.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new DotError(code, message); };

function projectState(raw, context) {
  const project = projectSummary(raw, undefined, context, { detail: true });
  const g = raw.gizmo;
  if (g.memory_scope != null && !['global', 'project_v2', 'unset'].includes(g.memory_scope)) fail('INVALID_RESPONSE', 'The project memory scope is not recognized.');
  if (raw.has_tpp_conversation != null && typeof raw.has_tpp_conversation !== 'boolean') fail('INVALID_RESPONSE', 'The project Work-conversation status is invalid.');
  return { project,
    currentScope: g.memory_scope === 'project_v2' ? 'project_v2' : 'global',
    ordinary: g.gizmo_snorlax_type == null && g.first_party_project_type == null,
    archived: g.is_archived === true || g.archived_at != null,
    hasWorkConversations: raw.has_tpp_conversation === true };
}

function reasons(state, memoryEnabled, crudAllowed, target) {
  const result = [];
  if (!state.project.canWrite) result.push('write_permission_required');
  if (!crudAllowed) result.push('workspace_project_changes_disabled');
  if (!memoryEnabled) result.push('account_memory_disabled');
  if (!state.ordinary) result.push('ordinary_project_required');
  if (!state.project.private) result.push('private_project_required');
  if (state.archived) result.push('project_archived');
  if (target === 'project_v2' && state.hasWorkConversations) result.push('work_conversations_present');
  return result;
}

function scope(value) {
  if (!['global', 'project_v2'].includes(value)) fail('INVALID_ARGUMENT', 'Memory scope must be global or project_v2.');
  return value;
}

export function projectMemoryCapabilities() {
  return { supported: ['get', 'set'], scopes: ['global', 'project_v2'],
    scope: 'Memory configuration of one ordinary private account project; account-wide saved memory is unchanged.',
    constraints: ['Fresh project, account memory and workspace policy checks are required.',
      'Projects containing Work conversations cannot switch to project_v2.',
      'The native UI also has a rollout flag; the service remains authoritative for availability.',
      'Configuration readback does not prove that all conversations immediately use the new memory mode.'],
    liveVerified: false };
}

export class ProjectMemory extends AccountProjects {
  capabilities() { return projectMemoryCapabilities(); }

  async _memoryState(context, selected) {
    const raw = await this._get(context, selected), state = projectState(raw, context);
    const settings = await context.request('GET', '/settings/user');
    if (!record(settings?.settings) || typeof settings.settings.m3m !== 'boolean') fail('PROJECT_ELIGIBILITY_UNVERIFIED', 'The account memory setting could not be verified.');
    let crudAllowed = true;
    try { await requireProjectCrud(context); }
    catch (error) { if (error?.code === 'PROJECT_PERMISSION_DENIED') crudAllowed = false; else throw error; }
    return { raw, state, memoryEnabled: settings.settings.m3m, crudAllowed };
  }

  async get({ projectId, accountId, signal } = {}) {
    validateProjectId(projectId);
    const context = await this._context(accountId, signal);
    const { state, memoryEnabled, crudAllowed } = await this._memoryState(context, projectId);
    const global = reasons(state, memoryEnabled, crudAllowed, 'global');
    const projectOnly = reasons(state, memoryEnabled, crudAllowed, 'project_v2');
    return { accountId, projectId, currentScope: state.currentScope, memoryEnabled,
      canChangeToGlobal: global.length === 0, canChangeToProjectOnly: projectOnly.length === 0,
      unavailableReasons: { global, project_v2: projectOnly }, liveBehaviorVerified: false };
  }

  async set({ projectId, accountId, scope: target, confirm, signal } = {}) {
    validateProjectId(projectId); scope(target);
    if (confirm !== projectId) fail('CONFIRMATION_REQUIRED', 'Confirm the exact project ID before changing its memory scope.');
    const context = await this._context(accountId, signal);
    const initial = await this._memoryState(context, projectId);
    let { raw, state } = initial;
    const unavailable = reasons(state, initial.memoryEnabled, initial.crudAllowed, target);
    if (unavailable.length) fail('PROJECT_MEMORY_UNAVAILABLE', `Project memory cannot be changed: ${unavailable.join(', ')}.`);
    if (state.currentScope === target) return { accountId, projectId, scope: target, changed: false, confirmed: true };
    // The native transition to project-only memory performs a fresh, uncached
    // project read specifically to rule out Work conversations.
    if (target === 'project_v2') {
      raw = await this._get(context, projectId); state = projectState(raw, context);
      const changed = reasons(state, initial.memoryEnabled, initial.crudAllowed, target);
      if (changed.length) fail('PROJECT_MEMORY_UNAVAILABLE', `Project memory cannot be changed: ${changed.join(', ')}.`);
    }
    const g = raw.gizmo;
    for (const [key, value, max] of [['emoji', g.display.emoji, 128], ['theme', g.display.theme, 128], ['instructions', g.instructions, 262144]]) {
      if (value != null && (typeof value !== 'string' || value.length > max)) fail('INVALID_RESPONSE', `The current project ${key} cannot be preserved safely.`);
    }
    const body = { emoji: g.display.emoji ?? null, instructions: g.instructions ?? '', name: g.display.name.trim(),
      theme: g.display.theme ?? null, memory_scope: target };
    const response = await context.request('PATCH', `/projects/${encodeURIComponent(projectId)}`, { body });
    if (!record(response) || response.error != null || response.success === false) throw new DotError('MUTATION_UNCONFIRMED', 'The memory change was not acknowledged. Inspect this project before retrying.', { projectId, delivery: 'unknown' });
    try {
      const actual = await this._get(context, projectId);
      if (projectState(actual, context).currentScope !== target) fail('INVALID_RESPONSE', 'The project did not retain the requested memory scope.');
      if (actual.gizmo.display.name !== body.name || (actual.gizmo.display.emoji ?? null) !== body.emoji
        || (actual.gizmo.display.theme ?? null) !== body.theme || (actual.gizmo.instructions ?? '') !== body.instructions) {
        fail('INVALID_RESPONSE', 'The preserved project metadata changed during the memory update.');
      }
      return { accountId, projectId, scope: target, changed: true, confirmed: true,
        propagation: 'Conversation behavior may take hours to reflect this configuration.' };
    } catch (error) { throw projectMutationUnverified(error, projectId, 'memory'); }
  }
}
