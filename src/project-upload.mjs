import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { AccountProjects, validateProjectId, projectSummary, requireProjectPermission, requireProjectCrud } from './account-projects.mjs';
import { readLibraryUploadSource, prepareVerifiedUploadRange } from './library-upload-source.mjs';
import { parseNativeUploadTarget, validateNativeUploadHeaders, normalizeNativeUploadStrategy, validateNativeMultipartStrategy, nativeUploadBlockId, nativeUploadTargetHash } from './library-upload.mjs';
import { validateStorageUploadHeaders } from './transport.mjs';
import { writePrivate } from './store.mjs';
import { withOperationLock } from './operation-lock.mjs';

// Native project source upload: _6r/y6r, D6r/O6r and g6r in the desktop
// app-initial bundle. It reserves directly for the project, never in Library.
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_STATE = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const FILE_ID = /^file[-_][A-Za-z0-9_-]+$/;
const HASH = /^[a-f0-9]{64}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/u;
const PHASES = new Set(['prepared', 'reserving', 'reserved', 'uploading', 'uploading_parts', 'committing', 'uploaded', 'processing', 'processed', 'attaching', 'attached', 'complete']);
const UNKNOWN = new Set(['reserving', 'uploading', 'committing', 'processing', 'attaching']);
const RESUMABLE = new Set(['prepared', 'reserved', 'uploaded', 'processed', 'attached', 'complete']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
const hash = value => createHash('sha256').update(value).digest('hex');
// T4r is the native filename-to-indexing MIME map. It deliberately differs
// from generic MIME lookup; the reserve/transfer MIME stays source.mimeType.
const INDEX_MIME = Object.freeze({ md: 'text/markdown', java: 'text/x-java', py: 'text/x-script.python', c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c++', php: 'text/x-php', rb: 'text/x-ruby', tex: 'application/x-latext', ts: 'text/x-typescript', cs: 'text/x-csharp', go: 'text/x-go', rs: 'text/x-rust', scala: 'application/x-scala', kt: 'text/x-kotlin', swift: 'text/x-swift', lua: 'text/x-lua', r: 'text/x-r', jl: 'text/x-julia', pl: 'text/x-perl', sh: 'text/x-shellscript', m: 'text/x-objectivec', mm: 'text/x-objectivec++', erl: 'text/x-erlang', ex: 'text/x-elixir', exs: 'text/x-elixir', hs: 'text/x-haskell', clj: 'text/x-clojure', groovy: 'text/x-groovy', dart: 'text/x-dart', bash: 'text/x-shellscript', jsx: 'text/jsx', tsx: 'text/tsx', hbs: 'text/x-handlebars', handlebars: 'text/x-handlebars', mustache: 'text/x-mustache', ejs: 'text/x-ejs', j2: 'text/x-jinja2', jinja: 'text/x-jinja2', jinja2: 'text/x-jinja2', liquid: 'text/x-liquid', erb: 'text/x-erb', twig: 'text/x-twig', pug: 'text/x-pug', jade: 'text/x-jade', tmpl: 'text/x-tmpl', json: 'application/json', yml: 'application/x-yaml', yaml: 'application/x-yaml', toml: 'application/toml', ini: 'text/plain', properties: 'text/plain', env: 'text/plain', xml: 'text/xml', conf: 'text/plain', log: 'text/plain', txt: 'text/plain', flashcards: 'text/plain', astro: 'text/x-astro', avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg', mpo: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' });

function catalogString(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value); }
function catalogArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10000) invalid(`The model catalog returned invalid ${label}.`);
  return value;
}
function optionalCatalogString(value) { return value == null || catalogString(value); }
// Syt/Pyt/Fyt/Nyt in app-shared compute the native default from presets,
// reversed visible categories, then model order. Only fields used here leave
// the raw response, and an absent model is a valid non-retrieval policy.
function nativeDefaultModel(data, models) {
  if (!optionalCatalogString(data.default_model_slug)) invalid('The model catalog returned an invalid default model.');
  const categories = catalogArray(data.categories, 'categories').filter(value => value != null).map(value => {
    if (!record(value) || value.disabled_by_admin != null && typeof value.disabled_by_admin !== 'boolean' || !optionalCatalogString(value.default_model)
      || value.model_lane != null && !['auto', 'instant', 'thinking', 'thinking_mini', 'pro'].includes(value.model_lane)) invalid('The model catalog returned an invalid category.');
    const supported = catalogArray(value.supported_models, 'supported models');
    if (supported.some(slug => !optionalCatalogString(slug))) invalid('The model catalog returned an invalid supported model.');
    return { ...value, supported_models: supported };
  }).filter(value => value.disabled_by_admin !== true);
  const versions = catalogArray(data.versions, 'versions').filter(value => value != null).map(value => {
    if (!record(value) || !catalogString(value.id) || value.disabled != null && typeof value.disabled !== 'boolean') invalid('The model catalog returned an invalid version.');
    const slugs = catalogArray(value.slugs, 'version models');
    if (slugs.some(slug => !optionalCatalogString(slug))) invalid('The model catalog returned an invalid version model.');
    const presets = catalogArray(value.intelligence_presets, 'intelligence presets').filter(value => value != null);
    if (presets.some(preset => !record(preset) || !catalogString(preset.model_slug)
      || preset.lane != null && !['auto', 'instant', 'thinking', 'thinking_mini', 'pro'].includes(preset.lane))) invalid('The model catalog returned an invalid intelligence preset.');
    return { ...value, slugs, intelligence_presets: presets };
  }).filter(value => value.disabled !== true);
  if (data.default_model_slug != null) return data.default_model_slug.trim();
  for (const version of versions) {
    const presets = version.intelligence_presets.length ? version.intelligence_presets : version.id === 'o3' ? [{ lane: 'thinking', model_slug: 'o3' }] : [];
    if (!presets.length) continue;
    const preset = presets[0], automatic = preset.lane === 'instant' ? categories.find(category => category.model_lane === 'auto' && category.default_model != null && version.slugs.includes(category.default_model))?.default_model : undefined;
    return (automatic ?? preset.model_slug).trim();
  }
  for (const category of [...categories].reverse()) {
    const slug = category.default_model ?? category.supported_models.find(value => value != null);
    if (slug != null) return slug.trim();
  }
  return models.keys().next().value ?? 'auto';
}

