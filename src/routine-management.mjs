import { DotError } from './errors.mjs';

// Installed-app contracts, inspected 2026-10-18: table-682be814c500.js,
// share-dialog-dd5d931cb8b6.js and shared-task-dialog-4dad6b90a910.js.
// Shared-task import is conversation-mediated. This module prepares the prompt;
// it never claims that prompt preparation has created a new routine.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = message => { throw new DotError('INVALID_ARGUMENT', message); };
const malformed = message => { throw new DotError('INVALID_RESPONSE', message); };
function object(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) malformed(`The ${label} response was not an object.`);
  return value;
}
function text(value, label, max = 64000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) invalid(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without NUL bytes.`);
  return value;
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') invalid(`${label} must be an ID returned by the API.`);
  return encodeURIComponent(value);
}
function oneOf(value, choices, label) {
  if (!choices.includes(value)) invalid(`${label} must be ${choices.join(', ')}.`);
  return value;
}
function scalarFields(value, fields) {
  return Object.fromEntries(fields.filter(key => own(value, key)
    && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])))
    .map(key => [key, value[key]]));
}
function cursor(value) {
  if (value != null && (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0'))) malformed('The routine query returned an invalid cursor.');
  return value ?? null;
}
function hidden(value) {
  return Boolean(value?.hidden || value?.is_hidden || value?.is_visually_hidden_from_conversation || value?.deleted_at != null
    || value?.metadata?.hidden || value?.metadata?.is_hidden || value?.metadata?.is_visually_hidden_from_conversation || value?.metadata?.deleted_at != null);
}
function routineSummary(value) {
  object(value, 'routine');
  if (hidden(value)) return null;
  if (typeof value.id !== 'string' || !value.id) malformed('The routine query returned an item without an ID.');
  const result = scalarFields(value, ['id', 'title', 'prompt', 'description', 'status', 'emoji', 'display_emoji', 'created_at', 'updated_at',
    'team_id', 'is_enabled', 'notifications_enabled', 'email_enabled', 'default_timezone', 'timing_mode', 'source', 'executor', 'conversation_id']);
  if (typeof value.schedule === 'string') result.schedule = value.schedule;
  else if (value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)) result.schedule = scalarFields(value.schedule, ['kind', 'next_run_at', 'display_text', 'summary']);
  if (Array.isArray(value.next_run_times)) result.next_run_times = value.next_run_times.filter(item => typeof item === 'string');
  if (value.owner && typeof value.owner === 'object' && !Array.isArray(value.owner)) result.owner = scalarFields(value.owner, ['id', 'type', 'name', 'display_name']);
  if (value.permissions && typeof value.permissions === 'object' && !Array.isArray(value.permissions)) result.permissions = scalarFields(value.permissions, ['can_read', 'can_write', 'can_manage', 'can_delete', 'can_share']);
  return result;
}
function share(value, operation) {
  const invalidShare = message => { throw new DotError('INVALID_RESPONSE', message, operation === 'read' ? {} : { delivery: 'unknown' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidShare('The routine share response was not an object. Read the current share before retrying.');
  if (typeof value.post_id !== 'string' || !value.post_id || typeof value.permalink !== 'string') {
    invalidShare(`The ${operation} response did not confirm a share link. Read the current share before retrying.`);
  }
  let url;
  try { url = new URL(value.permalink); } catch { invalidShare('The share response did not contain a valid permalink. Read the current share before retrying.'); }
  if (url.protocol !== 'https:' || url.username || url.password) invalidShare('The share response did not contain a safe HTTPS permalink. Read the current share before retrying.');
  return scalarFields(value, ['post_id', 'permalink', 'created_at', 'updated_at', 'title']);
}
function timingMode(value) {
  const modes = ['exact_schedule', 'flexible_schedule', 'condition_watch'];
  // Unlike automation save, this endpoint takes the native string enum.
  if (typeof value === 'number') value = modes[value];
  return oneOf(value, modes, 'timingMode');
}

export class RoutineManagement {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('RoutineManagement requires a DotClient.');
    this.transport = client.transport;
  }
  async query({ scope = 'personal', query = '', status = 'all', sort, limit = 25, cursor: pageCursor, signal } = {}) {
    oneOf(scope, ['personal', 'team', 'all'], 'scope');
    text(query, 'query', 256, true);
    oneOf(status, ['all', 'active', 'paused', 'finished'], 'status');
    if (sort != null) oneOf(sort, ['next_run_asc', 'updated_at_desc', 'title_asc', 'relevance'], 'sort');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer from 1 to 100.');
    if (pageCursor != null) text(pageCursor, 'cursor', 8192);
    const body = { scope, q: query, status, limit, ...(sort == null ? {} : { sort }), cursor: pageCursor ?? null };
    const data = object(await this.transport.request('POST', '/backend-api/automations/query', { body, signal }), 'routine query');
    if (!Array.isArray(data.items)) malformed('The routine query did not contain an items array.');
    return { items: data.items.map(routineSummary).filter(Boolean), cursor: cursor(data.cursor) };
  }
  async currentShare({ routineId, signal } = {}) {
    const data = object(await this.transport.request('GET', `/backend-api/share/automation/${id(routineId, 'routineId')}/current`, { signal }), 'current share');
    if (data.automation_id !== routineId || !own(data, 'current_share')) malformed('The current share response did not match the requested routine.');
    return { automation_id: routineId, current_share: data.current_share == null ? null : share(data.current_share, 'read') };
  }
  async createShare({ routineId, signal } = {}) {
    id(routineId, 'routineId');
    return share(await this.transport.request('POST', '/backend-api/share/automation', { body: { automation_id: routineId }, signal }), 'create');
  }
  async refreshShare({ routineId, signal } = {}) {
    return share(await this.transport.request('POST', `/backend-api/share/automation/${id(routineId, 'routineId')}/refresh`, { signal }), 'refresh');
  }
  async revokeShare({ routineId, signal } = {}) {
    await this.transport.request('DELETE', `/backend-api/share/automation/${id(routineId, 'routineId')}`, { signal });
    return { revoked: true, routineId };
  }
  async shared({ postId, signal } = {}) {
    const data = object(await this.transport.request('GET', `/backend-api/share/post/${id(postId, 'postId')}/automation`, { signal }), 'shared routine');
    const post = object(data.post, 'shared post');
    const automation = object(data.automation, 'shared automation');
    if (post.id !== postId) malformed('The shared routine response did not match the requested post.');
    const result = { post: scalarFields(post, ['id', 'title', 'permalink', 'is_owner', 'created_at', 'updated_at']),
      automation: scalarFields(automation, ['title', 'prompt', 'schedule', 'timing_mode', 'source_timezone', 'source_automation_id', 'conversation_origin', 'schedule_time_of_day']) };
    if (post.permissions && typeof post.permissions === 'object' && !Array.isArray(post.permissions)) result.post.permissions = scalarFields(post.permissions, ['can_read', 'can_write', 'can_share']);
    if (automation.model_selection && typeof automation.model_selection === 'object' && !Array.isArray(automation.model_selection)) result.automation.model_selection = scalarFields(automation.model_selection, ['model_slug', 'thinking_effort']);
    if (automation.schedule_components && typeof automation.schedule_components === 'object' && !Array.isArray(automation.schedule_components)) result.automation.schedule_components = scalarFields(automation.schedule_components, ['frequency', 'start_time', 'by_day', 'by_hour', 'by_minute', 'by_second', 'by_month', 'by_month_day', 'by_year_day']);
    return result;
  }
  async creationPrompt({ postId, title, prompt, schedule, timingMode: mode, signal } = {}) {
    id(postId, 'postId');
    const body = { title: text(title, 'title', 500).trim(), prompt: text(prompt, 'prompt').trim(),
      schedule: text(schedule, 'schedule', 16384, true), timing_mode: timingMode(mode), post_id: postId };
    const data = object(await this.transport.request('POST', '/backend-api/automations/generate_creation_prompt', { body, signal }), 'creation prompt');
    if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 256000) malformed('The creation prompt response did not contain a prompt.');
    return { prompt: data.prompt, postId, created: false };
  }
}
