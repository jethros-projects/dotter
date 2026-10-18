import { DotError } from './errors.mjs';

// Native saved-entity data, product-favorite-action and folder-menu contracts
// inspected in the installed app (2026-10-18). This is account Library state.
const BASE = '/backend-api/chat/frontend/v1/saved-entities';
const LIBRARY = '/backend-api/files/library';
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const LOCAL_CATEGORIES = new Set(['local_business', 'restaurant', 'hotel', 'point_of_interest']);
const VARIANT_OPTIONS_PATH = 'sidebar_params.extra_params.product_lookup_key.variant_options_query';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function invalid(message) { throw new DotError('INVALID_RESPONSE', message); }
function id(value, label = 'ID') { if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an API ID.`); return value; }
function text(value, label, max = 4096) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} must be a bounded, nonempty string without control characters.`); return value.trim(); }
function keys(value, allowed, label) { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} must be an object containing only supported fields.`); }
function url(value, label) { text(value, label, 16384); let parsed; try { parsed = new URL(value); } catch { fail(`${label} must be an HTTP(S) URL.`); } if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\s\\]/.test(value)) fail(`${label} must be an HTTP(S) URL without user information.`); return value; }
function variantOptions(value, reject) {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).length > 100 || Object.entries(value).some(([key, item]) => !key || key.length > 1024 || key === '__proto__' || typeof item !== 'string' || item.length > 4096 || /[\x00-\x1f\x7f]/.test(key + item))) reject('productLookupKey.variant_options_query must be a bounded string map or null.');
  return { ...value };
}
function productLookup(value) {
  if (value === null) return null;
  keys(value, ['data', 'version', 'last_variant_selection_group_id', 'variant_options_query'], 'productLookupKey');
  const result = {};
  for (const key of ['data', 'version', 'last_variant_selection_group_id']) if (own(value, key)) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 16384 || /[\x00-\x1f\x7f]/.test(value[key]))) fail(`productLookupKey.${key} must be a bounded string or null.`);
    result[key] = value[key];
  }
  if (own(value, 'variant_options_query')) {
    result.variant_options_query = variantOptions(value.variant_options_query, fail);
  }
  return result;
}
function visible(value) { return record(value) && !value.hidden && !value.is_hidden && !value.is_visually_hidden_from_conversation && !value.deleted_at && !value.metadata?.hidden && !value.metadata?.is_hidden && !value.metadata?.is_visually_hidden_from_conversation && (value.channel == null || ['final', 'commentary'].includes(value.channel)) && (value.metadata?.channel == null || ['final', 'commentary'].includes(value.metadata.channel)) && (value.recipient == null || value.recipient === 'all') && (value.metadata?.recipient == null || value.metadata?.recipient === 'all'); }
function bounded(value, depth = 0, path = '') {
  if (depth > 8) invalid('The saved target is too deeply nested.');
  if (path === VARIANT_OPTIONS_PATH) return variantOptions(value, invalid);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 16384 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => bounded(item, depth + 1, `${path}[]`));
  if (record(value) && Object.keys(value).length <= 100 && Object.keys(value).every(key => /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(key))) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, depth + 1, path ? `${path}.${key}` : key)]));
  invalid('The saved target contains unsupported or oversized data.');
}
function serverTarget(value) {
  if (!record(value) || !record(value.sidebar_params) || typeof value.sidebar_params.name !== 'string' || !value.sidebar_params.name || typeof value.sidebar_params.category !== 'string' || !value.sidebar_params.category || (value.identity != null && (!record(value.identity) || typeof value.identity.namespace !== 'string' || !value.identity.namespace || typeof value.identity.key !== 'string' || !value.identity.key))) invalid('The service returned an invalid saved target.');
  const out = bounded(value);
  if (Buffer.byteLength(JSON.stringify(out)) > 65536) invalid('The saved target exceeds 64 KiB.');
  return out;
}
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])); return value; }
function targetKey(value) { return JSON.stringify(stable(value.identity ?? { ...value.sidebar_params, multi_message_mode: value.sidebar_params.multi_message_mode ?? true, extra_params: value.sidebar_params.extra_params ?? null })); }
function targetSummary(value) { return { identity: value.identity == null ? null : { namespace: value.identity.namespace, key: value.identity.key }, name: value.sidebar_params.name, category: value.sidebar_params.category }; }
function entity(value, expectedTarget) {
  if (!visible(value)) invalid('The saved entity is not visible.');
  const target = serverTarget(value.saved_target);
  if (expectedTarget && targetKey(target) !== targetKey(expectedTarget)) invalid('The saved entity does not match the requested target.');
  try { id(value.library_file_id, 'libraryFileId'); if (value.library_directory_id != null) id(value.library_directory_id, 'directoryId'); } catch { invalid('The saved entity has invalid Library IDs.'); }
  return { libraryFileId: value.library_file_id, directoryId: value.library_directory_id ?? null, target: targetSummary(target) };
}

/** Construct only the product/local-business requests observed in native UI. */
export function buildSavedEntityRequest(spec) {
  keys(spec, ['kind', 'name', 'productId', 'url', 'query', 'provider', 'productLookupKey', 'rewrittenQueries', 'imageUrl', 'category', 'entityKey', 'entityLookupId', 'businessId', 'origin'], 'spec');
  const name = text(spec.name, 'name', 1024); let identity = null, category, extra;
  if (spec.kind === 'product') {
    if (['category', 'entityKey', 'entityLookupId', 'businessId'].some(key => own(spec, key))) fail('Product specs cannot contain local-business fields.');
    const productId = text(spec.productId, 'productId', 1024); category = 'product_rationale_and_reviews'; identity = { namespace: 'product', key: productId };
    extra = { ...(spec.productLookupKey === undefined ? {} : { product_lookup_key: productLookup(spec.productLookupKey) }),
      saved_product_shell: { id: productId, url: url(spec.url, 'url'), query: text(spec.query, 'query', 4096), provider: text(spec.provider, 'provider', 256) } };
    if (spec.rewrittenQueries !== undefined) {
      if (!Array.isArray(spec.rewrittenQueries) || spec.rewrittenQueries.length < 1 || spec.rewrittenQueries.length > 100) fail('rewrittenQueries must contain 1 to 100 strings.');
      extra.rewritten_queries = spec.rewrittenQueries.map(value => text(value, 'rewritten query', 4096));
    }
  } else if (spec.kind === 'local-business') {
    if (['productId', 'url', 'query', 'productLookupKey', 'rewrittenQueries'].some(key => own(spec, key))) fail('Local-business specs cannot contain product fields.');
    category = spec.category ?? 'local_business'; if (!LOCAL_CATEGORIES.has(category)) fail('Unsupported local-business category.'); extra = {};
    for (const [source, target] of [['entityKey', 'entity_key'], ['entityLookupId', 'entity_lookup_id'], ['provider', 'provider'], ['businessId', 'business_id']]) if (spec[source] !== undefined) extra[target] = text(spec[source], source, 4096);
    if (spec.entityLookupId !== undefined) { if (!/^lbe1_[A-Za-z0-9_-]{24}$/.test(spec.entityLookupId)) fail('entityLookupId must be a native lbe1 identifier.'); identity = { namespace: 'local_business', key: spec.entityLookupId }; }
    else if (spec.provider !== undefined && spec.businessId !== undefined) identity = { namespace: extra.provider, key: extra.business_id };
    else if (spec.provider !== undefined || spec.businessId !== undefined) fail('provider and businessId must be supplied together.');
    if (!Object.keys(extra).length) extra = null;
  } else fail('kind must be product or local-business.');
  const request = { saved_target: { identity, sidebar_params: { name, category, multi_message_mode: true, extra_params: extra } }, display_data: { name, image_url: spec.imageUrl == null ? null : url(spec.imageUrl, 'imageUrl') } };
  if (spec.origin !== undefined) { keys(spec.origin, ['conversationId', 'messageId'], 'origin'); request.origin = { conversation_id: id(spec.origin.conversationId, 'conversationId'), message_id: id(spec.origin.messageId, 'messageId') }; }
  serverTarget(request.saved_target); return request;
}

export function savedEntityCapabilities() { return { scope: 'Signed-in account Library saved products and places.', supported: ['status', 'get', 'save', 'remove', 'move'], constructors: ['product', 'local-business'], limits: { statusTargets: 100, targetBytes: 65536 }, limitations: ['Creation accepts only the product and local-business constructors observed in the native app.', 'Existing targets are hydrated from bounded native Library folder or favorite pages and matched to the exact requested Library ID before removal or moving.', 'Mutations are sent once without automatic retries.'], liveVerified: false }; }

export class SavedEntities {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('SavedEntities requires a DotClient.'); this.transport = client.transport; }
  capabilities() { return savedEntityCapabilities(); }
  async _identity(accountId) {
    id(accountId, 'accountId');
    if (typeof this.transport.authLoader === 'function') { const auth = await this.transport.authLoader({ authFile: this.transport.authFile }); if (auth.accountId !== accountId) throw new DotError('ACCOUNT_CHANGED', 'The signed-in account differs from the selected account.'); this.transport.assertIdentity?.(auth); }
  }
  async _call(method, route, options, accountId) {
    await this._identity(accountId); options.signal?.throwIfAborted();
    const result = await this.transport.request(method, route, { ...options, expectedAccountId: accountId, maxBytes: 2 * 1024 * 1024,
      ...(route.startsWith(BASE) ? { headers: { 'x-openai-use-sheep': '1' } } : {}) });
    await this._identity(accountId); return result;
  }
  async _status(targets, { accountId, signal }) {
    const byKey = new Map(); for (const target of targets) if (!byKey.has(targetKey(target))) byKey.set(targetKey(target), target);
    const unique = [...byKey.values()];
    const data = await this._call('POST', `${BASE}/status`, { body: { targets: unique }, signal }, accountId);
    if (!record(data) || !Array.isArray(data.saved_targets) || data.saved_targets.length > unique.length || data.saved_entities != null && (!Array.isArray(data.saved_entities) || data.saved_entities.length > unique.length)) invalid('The saved status response is invalid.');
    const requested = new Map(unique.map(target => [targetKey(target), target])); const saved = new Set(); const entities = new Map();
    for (const item of data.saved_targets) { const target = serverTarget(item), key = targetKey(target); if (!requested.has(key) || saved.has(key)) invalid('Saved status contains an unrelated or duplicate target.'); saved.add(key); }
    for (const item of data.saved_entities ?? []) { const target = serverTarget(item.saved_target), key = targetKey(target); if (!saved.has(key) || entities.has(key)) invalid('Saved status contains an unrelated or duplicate entity.'); entities.set(key, entity(item, requested.get(key))); }
    return unique.map(target => ({ target: targetSummary(target), saved: saved.has(targetKey(target)), ...(entities.has(targetKey(target)) ? { entity: entities.get(targetKey(target)) } : {}) }));
  }
  async status({ specs, accountId, signal } = {}) {
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 100) fail('specs must contain 1 to 100 product/local-business specs.');
    const targets = specs.map(spec => buildSavedEntityRequest(spec).saved_target);
    return { accountId: id(accountId, 'accountId'), items: await this._status(targets, { accountId, signal }) };
  }
  async _favoriteNode(fileId, { accountId, signal }) {
    let cursor; const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const batch = await this._call('GET', `${LIBRARY}/favorites`, { query: { limit: 50, include_sites: false, cursor }, signal }, accountId);
      if (!record(batch) || !Array.isArray(batch.items) || batch.items.length > 50) invalid('The Library favorites returned an invalid page.');
      const matches = batch.items.filter(item => item?.target_ref?.type === 'library_file' && item.target_ref.library_file_id === fileId);
      if (matches.length > 1) invalid('The Library favorites repeated the requested ID.');
      if (matches.length) {
        const match = matches[0];
        if (!visible(match) || match.availability !== 'available' || !visible(match.item)) throw new DotError('NOT_VISIBLE', 'The saved entity favorite is unavailable.');
        if (match.item.id !== fileId) invalid('The favorite item does not match the requested Library ID.');
        return match.item;
      }
      if (batch.cursor == null) return null;
      if (typeof batch.cursor !== 'string' || !batch.cursor || batch.cursor.length > 8192 || seen.has(batch.cursor)) invalid('The favorites returned an invalid or repeated cursor.');
      seen.add(batch.cursor); cursor = batch.cursor;
    }
    return null;
  }
  async _get(fileId, { accountId, signal }) {
    id(fileId, 'fileId'); let data;
    try { data = await this._call('GET', `${LIBRARY}/files/${encodeURIComponent(fileId)}`, { signal }, accountId); }
    catch (error) { if (error?.code !== 'HTTP_ERROR' || error?.details?.status !== 404) throw error; data = await this._call('GET', `${LIBRARY}/files/${encodeURIComponent(fileId)}/node`, { signal }, accountId); }
    if (!visible(data)) throw new DotError('NOT_VISIBLE', 'The Library node is not visible.');
    if (data.id !== fileId) invalid('The Library node does not match the requested ID.');
    // The native /node response omits saved_target. The folder nodes endpoint
    // hydrates it, so resolve only this exact ID within its known parent.
    if (data.library_artifact_type === 'saved_entity' && !record(data.saved_entity)) {
      const directoryId = data.parent_directory_id ?? data.directory_id ?? null;
      if (directoryId !== null && (typeof directoryId !== 'string' || !ID.test(directoryId))) invalid('The saved node has an invalid directory ID.');
      if (directoryId === null) {
        const favorite = await this._favoriteNode(fileId, { accountId, signal });
        if (favorite) data = favorite;
      }
      let cursor; const seen = new Set(); let found;
      for (let page = 0; !record(data.saved_entity) && page < 100; page++) {
        const batch = await this._call('GET', `${LIBRARY}/nodes`, { query: { parent_directory_id: directoryId, cursor,
          entry_surface: 'library', include_files: true, include_saved_entities: true, include_provider_roots: false, include_pages: false, include_sites: false, include_hidden_files: false }, signal }, accountId);
        if (!record(batch) || !Array.isArray(batch.items) || batch.items.length > 1000) invalid('The saved-entity folder returned an invalid page.');
        const matches = batch.items.filter(item => item?.id === fileId);
        if (matches.length > 1) invalid('The saved-entity folder repeated the requested ID.');
        if (matches.length) { found = matches[0]; break; }
        if (batch.cursor == null) break;
        if (typeof batch.cursor !== 'string' || !batch.cursor || batch.cursor.length > 8192 || seen.has(batch.cursor)) invalid('The saved-entity folder returned an invalid or repeated cursor.');
        seen.add(batch.cursor); cursor = batch.cursor;
      }
      if (!record(data.saved_entity)) {
        if (!found) throw new DotError('SAVED_TARGET_UNAVAILABLE', 'The exact saved target was not found within the bounded native Library folder and favorite pages. No mutation was sent.');
        if (!visible(found)) throw new DotError('NOT_VISIBLE', 'The saved-entity Library node is not visible.');
        data = found;
      }
    }
    if (!record(data.saved_entity) || data.library_artifact_type != null && data.library_artifact_type !== 'saved_entity') throw new DotError('UNSUPPORTED', 'This operation requires a native saved-entity Library node.');
    const target = serverTarget(data.saved_entity.saved_target);
    const directoryId = data.parent_directory_id ?? data.directory_id ?? null;
    if (directoryId !== null && (typeof directoryId !== 'string' || !ID.test(directoryId))) invalid('The saved node has an invalid directory ID.');
    let origin;
    if (data.saved_entity.origin != null) {
      try { origin = { conversationId: id(data.saved_entity.origin.conversation_id, 'origin conversationId'), messageId: id(data.saved_entity.origin.message_id, 'origin messageId') }; }
      catch { invalid('The saved entity returned an invalid origin.'); }
    }
    return { rawTarget: target, node: { fileId, name: typeof data.name === 'string' && data.name.length <= 16384 ? data.name : typeof data.file_name === 'string' && data.file_name.length <= 16384 ? data.file_name : target.sidebar_params.name,
      directoryId, target: targetSummary(target), ...(origin ? { origin } : {}) } };
  }
  async get({ fileId, accountId, signal } = {}) {
    const { rawTarget, node } = await this._get(fileId, { accountId, signal }); const [status] = await this._status([rawTarget], { accountId, signal });
    if (status.entity && status.entity.libraryFileId !== fileId) invalid('Saved status identifies a different Library node.');
    return { accountId, ...node, saved: status.saved, ...(status.entity ? { entity: status.entity } : {}) };
  }
  async save({ spec, accountId, signal } = {}) {
    const request = buildSavedEntityRequest(spec); id(accountId, 'accountId');
    const [before] = await this._status([request.saved_target], { accountId, signal }); if (before.saved) return { accountId, status: 'already-saved', ...before };
    const raw = await this._call('POST', BASE, { body: request, signal }, accountId); let created;
    try { created = entity(raw, request.saved_target); } catch { throw new DotError('MUTATION_UNCONFIRMED', 'The service did not return the expected saved entity. Inspect status before retrying.', { delivery: 'unknown' }); }
    try { const [after] = await this._status([request.saved_target], { accountId, signal });
      if (!after.saved || !after.entity || after.entity.libraryFileId !== created.libraryFileId) throw new Error('not confirmed');
      return { accountId, status: 'saved', ...after };
    } catch (error) { throw new DotError('MUTATION_UNCONFIRMED', 'Saving was acknowledged but status verification failed. Inspect the Library ID before retrying.', { delivery: 'acknowledged', libraryFileId: created.libraryFileId, verificationCode: error?.code ?? 'STATUS_MISMATCH' }); }
  }
  async remove({ fileId, confirm, accountId, signal } = {}) {
    id(fileId, 'fileId'); if (confirm !== fileId) fail('confirm must exactly match fileId.');
    const { rawTarget } = await this._get(fileId, { accountId, signal }); const [before] = await this._status([rawTarget], { accountId, signal });
    if (!before.saved || !before.entity || before.entity.libraryFileId !== fileId) throw new DotError('STATE_CHANGED', 'The requested saved entity is no longer the current saved target.');
    const result = await this._call('POST', `${BASE}/remove`, { body: { saved_target: rawTarget }, signal }, accountId);
    if (result?.success === false || result?.ok === false) throw new DotError('OPERATION_REJECTED', 'The saved entity removal was rejected.');
    try { const [after] = await this._status([rawTarget], { accountId, signal }); if (after.saved) throw new Error('still saved'); }
    catch (error) { throw new DotError('MUTATION_UNCONFIRMED', 'Removal was accepted but status verification failed. Inspect status before retrying.', { delivery: 'acknowledged', libraryFileId: fileId, verificationCode: error?.code ?? 'STATUS_MISMATCH' }); }
    return { accountId, fileId, removed: true };
  }
  async move({ fileId, directoryId, root = false, accountId, signal } = {}) {
    id(fileId, 'fileId'); if (typeof root !== 'boolean' || root && directoryId !== undefined || !root && directoryId === undefined) fail('Supply directoryId or root, exactly one.');
    const destination = root ? null : id(directoryId, 'directoryId'); const { rawTarget } = await this._get(fileId, { accountId, signal });
    const path = await this._call('GET', `${LIBRARY}/directories/path`, { query: destination === null ? {} : { directory_id: destination }, signal }, accountId);
    let rootId;
    if (destination !== null) { if (!Array.isArray(path?.items) || !path.items.some(item => item.id === destination && (item.kind == null || item.kind === 'directory') && visible(item) && !destination.startsWith('external-'))) fail('The destination must be an accessible native Library folder.'); }
    else { if (!Array.isArray(path?.items) || path.items.length !== 1 || path.items[0].is_root !== true || !visible(path.items[0]) || typeof path.items[0].id !== 'string' || !ID.test(path.items[0].id)) invalid('The service did not identify the native Library root.'); rootId = path.items[0].id; }
    const matches = value => value === destination || destination === null && value === rootId;
    const [before] = await this._status([rawTarget], { accountId, signal });
    if (!before.saved || !before.entity || before.entity.libraryFileId !== fileId) throw new DotError('STATE_CHANGED', 'The requested node is not the current saved entity.');
    if (matches(before.entity.directoryId)) return { accountId, fileId, directoryId: destination, moved: false, status: 'already-in-folder' };
    const result = await this._call('PATCH', `${LIBRARY}/files/${encodeURIComponent(fileId)}/move`, { body: { directory_id: destination }, signal }, accountId);
    if (result?.success !== true) throw new DotError('MUTATION_UNCONFIRMED', 'The service did not acknowledge the saved entity move. Inspect its current folder before retrying.', { delivery: 'unknown', libraryFileId: fileId });
    try { const [after] = await this._status([rawTarget], { accountId, signal }); if (!after.saved || !after.entity || after.entity.libraryFileId !== fileId || !matches(after.entity.directoryId)) throw new Error('not moved'); }
    catch (error) { throw new DotError('MUTATION_UNCONFIRMED', 'Moving was acknowledged but status verification failed. Inspect the Library node before retrying.', { delivery: 'acknowledged', libraryFileId: fileId, verificationCode: error?.code ?? 'STATUS_MISMATCH' }); }
    return { accountId, fileId, directoryId: destination, moved: true };
  }
}
