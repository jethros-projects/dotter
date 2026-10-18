import { DotError } from './errors.mjs';

// Account-wide Library contracts, not Dot room attachments. Inspected in
// ChatGPT.app: app-initial-90eb42395b7d.js and context-1576820c4ebb.js (2026-10-17).
const BASE = '/backend-api/files/library';
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const CATEGORIES = new Set(['image', 'images', 'documents', 'spreadsheets', 'presentations', 'pdfs', 'pages', 'meetings']);
const FIELDS = ['id', 'kind', 'name', 'file_name', 'file_id', 'mime_type', 'file_extension', 'file_size_bytes',
  'state', 'access_kind', 'parent_directory_id', 'directory_id', 'library_file_category', 'library_artifact_type',
  'record_creation_time', 'file_upload_time', 'created_at', 'updated_at', 'trashed_at', 'current_version_number',
  'origination_thread_id', 'origination_message_id', 'is_root', 'is_shared', 'is_project'];
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function id(value, label = 'fileId') {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an ID returned by the API.`);
  return value;
}
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) fail(`${label} must be a nonempty string of at most ${max} characters without NUL bytes or newlines.`);
  return value;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid object.');
  return value;
}
function pick(value, fields = FIELDS) {
  object(value);
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key) && (value[key] === null
    || typeof value[key] === 'boolean' || (typeof value[key] === 'number' && Number.isFinite(value[key]))
    || (typeof value[key] === 'string' && value[key].length <= 8192))).map(key => [key, value[key]]));
}
function hidden(value) { return Boolean(value?.hidden || value?.is_hidden || value?.is_visually_hidden_from_conversation || value?.metadata?.hidden || value?.metadata?.is_hidden || value?.metadata?.is_visually_hidden_from_conversation
  || (value?.channel != null && !['final', 'commentary'].includes(value.channel)) || (value?.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel))
  || (value?.recipient != null && value.recipient !== 'all') || (value?.metadata?.recipient != null && value.metadata.recipient !== 'all')); }
function file(value, expectedId) {
  object(value);
  if (typeof value.id !== 'string' || (expectedId != null && value.id !== expectedId)) throw new DotError('INVALID_RESPONSE', 'The Library file response did not match the requested file.');
  if (hidden(value)) throw new DotError('NOT_VISIBLE', 'The Library file is not a visible record.');
  return pick(value);
}
function page(value, project = file, max = 1000) {
  object(value);
  if (!Array.isArray(value.items) || value.items.length > max) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid or oversized page.');
  const cursor = value.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 8192)) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid cursor.');
  return { items: value.items.filter(item => !hidden(item)).map(item => project(item)), cursor };
}
function paging({ limit = 50, cursor } = {}, max = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) fail(`limit must be an integer from 1 to ${max}.`);
  if (cursor != null) text(cursor, 'cursor', 8192);
  return { limit, ...(cursor == null ? {} : { cursor }) };
}
function categories(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CATEGORIES.size || value.some(item => !CATEGORIES.has(item))) fail('categories must contain supported Library categories.');
  return [...new Set(value)];
}
function version(value, label) {
  // Existing Library files can have the initial revision numbered zero.
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer.`);
  return value;
}
function confirmed(fileId, confirm) { if (confirm !== fileId) fail('confirm must exactly match fileId for this operation.'); }
function mutation(data, fileId, operation) {
  if (data?.success !== true) throw new DotError('MUTATION_UNCONFIRMED', `The Library did not confirm ${operation}. Inspect the file before retrying.`, { fileId, delivery: 'unknown' });
  return { fileId, [operation]: true };
}
function favorite(value) {
  object(value);
  const result = pick(value, ['favorite_id', 'created_at', 'availability']);
  if (value.target_ref?.type === 'library_file' && typeof value.target_ref.library_file_id === 'string') {
    result.target_ref = { type: 'library_file', library_file_id: value.target_ref.library_file_id };
  }
  if (value.availability === 'available' && value.item != null && !hidden(value.item)) result.item = file(value.item);
  return result;
}
function versionSummary(value) {
  const result = pick(value, ['library_file_id', 'version_number', 'is_current', 'file_id', 'file_name', 'mime_type',
    'file_extension', 'file_size_bytes', 'library_file_category', 'version_created_at', 'file_upload_time',
    'origination_thread_id', 'origination_message_id', 'library_artifact_type', 'is_project']);
  if (!Number.isSafeInteger(result.version_number) || result.version_number < 0) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid file version.');
  if (value.version_provenance != null) result.version_provenance = pick(value.version_provenance, ['actor', 'actor_display_name', 'actor_email', 'action']);
  return result;
}