function plain(value, label, limit = 8192) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/u.test(value)) fail('INVALID_ARGUMENT', `${label} must be bounded text without control characters.`);
  return value;
}
function fileIds(resource) {
  if (!Array.isArray(resource.files) || resource.files.length > 10000) invalid('The project returned invalid file membership.');
  const result = new Map();
  for (const value of resource.files) {
    const id = value?.file_id || value?.id;
    if (!record(value) || typeof id !== 'string' || !ID.test(id) || result.has(id)) invalid('The project returned an invalid or repeated file identity.');
    result.set(id, value);
  }
  return result;
}
function capacity(resource, members) {
  if (resource.project_file_limits != null && !record(resource.project_file_limits)) invalid('The project returned invalid file limits.');
  const limit = resource.project_file_limits?.max_file_limit;
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 0 || limit > 10000)) invalid('The project returned an invalid file limit.');
  // Saved chat responses are project sources but do not consume upload slots.
  const savedResponse = file => {
    const saved = file.metadata?.project_save;
    return record(saved) && ['creator_id', 'conversation_id', 'message_id', 'conversation_title', 'save_id', 'title'].every(key => saved[key] == null || typeof saved[key] === 'string');
  };
  const counted = [...members.values()].filter(file => !savedResponse(file)).length;
  if (limit != null && counted >= limit) fail('PROJECT_FILE_LIMIT', 'The project has no available upload slot. No new upload write was sent.');
  return { limit: limit ?? null, counted };
}
function memberExpectation(state) {
  return { file_id: state.reservation.fileId, last_modified: Math.trunc(state.source.mtimeMs),
    ...(state.processing.libraryFileId ? { library_file_id: state.processing.libraryFileId } : {}),
    location: 'fs', name: state.processing.libraryFileName ?? state.source.name,
    size: state.source.sizeBytes, type: state.processing.mimeType ?? state.source.mimeType };
}
function validateExpectedMember(resource, context, state) {
  projectSummary(resource, state.context.projectId, context, { detail: true });
  const members = fileIds(resource), expected = memberExpectation(state), member = members.get(expected.file_id);
  if (!member) return false;
  if (state.context.priorFileIds.some(id => !members.has(id))) invalid('The upload readback is missing a previously present project source.');
  // Native g6r confirms membership by file_id. Full-file metadata is optional:
  // validate every available field without turning absent metadata into a
  // false failure or claiming that remote bytes were independently hashed.
  const verifiedFields = ['file_id'];
  if (member.file_response_type === 'full_file_response' && member.file_id === expected.file_id) {
    for (const key of ['name', 'size', 'type', 'last_modified', 'library_file_id']) {
      if (member[key] == null || expected[key] == null) continue;
      if (member[key] !== expected[key]) invalid('The project file metadata does not match this upload.');
      verifiedFields.push(key);
    }
  }
  return { verifiedFields, metadataAvailable: member.file_response_type === 'full_file_response', remoteContentHashVerified: false };
}
function processingReceipt(text, fileId) {
  const receipt = { completed: false, eventCount: 0, eventNames: [] };
  let ready = false;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) return { ...receipt, error: 'INVALID_RESPONSE' };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (++receipt.eventCount > 10000) { receipt.error = 'INVALID_RESPONSE'; break; }
    let event;
    try { event = JSON.parse(line.replace(/\r$/u, '')); } catch { receipt.error = 'INVALID_RESPONSE'; break; }
    if (!record(event) || typeof event.event !== 'string' || event.file_id != null && event.file_id !== fileId
      || event.extra != null && !record(event.extra)) { receipt.error = 'INVALID_RESPONSE'; break; }
    if (/^[a-z][a-z0-9_.:-]{0,127}$/iu.test(event.event) && receipt.eventNames.length < 256 && !receipt.eventNames.includes(event.event)) receipt.eventNames.push(event.event);
    if (event.event === 'file.processing.file_ready' && event.file_id === fileId) ready = true;
    const fallback = event.event === 'file.indexing.error' && event.file_id === fileId && ready && event.extra?.raw_file_fallback_available === true;
    if (/(?:^|\.)(?:error|cancelled|failed|unknown)$/u.test(event.event) && !fallback) {
      receipt.error = 'UPLOAD_PROCESSING_ERROR';
      if (/^[a-z][a-z0-9_.:-]{0,127}$/iu.test(event.event)) receipt.failureEvent = event.event;
      if (typeof event.extra?.error_code === 'string' && /^[a-z0-9_.:-]{1,128}$/iu.test(event.extra.error_code)) receipt.failureCode = event.extra.error_code;
      break;
    }
    const extra = event.extra;
    if (extra?.metadata_object_id != null) {
      if (typeof extra.metadata_object_id !== 'string' || !ID.test(extra.metadata_object_id) || receipt.libraryFileId && receipt.libraryFileId !== extra.metadata_object_id) { receipt.error = 'INVALID_RESPONSE'; break; }
      receipt.libraryFileId = extra.metadata_object_id;
    }
    if (extra?.library_file_name != null) {
      if (typeof extra.library_file_name !== 'string' || !extra.library_file_name || extra.library_file_name.length > 4096 || /[\x00-\x1f\x7f]/u.test(extra.library_file_name)) { receipt.error = 'INVALID_RESPONSE'; break; }
      receipt.libraryFileName = extra.library_file_name;
    }
    if (extra?.mime_type != null) {
      if (typeof extra.mime_type !== 'string' || extra.mime_type.length > 200 || !MIME.test(extra.mime_type)) { receipt.error = 'INVALID_RESPONSE'; break; }
      receipt.mimeType = extra.mime_type;
    }
    if (extra?.library_persistence_result === 'temporary') receipt.libraryPersistenceResult = 'temporary';
    if (event.event === 'file.processing.completed') {
      if (event.file_id !== fileId) { receipt.error = 'INVALID_RESPONSE'; break; }
      receipt.completed = true;
    }
    if (fallback) {
      receipt.completed = true;
      receipt.retrievalIndexingUnavailable = true;
      if (receipt.libraryPersistenceResult === 'temporary') { delete receipt.libraryFileId; delete receipt.libraryFileName; }
    }
  }
  if (!receipt.error && !receipt.completed) receipt.error = 'UPLOAD_READBACK_PENDING';
  return receipt;
}
async function statePath(value) {
  plain(value, 'stateFile'); const requested = resolve(value), parent = await realpath(dirname(requested)).catch(() => null);
  if (!parent) fail('INVALID_ARGUMENT', 'The state directory must exist.');
  return join(parent, basename(requested));
}
function validateTransfer(state) {
  const transfer = state.transfer, plan = validateNativeMultipartStrategy(transfer?.strategy, state.source.sizeBytes);
  if (!plan || transfer.kind !== 'azure_multipart' || transfer.fileId !== state.reservation.fileId || transfer.sourceSha256 !== state.source.sha256
    || transfer.projectId !== state.context.projectId || !HASH.test(transfer.targetHash ?? '') || !Array.isArray(transfer.parts) || transfer.parts.length !== plan.part_count) fail('INVALID_UPLOAD_STATE', 'The saved multipart transfer is not bound to this project source.');
  if (state.reservation.uploadUrl && transfer.targetHash !== nativeUploadTargetHash(parseNativeUploadTarget(state.reservation.uploadUrl).url ?? '')) fail('INVALID_UPLOAD_STATE', 'The multipart upload target changed.');
  for (let index = 0; index < transfer.parts.length; index++) {
    const part = transfer.parts[index], offset = index * plan.part_size_bytes, length = Math.min(plan.part_size_bytes, state.source.sizeBytes - offset);
    if (!record(part) || part.index !== index || part.offset !== offset || part.length !== length || part.blockId !== nativeUploadBlockId(index)
      || !HASH.test(part.sha256 ?? '') || !['pending', 'inflight', 'uploaded'].includes(part.status)) fail('INVALID_UPLOAD_STATE', 'The saved multipart part map is invalid.');
  }
}
function validateState(state) {
  if (!record(state) || state.schemaVersion !== 1 || state.kind !== 'native-project-upload' || !PHASES.has(state.phase)
    || typeof state.operationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(state.operationId) || !record(state.identity) || typeof state.identity.accountId !== 'string' || !ID.test(state.identity.accountId) || typeof state.identity.subjectSha256 !== 'string' || !HASH.test(state.identity.subjectSha256)
    || !record(state.source) || !record(state.context) || !record(state.reservation) || !record(state.processing) || !record(state.attachment)) fail('INVALID_UPLOAD_STATE', 'Unsupported project upload state.');
  try { validateProjectId(state.context.projectId); } catch { fail('INVALID_UPLOAD_STATE', 'The saved project identity is invalid.'); }
  const source = state.source;
  if (typeof source.path !== 'string' || resolve(source.path) !== source.path || typeof source.name !== 'string' || !source.name || source.name.length > 240 || /[\x00-\x1f\x7f\\/]/u.test(source.name)
    || basename(source.path) !== source.name || typeof source.mimeType !== 'string' || source.mimeType.length > 200 || !MIME.test(source.mimeType)
    || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > MAX_BYTES || !HASH.test(source.sha256 ?? '')
    || typeof source.dev !== 'string' || !/^\d+$/.test(source.dev) || typeof source.ino !== 'string' || !/^\d+$/.test(source.ino)
    || !Number.isFinite(source.mtimeMs) || !Number.isFinite(source.ctimeMs) || !['declared_mime', 'filename_extension'].includes(source.mimeResolutionSource)
    || !Array.isArray(state.context.priorFileIds) || state.context.priorFileIds.length > 10000 || new Set(state.context.priorFileIds).size !== state.context.priorFileIds.length
    || state.context.priorFileIds.some(id => typeof id !== 'string' || !ID.test(id)) || typeof state.context.indexForRetrieval !== 'boolean') fail('INVALID_UPLOAD_STATE', 'The saved upload source or project context is invalid.');
  if (state.reservation.fileId != null && !FILE_ID.test(state.reservation.fileId) || !['prepared', 'reserving'].includes(state.phase) && !FILE_ID.test(state.reservation.fileId ?? '')
    || state.processing.libraryFileId != null && (typeof state.processing.libraryFileId !== 'string' || !ID.test(state.processing.libraryFileId))
    || state.processing.libraryFileName != null && (typeof state.processing.libraryFileName !== 'string' || !state.processing.libraryFileName || state.processing.libraryFileName.length > 4096 || /[\x00-\x1f\x7f]/u.test(state.processing.libraryFileName))
    || state.processing.mimeType != null && (typeof state.processing.mimeType !== 'string' || state.processing.mimeType.length > 200 || !MIME.test(state.processing.mimeType))
    || ['processed', 'attaching', 'attached', 'complete'].includes(state.phase) && (state.processing.completed !== true || state.processing.error != null)
    || state.phase === 'attached' && state.attachment.acknowledged !== true || state.phase === 'complete' && state.attachment.verified !== true) fail('INVALID_UPLOAD_STATE', 'The saved upload receipt or phase is invalid.');
  if (state.attachment.readback != null) {
    const readback = state.attachment.readback;
    if (!record(readback) || !Array.isArray(readback.verifiedFields) || readback.verifiedFields.length > 6
      || readback.verifiedFields.some(field => !['file_id', 'name', 'size', 'type', 'last_modified', 'library_file_id'].includes(field))
      || !readback.verifiedFields.includes('file_id') || new Set(readback.verifiedFields).size !== readback.verifiedFields.length
      || typeof readback.metadataAvailable !== 'boolean' || readback.remoteContentHashVerified !== false) fail('INVALID_UPLOAD_STATE', 'The saved project readback evidence is invalid.');
  }
  if (state.transfer) validateTransfer(state);
  else if (['uploading_parts', 'committing'].includes(state.phase)) fail('INVALID_UPLOAD_STATE', 'A multipart phase requires a verified part map.');
  return state;
}
async function readState(file, missing = false) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.mode & 0o077 || before.size > MAX_STATE || process.getuid && before.uid !== process.getuid()) fail('INVALID_UPLOAD_STATE', 'The project upload state must be an owner-only regular file of at most 16 MiB.');
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_STATE + 1)); let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INVALID_UPLOAD_STATE', 'The project upload state changed while being read.');
    return validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
  } catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    if (error instanceof DotError) throw error;
    fail('INVALID_UPLOAD_STATE', 'Cannot read the private project upload state.');
  } finally { await handle?.close(); }
}
function result(state, stateFile) {
  const completed = state.phase === 'complete';
  return { accountId: state.identity.accountId, projectId: state.context.projectId, fileId: state.reservation.fileId ?? null, libraryFileId: state.processing.libraryFileId ?? null,
    phase: state.phase, status: completed ? 'complete' : state.phase === 'uploading_parts' ? 'partial_upload' : UNKNOWN.has(state.phase) ? 'outcome_unknown' : state.phase === 'processed' ? 'awaiting_attachment' : state.phase === 'attached' ? 'awaiting_readback' : state.phase === 'reserved' && state.reservation.metadataValid !== true ? 'invalid_reservation' : 'ready_to_resume',
    completed, stateFile, canResume: RESUMABLE.has(state.phase) && (state.phase !== 'reserved' || state.reservation.metadataValid === true), canResumeParts: state.phase === 'uploading_parts', canReconcile: !!state.reservation.fileId,
    storageDeletionRequested: false, unattachedFileMayRemain: !!state.reservation.fileId && !completed,
    membershipVerified: state.attachment.verified === true,
    verifiedFields: state.attachment.readback?.verifiedFields ?? [],
    metadataAvailable: state.attachment.readback?.metadataAvailable ?? false, remoteContentHashVerified: false,
    name: state.processing.libraryFileName ?? state.source.name, mimeType: state.processing.mimeType ?? state.source.mimeType, sizeBytes: state.source.sizeBytes, sha256: state.source.sha256,
    indexForRetrieval: state.context.indexForRetrieval, ...(state.processing.libraryPersistenceResult ? { libraryPersistenceResult: state.processing.libraryPersistenceResult } : {}),
    ...(state.processing.retrievalIndexingUnavailable ? { retrievalIndexingUnavailable: true, indexed: false } : {}),
    ...(state.transfer ? { transfer: { kind: state.transfer.kind, parts: state.transfer.parts.length, uploadedParts: state.transfer.parts.filter(part => part.status === 'uploaded').length } } : {}) };
}

