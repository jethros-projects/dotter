import { AccountProjects, validateProjectId, projectSummary, requireProjectPermission, requireProjectCrud, projectMutationUnverified } from './account-projects.mjs';
import { DotError } from './errors.mjs';

// Native contracts: data-279f6a57e9d3.js A, source-queries-8e9f48a1fbe4.js,
// source-dialogs-c0b9d733542d.js w and conversation-turn-content AA/jA/BA/RA.
// A saved response is a project source. There is no native GET-one route;
// lookups and write verification use the fully paginated source collection.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const SAVE_LIMIT = 100;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
function identifier(value, label, response = false) {
  if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))(`${label} must be a native identifier.`);
  return value;
}
function count(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail('INVALID_ARGUMENT', `${label} must be an integer from 1 to ${maximum}.`);
  return value;
}
function cursor(value, response = false) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))('The project saved-response cursor is invalid.');
  return value;
}
function title(value, response = false) {
  // A newly saved source may have an empty title until native auto-titling
  // finishes. Rename is the only operation requiring a nonempty title.
  if (typeof value !== 'string') (response ? invalid : message => fail('INVALID_ARGUMENT', message))('The saved-response title is invalid. Rename requires 1 to 200 characters.');
  const selected = response ? value : value.trim();
  if (selected.length > (response ? 8192 : 200) || /[\x00-\x1f\x7f-\x9f]/.test(selected) || !response && !selected) (response ? invalid : message => fail('INVALID_ARGUMENT', message))('The saved-response title is invalid. Rename requires 1 to 200 characters.');
  return selected;
}
function hidden(value, depth = 0) {
  if (!record(value) || depth > 8) return true;
  return ['hidden', 'is_hidden', 'is_visually_hidden_from_conversation', 'deleted', 'is_deleted', 'removed', 'is_removed', 'private', 'is_private', 'internal', 'is_internal', 'redacted', 'is_redacted'].some(key => value[key] === true)
    || ['visible', 'is_visible', 'user_visible', 'is_user_visible'].some(key => value[key] === false)
    || value.deleted_at != null || value.deletedAt != null || value.removed_at != null
    || typeof value.visibility === 'string' && ['hidden', 'internal', 'deleted', 'redacted'].includes(value.visibility.toLowerCase())
    || value.channel != null && !['final', 'commentary'].includes(value.channel) || value.recipient != null && value.recipient !== 'all'
    || record(value.metadata) && hidden(value.metadata, depth + 1);
}
function save(value) {
  if (!record(value) || hidden(value)) invalid('The saved-response collection contained an invalid or hidden source.');
  const result = { id: identifier(value.id, 'saveId', true), title: title(value.title, true),
    conversationId: identifier(value.conversation_id, 'conversationId', true), messageId: identifier(value.message_id, 'messageId', true) };
  // Owner identity is not an authorization gate. Only include the optional
  // identifier used by the native list; never copy arbitrary source payloads.
  if (value.owner_id != null) result.ownerId = identifier(value.owner_id, 'ownerId', true);
  for (const [field, output] of [['created_at', 'createdAt'], ['create_time', 'createTime'], ['update_time', 'updateTime']]) {
    if (value[field] != null) {
      if (!(typeof value[field] === 'string' && value[field].length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(value[field]) || typeof value[field] === 'number' && Number.isFinite(value[field]))) invalid('The saved response returned an invalid timestamp.');
      result[output] = value[field];
    }
  }
  return result;
}
function sameSource(left, right) { return left.id === right.id && left.conversationId === right.conversationId && left.messageId === right.messageId; }
function removedAcknowledgement(value) {
  if (typeof value === 'string') {
    if (value.trim() === '') return;
    try { value = JSON.parse(value); } catch { invalid('The saved-response removal did not return a valid acknowledgement.'); }
  }
  if (!record(value) || value.error != null || value.success === false || value.completed === false) invalid('The server did not acknowledge saved-response removal.');
}
function sourceMatches(item, conversationId, messageId) { return item.conversationId === conversationId && item.messageId === messageId; }
function exactSource(items, saveId) {
  const found = items.find(item => item.id === saveId);
  if (!found) fail('PROJECT_SAVE_NOT_FOUND', 'The saved response is not present in the selected project.');
  return found;
}
function uniqueResponse(items, conversationId, messageId) {
  const found = items.filter(item => sourceMatches(item, conversationId, messageId));
  if (found.length > 1) invalid('The project returned multiple sources for the selected response.');
  return found[0];
}
function preserved(before, after, removedId) {
  const next = new Map(after.map(item => [item.id, item]));
  for (const item of before) {
    if (item.id === removedId) continue;
    if (!next.has(item.id) || !sameSource(item, next.get(item.id))) invalid('The saved-response change did not preserve another project source.');
  }
}
function writable(resource, context) {
  requireProjectPermission(resource, context, 'can_write');
  if (['potion', 'locked_chats'].includes(resource.gizmo.gizmo_snorlax_type)) fail('PROJECT_SCOPE_UNSUPPORTED', 'This project subtype does not support native saved responses.');
}
function sourceMessage(value, projectId, conversationId, messageId) {
  if (!record(value) || hidden(value) || (value.id ?? value.conversation_id) !== conversationId || value.gizmo_id !== projectId || !record(value.mapping) || Object.keys(value.mapping).length > 100000) invalid('The conversation did not identify the selected visible project conversation.');
  if (value.id != null && value.id !== conversationId || value.conversation_id != null && value.conversation_id !== conversationId) invalid('The conversation returned conflicting source identities.');
  let current = value.current_node;
  const seen = new Set(), messageIds = new Set(); let selected;
  if (typeof current !== 'string' || !Object.hasOwn(value.mapping, current)) invalid('The conversation did not identify its selected branch.');
  while (current != null) {
    if (typeof current !== 'string' || seen.has(current) || seen.size >= 100000 || !record(value.mapping[current])) invalid('The selected conversation branch is invalid or cyclic.');
    seen.add(current); const node = value.mapping[current];
    if (node.id !== undefined && node.id !== current) invalid('The conversation node identity did not match its mapping.');
    if (node.message != null) {
      if (!record(node.message)) invalid('The selected conversation contained an invalid message.');
      const candidate = node.message;
      identifier(candidate.id, 'messageId', true);
      if (messageIds.has(candidate.id)) invalid('The selected conversation branch repeated a message identity.');
      messageIds.add(candidate.id);
      if (candidate.id === messageId) {
        if (hidden(node) || hidden(candidate) || !record(candidate.author) || hidden(candidate.author)
          || candidate.author.role !== 'assistant' || candidate.channel != null && candidate.channel !== 'final'
          || candidate.recipient != null && candidate.recipient !== 'all' || candidate.metadata?.is_message_fragment === true
          || candidate.status === 'in_progress'
          || candidate.metadata?.can_save !== true) fail('PROJECT_RESPONSE_NOT_SAVEABLE', 'Select a visible canonical assistant response that the service permits saving.');
        const content = candidate.content;
        if (!record(content)) invalid('The selected assistant response did not contain valid content.');
        const text = typeof content.text === 'string' ? content.text : Array.isArray(content.parts) ? content.parts.filter(part => typeof part === 'string').join('') : '';
        if (content.content_type === 'text' && /^::\s*SKIP_COMPLETION\s*::$/.test(text.trim())) fail('PROJECT_RESPONSE_NOT_SAVEABLE', 'Hidden completion markers cannot be saved as a project response.');
        selected = candidate;
      }
    }
    current = node.parent;
  }
  if (!selected) fail('PROJECT_RESPONSE_NOT_SAVEABLE', 'The response is not on the selected visible conversation branch.');
  return selected;
}