export function libraryCapabilities() {
  return { scope: 'Entire signed-in ChatGPT account Library; not limited to Dot attachments.',
    supported: ['browse', 'search', 'details', 'directory-path', 'rename', 'move', 'trash', 'restore', 'versions', 'restore-version', 'favorites', 'favorite-status', 'storage-usage'],
    destructiveConfirmation: 'trash and restore-version require confirm equal to fileId',
    limitations: ['Folder content, permanent deletion and empty-trash are exposed by LibraryContent.', 'Mounted-provider capabilities and access are enforced by the service.', 'Page, site, saved-entity, and directory trash/restore use separate product APIs and are rejected here.'],
    liveVerified: false };
}

export class DotLibrary {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotLibrary requires a DotClient.');
    this.transport = client.transport;
  }
  capabilities() { return libraryCapabilities(); }
  async browse({ directoryId, query, cursor, categories: inputCategories, foldersOnly = false, source,
    includeFiles, includeSavedEntities = true, includeProviderRoots, includePages, includeSites = false,
    includeFolderCounts = false, includeOneDrive = false, hydrateFolderThumbnails, signal } = {}) {
    if (directoryId != null) id(directoryId, 'directoryId');
    if (query != null) text(query, 'query', 4096);
    if (cursor != null) text(cursor, 'cursor', 8192);
    for (const [name, value] of Object.entries({ foldersOnly, includeFiles, includeSavedEntities, includeProviderRoots, includePages, includeSites, includeFolderCounts, includeOneDrive, hydrateFolderThumbnails })) {
      if (value !== undefined && typeof value !== 'boolean') fail(`${name} must be a boolean.`);
    }
    if (source != null && !['uploaded', 'generated'].includes(source)) fail('source must be uploaded or generated.');
    const queryFields = { parent_directory_id: directoryId, cursor, q: query, entry_surface: 'library',
      include_files: includeFiles ?? !foldersOnly, include_saved_entities: includeSavedEntities, include_sites: includeSites,
      include_folder_counts: includeFolderCounts, include_hidden_files: false, include_onedrive: includeOneDrive,
      ...(source == null ? {} : { source }), ...(includeProviderRoots === undefined ? {} : { include_provider_roots: includeProviderRoots }),
      ...(includePages === undefined ? {} : { include_pages: includePages }),
      ...(hydrateFolderThumbnails === undefined ? {} : { hydrate_folder_thumbnails: hydrateFolderThumbnails }) };
    const filter = categories(inputCategories);
    // The app serializer repeats array keys (categories=a&categories=b).
    if (filter?.length) queryFields.categories = filter.length === 1 ? filter[0] : filter;
    return page(await this.transport.request('GET', `${BASE}/nodes`, { query: queryFields, signal, maxBytes: 2 * 1024 * 1024 }));
  }
  async search({ query, limit = 50, cursor, categories: inputCategories, trash = false, state, source, ranking,
    providers, externalAccountKeys, allowlistIds, includeNativeFiles, includeUploadedFiles, includeImagegenFiles,
    includeSavedEntities = true, includePages, includeSites = false, excludeSpaceRoots, signal } = {}) {
    if (query != null) text(query, 'query', 4096);
    for (const [name, value] of Object.entries({ trash, includeNativeFiles, includeUploadedFiles, includeImagegenFiles, includeSavedEntities, includePages, includeSites, excludeSpaceRoots })) {
      if (value !== undefined && typeof value !== 'boolean') fail(`${name} must be a boolean.`);
    }
    if (state != null && state !== 'ready') fail('The verified state filter is ready.');
    if (source != null && !['uploaded', 'generated'].includes(source)) fail('source must be uploaded or generated.');
    if (ranking != null && ranking !== 'suggested') fail('The verified ranking is suggested.');
    // This POST endpoint accepts mounted providers only. Native/native_shared
    // are valid on other Library APIs, but produce a 422 in this request body.
    const knownProviders = new Set(['google_drive', 'box', 'dropbox', 'sharepoint', 'onedrive']);
    if (providers !== undefined && (!Array.isArray(providers) || providers.length > 7 || providers.some(value => !knownProviders.has(value)))) fail('providers must contain only google_drive, box, dropbox, sharepoint or onedrive. Use includeNativeFiles (--include-native-files) for native Library entries.');
    if (allowlistIds !== undefined && (!Array.isArray(allowlistIds) || allowlistIds.length > 1000)) fail('allowlistIds must contain at most 1000 IDs.');
    allowlistIds?.forEach(value => id(value));
    if (externalAccountKeys !== undefined) {
      if (!externalAccountKeys || typeof externalAccountKeys !== 'object' || Array.isArray(externalAccountKeys)) fail('externalAccountKeys must map providers to account-key arrays.');
      for (const [name, values] of Object.entries(externalAccountKeys)) {
        if (!knownProviders.has(name) || ['native', 'native_shared'].includes(name) || providers !== undefined && !providers.includes(name)
          || !Array.isArray(values) || values.length > 100) fail('Invalid external account-key filter.');
        values.forEach(value => text(value, 'external account key', 512));
      }
    }
    const body = { ...paging({ limit, cursor }), q: query ?? null, trashed_only: trash,
      include_hidden_files: false, include_saved_entities: includeSavedEntities, include_sites: includeSites };
    const optional = { state, source, ranking, providers: providers === undefined ? undefined : [...new Set(providers)],
      external_account_keys: externalAccountKeys, allowlist_ids: allowlistIds === undefined ? undefined : [...new Set(allowlistIds)],
      include_native_files: includeNativeFiles, include_uploaded_files: includeUploadedFiles,
      include_imagegen_files: includeImagegenFiles, include_pages: includePages, exclude_space_roots: excludeSpaceRoots };
    for (const [key, value] of Object.entries(optional)) if (value !== undefined) body[key] = value;
    const filter = categories(inputCategories); if (filter !== undefined) body.categories = filter;
    return page(await this.transport.request('POST', BASE, { body, signal, maxBytes: 2 * 1024 * 1024 }));
  }
  async get({ fileId, includeTrashed = false, signal } = {}) {
    id(fileId);
    if (typeof includeTrashed !== 'boolean') fail('includeTrashed must be a boolean.');
    let data;
    try { data = await this.transport.request('GET', `${BASE}/files/${encodeURIComponent(fileId)}`, { signal, maxBytes: 256 * 1024 }); }
    catch (error) {
      if (error?.code !== 'HTTP_ERROR' || error?.details?.status !== 404) throw error;
      try {
        data = await this.transport.request('GET', `${BASE}/files/${encodeURIComponent(fileId)}/node`, { signal, maxBytes: 256 * 1024 });
      } catch (nodeError) {
        if (!includeTrashed || nodeError?.code !== 'HTTP_ERROR' || nodeError?.details?.status !== 404) throw nodeError;
        // Trashed files intentionally disappear from both detail endpoints.
        // Resolve the exact ID through the bounded native trash listing before
        // any restore/permanent-delete mutation or file-type decision.
        let cursor; const seen = new Set();
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const batch = await this.search({ trash: true, limit: 100, cursor, signal });
          const found = batch.items.find(item => item.id === fileId && item.trashed_at != null);
          if (found) return file(found, fileId);
          if (batch.cursor == null) throw nodeError;
          if (seen.has(batch.cursor)) throw new DotError('INVALID_RESPONSE', 'The trash listing repeated a cursor.');
          seen.add(batch.cursor); cursor = batch.cursor;
        }
        throw new DotError('PAGINATION_LIMIT', 'The target was not found within 100 trash pages. No mutation was sent.');
      }
    }
    return file(data, fileId);
  }
  async directoryPath({ directoryId = null, signal } = {}) {
    if (directoryId !== null) id(directoryId, 'directoryId');
    return page(await this.transport.request('GET', `${BASE}/directories/path`, { query: { directory_id: directoryId }, signal, maxBytes: 256 * 1024 }), file, 100);
  }
  async rename({ fileId, name, signal } = {}) {
    id(fileId); text(name, 'name');
    const current = await this.get({ fileId, signal });
    if (current.kind === 'directory' || ['site', 'site_preview'].includes(current.library_artifact_type)) throw new DotError('UNSUPPORTED', 'Site and directory renaming use separate product APIs.');
    return file(await this.transport.request('PATCH', `${BASE}/files/${encodeURIComponent(fileId)}`, { body: { file_name: name }, signal, maxBytes: 256 * 1024 }), fileId);
  }
  async renameDirectory({ directoryId, name, signal } = {}) {
    id(directoryId, 'directoryId'); text(name, 'name');
    return file(await this.transport.request('PATCH', `${BASE}/directories/${encodeURIComponent(directoryId)}`, { body: { name }, signal, maxBytes: 256 * 1024 }), directoryId);
  }
  async move({ fileId, directoryId, signal } = {}) {
    id(fileId); if (directoryId !== null) id(directoryId, 'directoryId');
    return mutation(await this.transport.request('PATCH', `${BASE}/files/${encodeURIComponent(fileId)}/move`, { body: { directory_id: directoryId }, signal, maxBytes: 256 * 1024 }), fileId, 'moved');
  }
  async moveDirectory({ directoryId, parentDirectoryId, signal } = {}) {
    id(directoryId, 'directoryId'); if (parentDirectoryId !== null) id(parentDirectoryId, 'parentDirectoryId');
    if (parentDirectoryId === directoryId) fail('A directory cannot be its own parent.');
    return file(await this.transport.request('PATCH', `${BASE}/directories/${encodeURIComponent(directoryId)}`, { body: { parent_directory_id: parentDirectoryId }, signal, maxBytes: 256 * 1024 }), directoryId);
  }
  async trash({ fileId, confirm, signal } = {}) {
    id(fileId); confirmed(fileId, confirm);
    const current = await this.get({ fileId, signal });
    if (current.kind === 'directory' || ['page', 'site', 'site_preview', 'saved_entity', 'chat_message_snapshot'].includes(current.library_artifact_type)) throw new DotError('UNSUPPORTED', 'Page, site, saved-entity, and directory deletion use separate product APIs.');
    return mutation(await this.transport.request('DELETE', `${BASE}/files/${encodeURIComponent(fileId)}`, {
      query: { soft_delete: true, file_id: current.file_id, parent_directory_id: current.parent_directory_id ?? current.directory_id, file_name: current.file_name ?? current.name },
      signal, maxBytes: 256 * 1024 }), fileId, 'trashed');
  }
  async restore({ fileId, signal } = {}) {
    id(fileId);
    const current = await this.get({ fileId, includeTrashed: true, signal });
    if (current.kind === 'directory' || ['page', 'site', 'site_preview', 'saved_entity', 'chat_message_snapshot'].includes(current.library_artifact_type)) throw new DotError('UNSUPPORTED', 'Page, site, saved-entity, and directory restoration use separate product APIs.');
    const data = await this.transport.request('POST', `${BASE}/files/${encodeURIComponent(fileId)}/restore`, { signal, maxBytes: 256 * 1024 });
    if (data.success === false) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not confirm restoration. Inspect the file before retrying.', { fileId, delivery: 'unknown' });
    if (data.id != null) return { file: file(data, fileId), status: 'accepted' };
    return { fileId, status: 'accepted' };
  }
  async versions({ fileId, limit = 20, cursor, signal } = {}) {
    id(fileId);
    return page(await this.transport.request('GET', `${BASE}/files/${encodeURIComponent(fileId)}/versions`, { query: paging({ limit, cursor }, 100), signal, maxBytes: 2 * 1024 * 1024 }), versionSummary);
  }
  async restoreVersion({ fileId, version: targetVersion, expectedCurrentVersion, confirm, signal } = {}) {
    id(fileId); confirmed(fileId, confirm); version(targetVersion, 'version'); version(expectedCurrentVersion, 'expectedCurrentVersion');
    if (targetVersion === expectedCurrentVersion) fail('The selected version is already current.');
    const result = file(await this.transport.request('POST', `${BASE}/files/${encodeURIComponent(fileId)}/versions/${targetVersion}/restore`, {
      body: { expected_current_version: expectedCurrentVersion }, signal, maxBytes: 256 * 1024 }), fileId);
    if (!Number.isSafeInteger(result.current_version_number) || result.current_version_number < 0) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not return the restored revision. Inspect version history before retrying.', { fileId, delivery: 'unknown' });
    return result;
  }
  async favorites({ limit = 50, cursor, signal } = {}) {
    return page(await this.transport.request('GET', `${BASE}/favorites`, { query: { ...paging({ limit, cursor }, 50), include_sites: false }, signal, maxBytes: 2 * 1024 * 1024 }), favorite);
  }
  async favorite({ fileId, signal } = {}) {
    id(fileId);
    const data = await this.transport.request('POST', `${BASE}/favorites`, { body: { target_ref: { type: 'library_file', library_file_id: fileId } }, signal, maxBytes: 256 * 1024 });
    if (typeof data.favorite_id !== 'string' || !ID.test(data.favorite_id)) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not return a favorite ID. Check favorite status before retrying.', { fileId, delivery: 'unknown' });
    return { fileId, favoriteId: data.favorite_id };
  }
  async unfavorite({ favoriteId, signal } = {}) {
    id(favoriteId, 'favoriteId');
    await this.transport.request('DELETE', `${BASE}/favorites/${encodeURIComponent(favoriteId)}`, { signal, maxBytes: 256 * 1024 });
    return { favoriteId, removed: true };
  }
  async favoriteStatus({ fileIds, signal } = {}) {
    if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 50) fail('fileIds must contain from 1 to 50 IDs.');
    const unique = [...new Set(fileIds.map(value => id(value)))];
    const data = await this.transport.request('POST', `${BASE}/favorites/status`, { body: { target_refs: unique.map(library_file_id => ({ type: 'library_file', library_file_id })) }, signal, maxBytes: 256 * 1024 });
    if (!Array.isArray(data?.items) || data.items.length !== unique.length
      || new Set(data.items.map(item => item?.target_ref?.library_file_id)).size !== unique.length) throw new DotError('INVALID_RESPONSE', 'The Library returned an incomplete or invalid favorite-status page.');
    return { items: data.items.map(item => {
      const fileId = item?.target_ref?.library_file_id;
      if (item?.target_ref?.type !== 'library_file' || !unique.includes(fileId)) throw new DotError('INVALID_RESPONSE', 'Favorite status did not match the requested files.');
      return { fileId, available: item.availability === 'available', favorited: item.availability === 'available' && item.favorite != null,
        favoriteId: item.availability === 'available' && typeof item.favorite?.favorite_id === 'string' ? item.favorite.favorite_id : null };
    }) };
  }
  async storageUsage({ signal } = {}) {
    const result = pick(await this.transport.request('GET', `${BASE}/storage/usage`, { signal, maxBytes: 64 * 1024 }), ['used_bytes', 'allowed_bytes', 'remaining_bytes', 'is_over_limit', 'limit_tier', 'plan_type']);
    if (!Number.isFinite(result.used_bytes) || !Number.isFinite(result.allowed_bytes)) throw new DotError('INVALID_RESPONSE', 'The Library returned invalid storage usage.');
    return result;
  }
}