export function projectUploadCapabilities() {
  return { scope: 'Direct native g-p- project source uploads.', supported: ['upload', 'status', 'reconcile'], maxBytes: MAX_BYTES,
    limitations: ['An explicit account, project, local regular file and private state file are required.', 'Every upload write is journaled before submission and never automatically retried.', 'Interrupted Azure blocks require explicit resumeParts; an uncertain commit, processing or attachment is never replayed.', 'Completion requires exact project file membership and validates every available full-file metadata field; verified fields are reported. Remote content hashes are not independently verified. Library persistence is optional in the native project workflow.', 'Native account, project permission and file-capacity checks apply.', 'A failed upload may leave an unattached general Files object or storage reservation. The private journal retains any returned file ID; no verified storage deletion or rollback is available and none is attempted.'], liveVerified: false };
}

export class ProjectUpload extends AccountProjects {
  capabilities() { return projectUploadCapabilities(); }
  async _identity(context, state) {
    await context.assert();
    if (typeof context.subject !== 'string' || !context.subject) fail('AUTH_IDENTITY_REQUIRED', 'Project uploads require an authenticated user identity.');
    const identity = { accountId: context.accountId, subjectSha256: hash(context.subject) };
    if (state && (state.identity.accountId !== identity.accountId || state.identity.subjectSha256 !== identity.subjectSha256)) fail('ACCOUNT_CHANGED', 'This project upload belongs to a different signed-in identity.');
    return identity;
  }
  async _save(file, state, phase, patch = {}, acknowledged = false) {
    const next = { ...state, ...patch, phase };
    try {
      const serialized = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(serialized) > MAX_STATE) fail('INVALID_UPLOAD_STATE', 'The project upload journal exceeds its bounded size.');
      await writePrivate(file, serialized, { overwrite: true }); return next;
    } catch (error) {
      fail('UPLOAD_RECEIPT_NOT_SAVED', acknowledged ? 'The service replied but its project upload receipt could not be saved. Do not repeat this upload.' : 'The project upload journal could not be saved; no further request was sent.',
        { phase, delivery: acknowledged ? 'acknowledged' : 'not_sent', fileId: next.reservation.fileId ?? null, projectId: next.context.projectId, reason: error.code ?? 'WRITE_FAILED' });
    }
  }
  async _request(context, state, method, path, options = {}) {
    await this._identity(context, state);
    const value = await context.request(method, path, options);
    await this._identity(context, state); return value;
  }
  async _preflight(context, projectId, state, { allowAttached = false } = {}) {
    await this._identity(context, state); await requireProjectCrud(context);
    const resource = await this._get(context, projectId);
    requireProjectPermission(resource, context, 'can_write');
    const members = fileIds(resource);
    if (state?.context.priorFileIds.some(id => !members.has(id))) fail('PROJECT_MEMBERSHIP_CHANGED', 'A previously present project source was removed. Review the project before resuming this upload.');
    const attached = !!state?.reservation.fileId && members.has(state.reservation.fileId);
    if (!attached || !allowAttached) capacity(resource, members);
    return { resource, members, attached };
  }
  async _indexPolicy(context, resource, source) {
    const data = await context.request('GET', '/models', { query: { iim: false, include_icons: false, is_gizmo: false }, maxBytes: 4 * 1024 * 1024 });
    if (!record(data) || !Array.isArray(data.models) || data.models.length > 10000) invalid('The model catalog did not provide a verifiable project attachment policy.');
    const models = new Map();
    for (const model of data.models) {
      if (model == null) continue;
      if (!record(model) || !catalogString(model.slug) || models.has(model.slug.trim())
        || model.tags != null && (!Array.isArray(model.tags) || model.tags.length > 10000 || model.tags.some(tag => typeof tag !== 'string' || tag.length > 1024))
        || model.product_features != null && !record(model.product_features)) invalid('The model catalog contained an invalid model identity.');
      models.set(model.slug.trim(), model);
    }
    const defaultSlug = nativeDefaultModel(data, models);
    const selected = models.get('gpt-4o') ?? [...models.values()].find(model => model.tags?.includes('gpt4o'))
      ?? models.get(defaultSlug);
    const attachments = selected?.product_features?.attachments;
    if (attachments != null && (!record(attachments) || attachments.type != null && !['code_interpreter', 'multimodal', 'retrieval', 'context_connector', 'multimodal_audio'].includes(attachments.type)
      || attachments.accepted_mime_types != null && (!Array.isArray(attachments.accepted_mime_types) || attachments.accepted_mime_types.length > 10000 || attachments.accepted_mime_types.some(value => typeof value !== 'string' || value.length > 200)))) invalid('The native project attachment policy is invalid.');
    const extension = source.name.split('.').at(-1)?.toLowerCase(), resolvedMime = INDEX_MIME[extension] || source.mimeType;
    let indexed = attachments?.type === 'retrieval' && attachments.accepted_mime_types?.includes(resolvedMime) === true;
    if (!indexed && resource.gizmo?.use_injest_path === true && ['xls', 'xlsx', 'csv'].includes(extension)) indexed = true;
    // Image fallback requires a separate native Statsig gate. Without that
    // account-specific proof the general retrieval policy remains authoritative.
    return indexed;
  }
  async _multipart(file, state, source, context, signal) {
    const plan = validateNativeMultipartStrategy(state.reservation.uploadStrategy, source.sizeBytes), target = parseNativeUploadTarget(state.reservation.uploadUrl);
    const host = target.kind === 'signed' ? new URL(target.url).hostname : '';
    if (!plan || target.kind !== 'signed' || !(/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(host) || /^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(host))
      || [...new URL(target.url).searchParams.keys()].some(key => ['x-amz-algorithm', 'comp', 'blockid'].includes(key.toLowerCase()))) fail('UNSUPPORTED_UPLOAD_STRATEGY', 'Azure multipart requires its original signed Azure reservation.');
    if (typeof this.transport.uploadAzureBlock !== 'function' || typeof this.transport.commitAzureBlocks !== 'function') fail('UNSUPPORTED_TRANSPORT', 'This transport cannot perform native Azure multipart uploads.');
    if (!state.transfer) {
      const parts = [];
      for (let index = 0; index < plan.part_count; index++) {
        const offset = index * plan.part_size_bytes, length = Math.min(plan.part_size_bytes, source.sizeBytes - offset);
        const range = await prepareVerifiedUploadRange(source, { start: offset, endExclusive: offset + length, signal });
        parts.push({ index, blockId: nativeUploadBlockId(index), offset, length, sha256: range.sha256, status: 'pending' });
      }
      state = await this._save(file, state, 'reserved', { transfer: { kind: 'azure_multipart', strategy: plan, fileId: state.reservation.fileId,
        sourceSha256: source.sha256, projectId: state.context.projectId, targetHash: nativeUploadTargetHash(target.url), parts } });
    }
    validateTransfer(state); await this._identity(context, state); signal?.throwIfAborted();
    state = await this._save(file, state, 'uploading_parts');
    let chain = Promise.resolve(), next = 0, firstError;
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const persist = (index, status, acknowledged = false) => {
      const operation = chain.then(async () => {
        const parts = state.transfer.parts.map((part, i) => i === index ? { ...part, status } : part);
        state = await this._save(file, state, 'uploading_parts', { transfer: { ...state.transfer, parts } }, acknowledged);
      });
      chain = operation.catch(() => {}); return operation;
    };
    const worker = async () => {
      try {
        for (;;) {
          combined.throwIfAborted(); const index = next++; if (index >= state.transfer.parts.length) return;
          const part = state.transfer.parts[index]; if (part.status === 'uploaded') continue;
          const range = await prepareVerifiedUploadRange(source, { start: part.offset, endExclusive: part.offset + part.length, signal: combined });
          if (range.sha256 !== part.sha256) fail('UPLOAD_SOURCE_MISMATCH', 'A multipart source range changed. No further block was sent.');
          await this._identity(context, state); combined.throwIfAborted(); await persist(index, 'inflight');
          combined.throwIfAborted();
          await this.transport.uploadAzureBlock(target.url, { ...range, blockId: part.blockId, contentType: source.mimeType, signal: combined, timeoutMs: 600000 });
          await this._identity(context, state); await persist(index, 'uploaded', true);
        }
      } catch (error) { firstError ??= error; controller.abort(error); }
    };
    await Promise.allSettled(Array.from({ length: Math.min(5, plan.max_part_concurrency, plan.part_count) }, worker)); await chain;
    if (firstError) throw firstError;
    if (state.transfer.parts.some(part => part.status !== 'uploaded')) fail('UPLOAD_OUTCOME_UNKNOWN', 'Not every project upload part was acknowledged.');
    await this._identity(context, state); signal?.throwIfAborted(); state = await this._save(file, state, 'committing');
    await this.transport.commitAzureBlocks(target.url, { blockIds: state.transfer.parts.map(part => part.blockId), contentType: source.mimeType, signal, timeoutMs: 120000 });
    await this._identity(context, state);
    return this._save(file, state, 'uploaded', { reservation: { fileId: state.reservation.fileId } }, true);
  }
  async _finish(file, state, context, signal) {
    const before = await this._preflight(context, state.context.projectId, state, { allowAttached: true });
    if (before.attached) {
      const readback = validateExpectedMember(before.resource, context, state);
      return this._save(file, state, 'complete', { attachment: { ...state.attachment, verified: true, readback } });
    }
    if (state.phase === 'attached') fail('UPLOAD_READBACK_PENDING', 'The acknowledged project file attachment is not visible yet. Reconcile it without repeating the write.');
    if (state.phase !== 'processed') fail('UPLOAD_OUTCOME_UNKNOWN', 'The prior project upload write is uncertain. Reconcile without repeating it.');
    state = await this._save(file, state, 'processed', { context: { ...state.context, priorFileIds: [...before.members.keys()] } });
    await this._identity(context, state); signal?.throwIfAborted(); state = await this._save(file, state, 'attaching');
    const acknowledgement = await this._request(context, state, 'POST', `/projects/${encodeURIComponent(state.context.projectId)}/files`, { body: { files: [memberExpectation(state)] } });
    // Preserve the acknowledgement before requiring an exact independent GET.
    if (!record(acknowledgement) || acknowledgement.error != null || !record(acknowledgement.resource)) fail('MUTATION_UNCONFIRMED', 'The project attachment was not acknowledged. Reconcile the saved upload; do not attach it again.');
    const response = acknowledgement.resource;
    projectSummary(response, state.context.projectId, context, { detail: true });
    if (!fileIds(response).has(state.reservation.fileId)) fail('MUTATION_UNCONFIRMED', 'The project attachment response did not include this file. Reconcile the saved upload.');
    state = await this._save(file, state, 'attached', { attachment: { acknowledged: true } }, true);
    const readback = await this._get(context, state.context.projectId); await this._identity(context, state);
    const verification = validateExpectedMember(readback, context, state);
    if (!verification) fail('UPLOAD_READBACK_PENDING', 'The acknowledged project file attachment is not visible yet. Reconcile it without repeating the write.');
    return this._save(file, state, 'complete', { attachment: { acknowledged: true, verified: true, readback: verification } });
  }
  async status({ stateFile, accountId, signal } = {}) {
    const file = await statePath(stateFile), state = await readState(file), context = await this._context(accountId, signal);
    await this._identity(context, state); return result(state, file);
  }
  async upload({ projectId, accountId, file: sourceFile, stateFile, mimeType, resumeParts = false, signal } = {}) {
    validateProjectId(projectId); if (typeof resumeParts !== 'boolean') fail('INVALID_ARGUMENT', 'resumeParts must be boolean.');
    const file = await statePath(stateFile);
    return withOperationLock(file, async () => {
      let state = await readState(file, true);
      const context = await this._context(accountId, signal), identity = await this._identity(context, state);
      if (state && state.context.projectId !== projectId) fail('UPLOAD_SOURCE_MISMATCH', 'This journal belongs to another project.');
      const payload = await readLibraryUploadSource(sourceFile, { mimeType: mimeType ?? state?.source.mimeType, signal });
      if ([file, file + '.lock', file + '.lock.recovery-lock'].includes(payload.source.path)) fail('INVALID_ARGUMENT', 'Source and upload state must be separate files.');
      if (state) {
        if (Object.keys(payload.source).some(key => key !== 'mimeResolutionSource' && state.source[key] !== payload.source[key])) fail('UPLOAD_SOURCE_MISMATCH', 'This journal belongs to a different source file.');
        if (UNKNOWN.has(state.phase)) fail('UPLOAD_OUTCOME_UNKNOWN', 'A prior project upload write has an uncertain outcome. Reconcile this journal; no write was repeated.', { phase: state.phase, fileId: state.reservation.fileId ?? null, projectId });
        if (state.phase === 'uploading_parts' && !resumeParts) fail('UPLOAD_OUTCOME_UNKNOWN', 'This multipart upload was interrupted. Only explicit resumeParts may repeat its unchanged deterministic uncommitted blocks.', { phase: state.phase, fileId: state.reservation.fileId, projectId });
      } else {
        if (resumeParts) fail('INVALID_ARGUMENT', 'resumeParts requires an existing interrupted multipart journal.');
        const preflight = await this._preflight(context, projectId);
        state = { schemaVersion: 1, kind: 'native-project-upload', operationId: randomUUID(), identity, source: payload.source,
          context: { projectId, priorFileIds: [...preflight.members.keys()], indexForRetrieval: await this._indexPolicy(context, preflight.resource, payload.source) },
          phase: 'prepared', reservation: {}, processing: {}, attachment: {} };
        await writePrivate(file, JSON.stringify(state, null, 2) + '\n');
      }
      if (state.phase === 'complete') return result(state, file);
      if (state.phase === 'prepared') {
        await this._preflight(context, projectId, state); await this._identity(context, state); signal?.throwIfAborted();
        state = await this._save(file, state, 'reserving');
        const response = await this._request(context, state, 'POST', '/files', { headers: { 'chatgpt-project-id': projectId }, body: {
          file_name: state.source.name, file_size: state.source.sizeBytes, gizmo_id: projectId, mime_type: state.source.mimeType,
          reset_rate_limits: false, supports_direct_azure_multipart: true, timezone_offset_min: new Date().getTimezoneOffset(), use_case: 'gizmo' } });
        const reservation = { ...(FILE_ID.test(response?.file_id ?? '') ? { fileId: response.file_id } : {}),
          ...(typeof response?.upload_url === 'string' && response.upload_url.length <= 16384 ? { uploadUrl: response.upload_url } : {}),
          requiredHeaders: {}, uploadStrategy: normalizeNativeUploadStrategy(response?.direct_library_upload_strategy), metadataValid: false };
        state = await this._save(file, state, reservation.fileId ? 'reserved' : 'reserving', { reservation }, true);
        if (!reservation.fileId || !reservation.uploadUrl || response?.status === 'error') invalid('The project file reservation was incomplete. Inspect the saved state; do not reserve again.');
        parseNativeUploadTarget(reservation.uploadUrl);
        state = await this._save(file, state, 'reserved', { reservation: { ...reservation, requiredHeaders: validateNativeUploadHeaders(response?.upload_headers), metadataValid: true } });
      }
      if (state.phase === 'reserved' || state.phase === 'uploading_parts') {
        if (state.reservation.metadataValid !== true) invalid('Stored project upload reservation metadata is invalid or incomplete. No bytes were sent.');
        await this._preflight(context, projectId, state);
        const target = parseNativeUploadTarget(state.reservation.uploadUrl), plan = validateNativeMultipartStrategy(state.reservation.uploadStrategy, state.source.sizeBytes);
        if (plan) state = await this._multipart(file, state, payload.source, context, signal);
        else {
          if (state.phase === 'uploading_parts') fail('INVALID_UPLOAD_STATE', 'An interrupted multipart upload cannot become a whole-file upload.');
          if (target.kind === 'signed' && typeof this.transport.uploadSignedFile !== 'function' || target.kind === 'estuary' && typeof this.transport.uploadEstuaryFile !== 'function') fail('UNSUPPORTED_TRANSPORT', 'The transport does not support file-backed uploads.');
          validateStorageUploadHeaders(state.reservation.requiredHeaders); await this._identity(context, state); signal?.throwIfAborted(); state = await this._save(file, state, 'uploading');
          if (target.kind === 'signed') await this.transport.uploadSignedFile(target.url, { source: payload.source, contentType: state.source.mimeType, requiredHeaders: state.reservation.requiredHeaders, signal, timeoutMs: 600000 });
          else await this.transport.uploadEstuaryFile(target.upstream, { source: payload.source, expectedAccountId: accountId, signal, timeoutMs: 600000 });
          await this._identity(context, state); state = await this._save(file, state, 'uploaded', { reservation: { fileId: state.reservation.fileId } }, true);
        }
      }
      if (state.phase === 'uploaded') {
        const current = await this._preflight(context, projectId, state);
        state = await this._save(file, state, 'uploaded', { context: { ...state.context, indexForRetrieval: await this._indexPolicy(context, current.resource, payload.source) } });
        await this._identity(context, state); signal?.throwIfAborted(); state = await this._save(file, state, 'processing');
        const stream = await this._request(context, state, 'POST', '/files/process_upload_stream', { headers: { 'chatgpt-project-id': projectId }, responseType: 'text', maxBytes: 2 * 1024 * 1024, timeoutMs: 600000,
          body: { entry_surface: 'project_sources', file_id: state.reservation.fileId, file_name: state.source.name, gizmo_id: projectId,
            index_for_retrieval: state.context.indexForRetrieval, mime_type: state.source.mimeType, use_case: 'gizmo' } });
        const processing = processingReceipt(stream, state.reservation.fileId);
        state = await this._save(file, state, 'processing', { processing }, true);
        if (processing.error) fail(processing.error, 'Processing did not confirm a completed project source. Reconcile this journal; do not repeat the upload.');
        state = await this._save(file, state, 'processed');
      }
      state = await this._finish(file, state, context, signal); return result(state, file);
    }, { label: 'project upload', busyCode: 'UPLOAD_BUSY', failedCode: 'UPLOAD_BUSY' });
  }
  async reconcile({ stateFile, accountId, signal } = {}) {
    const file = await statePath(stateFile);
    return withOperationLock(file, async () => {
      let state = await readState(file); const context = await this._context(accountId, signal); await this._identity(context, state);
      if (!state.reservation.fileId) return { ...result(state, file), reconciled: false, reason: 'No file ID was received; another reservation is not safe.' };
      const resource = await this._get(context, state.context.projectId); await this._identity(context, state);
      if (!fileIds(resource).has(state.reservation.fileId)) {
        // A saved successful processing receipt can be resumed at attachment.
        // No search by filename, Library scan, reserve, process or attach occurs.
        if (state.phase === 'processing' && state.processing.completed === true && state.processing.error == null) state = await this._save(file, state, 'processed');
        return { ...result(state, file), reconciled: false, reason: state.phase === 'processed' ? 'The source was processed but is not attached. Resume this journal to attach it once.' : 'This exact file is not present in the project. The previous write was not repeated.' };
      }
      if (state.processing.completed !== true || state.processing.error != null) return { ...result(state, file), reconciled: false, reason: 'The file is present, but this journal has no valid processing receipt. No unknown write was replayed.' };
      const readback = validateExpectedMember(resource, context, state);
      if (!readback) fail('UPLOAD_READBACK_PENDING', 'This project upload is not visible yet.');
      state = await this._save(file, state, 'complete', { attachment: { ...state.attachment, verified: true, reconciled: true, readback } });
      return { ...result(state, file), reconciled: true };
    }, { label: 'project upload', busyCode: 'UPLOAD_BUSY', failedCode: 'UPLOAD_BUSY' });
  }
}