export function projectSaveCapabilities() {
  return { scope: 'Native saved assistant responses attached to a g-p- account project.', supported: ['list', 'get', 'create', 'rename', 'remove'],
    limits: { savedResponsesPerProject: SAVE_LIMIT, pageSize: PAGE_SIZE },
    limitations: ['Create requires an existing selected, visible assistant response with native can_save permission in the same project.',
      'Get reads saved-source metadata through the collection; no unsupported GET-one or content endpoint is used.',
      'An existing saved response is returned unchanged when create is requested again.',
      'Writable collaborators can rename or remove saved responses; removal affects everyone in a shared project.',
      'Known in-progress source messages are rejected; other wire status values do not replace native can_save eligibility.',
      'New titles may initially be empty while the native service generates them. No background title polling is started.',
      'Mutations are sent once and require an exact paginated readback; uncertain writes are never replayed.'], liveVerified: false };
}

export class ProjectSaves extends AccountProjects {
  capabilities() { return projectSaveCapabilities(); }
  async _saves(context, projectId, { limit = PAGE_SIZE, pages = MAX_PAGES, initial = null } = {}) {
    let next = initial, pagesRead = 0;
    const items = [], seen = new Set(), byId = new Map();
    for (; pagesRead < pages;) {
      if (next !== null) { if (seen.has(next)) invalid('The saved-response cursor did not advance.'); seen.add(next); }
      const value = await context.request('GET', `/projects/${encodeURIComponent(projectId)}/saves`, { query: { cursor: next, limit } });
      if (!record(value) || !Array.isArray(value.items) || value.items.length > limit) invalid('The project returned an invalid saved-response page.');
      for (const raw of value.items) {
        const item = save(raw), previous = byId.get(item.id);
        if (previous && (!sameSource(previous, item) || previous.title !== item.title)) invalid('The project returned conflicting records for one saved response.');
        if (!previous) { byId.set(item.id, item); items.push(item); }
      }
      next = cursor(value.cursor, true); pagesRead++;
      if (next === null) break;
    }
    if (next !== null && seen.has(next)) invalid('The saved-response cursor did not advance.');
    return { items, cursor: next, pagesRead };
  }
  async _allSaves(context, projectId) {
    const result = await this._saves(context, projectId);
    if (result.cursor !== null) fail('PROJECT_SAVES_INCOMPLETE', 'The saved-response collection exceeded the bounded full-read limit.');
    return result.items;
  }
  async _writeContext(accountId, projectId, signal) {
    const context = await this._context(accountId, signal);
    await requireProjectCrud(context);
    writable(await this._get(context, projectId), context);
    return context;
  }
  async list({ projectId, accountId, limit = PAGE_SIZE, pages = 1, cursor: initial, signal } = {}) {
    validateProjectId(projectId);
    if (limit !== PAGE_SIZE) fail('INVALID_ARGUMENT', 'The verified native saved-response page size is 100.');
    count(pages, 'pages', MAX_PAGES); const next = cursor(initial);
    const context = await this._context(accountId, signal); await this._get(context, projectId);
    return { accountId, projectId, ...await this._saves(context, projectId, { limit, pages, initial: next }) };
  }
  async get({ projectId, accountId, saveId, signal } = {}) {
    validateProjectId(projectId); identifier(saveId, 'saveId');
    const context = await this._context(accountId, signal); await this._get(context, projectId);
    return { accountId, projectId, save: exactSource(await this._allSaves(context, projectId), saveId) };
  }
  async create({ projectId, accountId, conversationId, messageId, signal } = {}) {
    validateProjectId(projectId); identifier(conversationId, 'conversationId'); identifier(messageId, 'messageId');
    const context = await this._writeContext(accountId, projectId, signal);
    const before = await this._allSaves(context, projectId), existing = uniqueResponse(before, conversationId, messageId);
    if (existing) return { accountId, projectId, save: existing, changed: false, confirmed: true, requestAcknowledged: false, reconciled: false };
    if (before.length >= SAVE_LIMIT) fail('PROJECT_SAVE_LIMIT', 'The project already has 100 saved responses. Remove one before saving another response.');
    const conversation = await context.request('GET', `/conversation/${encodeURIComponent(conversationId)}`, { maxBytes: 16 * 1024 * 1024 });
    sourceMessage(conversation, projectId, conversationId, messageId);
    // Source hydration may take time; recheck write permission immediately
    // before dispatching the sole mutation.
    writable(await this._get(context, projectId), context);
    let acknowledged, error;
    try {
      acknowledged = save(await context.request('POST', `/projects/${encodeURIComponent(projectId)}/saves`, { body: { conversation_id: conversationId, message_id: messageId } }));
      if (!sourceMatches(acknowledged, conversationId, messageId)) invalid('The saved-response creation returned a different source.');
    } catch (caught) { error = caught; acknowledged = undefined; }
    try {
      const after = await this._allSaves(context, projectId), result = uniqueResponse(after, conversationId, messageId);
      preserved(before, after);
      if (!result || acknowledged && !sameSource(acknowledged, result)) invalid('The new saved response could not be identified in the selected project.');
      return { accountId, projectId, save: result, changed: true, confirmed: true, requestAcknowledged: Boolean(acknowledged), reconciled: !acknowledged };
    } catch (caught) { throw this._unverified(error ?? caught, projectId, 'save-response', { conversationId, messageId }, Boolean(acknowledged)); }
  }
  async rename({ projectId, accountId, saveId, title: nextTitle, signal } = {}) {
    validateProjectId(projectId); identifier(saveId, 'saveId'); nextTitle = title(nextTitle);
    const context = await this._writeContext(accountId, projectId, signal), before = await this._allSaves(context, projectId), selected = exactSource(before, saveId);
    if (selected.title.trim() === nextTitle) return { accountId, projectId, save: selected, changed: false, confirmed: true, requestAcknowledged: false, reconciled: false };
    let acknowledged = false, error;
    try {
      const result = save(await context.request('PATCH', `/projects/${encodeURIComponent(projectId)}/saves/${encodeURIComponent(saveId)}`, { body: { title: nextTitle } }));
      if (!sameSource(selected, result) || result.title !== nextTitle) invalid('The saved-response rename returned a different source or title.');
      acknowledged = true;
    } catch (caught) { error = caught; }
    try {
      const after = await this._allSaves(context, projectId), result = exactSource(after, saveId); preserved(before, after);
      if (!sameSource(selected, result) || result.title !== nextTitle) invalid('The saved response did not persist its requested title.');
      return { accountId, projectId, save: result, changed: true, confirmed: true, requestAcknowledged: acknowledged, reconciled: !acknowledged };
    } catch (caught) { throw this._unverified(error ?? caught, projectId, 'rename-saved-response', { saveId }, acknowledged); }
  }
  async remove({ projectId, accountId, saveId, confirm, signal } = {}) {
    validateProjectId(projectId); identifier(saveId, 'saveId');
    if (confirm !== saveId) fail('CONFIRMATION_REQUIRED', 'Confirm the exact saved-response ID. Removal affects everyone with access to this project.');
    const context = await this._writeContext(accountId, projectId, signal), before = await this._allSaves(context, projectId); exactSource(before, saveId);
    let acknowledged = false, error;
    try { removedAcknowledgement(await context.request('DELETE', `/projects/${encodeURIComponent(projectId)}/saves/${encodeURIComponent(saveId)}`, { responseType: 'text' })); acknowledged = true; }
    catch (caught) { error = caught; }
    try {
      const after = await this._allSaves(context, projectId); preserved(before, after, saveId);
      if (after.some(item => item.id === saveId)) invalid('The removed saved response is still present in this project.');
      return { accountId, projectId, saveId, removedFromProject: true, confirmed: true, requestAcknowledged: acknowledged, reconciled: !acknowledged };
    } catch (caught) { throw this._unverified(error ?? caught, projectId, 'remove-saved-response', { saveId }, acknowledged); }
  }
  _unverified(error, projectId, operation, identity, acknowledged) {
    const failure = projectMutationUnverified(error, projectId, operation);
    failure.details = { ...failure.details, ...identity, delivery: acknowledged ? 'accepted' : 'unknown' };
    return failure;
  }
}
