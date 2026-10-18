import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { DotLibrary } from './library.mjs';
import { fileDownloadTarget } from './files.mjs';
import { writePrivate } from './store.mjs';

// Contracts inspected in the installed client, including library-create-dialog,
// preview-d31e3d6e8ee2, library-deep-research-preview and app-initial (2026-10-18).
const BASE = '/backend-api/files/library';
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_INLINE = 1024 * 1024;
const FIELDS = ['id', 'kind', 'name', 'file_name', 'file_id', 'mime_type', 'file_extension', 'file_size_bytes', 'state', 'access_kind',
  'parent_directory_id', 'directory_id', 'library_file_category', 'library_artifact_type', 'record_creation_time', 'file_upload_time',
  'created_at', 'updated_at', 'trashed_at', 'current_version_number', 'is_root', 'is_shared', 'is_project', 'provider'];
const OMIT = /^(?:_.*|.*(?:token|authorization|cookie|secret|signed_url|download_url|content_url|thumbnail_url)|raw_messages|analysis|reasoning|reasoning_content|chain_of_thought|scratchpad|tool_response_metadata|meta|metadata|debug|internal|system_prompt|developer_prompt)$/i;
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function id(value, label = 'fileId') {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an ID returned by the API.`);
  return value;
}
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\0\r\n]/.test(value)) fail(`${label} must be a nonempty string of at most ${max} bytes without NUL or newlines.`);
  return value;
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid object.'); return value; }
function hidden(value) { return Boolean(value?.hidden || value?.is_hidden || value?.is_visually_hidden_from_conversation || value?.deleted_at
  || value?.metadata?.hidden || value?.metadata?.is_hidden || value?.metadata?.is_visually_hidden_from_conversation
  || (value?.channel != null && !['final', 'commentary'].includes(value.channel)) || (value?.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel))
  || (value?.recipient != null && value.recipient !== 'all') || (value?.metadata?.recipient != null && value.metadata.recipient !== 'all')); }
function file(value, expectedId) {
  object(value); if (typeof value.id !== 'string' || !ID.test(value.id) || (expectedId != null && value.id !== expectedId)) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid or mismatched file.');
  if (hidden(value)) throw new DotError('NOT_VISIBLE', 'The Library record is not visible.');
  return Object.fromEntries(FIELDS.filter(k => Object.hasOwn(value, k) && (value[k] === null || typeof value[k] === 'boolean' || typeof value[k] === 'number' && Number.isFinite(value[k]) || typeof value[k] === 'string' && value[k].length <= 8192)).map(k => [k, value[k]]));
}
function confirmId(value, confirmation, label = 'fileId') { id(value, label); if (confirmation !== value) fail(`confirm must exactly match ${label}.`); }
function accepted(value, fields = {}) { object(value); if (value.success === false) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not confirm this operation. Inspect its state before retrying.', { delivery: 'unknown' }); return { ...fields, status: value.success === true || value.completed === true ? 'completed' : 'accepted' }; }
function success(value, fields = {}) { if (value?.success !== true) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not confirm this operation. Inspect its state before retrying.', { delivery: 'unknown' }); return { ...fields, status: 'completed' }; }
function inline(value) { if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > MAX_INLINE) fail('content must be text of at most 1 MiB without NUL bytes.'); return value || '\n'; }
function maxBytes(value) { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES) fail('maxBytes must be from 1 byte to 100 MiB.'); return value; }
function outputOptions(output, overwrite) { text(output, 'output', 8192); if (typeof overwrite !== 'boolean') fail('overwrite must be true or false.'); }
function argsObject(value) { if (value == null) return {}; if (typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('args must be a JSON object.'); let encoded; try { encoded = JSON.stringify(value); } catch { fail('args must be JSON serializable.'); } if (Buffer.byteLength(encoded) > 64 * 1024 || encoded.includes('\\u0000')) fail('args must be a JSON object of at most 64 KiB without NUL.'); return JSON.parse(encoded); }
// Saved reports expose user-visible structured state. Do not forward hidden
// messages, model reasoning, credential fields, or bearer download links.
function visible(value, depth = 0, count = { value: 0 }) {
  if (++count.value > 20000 || depth > 32) throw new DotError('INVALID_RESPONSE', 'The saved report exceeds the supported structure bounds.');
  if (value == null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new DotError('INVALID_RESPONSE', 'The saved report contains an oversized field.');
    if (value.trim() === '::SKIP_COMPLETION::') return undefined;
    // URLs with signed query strings are credentials, even under unknown keys.
    if (/^https?:\/\//i.test(value) && /[?&](?:sig|signature|token|access_token|se|sv|st|skoid|sktid|skv|x-amz-[^=]+)=/i.test(value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map(v => visible(v, depth + 1, count)).filter(v => v !== undefined);
  object(value); if (hidden(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) if (!OMIT.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key)) {
    const projected = visible(item, depth + 1, count); if (projected !== undefined) result[key] = projected;
  }
  return result;
}
function regularFile(value) { if (value.kind === 'directory' || ['page', 'site', 'site_preview', 'saved_entity', 'chat_message_snapshot'].includes(value.library_artifact_type)) throw new DotError('UNSUPPORTED', 'This operation requires a regular Library file; Pages, sites, saved entities, and folders have separate lifecycle APIs.'); return value; }

function removableChatSnapshot(value, expectedId) {
  const current = file(value, expectedId);
  if (current.kind !== 'file' || current.library_artifact_type !== 'chat_message_snapshot' || value.saved_entity != null) {
    throw new DotError('UNSUPPORTED', 'Only a saved chat snapshot can use snapshot removal.');
  }
  // Native t_u/o_u, zU and c_u require a current native, non-root record;
  // c_u also identifies the library: parent namespace as shared content.
  if (value.id.startsWith('external-') || value.id.startsWith('pending:') || value.access_kind === 'shared' || value.access_kind === 'mounted'
    || value.is_shared === true || value.shared_by != null || value.direct_share_id != null || value.has_opened_shared_membership === true
    || value.provider != null && value.provider !== 'native' || value.is_root === true || value.id === 'library:collection:shared-with-me'
    || value.parent_directory_id?.startsWith?.('library:') || value.id.startsWith('library:shared-directory:')) {
    throw new DotError('UNSUPPORTED', 'External, shared, root, and pending Library records cannot use snapshot removal.');
  }
  if (value.deleted_at != null || value.trashed_at != null || value.is_deleted === true || value.is_trashed === true
    || value.is_user_visible === false || value.metadata?.deleted_at != null || value.metadata?.trashed_at != null
    || value.metadata?.is_user_visible === false || value.pendingResponseFavorite === true) {
    throw new DotError('NOT_VISIBLE', 'The saved chat snapshot is not a current visible Library record.');
  }
  return current;
}

// Native actions.R/Te and app-shared h8/Lhn: registration is only the final
// step of a provider upload. Native/room uploads already create their entry.
function externalUploadParent(value) {
  if (typeof value !== 'string' || value.length > 4096 || Buffer.byteLength(value) > 4096 || /[\x00-\x20\x7f]/u.test(value)) fail('parentDirectoryId must be an eligible external-provider upload folder; native uploads use library upload.');
  const match = /^external-(gdrive|box|dropbox|sharepoint):(?:account:((?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+):)?(?:(folder):(\S+)|(root))$/u.exec(value);
  if (!match) fail('parentDirectoryId must be an eligible external-provider upload folder.');
  const [, provider, account, , nativeId, root] = match;
  if (account != null) {
    if (provider === 'gdrive') { if (!/^[A-Za-z0-9_-]+$/u.test(account)) fail('Invalid provider account key.'); }
    else {
      let decoded; try { decoded = decodeURIComponent(account); } catch { fail('Invalid provider account key.'); }
      const encoded = encodeURIComponent(decoded).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      if (!decoded || decoded.trim() !== decoded || /[\x00-\x1f\x7f]/u.test(decoded) || Buffer.byteLength(decoded) > 512 || account.length > 1536 || encoded !== account) fail('Invalid provider account key.');
    }
  }
  if (provider === 'gdrive' && root && account == null || provider === 'box' && !root && !/^[1-9][0-9]*$/u.test(nativeId) || provider === 'dropbox' && !root && !/^id:[A-Za-z0-9_:-]+$/u.test(nativeId)) fail('The provider destination is not eligible for uploads.');
  if (provider === 'sharepoint') {
    const decode = (part, limit) => {
      if (typeof part !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${limit}}$`, 'u').test(part)) return null;
      const bytes = Buffer.from(part, 'base64url'); return bytes.toString('base64url') === part ? bytes.toString('latin1') : null;
    };
    const opaque = part => /^[A-Za-z0-9._!~:-]{1,512}$/u.test(decode(part, 683) ?? '');
    const site = part => {
      const decoded = decode(part, 436); if (decoded == null) return false;
      const [host, first, second, ...rest] = decoded.split(','), guid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
      return rest.length === 0 && host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) && guid.test(first ?? '') && guid.test(second ?? '');
    };
    const [version, kind, ...parts] = (nativeId ?? '').split(':');
    const count = kind === 'drive' ? 1 : kind === 'item' ? 2 : 0;
    if (!count || !['v1', 'v2'].includes(version) || parts.length !== count + Number(version === 'v2') || version === 'v2' && !site(parts[0]) || !(version === 'v2' ? parts.slice(1) : parts).every(opaque)) fail('SharePoint uploads require a canonical drive or item folder destination.');
  }
  return { id: value, provider: provider === 'gdrive' ? 'google_drive' : provider, account };
}
function externalReceiptMatches(value, destination) {
  if (!value.startsWith('external-')) return true;
  const match = /^external-(gdrive|box|dropbox|sharepoint|onedrive):(?:account:([^:]+):)?file:(.+)$/u.exec(value);
  if (!match || (match[1] === 'gdrive' ? 'google_drive' : match[1]) !== destination.provider
    || match[2] != null && destination.account != null && match[2] !== destination.account) return false;
  if (match[2] != null && !(match[1] === 'gdrive' ? /^[A-Za-z0-9_-]+$/u : /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,512}$/u).test(match[2])) return false;
  // Preserve opaque Microsoft IDs; the other native provider formats have
  // an explicit file-tail contract in the installed client.
  return match[1] === 'gdrive' ? /^[A-Za-z0-9_-]{5,512}$/u.test(match[3])
    : match[1] === 'box' ? /^[1-9][0-9]{0,511}$/u.test(match[3])
    : match[1] === 'dropbox' ? /^id:[A-Za-z0-9_:-]{1,253}$/u.test(match[3]) : true;
}

