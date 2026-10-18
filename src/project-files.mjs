import { AccountProjects, validateProjectId, projectSummary, requireProjectPermission, requireProjectCrud, projectMutationUnverified } from './account-projects.mjs';
import { DotError } from './errors.mjs';
import { lookup as lookupMimeType } from 'mime-types';

// Native project sources: app-initial g6r (attach), x5r (remove), and
// add-sources-dialog-4596e9a20547 Pn (existing Library-file constructor).
// This module changes project membership. It never deletes Library records or
// uploads a local file through the ordinary account-Library upload workflow.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const GENERAL_FILE = /^file[-_][A-Za-z0-9_-]+$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
function id(value, label = 'fileId') {
  if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) fail('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function selectedIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || new Set(value).size !== value.length) fail('INVALID_ARGUMENT', 'libraryFileIds must contain 1 to 100 unique Library file IDs.');
  for (const valueId of value) { id(valueId, 'Library file ID'); if (valueId.startsWith('external-')) fail('UNSUPPORTED', 'External-provider files require explicit materialization before they can be attached as native Library files.'); }
  return value;
}
function hidden(value, depth = 0) {
  if (!record(value) || depth > 8) return true;
  return ['hidden', 'is_hidden', 'is_visually_hidden_from_conversation', 'deleted', 'is_deleted', 'removed', 'is_removed', 'internal', 'is_internal', 'redacted', 'is_redacted'].some(key => value[key] === true)
    || ['visible', 'is_visible', 'user_visible', 'is_user_visible'].some(key => value[key] === false)
    || value.deleted_at != null || value.trashed_at != null || value.removed_at != null
    || typeof value.visibility === 'string' && ['hidden', 'internal', 'deleted', 'redacted'].includes(value.visibility.toLowerCase())
    || value.channel != null && !['final', 'commentary'].includes(value.channel)
    || value.recipient != null && value.recipient !== 'all'
    || record(value.metadata) && hidden(value.metadata, depth + 1);
}
function memberId(value) { const result = value?.file_id || value?.id; if (typeof result !== 'string' || !ID.test(result)) invalid('The project returned an invalid file identity.'); return result; }
function fileMembers(resource) {
  if (!Array.isArray(resource.files) || resource.files.length > 10000) invalid('The project returned invalid file membership.');
  const result = new Map();
  for (const file of resource.files) { const value = memberId(file); if (result.has(value)) invalid('The project repeated a file identity.'); result.set(value, file); }
  return result;
}
function savedMessageSource(value) {
  const save = value?.metadata?.project_save;
  return record(save) && ['creator_id', 'conversation_id', 'message_id', 'conversation_title', 'save_id', 'title'].every(key => save[key] == null || typeof save[key] === 'string');
}
function capacity(resource) {
  if (resource.project_file_limits != null && !record(resource.project_file_limits)) invalid('The project returned invalid file limits.');
  const value = resource.project_file_limits?.max_file_limit;
  if (value != null && (!Number.isSafeInteger(value) || value < 0 || value > 10000)) invalid('The project returned an invalid file limit.');
  const counted = new Set(resource.files.filter(file => !savedMessageSource(file)).map(memberId)).size;
  return { limit: value ?? null, counted, available: value == null ? null : Math.max(0, value - counted) };
}
function libraryAttachEligibility(resource, context) {
  const summary = requireProjectPermission(resource, context, 'can_write');
  if (!summary.private || resource.gizmo.memory_scope === 'project_v2') fail('PROJECT_LIBRARY_UNAVAILABLE', 'Existing Library files require an editable private project with default memory.');
  return summary;
}
function safeName(value) { if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) invalid('The Library file did not provide a valid filename.'); return value; }
function libraryFile(value, expectedId) {
  if (!record(value) || value.id !== expectedId) invalid('The Library file response did not match the requested Library identity.');
  if (hidden(value) || value.kind === 'directory' || ['page', 'site', 'site_preview', 'saved_entity', 'chat_message_snapshot'].includes(value.library_artifact_type)) fail('PROJECT_FILE_UNAVAILABLE', 'Only visible regular native Library files can be attached as project files.');
  if (value.state !== 'ready') fail('PROJECT_FILE_NOT_READY', 'The selected Library file is not ready. No attachment was sent.');
  if (typeof value.file_id !== 'string' || !GENERAL_FILE.test(value.file_id)) invalid('The Library file did not identify its general Files object.');
  const name = safeName(value.file_name ?? value.name);
  if (value.mime_type != null && (typeof value.mime_type !== 'string' || value.mime_type.length > 200 || !MIME.test(value.mime_type))) invalid('The Library file returned an invalid MIME type.');
  return { file_id: value.file_id, library_file_id: expectedId, location: 'fs', name, type: value.mime_type ?? (lookupMimeType(name) || null) };
}
function missingExpected(previous, next, removed = new Set()) { return [...previous.keys()].filter(value => !removed.has(value) && !next.has(value)); }
function verifyAttachment(resource, context, selectedProjectId, expected, previous) {
  projectSummary(resource, selectedProjectId, context, { detail: true });
  const actual = fileMembers(resource);
  if (expected.some(file => !actual.has(file.file_id)) || missingExpected(previous, actual).length) invalid('The project did not confirm the requested file membership without removing another source.');
  for (const expectedFile of expected) {
    const actualFile = actual.get(expectedFile.file_id);
    if (actualFile.library_file_id != null && actualFile.library_file_id !== expectedFile.library_file_id) invalid('The project returned a different Library mapping for an attached file.');
  }
  return actual;
}

