import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { fileDownloadTarget } from './files.mjs';
import { writePrivate } from './store.mjs';
import { DotLibrary } from './library.mjs';

// Contracts inspected in the installed app's app-initial, app-primary,
// form-dialog and image-favorite/action bundles (2026-10-18).
const BASE = '/backend-api/files/library';
const PROVIDERS = new Set(['google_drive', 'box', 'dropbox', 'sharepoint', 'onedrive']);
// The capabilities endpoint also reports iManage status. Retain its metadata
// without enabling provider operations or selectors that lack native contracts.
const CAPABILITY_PROVIDERS = new Set([...PROVIDERS, 'imanage']);
const ALL_PROVIDERS = new Set(['native', 'native_shared', ...PROVIDERS]);
const ENTITY_TYPES = new Set(['self', 'person', 'pet', 'place', 'asset']);
const ID = /^[A-Za-z0-9_.~:%-]{1,2048}$/;
const NODE_FIELDS = ['id', 'file_id', 'name', 'file_name', 'kind', 'mime_type', 'file_extension', 'file_size_bytes', 'state', 'access_kind', 'parent_directory_id', 'directory_id', 'library_file_category', 'library_artifact_type', 'record_creation_time', 'file_upload_time', 'created_at', 'updated_at', 'current_version_number', 'provider', 'library_provider', 'is_root', 'is_shared', 'gizmo_id', 'origination_thread_id', 'origination_message_id', 'last_used_at'];
const REF_FIELDS = ['id', 'entity_name', 'entity_type', 'entity_description', 'asset_pointer', 'thumbnail_asset_pointer', 'library_file_id', 'source_conversation_id', 'source_message_id', 'image_index', 'created_at', 'updated_at'];
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function invalid(message) { throw new DotError('INVALID_RESPONSE', message); }
function id(value, name = 'ID') { if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) fail(`${name} must be an ID returned by the API.`); return value; }
function text(value, name, max = 4096, empty = false) { if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\0\r\n]/u.test(value)) fail(`${name} must be a bounded string without NUL bytes or newlines.`); return value; }
function bool(value, name) { if (typeof value !== 'boolean') fail(`${name} must be a boolean.`); return value; }
function obj(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an API object.'); return value; }
function pick(value, fields) { obj(value); return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key) && (value[key] === null || typeof value[key] === 'boolean' || typeof value[key] === 'number' && Number.isFinite(value[key]) || typeof value[key] === 'string' && value[key].length <= 16384)).map(key => [key, value[key]])); }
function visible(value) { return value && !value.hidden && !value.is_hidden && !value.is_visually_hidden_from_conversation && !value.deleted_at && !value.metadata?.hidden && !value.metadata?.is_hidden && !value.metadata?.is_visually_hidden_from_conversation && (value.channel == null || ['final', 'commentary'].includes(value.channel)) && (value.metadata?.channel == null || ['final', 'commentary'].includes(value.metadata.channel)) && (value.recipient == null || value.recipient === 'all') && (value.metadata?.recipient == null || value.metadata.recipient === 'all'); }
function unavailableReceipt(value) {
  return !visible(value) || [value, value?.metadata].some(item => item != null
    && (['deleted', 'is_deleted', 'is_removed', 'internal', 'redacted'].some(key => item[key] === true)
      || item.deleted_at != null || item.trashed_at != null));
}
function node(value) {
  const result = pick(value, NODE_FIELDS);
  if (value.external_account != null) result.external_account = pick(value.external_account, ['key', 'name', 'email', 'display_name']);
  if (value.shared_by != null) result.shared_by = pick(value.shared_by, ['id', 'name', 'email']);
  return result;
}
function reference(value, expected) {
  if (!visible(value)) throw new DotError('NOT_VISIBLE', 'The reference image is not visible.');
  const result = pick(value, REF_FIELDS);
  if (typeof result.id !== 'string' || expected != null && result.id !== expected) invalid('Reference image identity did not match.');
  for (const key of ['asset_pointer', 'thumbnail_asset_pointer']) if (result[key] != null && !/^sediment:\/\/[A-Za-z0-9_-]+$/u.test(result[key])) delete result[key];
  result.hasContent = typeof value.content_url === 'string'; result.hasThumbnail = typeof value.thumbnail_url === 'string';
  return result;
}
function referenceMutation(value, { referenceImageId, entityName, entityType }) {
  const result = reference(value, referenceImageId);
  // Manual asset creation may deduplicate to an existing reference. The native
  // form then PATCHes its requested label/type; this CLI issues only one write.
  // Optional response fields may be absent, but explicit contradictory echoes
  // must never be returned as a successful mutation receipt.
  if ([['entity_name', entityName], ['entity_type', entityType]].some(([key, expected]) => Object.hasOwn(value, key) && value[key] !== expected)) {
    const details = { delivery: 'unknown' };
    if (ID.test(result.id) && !['.', '..'].includes(result.id)) details.referenceImageId = result.id;
    throw new DotError('INVALID_RESPONSE', 'The reference image response did not match the requested label or type. Check reference images before retrying the write.', details);
  }
  return result;
}
function page(value, project = node, cursorField = 'cursor') { obj(value); if (!Array.isArray(value.items) || value.items.length > 1000) invalid('Invalid or oversized result page.'); const cursor = value[cursorField] ?? null; if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 8192)) invalid('Invalid result cursor.'); return { items: value.items.filter(visible).map(project), cursor }; }
function paging(limit, cursor, max = 100) { if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) fail(`limit must be from 1 to ${max}.`); if (cursor != null) text(cursor, 'cursor', 8192); return { limit, ...(cursor == null ? {} : { cursor }) }; }
function provider(value, native = false) { if (!(native ? ALL_PROVIDERS : PROVIDERS).has(value)) fail('Unsupported Library provider.'); return value; }
function providers(values, native = false) { if (!Array.isArray(values) || values.length < 1 || values.length > 7) fail('providers must contain 1 to 7 providers.'); return [...new Set(values.map(value => provider(value, native)))]; }
function mounted(value, selected) {
  text(value, 'fileId', 4096);
  const patterns = [
    ['google_drive', /^external-gdrive:(?:account:[A-Za-z0-9_-]+:)?file:[A-Za-z0-9_-]{5,512}$/u],
    ['box', /^external-box:(?:account:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,512}:)?file:[1-9][0-9]{0,511}$/u],
    ['dropbox', /^external-dropbox:(?:account:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,512}:)?file:id:[A-Za-z0-9_:-]{1,253}$/u],
    ['sharepoint', /^external-sharepoint:(?:account:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+:)?file:\S+$/u],
    ['onedrive', /^external-onedrive:(?:account:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+:)?file:\S+$/u]
  ];
  const match = patterns.find(([, pattern]) => pattern.test(value));
  if (!match || selected != null && match[0] !== selected) fail('fileId must be a mounted file ID for the selected provider.');
  return match[0];
}
function externalAccounts(value, selected) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('externalAccountKeys must map providers to account-key arrays.');
  const out = {};
  for (const [key, values] of Object.entries(value)) {
    provider(key); if (selected && !selected.includes(key)) fail('Account-key filters must belong to selected providers.');
    if (!Array.isArray(values) || values.length > 100) fail('Account-key filters must be arrays with at most 100 keys.');
    out[key] = [...new Set(values.map(value => text(value, 'external account key', 512)))];
  }
  return out;
}
function sourceUrl(value, selected) {
  text(value, 'url', 16384); let url; try { url = new URL(value); } catch { fail('url must be an HTTPS provider URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[\s\\]/u.test(value)) fail('url must be an HTTPS provider URL without user information.');
  const host = url.hostname;
  const valid = selected === 'google_drive' ? ['docs.google.com', 'drive.google.com'].includes(host)
    : selected === 'box' ? host === 'app.box.com'
    : selected === 'dropbox' ? ['www.dropbox.com', 'dropbox.com', 'dl.dropboxusercontent.com'].includes(host)
    : selected === 'sharepoint' || selected === 'onedrive' ? host.endsWith('.sharepoint.com') || host === 'onedrive.live.com' || host === '1drv.ms' : false;
  if (!valid) fail('The URL host does not match the selected provider.'); return url;
}
function publicUrl(value, selected) { if (value == null) return null; try { const url = sourceUrl(value, selected); url.search = ''; url.hash = ''; return url.href; } catch { invalid('The API returned an unexpected provider URL.'); } }
function microsoftPreviewAvailable(value, selected) {
  if (value == null) return false;
  // Native CYu/nxs accepts printable-ASCII HTTPS previews only on a single
  // SharePoint tenant label. A personal -my tenant is valid for OneDrive.
  if (typeof value !== 'string' || value.length > 16384 || !value.startsWith('https://') || /[^\x21-\x7e]/u.test(value)
    || /[:@]/u.test(value.slice(8).split(/[/?#]/u, 1)[0])) invalid('The API returned an invalid Microsoft preview URL.');
  let url; try { url = sourceUrl(value, selected); } catch { invalid('The API returned an invalid Microsoft preview URL.'); }
  const tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.sharepoint\.com$/i.exec(url.hostname);
  if (!tenant || selected === 'sharepoint' && tenant[1].toLowerCase().endsWith('-my')) invalid('The API returned an invalid Microsoft preview URL.');
  return true;
}
function imageSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('source must contain content_url and optional original_content_url.');
  if (Object.keys(value).some(key => !['content_url', 'original_content_url'].includes(key))) fail('Unknown image source field.');
  const out = {};
  for (const key of ['content_url', 'original_content_url']) if (value[key] != null) {
    text(value[key], key, 16384); let url; try { url = new URL(value[key]); } catch { fail('Image source must be an HTTP(S) URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\]/u.test(value[key])) fail('Image source must be an HTTP(S) URL without user information.');
    out[key] = value[key];
  }
  if (!out.content_url) fail('source.content_url is required.'); return out;
}
function favorite(value) { const out = pick(value, ['favorite_id', 'library_file_id', 'directory_id', 'created_at', 'favorited_at', 'message_id']); if (value.target_ref?.type === 'library_file') out.target_ref = pick(value.target_ref, ['type', 'library_file_id']); return out; }
function capability(value, depth = 0) {
  if (depth > 3) invalid('Provider capabilities exceeded the supported nesting depth.');
  if (value === null || typeof value === 'boolean') return value;
  const out = pick(value, ['state', 'available', 'enabled', 'unavailable_reason', 'reason', 'provider', 'link_id', 'name']);
  if (value.capabilities && typeof value.capabilities === 'object') out.capabilities = Object.fromEntries(Object.entries(value.capabilities).slice(0, 100).filter(([key]) => /^[a-z][a-z_]{0,80}$/u.test(key)).map(([key, item]) => [key, capability(item, depth + 1)]));
  return out;
}
export function libraryProviderCapabilities() { return { scope: 'Entire signed-in account Library and linked providers.', supported: ['mounted-capabilities', 'mounted-search', 'cached-search', 'materialize', 'preview', 'resolve', 'file-metadata', 'global-search', 'shared-search', 'recents', 'reference-images', 'reference-thumbnails', 'image-favorites', 'conversation-favorites'], liveVerified: false, limitations: ['Provider previews return sanitized source links and availability, never signed preview URLs.', 'Reference thumbnails download only through verified first-party or anonymous signed-file routes.', 'Mutations are issued once without automatic retries.'] }; }

export class LibraryProviders {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('LibraryProviders requires a DotClient.'); this.transport = client.transport; this.library = new DotLibrary(client); }
  browse(options) { return this.library.browse(options); }
  librarySearch(options) { return this.library.search(options); }
  capabilities() { return libraryProviderCapabilities(); }
  async mountedCapabilities({ provider: selected, linkId, signal } = {}) {
    if (selected != null) provider(selected); if (linkId != null) id(linkId, 'linkId');
    const data = obj(await this.transport.request('GET', `${BASE}/mounted/capabilities`, { query: { provider: selected, link_id: linkId }, signal }));
    const result = {};
    if (data.providers != null) { result.providers = {}; for (const [key, value] of Object.entries(obj(data.providers))) if (CAPABILITY_PROVIDERS.has(key)) result.providers[key] = capability(value); }
    if (data.eligible_link_browsing != null) result.eligible_link_browsing = Object.fromEntries(Object.entries(obj(data.eligible_link_browsing)).filter(([key, value]) => CAPABILITY_PROVIDERS.has(key) && typeof value === 'boolean'));
    if (data.link_browsing != null) { result.link_browsing = {}; for (const [key, value] of Object.entries(obj(data.link_browsing))) if (CAPABILITY_PROVIDERS.has(key)) result.link_browsing[key] = Object.fromEntries(Object.entries(obj(value)).slice(0, 100).map(([key, value]) => [key, capability(value)])); }
    return result;
  }
  async oneDriveCapability({ signal } = {}) { return capability(await this.transport.request('GET', `${BASE}/mounted/capabilities/onedrive`, { signal })); }
  async search({ query, limit = 20, providers: selected, signal } = {}) {
    text(query, 'query'); const choices = providers(selected); paging(limit);
    return page(await this.transport.request('GET', `${BASE}/mounted/search`, { query: { q: query, limit, providers: choices }, signal, maxBytes: 2 * 1024 * 1024 }));
  }
  async searchCache({ query, limit = 20, provider: selected, signal } = {}) {
    text(query, 'query'); provider(selected); paging(limit);
    const data = await this.transport.request('GET', `${BASE}/mounted/search/cache`, { query: { q: query, limit, provider: selected }, signal, maxBytes: 2 * 1024 * 1024 });
    // The cache endpoint returns 204 for a miss. Transport represents an empty
    // successful 204 as {completed:true}, rather than the null used by the UI.
    const empty = data == null || data?.completed === true && Object.keys(data).length === 1;
    return empty ? { items: [], cursor: null, cacheMiss: true } : { ...page(data), cacheMiss: false };
  }
  async recents({ limit = 20, providers: selected = ['native'], externalAccountKeys, signal } = {}) {
    const choices = providers(selected, true), keys = externalAccounts(externalAccountKeys, choices); paging(limit);
    return page(await this.transport.request('GET', `${BASE}/recents`, { query: { limit, library_providers: choices, external_account_keys: keys === undefined ? undefined : JSON.stringify(keys) }, signal, maxBytes: 2 * 1024 * 1024 }));
  }
  async materialize({ fileId, name, mimeType = null, indexForRetrieval = false, signal } = {}) {
    mounted(fileId); text(name, 'name', 1024); if (mimeType !== null) text(mimeType, 'mimeType', 256); bool(indexForRetrieval, 'indexForRetrieval');
    const receipt = await this.transport.request('POST', `${BASE}/mounted/materialize`, { body: { file_id: fileId, name, mime_type: mimeType, index_for_retrieval: indexForRetrieval }, signal });
    let result;
    try {
      if (unavailableReceipt(receipt) || receipt.kind === 'directory') throw new Error();
      result = node(receipt);
      // Native download consumes a general Files ID, not another mounted or
      // Library ID. An unusable receipt cannot establish a completed import.
      if (typeof result.file_id !== 'string' || result.file_id.length > 1024 || !/^file[-_][A-Za-z0-9_-]+$/u.test(result.file_id)) throw new Error();
    } catch { throw new DotError('MUTATION_UNCONFIRMED', 'The API did not return a usable materialized file receipt. Inspect before retrying.', { delivery: 'unknown' }); }
    return result;
  }
  async fileMetadata({ provider: selected, fileId, signal } = {}) {
    provider(selected); mounted(fileId, selected);
    const value = await this.transport.request('POST', `${BASE}/mounted/${selected}/file_metadata`, { body: { file_id: fileId }, signal });
    if (value?.file_id !== fileId) invalid('Provider metadata did not match the requested file.'); return node(value);
  }
  async resolve({ provider: selected, url, nativeFileId, signal } = {}) {
    provider(selected);
    if (['box', 'google_drive'].includes(selected)) {
      if (url !== undefined) fail('Use nativeFileId to resolve a Google Drive or Box file.');
      id(nativeFileId, 'nativeFileId');
      return this.fileMetadata({ provider: selected, fileId: `external-${selected === 'google_drive' ? 'gdrive' : 'box'}:file:${nativeFileId}`, signal });
    }
    if (nativeFileId !== undefined) fail('Use url to resolve this provider.'); sourceUrl(url, selected);
    const value = await this.transport.request('POST', `${BASE}/mounted/${selected === 'onedrive' ? 'sharepoint' : selected}/resolve_file_url`, { body: { url }, signal });
    mounted(value?.file_id, selected); return node(value);
  }
  async preview({ provider: selected, fileId, signal } = {}) {
    provider(selected); mounted(fileId, selected);
    signal?.throwIfAborted();
    if (selected === 'google_drive' || selected === 'box') {
      const nativeFileId = fileId.slice(fileId.indexOf(':file:') + 6);
      const sourceUrl = selected === 'google_drive' ? `https://drive.google.com/file/d/${encodeURIComponent(nativeFileId)}/view` : `https://app.box.com/file/${encodeURIComponent(nativeFileId)}`;
      return { fileId, provider: selected, sourceUrl, previewAvailable: false };
    }
    const data = await this.transport.request('POST', `${BASE}/mounted/${selected === 'onedrive' ? 'sharepoint' : selected}/preview`, { body: { file_id: fileId }, signal });
    if (data?.file_id !== fileId) invalid('Provider preview did not match the requested file.');
    return { fileId, provider: selected, sourceUrl: publicUrl(selected === 'dropbox' ? data.shared_link_url : data.web_url, selected),
      previewAvailable: selected === 'dropbox' ? false : microsoftPreviewAvailable(data.preview_url, selected) };
  }
  async sharedSearch({ query, signal } = {}) {
    text(query, 'query'); return page(await this.transport.request('GET', `${BASE}/shared/search`, { query: { q: query, limit: 20 }, signal, maxBytes: 2 * 1024 * 1024 }));
  }
  async globalSearch({ query, queryId = randomUUID(), cursor, limit = 20, entrypoint = 'library_page', providers: selected = ['native', 'native_shared'], externalAccountKeys, lanes = ['image', 'document', 'folder'], directoryId, fileTypes, source, allowlistIds, includeSites = false, includePages = false, spaceSearchSource = 'space', includeSpaceFiles = true, ownership, pageSearchTarget, signal } = {}) {
    text(query, 'query'); id(queryId, 'queryId'); paging(limit, cursor); bool(includeSites, 'includeSites'); bool(includePages, 'includePages'); bool(includeSpaceFiles, 'includeSpaceFiles');
    if (!['library_page', 'composer'].includes(entrypoint)) fail('entrypoint must be library_page or composer.');
    let choices = providers(selected, true); const keys = externalAccounts(externalAccountKeys, choices);
    choices = choices.filter(value => keys?.[value]?.length !== 0);
    if (!Array.isArray(lanes) || !lanes.length || lanes.some(value => !['image', 'document', 'folder'].includes(value))) fail('lanes must contain image, document, or folder.');
    if (directoryId != null) id(directoryId, 'directoryId');
    if (fileTypes !== undefined && (!Array.isArray(fileTypes) || fileTypes.length > 20 || fileTypes.some(value => !['image', 'images', 'documents', 'spreadsheets', 'presentations', 'pdfs', 'pages', 'meetings'].includes(value)))) fail('Unsupported fileTypes filter.');
    if (source != null && !['uploaded', 'generated'].includes(source)) fail('source must be uploaded or generated.');
    if (allowlistIds !== undefined && (!Array.isArray(allowlistIds) || allowlistIds.length > 1000)) fail('allowlistIds must contain at most 1000 IDs.'); allowlistIds?.forEach(value => id(value));
    if (ownership != null && !['owned', 'shared', 'all'].includes(ownership)) fail('ownership must be owned, shared, or all.');
    if (!['files', 'space'].includes(spaceSearchSource)) fail('spaceSearchSource must be files or space.');
    if (pageSearchTarget !== undefined) text(pageSearchTarget, 'pageSearchTarget', 100);
    if (!choices.length || allowlistIds?.length === 0) return { items: [], cursor: null, partialResults: false };
    const filters = { lanes: [...new Set(lanes)], library_providers: choices, include_sites: includeSites, ...(keys === undefined ? {} : { external_account_keys: keys }), ...(directoryId === undefined ? {} : { directory_id: directoryId === 'external-gdrive:root' ? null : directoryId }), ...(fileTypes === undefined ? {} : { file_types: fileTypes }), ...(source == null ? {} : { source }), ...(allowlistIds === undefined ? {} : { allowlist_ids: [...new Set(allowlistIds)] }) };
    const requests = [{ type: 'library', filters }];
    if (includePages && choices.includes('native') && allowlistIds === undefined) {
      if (spaceSearchSource === 'files') { if (cursor == null) requests.push({ type: 'files', include_files: false }); }
      else requests.push({ type: 'space', filters: {}, ...(includeSpaceFiles ? {} : { include_files: false }), ...(pageSearchTarget === undefined ? {} : { page_search_target: pageSearchTarget }) });
    }
    const data = obj(await this.transport.request('POST', '/backend-api/global/search', { body: { query, query_id: queryId, cursor: cursor ?? null, limit, entrypoint, ...(ownership == null ? {} : { scope: { ownership } }), source_requests: requests }, signal, maxBytes: 4 * 1024 * 1024 }));
    // A hidden payload can contain a visible-looking outer snippet; omit the entire hit.
    if (Array.isArray(data.items)) data.items = data.items.filter(value => value.payload == null || visible(value.payload) && (value.payload.library_file == null || visible(value.payload.library_file)));
    const result = page(data, value => {
      const out = pick(value, ['id', 'title', 'snippet', 'source_type', 'update_time', 'create_time', 'score']);
      if (value.payload && visible(value.payload)) { out.payload = node(value.payload); Object.assign(out.payload, pick(value.payload, ['library_item_id', 'page_id', 'space_id', 'document_type'])); if (value.payload.library_file && visible(value.payload.library_file)) { out.payload.library_file = node(value.payload.library_file); Object.assign(out.payload.library_file, pick(value.payload.library_file, ['library_item_id'])); } }
      return out;
    });
    return { ...result, partialResults: data.partial_results === true, sourceStatuses: Array.isArray(data.source_statuses) ? data.source_statuses.slice(0, 100).map(value => pick(value, ['source_key', 'status', 'error_code'])) : [] };
  }
  async referenceImages({ limit = 50, cursor, signal } = {}) { return page(await this.transport.request('GET', `${BASE}/reference-images`, { query: paging(limit, cursor, 50), signal }), value => reference(value), 'next_cursor'); }
  async createReferenceImage({ requestKind = 'manual_asset', entityName, entityType, assetPointer, idempotencyKey = randomUUID(), entityDescription, imageIndex = 0, libraryFileId, sourceConversationId, sourceMessageId, suggestionMessageId, signal } = {}) {
    text(entityName, 'entityName', 256); if (!ENTITY_TYPES.has(entityType)) fail('Unsupported entityType.');
    let body;
    if (requestKind === 'manual_asset') {
      if (typeof assetPointer !== 'string' || !/^sediment:\/\/[A-Za-z0-9_-]+$/u.test(assetPointer)) fail('assetPointer must be a sediment file pointer.');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) fail('idempotencyKey must be a UUID.');
      if (imageIndex !== 0) fail('manual_asset imageIndex must be 0.');
      body = { asset_pointer: assetPointer, entity_name: entityName, entity_type: entityType, idempotency_key: idempotencyKey, image_index: 0, request_kind: requestKind };
    } else if (requestKind === 'suggestion_library') {
      text(entityDescription, 'entityDescription', 16384); for (const [label, value] of Object.entries({ libraryFileId, sourceConversationId, sourceMessageId, suggestionMessageId })) id(value, label);
      if (!Number.isSafeInteger(imageIndex) || imageIndex < 0 || imageIndex > 100) fail('imageIndex must be from 0 to 100.');
      if (assetPointer !== undefined) fail('suggestion_library does not accept assetPointer.');
      body = { entity_name: entityName, entity_type: entityType, entity_description: entityDescription, image_index: imageIndex, library_file_id: libraryFileId, source_conversation_id: sourceConversationId, source_message_id: sourceMessageId, suggestion_message_id: suggestionMessageId, request_kind: requestKind };
    } else fail('requestKind must be manual_asset or suggestion_library.');
    return referenceMutation(await this.transport.request('POST', `${BASE}/reference-images`, { body, signal, ...(requestKind === 'manual_asset' ? { idempotencyKey } : {}) }), { entityName, entityType });
  }
  async updateReferenceImage({ referenceImageId, entityName, entityType, signal } = {}) {
    id(referenceImageId, 'referenceImageId'); text(entityName, 'entityName', 256); if (!ENTITY_TYPES.has(entityType)) fail('Unsupported entityType.');
    return referenceMutation(await this.transport.request('PATCH', `${BASE}/reference-images/${encodeURIComponent(referenceImageId)}`, { body: { entity_name: entityName, entity_type: entityType }, signal }), { referenceImageId, entityName, entityType });
  }
  async deleteReferenceImage({ referenceImageId, confirm, signal } = {}) {
    id(referenceImageId, 'referenceImageId'); if (confirm !== referenceImageId) fail('confirm must exactly match referenceImageId.');
    const data = await this.transport.request('DELETE', `${BASE}/reference-images/${encodeURIComponent(referenceImageId)}`, { signal });
    if (data?.success === false) throw new DotError('MUTATION_UNCONFIRMED', 'The API did not confirm deletion.', { delivery: 'unknown' }); return { referenceImageId, deleted: true };
  }
  async referenceThumbnail({ referenceImageId, output, overwrite = false, signal } = {}) {
    id(referenceImageId, 'referenceImageId'); bool(overwrite, 'overwrite'); if (output !== undefined) text(output, 'output', 8192);
    const data = await this.transport.request('GET', `${BASE}/reference-images/${encodeURIComponent(referenceImageId)}/thumbnail_url`, { signal });
    if (data?.thumbnail_url == null) return { referenceImageId, available: false };
    const target = fileDownloadTarget(data.thumbnail_url);
    if (output === undefined) return { referenceImageId, available: true };
    const bytes = target.kind === 'signed' ? await this.transport.fetchSigned(target.url, { signal, maxBytes: 20 * 1024 * 1024 }) : await this.transport.requestBytes('GET', target.route, { query: target.query, signal, maxBytes: 20 * 1024 * 1024 });
    if (!Buffer.isBuffer(bytes) || bytes.length > 20 * 1024 * 1024) invalid('Invalid thumbnail bytes.');
    const path = await writePrivate(output, bytes, { overwrite, signal }); return { referenceImageId, available: true, path, sizeBytes: bytes.length };
  }
  async imageFavorite({ source, signal } = {}) {
    const body = imageSource(source); const result = favorite(await this.transport.request('POST', `${BASE}/image-favorites`, { body, signal }));
    if (typeof result.favorite_id !== 'string' || typeof result.library_file_id !== 'string') throw new DotError('MUTATION_UNCONFIRMED', 'The API did not return the saved image identity. Inspect before retrying.', { delivery: 'unknown' }); return result;
  }
  async imageFavoriteStatus({ sources, signal } = {}) {
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 50) fail('sources must contain 1 to 50 image sources.'); const body = { sources: sources.map(imageSource) };
    const data = await this.transport.request('POST', `${BASE}/image-favorites/status`, { body, signal });
    if (!Array.isArray(data) || data.length !== sources.length) invalid('Image favorite status count did not match.');
    return { items: data.map((value, index) => ({ index, ...favorite(value) })) };
  }
  async saveChatMessage() {
    throw new DotError('UNSUPPORTED', 'Library chat-message saving was removed because no working CLI workflow was verified.');
  }
  async conversationFavorites({ conversationId, limit = 20, cursor, signal } = {}) {
    id(conversationId, 'conversationId'); return page(await this.transport.request('GET', `${BASE}/favorites/conversations/${encodeURIComponent(conversationId)}`, { query: paging(limit, cursor, 100), signal }), favorite);
  }
}