export function libraryContentCapabilities() { return { scope: 'Signed-in account Library content and folders', supported: ['create-directory', 'delete-directory', 'register-upload', 'create-inline', 'update-inline', 'download', 'content', 'thumbnail', 'page-attachment-content', 'page-attachment-download', 'recents', 'opened', 'plan-summary', 'deep-research', 'deep-research-state', 'deep-research-images', 'deep-research-export', 'permanent-delete', 'delete-batch', 'empty-trash'],
  limits: { inlineBytes: MAX_INLINE, downloadBytes: MAX_BYTES, batchFiles: 25 },
  notes: ['Writes are never retried automatically.', 'Permanent file and folder deletion require exact ID confirmation; empty-trash requires EMPTY LIBRARY TRASH.', 'Saved report export returns filtered structured output; --output saves that response as private JSON.', 'Download destinations never receive signed URLs in command output.'], liveVerified: false }; }

export class LibraryContent {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('LibraryContent requires a DotClient.'); this.client = client; this.transport = client.transport; this.library = new DotLibrary(client); }
  capabilities() { return libraryContentCapabilities(); }
  async createDirectory({ name, parentDirectoryId = null, signal } = {}) {
    text(name, 'name'); if (parentDirectoryId !== null) id(parentDirectoryId, 'parentDirectoryId');
    return file(await this.transport.request('POST', `${BASE}/directories`, { body: { name: name.trim(), parent_directory_id: parentDirectoryId }, signal, maxBytes: 256 * 1024 }));
  }
  async deleteDirectory({ directoryId, confirm, signal } = {}) {
    confirmId(directoryId, confirm, 'directoryId');
    // Folder deletion has no soft-delete flag in the observed contract.
    return success(await this.transport.request('DELETE', `${BASE}/directories/${encodeURIComponent(directoryId)}`, { signal, maxBytes: 64 * 1024 }), { directoryId });
  }
  async registerUpload({ fileId, fileName, mimeType = null, parentDirectoryId = null, signal } = {}) {
    if (typeof fileId !== 'string' || fileId.length > 1024 || !/^file[-_][A-Za-z0-9_-]+$/u.test(fileId)) fail('register-upload requires a general Files upload ID from an external-provider upload; native and room uploads already have a Library entry.');
    text(fileName, 'fileName'); const destinationIdentity = externalUploadParent(parentDirectoryId);
    if (mimeType !== null && (typeof mimeType !== 'string' || mimeType.length > 200 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/u.test(mimeType))) fail('mimeType must be a MIME type.');
    const capabilities = object(await this.transport.request('GET', `${BASE}/mounted/capabilities`, { query: { provider: destinationIdentity.provider }, signal, maxBytes: 256 * 1024 }));
    if (capabilities.providers?.[destinationIdentity.provider]?.capabilities?.library_browsing?.state !== 'available') throw new DotError('UNSUPPORTED', 'The external provider is not currently available for Library browsing. No registration was sent.');
    const path = object(await this.transport.request('GET', `${BASE}/directories/path`, { query: { directory_id: parentDirectoryId }, signal, maxBytes: 256 * 1024 }));
    const destination = Array.isArray(path.items) && path.items.length <= 100 ? path.items.at(-1) : null;
    if (!destination || destination.id !== parentDirectoryId || hidden(destination) || destination.kind != null && destination.kind !== 'directory' || destination.deleted_at || destination.trashed_at) throw new DotError('INVALID_RESPONSE', 'The external upload destination is not an accessible current folder. No registration was sent.');
    signal?.throwIfAborted();
    const result = await this.transport.request('POST', `${BASE}/files`, { body: { parent_directory_id: parentDirectoryId, file_id: fileId, file_name: fileName, mime_type: mimeType }, signal, maxBytes: 256 * 1024 });
    // Native registration may return only {id}. Do not demand optional fields,
    // but every identity field that is present must agree with this upload.
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.~:%-]{0,4095}$/u.test(result.id)
      || hidden(result) || result.trashed_at != null || result.kind === 'directory' || result.file_id != null && result.file_id !== fileId
      || ['parent_directory_id', 'directory_id'].some(key => result[key] != null && result[key] !== parentDirectoryId)
      || ['file_name', 'name'].some(key => result[key] != null && result[key] !== fileName)
      || !externalReceiptMatches(result.id, destinationIdentity)) {
      throw new DotError('INVALID_RESPONSE', 'Provider registration returned an unexpected file identity; inspect it before retrying.', { delivery: 'unknown' });
    }
    return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(result, key) && (result[key] === null || typeof result[key] === 'boolean' || typeof result[key] === 'number' && Number.isFinite(result[key]) || typeof result[key] === 'string' && result[key].length <= 8192)).map(key => [key, result[key]]));
  }
  async createInline({ content, fileName, createKey = randomUUID(), directoryId = null, signal } = {}) {
    const value = inline(content); text(fileName, 'fileName'); if (directoryId !== null) id(directoryId, 'directoryId'); if (typeof createKey !== 'string' || !UUID.test(createKey)) fail('createKey must be a UUID.');
    const result = file(await this.transport.request('POST', `${BASE}/files/inline-content`, { body: { content: value, file_name: fileName, create_key: createKey, directory_id: directoryId, library_file_info: { library_artifact_type: 'writing_block' } }, signal, maxBytes: 256 * 1024 }));
    return { ...result, createKey };
  }
  async updateInline({ fileId, content, fileName, confirm, signal } = {}) {
    confirmId(fileId, confirm); const value = inline(content); text(fileName, 'fileName');
    return file(await this.transport.request('PATCH', `${BASE}/files/${encodeURIComponent(fileId)}`, { body: { inline_content: value, file_name: fileName }, signal, maxBytes: 256 * 1024 }), fileId);
  }
  async recents({ limit = 50, providers = ['native'], externalAccountKeys, signal } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('limit must be 1 to 100.');
    const supported = new Set(['native', 'google_drive', 'dropbox', 'sharepoint', 'onedrive', 'box']);
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 6 || providers.some(p => !supported.has(p))) fail('providers must contain recognized Library providers.');
    if (externalAccountKeys !== undefined && (!externalAccountKeys || typeof externalAccountKeys !== 'object' || Array.isArray(externalAccountKeys) || Object.entries(externalAccountKeys).some(([provider, keys]) => !supported.has(provider) || !Array.isArray(keys) || keys.length > 100 || keys.some(k => typeof k !== 'string' || !k || k.length > 1024 || /[\0\r\n]/.test(k))))) fail('externalAccountKeys must map recognized provider names to bounded arrays of account key strings.');
    const data = object(await this.transport.request('GET', `${BASE}/recents`, { query: { limit, library_providers: [...new Set(providers)], external_account_keys: externalAccountKeys === undefined ? undefined : JSON.stringify(externalAccountKeys) }, signal, maxBytes: 2 * 1024 * 1024 }));
    if (!Array.isArray(data.items) || data.items.length > 1000) throw new DotError('INVALID_RESPONSE', 'The Library returned an invalid recent-file list.');
    return { items: data.items.filter(item => !hidden(item)).map(item => file(item)), cursor: null };
  }
  async markOpened({ fileId, signal } = {}) { id(fileId); return accepted(await this.transport.request('POST', `${BASE}/files/${encodeURIComponent(fileId)}/opened`, { signal, maxBytes: 64 * 1024 }), { fileId }); }
  async _saveAsset({ fileId, output, overwrite = false, maxBytes: limit = MAX_BYTES, signal, kind, range, pageId } = {}) {
    id(fileId); outputOptions(output, overwrite); maxBytes(limit); if (pageId !== undefined) id(pageId, 'pageId'); if (kind === 'thumbnail' && pageId !== undefined) fail('Page attachment thumbnails are not exposed by this Library endpoint.');
    // The native client materializes provider files before downloading their
    // returned general Files ID. Do not turn a read into that implicit write.
    if (kind !== 'thumbnail' && /^external-(?:gdrive|box|dropbox|sharepoint|onedrive):/u.test(fileId)) {
      throw new DotError('UNSUPPORTED', 'Mounted provider bytes require explicit materialization. Use library providers preview for a source link, or library providers materialize and then library download with its returned file_id.');
    }
    if (range !== undefined && (typeof range !== 'string' || !/^bytes=\d+-\d+$/.test(range))) fail('range must be bytes=START-END.');
    if (range !== undefined) { const [start, end] = range.slice(6).split('-').map(Number); if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > limit) fail('range must be ordered and fit within maxBytes.'); }
    const options = { signal, maxBytes: limit, ...(range === undefined ? {} : { range, includeResponse: true }) };
    let response;
    if (pageId !== undefined) {
      response = await this.transport.requestBytes('GET', `${BASE}/files/${encodeURIComponent(fileId)}/${kind === 'content' ? 'content_redirect' : 'download_redirect'}`, {
        ...options, headers: { 'X-OpenAI-Attach-Auth': '1' }, query: { page_id: pageId, ...(kind === 'download' ? { start_download: true } : {}) },
      });
    } else {
      const route = `${BASE}/files/${encodeURIComponent(fileId)}/${kind === 'content' ? 'content_url' : kind === 'thumbnail' ? 'thumbnail_url' : 'download_url'}`;
      let data, sourceId = fileId, sourceKey = kind === 'content' ? 'content_url' : kind === 'thumbnail' ? 'thumbnail_url' : 'download_url';
      if (kind !== 'thumbnail' && /^file[-_][A-Za-z0-9_-]+$/u.test(fileId)) {
        // Materialization returns a general Files ID rather than a Library ID.
        // The installed client downloads that ID directly, without registering
        // another Library entry or involving a messaging room.
        sourceKey = 'download_url';
        data = object(await this.transport.request('GET', `/backend-api/files/download/${encodeURIComponent(fileId)}`, {
          query: kind === 'content' ? { inline: 'true' } : undefined, signal, maxBytes: 64 * 1024,
        }));
      } else try {
        data = object(await this.transport.request('GET', route, { signal, maxBytes: 64 * 1024 }));
      } catch (error) {
        if (kind === 'thumbnail' || error?.code !== 'HTTP_ERROR' || error?.details?.status !== 404) throw error;
        // Legacy Library nodes (including messaging uploads) expose their
        // underlying file ID through /node and use the general file downloader.
        const current = regularFile(await this.library.get({ fileId, signal }));
        if (typeof current.file_id !== 'string' || !ID.test(current.file_id) || current.file_id === fileId) throw error;
        sourceId = current.file_id; sourceKey = 'download_url';
        data = object(await this.transport.request('GET', `/backend-api/files/download/${encodeURIComponent(sourceId)}`, {
          query: kind === 'content' ? { inline: 'true' } : undefined, signal, maxBytes: 64 * 1024,
        }));
      }
      if (data.id != null && data.id !== sourceId || data.file_id != null && data.file_id !== sourceId || data.library_file_id != null && data.library_file_id !== fileId) throw new DotError('INVALID_RESPONSE', 'The asset response did not match the requested file.');
      const target = fileDownloadTarget(data[sourceKey]);
      if (target.route === `${BASE}/content_download` && target.query.library_file_id !== fileId) throw new DotError('INVALID_RESPONSE', 'The signed Library download URL targets another file.');
      signal?.throwIfAborted();
      response = target.kind === 'signed' ? await this.transport.fetchSigned(target.url, options) : await this.transport.requestBytes('GET', target.route, { ...options, query: target.query });
    }
    const bytes = range === undefined ? response : response?.body;
    if (range !== undefined) {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response?.headers?.get('content-range') ?? '');
      const [start, end] = range.slice(6).split('-').map(Number);
      if (response?.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) > end || Number(match[2]) < start
        || (match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])))
        || Number(match[2]) !== end && (match[3] === '*' || Number(match[2]) + 1 !== Number(match[3]))
        || bytes?.byteLength !== Number(match[2]) - start + 1) throw new DotError('INVALID_RANGE_RESPONSE', 'The server did not honor the requested byte range. No file was saved.');
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) throw new DotError('INVALID_RESPONSE', 'The asset response was not bounded file bytes.');
    signal?.throwIfAborted(); const path = await writePrivate(output, bytes, { overwrite, signal });
    return { fileId, kind, path, sizeBytes: bytes.byteLength, ...(range === undefined ? {} : { range }) };
  }
  download(options) { return this._saveAsset({ ...options, kind: 'download' }); }
  content(options) { return this._saveAsset({ ...options, kind: 'content' }); }
  thumbnail(options) { return this._saveAsset({ ...options, kind: 'thumbnail' }); }
  async planSummary({ fileId, signal } = {}) { id(fileId); const data = object(await this.transport.request('GET', `${BASE}/files/${encodeURIComponent(fileId)}/plan-summary`, { signal, maxBytes: 4 * 1024 * 1024 })); const result = visible(data); if (result === undefined) throw new DotError('NOT_VISIBLE', 'The plan summary is not visible.'); return { ...result, fileId }; }
  async deepResearch({ fileId, signal } = {}) { id(fileId); const data = object(await this.transport.request('GET', `${BASE}/files/${encodeURIComponent(fileId)}/deep-research`, { signal, maxBytes: 4 * 1024 * 1024 })); const result = visible(data); if (result === undefined) throw new DotError('NOT_VISIBLE', 'The saved report is not visible.'); return { ...result, fileId }; }
  async _reportTool(name, { fileId, args = {}, signal } = {}) {
    if (!['get_state', 'get_inline_images', 'export'].includes(name)) fail('Unsupported saved-report tool.');
    id(fileId); const body = { args: argsObject(args) };
    const data = object(await this.transport.request('POST', `${BASE}/files/${encodeURIComponent(fileId)}/deep-research/tools/${name}`, { body, signal, maxBytes: 4 * 1024 * 1024 }));
    if (data.isError === true) throw new DotError('REPORT_TOOL_ERROR', 'The saved-report tool returned an error.');
    const result = visible(data.structuredContent ?? {}); if (result === undefined) throw new DotError('NOT_VISIBLE', 'The saved-report state is not visible.');
    return { fileId, tool: name, structuredContent: result };
  }
  deepResearchState(options) { return this._reportTool('get_state', options); }
  deepResearchImages(options) { return this._reportTool('get_inline_images', options); }
  async deepResearchExport({ output, overwrite = false, ...options } = {}) { if (output !== undefined) outputOptions(output, overwrite); const result = await this._reportTool('export', options); if (output === undefined) return result; const path = await writePrivate(output, `${JSON.stringify(result, null, 2)}\n`, { overwrite, signal: options.signal }); return { fileId: result.fileId, tool: 'export', format: 'json', path }; }
  async permanentDelete({ fileId, confirm, signal } = {}) {
    confirmId(fileId, confirm); signal?.throwIfAborted();
    const current = await this.library.get({ fileId, includeTrashed: true, signal });
    if (current.library_artifact_type === 'chat_message_snapshot') {
      signal?.throwIfAborted();
      // Native Le/Nvu remove the saved snapshot, not its source message. Read
      // raw metadata again because the general Library projection omits some
      // sharing/deletion flags needed before this type-specific operation.
      let raw;
      const route = `${BASE}/files/${encodeURIComponent(fileId)}`;
      try { raw = await this.transport.request('GET', route, { signal, maxBytes: 256 * 1024 }); }
      catch (error) {
        if (error?.code !== 'HTTP_ERROR' || error?.details?.status !== 404) throw error;
        signal?.throwIfAborted();
        raw = await this.transport.request('GET', `${route}/node`, { signal, maxBytes: 256 * 1024 });
      }
      removableChatSnapshot(raw, fileId);
      signal?.throwIfAborted();
      return success(await this.transport.request('DELETE', `${BASE}/files/${encodeURIComponent(fileId)}`, { query: { soft_delete: false }, signal, maxBytes: 64 * 1024 }), { fileId });
    }
    regularFile(current); signal?.throwIfAborted();
    return success(await this.transport.request('DELETE', `${BASE}/files/${encodeURIComponent(fileId)}`, { query: { soft_delete: false, file_id: current.file_id, parent_directory_id: current.parent_directory_id ?? current.directory_id, file_name: current.file_name ?? current.name }, signal, maxBytes: 64 * 1024 }), { fileId });
  }
  async deleteBatch({ fileIds, confirmFileIds, signal } = {}) {
    if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 25 || new Set(fileIds).size !== fileIds.length) fail('fileIds must contain 1 to 25 distinct IDs.'); fileIds.forEach(value => id(value));
    if (!Array.isArray(confirmFileIds) || confirmFileIds.length !== fileIds.length || new Set(confirmFileIds).size !== fileIds.length || fileIds.some(value => !confirmFileIds.includes(value))) fail('confirmFileIds must exactly match the selected fileIds.');
    const records = []; for (const fileId of fileIds) {
      const record = regularFile(await this.library.get({ fileId, signal }));
      if (typeof record.file_id !== 'string' || !ID.test(record.file_id)) throw new DotError('INVALID_RESPONSE', 'A selected Library file has no valid underlying upload ID. No deletion was sent.');
      records.push(record);
    }
    const data = object(await this.transport.request('POST', `${BASE}/files/delete-batch`, { body: { files: records.map(item => ({ library_file_id: item.id, file_id: item.file_id, parent_directory_id: item.parent_directory_id ?? item.directory_id, file_name: item.file_name ?? item.name })) }, signal, maxBytes: 256 * 1024 }));
    if (!Array.isArray(data.files) || data.files.length !== fileIds.length || new Set(data.files.map(item => item?.library_file_id)).size !== fileIds.length || data.files.some(item => !fileIds.includes(item?.library_file_id) || typeof item.success !== 'boolean')) throw new DotError('MUTATION_UNCONFIRMED', 'The batch response did not account for every selected file. Inspect Library state before retrying.', { delivery: 'unknown' });
    return { files: data.files.map(item => ({ fileId: item.library_file_id, success: item.success })), status: data.files.every(item => item.success) ? 'completed' : 'partial', deletion: 'soft' };
  }
  async emptyTrash({ confirm, signal } = {}) {
    if (confirm !== 'EMPTY LIBRARY TRASH') fail('confirm must be EMPTY LIBRARY TRASH. This permanently removes account-wide Library trash.');
    const data = object(await this.transport.request('DELETE', `${BASE}/trash`, { signal, maxBytes: 64 * 1024 }));
    if (!Number.isSafeInteger(data.deleted_count) || data.deleted_count < 0 || !Number.isSafeInteger(data.failed_count) || data.failed_count < 0) throw new DotError('MUTATION_UNCONFIRMED', 'The Library did not return valid trash deletion counts. Inspect trash before retrying.', { delivery: 'unknown' });
    return { deletedCount: data.deleted_count, failedCount: data.failed_count, status: data.failed_count === 0 ? 'completed' : 'partial' };
  }
}