export function projectFileCapabilities() {
  return { scope: 'Native g-p- project file membership.', supported: ['list', 'attach-library', 'remove'],
    limits: { libraryFilesPerRequest: 100 },
    limitations: ['Uses existing, ready native Library files with verified file metadata.', 'Library attachment requires a writable private project with default memory and country availability.', 'The server-provided project file limit is enforced before the request; existing files are not attached again.', 'Removing a source sends only the project-membership DELETE; it does not send a Library or general Files deletion.', 'New local-file uploads, provider materialization and connector sources require separate native workflows and are not implemented here.', 'Mutations are never retried; a single readback may reconcile an uncertain result.'], liveVerified: false };
}

export class ProjectFiles extends AccountProjects {
  capabilities() { return projectFileCapabilities(); }
  async list({ projectId, accountId, signal } = {}) {
    validateProjectId(projectId); const context = await this._context(accountId, signal);
    const resource = await this._get(context, projectId);
    fileMembers(resource);
    const summary = projectSummary(resource, projectId, context, { detail: true });
    return { accountId, projectId, items: summary.files, capacity: capacity(resource) };
  }
  async _libraryFile(context, libraryFileId) {
    let value;
    try { value = await context.request('GET', `/files/library/files/${encodeURIComponent(libraryFileId)}`, { maxBytes: 256 * 1024 }); }
    catch (error) {
      if (error?.code !== 'HTTP_ERROR' || error?.details?.status !== 404) throw error;
      value = await context.request('GET', `/files/library/files/${encodeURIComponent(libraryFileId)}/node`, { maxBytes: 256 * 1024 });
    }
    return libraryFile(value, libraryFileId);
  }
  async attachLibrary({ projectId, accountId, libraryFileIds, signal } = {}) {
    validateProjectId(projectId); selectedIds(libraryFileIds);
    const context = await this._context(accountId, signal);
    await requireProjectCrud(context);
    libraryAttachEligibility(await this._get(context, projectId), context);
    const settings = await context.request('GET', '/settings/user', { maxBytes: 1024 * 1024 });
    if (!record(settings) || settings.flags != null && !record(settings.flags)) invalid('The account Library availability response was invalid.');
    if (settings.flags?.file_library_enabled_for_registration_country === false) fail('PROJECT_LIBRARY_UNAVAILABLE', 'Library attachments are unavailable for this account registration country.');
    const hydrated = [];
    for (const libraryFileId of libraryFileIds) hydrated.push(await this._libraryFile(context, libraryFileId));
    // Hydrating several sources can take time. Refresh the project immediately
    // before deciding capacity and dispatching the single membership mutation.
    const before = await this._get(context, projectId); libraryAttachEligibility(before, context);
    const previous = fileMembers(before), byFile = new Map();
    for (const file of hydrated) if (!byFile.has(file.file_id)) byFile.set(file.file_id, file);
    const requested = [...byFile.values()], additions = requested.filter(file => !previous.has(file.file_id));
    const available = capacity(before);
    if (available.available !== null && additions.length > available.available) fail('PROJECT_FILE_LIMIT', 'The selected files exceed the available project file slots. No attachment was sent.', { requested: additions.length, available: available.available, limit: available.limit });
    const output = (resource, members, { changed, requestAcknowledged, reconciled = false }) => ({ accountId, projectId, changed, requestAcknowledged, reconciled, membershipVerified: true,
      files: requested.map(file => ({ fileId: file.file_id, requestedLibraryFileId: file.library_file_id, alreadyPresent: previous.has(file.file_id), libraryMappingVerified: members.get(file.file_id)?.library_file_id === file.library_file_id })),
      capacity: capacity(resource), storageDeletionRequested: false });
    if (!additions.length) return output(before, previous, { changed: false, requestAcknowledged: false });
    let requestAcknowledged = false, error;
    try {
      const result = await context.request('POST', `/projects/${encodeURIComponent(projectId)}/files`, { body: { files: additions } });
      if (!record(result) || result.error != null || !record(result.resource)) invalid('The attachment did not return a project resource.');
      projectSummary(result.resource, projectId, context, { detail: true });
      verifyAttachment(result.resource, context, projectId, additions, previous); requestAcknowledged = true;
    } catch (caught) { error = caught; }
    try {
      const after = await this._get(context, projectId), members = verifyAttachment(after, context, projectId, additions, previous);
      return output(after, members, { changed: true, requestAcknowledged, reconciled: !requestAcknowledged });
    } catch (caught) {
      const failure = projectMutationUnverified(error ?? caught, projectId, 'attach-library-files');
      failure.details = { ...failure.details, projectId, operation: 'attach-library-files', delivery: requestAcknowledged ? 'accepted' : 'unknown', fileIds: additions.map(file => file.file_id) };
      throw failure;
    }
  }
  async remove({ projectId, accountId, fileId, confirm, signal } = {}) {
    validateProjectId(projectId); id(fileId);
    if (confirm !== fileId) fail('CONFIRMATION_REQUIRED', 'Confirm the exact project file ID to remove its project membership.');
    const context = await this._context(accountId, signal);
    await requireProjectCrud(context);
    const before = await this._get(context, projectId);
    requireProjectPermission(before, context, 'can_write');
    const previous = fileMembers(before);
    if (!previous.has(fileId)) fail('PROJECT_FILE_NOT_FOUND', 'The exact file ID is not a current member of this project. No deletion was sent.');
    if (savedMessageSource(previous.get(fileId))) fail('PROJECT_SAVED_RESPONSE', 'This source is a saved response. Remove it through the project saved-response command so its save record and backing file stay consistent.');
    const removed = new Set([fileId]);
    const verify = resource => {
      projectSummary(resource, projectId, context, { detail: true });
      const next = fileMembers(resource);
      if (next.has(fileId) || missingExpected(previous, next, removed).length) invalid('The project did not confirm removal of only the requested source.');
      return next;
    };
    let requestAcknowledged = false, error;
    try {
      const result = await context.request('DELETE', `/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`);
      if (!record(result) || result.error != null || !record(result.resource)) invalid('The source removal did not return a project resource.');
      verify(result.resource); requestAcknowledged = true;
    } catch (caught) { error = caught; }
    try {
      const after = await this._get(context, projectId); verify(after);
      return { accountId, projectId, fileId, removedFromProject: true, membershipVerified: true, requestAcknowledged, reconciled: !requestAcknowledged, storageDeletionRequested: false };
    } catch (caught) {
      const failure = projectMutationUnverified(error ?? caught, projectId, 'remove-project-file');
      failure.details = { ...failure.details, projectId, operation: 'remove-project-file', delivery: requestAcknowledged ? 'accepted' : 'unknown', fileId };
      throw failure;
    }
  }
}
