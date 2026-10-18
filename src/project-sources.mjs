import { setTimeout as delay } from 'node:timers/promises';
import { DotError } from './errors.mjs';
import { AccountProjects, validateProjectId, projectSummary, requireProjectPermission, projectMutationUnverified, requireProjectCrud } from './account-projects.mjs';

// Installed client contracts: source-queries-8e9f48a1fbe4.js,
// source-file-selection-1c9e002e4ce3.js, add-sources-dialog-4596e9a20547.js
// and page-ac155a1a57a1.js. Website and provider URLs intentionally have
// different native normalization rules.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const PROVIDERS = Object.freeze({
  google_drive: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
  slack: 'asdk_app_69a1d78e929881919bba0dbda1f6436d',
  linear: 'asdk_app_69a089a326dc8191b32a3f2553f5be2c',
});
export { PROVIDERS as PROJECT_CONNECTOR_PROVIDERS };
const HEADERS = Object.freeze({ 'OAI-Product-Sku': 'CHATGPT_PROJECTS', 'X-Codex-Surface': 'other' });
// Native add-sources-dialog Ee=Kur=TFn reads connector metadata through
// connector_setup; hIn keeps the accessible-links request on other.
const CONNECTOR_HEADERS = Object.freeze({ 'OAI-Product-Sku': 'CHATGPT_PROJECTS', 'X-Codex-Surface': 'connector_setup' });
const mutations = new WeakMap();
const MEMBERSHIP = Symbol('projectSourceMembership');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
const invalid = message => fail('INVALID_RESPONSE', message);
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail('INVALID_ARGUMENT', `${label} must be an ID returned by the API.`);
  return value;
}
function validId(value) { return typeof value === 'string' && ID.test(value) && value !== '.' && value !== '..'; }
function bounded(value, label, max = 8192) {
  if (typeof value !== 'string' || !value || value.length > max || CONTROLS.test(value)) fail('INVALID_ARGUMENT', `${label} must be a bounded string without control characters.`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function boolean(value, label) { if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', `${label} must be true or false.`); }
function cursor(value, response = false) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 8192 || CONTROLS.test(value)) (response ? invalid : message => fail('INVALID_ARGUMENT', message))('The project-source pagination cursor is invalid.');
  return value;
}
function safeText(value, max = 8192) { return typeof value === 'string' && value.length <= max && !CONTROLS.test(value) ? value : null; }
// Native lT normalizes the two names used for the same app identity. Rollout
// configuration may contain other migrations; unrelated IDs are not guessed.
function connectorIdentity(value) { return typeof value === 'string' && value.startsWith('asdk_app_') ? `connector_${value.slice(9)}` : value; }
function visible(value, depth = 0) {
  return record(value) && depth < 8 && value.hidden !== true && value.is_hidden !== true && value.deleted !== true && value.is_deleted !== true
    && value.deleted_at == null && value.removed !== true && value.is_removed !== true && value.removed_at == null
    && value.private !== true && value.is_private !== true && value.internal !== true && value.is_internal !== true && value.redacted !== true
    && value.visible !== false && value.is_visible !== false && value.user_visible !== false && value.is_user_visible !== false
    && !(typeof value.visibility === 'string' && ['hidden', 'internal', 'deleted', 'redacted'].includes(value.visibility.toLowerCase()))
    && (value.metadata == null || visible(value.metadata, depth + 1));
}
function sourceProjection(value, projectId) {
  if (!record(value) || !validId(value.scope_id) || !safeText(value.connector_type, 128) || !safeText(value.scope_type, 128)
    || value.project_id != null && value.project_id !== projectId) invalid('The project returned an invalid or unrelated source.');
  const result = { scopeId: value.scope_id, connectorType: value.connector_type, scopeType: value.scope_type };
  for (const [native, name, max] of [['display_name', 'displayName', 4096], ['canonical_handle', 'canonicalHandle', 8192],
    ['last_sync_status', 'lastSyncStatus', 128], ['last_synced_at', 'lastSyncedAt', 128], ['last_sync_detail_message', 'lastSyncDetailMessage', 8192]]) {
    if (value[native] == null) result[name] = null;
    else { const text = safeText(value[native], max); if (text === null) invalid('The project source contained invalid display or synchronization metadata.'); result[name] = text; }
  }
  if (typeof value.created_at === 'number') {
    const date = new Date(value.created_at > 0 && value.created_at <= 9999999999 ? value.created_at * 1000 : value.created_at);
    if (!Number.isFinite(value.created_at) || !Number.isFinite(date.getTime())) invalid('The project source creation timestamp was invalid.');
    result.createdAt = date.toISOString();
  } else if (value.created_at == null) result.createdAt = null;
  else { result.createdAt = safeText(value.created_at, 128); if (result.createdAt === null) invalid('The project source creation timestamp was invalid.'); }
  if (value.original_url == null) result.originalUrl = null;
  else {
    if (!safeText(value.original_url, 32768)) invalid('The project source URL was invalid.');
    let url; try { url = new URL(value.original_url); } catch { invalid('The project source URL was invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid('The project source URL was invalid.');
    result.originalUrl = value.original_url;
  }
  if (value.is_connector_syncable != null && typeof value.is_connector_syncable !== 'boolean') invalid('The project source synchronization capability was invalid.');
  result.syncable = value.is_connector_syncable === true;
  return result;
}
function sourceType(value, { website = true } = {}) {
  if (!Object.hasOwn(PROVIDERS, value) && !(website && value === 'website')) fail('INVALID_ARGUMENT', `connectorType must be ${website ? 'website, ' : ''}google_drive, slack or linear.`);
  return value;
}
function providerUrl(value) {
  const trimmed = bounded(typeof value === 'string' ? value.trim() : value, 'url', 32768);
  let url; try { if (!/^https?:\/\//i.test(trimmed)) throw new Error(); url = new URL(trimmed); } catch { fail('INVALID_ARGUMENT', 'Provider source URLs must be explicit HTTP or HTTPS URLs.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_ARGUMENT', 'Provider source URLs must be HTTP or HTTPS URLs without embedded credentials.');
  return trimmed;
}
export function normalizeProjectWebsiteUrl(value) {
  const trimmed = bounded(typeof value === 'string' ? value.trim() : value, 'url', 32768);
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`), labels = url.hostname.split('.');
    const ipv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    if (!['http:', 'https:'].includes(url.protocol) || ipv4.test(url.hostname) || labels.length < 2 || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error();
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '')}`;
  } catch { fail('INVALID_ARGUMENT', 'Website sources require a supported public HTTP or HTTPS hostname.'); }
}
function sameUrl(actual, expected, type) {
  if (actual == null) return false;
  if (type === 'website') { try { return normalizeProjectWebsiteUrl(actual) === expected; } catch { return false; } }
  try { return new URL(actual).href === new URL(expected).href; } catch { return false; }
}
function sameIdentity(a, b) { return a.scopeId === b.scopeId && a.connectorType === b.connectorType && a.scopeType === b.scopeType && a.originalUrl === b.originalUrl && a.canonicalHandle === b.canonicalHandle; }
function connectorCount(sources) {
  if (sources[MEMBERSHIP].unknown) fail('SOURCE_SCAN_INCOMPLETE', 'The source list did not provide complete membership metadata; no change was attempted.');
  return [...sources[MEMBERSHIP].ids.values()].filter(type => type !== 'website').length;
}
function assertCapacity(raw, sources) {
  const limit = raw.project_connector_scope_limits?.max_connector_scope_limit;
  // Native W treats missing/null limits as uncapped. It never manufactures a
  // default plan limit; malformed present values still cannot authorize a write.
  if (limit == null) return;
  if (!Number.isInteger(limit) || limit < 0 || limit > 100000) fail('SOURCE_LIMIT_UNVERIFIED', 'The service supplied an invalid project connector-source limit.');
  if (connectorCount(sources) >= limit) fail('SOURCE_LIMIT_REACHED', 'This project has reached its connector-source limit.');
}
function synchronization(source, baseline) {
  const fresh = !baseline || baseline.sawRunning || source.lastSyncStatus !== baseline.lastSyncStatus
    || source.lastSyncedAt != null && source.lastSyncedAt !== baseline.lastSyncedAt;
  if (source.lastSyncStatus === 'failed' && fresh) return { status: 'failed', completed: false, detail: source.lastSyncDetailMessage };
  if (source.lastSyncStatus === 'completed' && fresh) return { status: source.lastSyncDetailMessage?.trim() ? 'partial' : 'completed', completed: true, detail: source.lastSyncDetailMessage };
  return { status: source.lastSyncStatus === 'running' ? 'running' : 'pending', completed: false, detail: source.lastSyncDetailMessage };
}
function uncertain(error, projectId, operation, scopeId) {
  const wrapped = projectMutationUnverified(error, projectId, operation);
  if (scopeId && record(wrapped.details)) wrapped.details = { ...wrapped.details, scopeId };
  return wrapped;
}

export function projectSourceCapabilities() {
  return { scope: 'Native account project website and connector sources.', supported: ['list', 'get', 'providers', 'add', 'remove', 'sync', 'wait'],
    connectorTypes: ['website', ...Object.keys(PROVIDERS)], productSku: 'CHATGPT_PROJECTS', liveVerified: false,
    limitations: ['Fresh readable ordinary projects are required; mutations require current project and account permissions.',
      'Provider sources require an existing active connection; provider authorization uses the connector workflow.',
      'Website URLs use native normalization, which removes query strings, fragments and embedded credentials.',
      'Accepted synchronization is distinct from completed synchronization; partial and failed syncs remain explicit.',
      'No mutation is automatically retried. Existing source and project IDs remain available after partial success.'] };
}

export class ProjectSources extends AccountProjects {
  capabilities() { return projectSourceCapabilities(); }
  async _sourceContext(projectId, accountId, signal, write = false) {
    validateProjectId(projectId);
    const c = await this._context(accountId, signal), raw = await this._get(c, projectId);
    const project = write ? requireProjectPermission(raw, c, 'can_write') : projectSummary(raw, projectId, c, { detail: true });
    if (raw.gizmo.gizmo_snorlax_type != null) fail('PROJECT_SCOPE_UNSUPPORTED', 'Connector sources require an ordinary account project.');
    if (write) await requireProjectCrud(c);
    return { ...c, project, raw, projectId, signal };
  }
  async _assertSourceWrite(c) {
    const raw = await this._get(c, c.projectId), project = requireProjectPermission(raw, c, 'can_write');
    if (raw.gizmo.gizmo_snorlax_type != null) fail('PROJECT_SCOPE_UNSUPPORTED', 'Connector sources require an ordinary account project.');
    await requireProjectCrud(c);
    return { raw, project };
  }
  async _sourcePage(c, next) {
    const response = await c.request('GET', `/projects/${encodeURIComponent(c.projectId)}/connector_scopes`, { query: { cursor: next, limit: 100 } });
    if (!record(response) || !Array.isArray(response.items) || response.items.length > 100 || !response.items.every(record)) invalid('The project-source page was invalid.');
    const items = response.items.filter(value => visible(value)).map(value => sourceProjection(value, c.projectId));
    const members = response.items.map(value => ({ id: validId(value.scope_id) ? value.scope_id : null, type: safeText(value.connector_type, 128) }));
    return { items, cursor: cursor(response.cursor, true), members };
  }
  async _sourcePages(c, { pages = 100, initial = null } = {}) {
    let next = initial, pagesRead = 0; const items = [], seen = new Set(), ids = new Map(), membership = { ids: new Map(), unknown: false };
    while (pagesRead < pages) {
      if (next !== null) { if (seen.has(next)) invalid('The project-source pagination cursor did not advance.'); seen.add(next); }
      const page = await this._sourcePage(c, next);
      for (const member of page.members) {
        if (member.id === null || member.type === null) { membership.unknown = true; continue; }
        if (membership.ids.has(member.id) && membership.ids.get(member.id) !== member.type) invalid('The project returned conflicting source membership.');
        membership.ids.set(member.id, member.type);
      }
      for (const item of page.items) {
        if (ids.has(item.scopeId)) { if (!sameIdentity(ids.get(item.scopeId), item)) invalid('The project returned conflicting source identities.'); continue; }
        ids.set(item.scopeId, item); items.push(item);
      }
      pagesRead++; next = page.cursor; if (next === null) break;
    }
    if (next !== null && seen.has(next)) invalid('The project-source pagination cursor did not advance.');
    Object.defineProperty(items, MEMBERSHIP, { value: membership });
    return { items, cursor: next, pagesRead };
  }
  async _allSources(c) {
    const result = await this._sourcePages(c);
    if (result.cursor !== null) fail('SOURCE_SCAN_INCOMPLETE', 'The project-source scan reached its page bound; no change was attempted.');
    return result.items;
  }
  async _exactSource(c, scopeId) {
    const source = (await this._allSources(c)).find(source => source.scopeId === scopeId);
    if (!source) fail('SOURCE_NOT_FOUND', 'The source is not present in this project.');
    return source;
  }
  async _locked(c, key, action) {
    let locks = mutations.get(this.transport); if (!locks) mutations.set(this.transport, locks = new Set());
    const selected = `${c.accountId}:${c.projectId}:${key}`;
    if (locks.has(selected)) fail('SOURCE_OPERATION_IN_PROGRESS', 'A matching project-source operation is already running in this client.');
    locks.add(selected); try { return await action(); } finally { locks.delete(selected); }
  }
  async sourcesList({ projectId, accountId, pages = 1, cursor: initial, signal } = {}) {
    integer(pages, 'pages', 1, 100); initial = cursor(initial);
    const c = await this._sourceContext(projectId, accountId, signal);
    const result = await this._sourcePages(c, { pages, initial });
    // The private scan metadata includes hidden IDs for safe negative checks.
    // It must never be attached to an array returned by the public API.
    return { accountId, projectId, items: [...result.items], cursor: result.cursor, pagesRead: result.pagesRead };
  }
  async sourceGet({ projectId, accountId, scopeId, signal } = {}) {
    id(scopeId, 'scopeId'); const c = await this._sourceContext(projectId, accountId, signal);
    return { accountId, projectId, source: await this._exactSource(c, scopeId) };
  }
  async _providers(c, types) {
    const response = await c.request('POST', '/aip/connectors/links/list_accessible', { body: { principals: [], link_refresh_strategy: 'BLOCKING' }, headers: HEADERS });
    if (!record(response) || !Array.isArray(response.links) || response.links.length > 10000) invalid('The project connector list was invalid.');
    const providers = [];
    for (const type of types) {
      const connectorId = PROVIDERS[type], connector = await c.request('GET', `/aip/connectors/${encodeURIComponent(connectorId)}`, { query: { include_actions: false }, headers: CONNECTOR_HEADERS });
      if (!visible(connector) || connectorIdentity(connector.id) !== connectorIdentity(connectorId)) invalid('The service returned a different or hidden project connector.');
      const links = response.links.filter(link => visible(link) && link.visibility !== 'HIDDEN' && connectorIdentity(link.connector_id) === connectorIdentity(connectorId)
        && validId(link.id) && !link.id.startsWith('implicit_link::'));
      const available = connector.status !== 'DISABLED_BY_ADMIN';
      const connected = available && links.some(link => link.connector_status !== 'DISABLED_BY_ADMIN' && link.unavailable_reason == null && link.auth_status === 'ACTIVE');
      providers.push({ connectorType: type, connectorId, available, connected, status: safeText(connector.status, 128),
        links: links.map(link => ({ linkId: link.id, authStatus: safeText(link.auth_status, 128), available: link.unavailable_reason == null && link.connector_status !== 'DISABLED_BY_ADMIN' })) });
    }
    return providers;
  }
  async sourceProviders({ projectId, accountId, connectorType, signal } = {}) {
    if (connectorType !== undefined) sourceType(connectorType, { website: false });
    const c = await this._sourceContext(projectId, accountId, signal);
    return { accountId, projectId, providers: await this._providers(c, connectorType ? [connectorType] : Object.keys(PROVIDERS)) };
  }
  _waitOptions(wait, timeout, interval) { boolean(wait, 'wait'); integer(timeout, 'timeout', 1000, 600000); integer(interval, 'interval', 100, 30000); }
  async _waitSource(c, identity, { timeout, interval, baseline } = {}) {
    const started = Date.now(); let currentBaseline = baseline ? { ...baseline } : undefined;
    do {
      c.signal?.throwIfAborted();
      const source = await this._exactSource(c, identity.scopeId);
      if (!sameIdentity(source, identity)) invalid('The source identity changed while checking synchronization.');
      if (currentBaseline && source.lastSyncStatus === 'running') currentBaseline.sawRunning = true;
      const state = synchronization(source, currentBaseline);
      if (state.status === 'failed' || state.completed) return { source, synchronization: state };
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 0) return { source, synchronization: { ...state, timedOut: true } };
      await delay(Math.min(interval, remaining), undefined, { signal: c.signal });
    } while (true);
  }
  async _startSync(c, source, { wait, timeout, interval }) {
    if (source.connectorType === 'website' || !source.syncable) fail('SOURCE_NOT_SYNCABLE', 'This project source does not support connector synchronization.');
    if (source.lastSyncStatus === 'running' || source.lastSyncStatus === 'pending') fail('SOURCE_SYNC_IN_PROGRESS', 'This source already has a synchronization in progress.');
    await c.request('POST', `/projects/${encodeURIComponent(c.projectId)}/connector_scopes/${encodeURIComponent(source.scopeId)}/sync`);
    try {
      const result = wait ? await this._waitSource(c, source, { timeout, interval, baseline: source })
        : { source: await this._exactSource(c, source.scopeId) };
      if (!sameIdentity(result.source, source)) invalid('The source identity changed after synchronization was requested.');
      const state = result.synchronization ?? synchronization(result.source, source);
      return { source: result.source, synchronization: { accepted: true, ...state } };
    } catch (error) { throw uncertain(error, c.projectId, 'source sync', source.scopeId); }
  }
  async sourceAdd({ projectId, accountId, connectorType, url, wait = false, timeout = 60000, interval = 1000, signal } = {}) {
    sourceType(connectorType); this._waitOptions(wait, timeout, interval);
    const originalUrl = connectorType === 'website' ? normalizeProjectWebsiteUrl(url) : providerUrl(url);
    const c = await this._sourceContext(projectId, accountId, signal, true);
    return this._locked(c, 'add', async () => {
      const before = await this._allSources(c);
      if (before[MEMBERSHIP].unknown) fail('SOURCE_SCAN_INCOMPLETE', 'The source list did not provide complete membership metadata; no change was attempted.');
      if (before.some(source => source.connectorType === connectorType && sameUrl(source.originalUrl, originalUrl, connectorType))) fail('SOURCE_ALREADY_EXISTS', 'This source URL is already present in the project.');
      if (connectorType !== 'website') {
        assertCapacity(c.raw, before);
        const [provider] = await this._providers(c, [connectorType]);
        if (!provider.available || !provider.connected) fail('CONNECTION_UNAVAILABLE', 'An active project-compatible provider connection is required before adding this source.');
      }
      const refreshed = await this._assertSourceWrite(c);
      if (connectorType !== 'website') {
        assertCapacity(refreshed.raw, before);
      }
      const response = await c.request('POST', `/projects/${encodeURIComponent(projectId)}/connector_scopes`, { body: { connector_type: connectorType, original_url: originalUrl } });
      let scopeId;
      try {
        let returned;
        if (connectorType !== 'website') {
          if (!visible(response)) invalid('The created source was not a visible resource.');
          returned = sourceProjection(response, projectId); scopeId = returned.scopeId;
          if (returned.connectorType !== connectorType || !sameUrl(returned.originalUrl, originalUrl, connectorType) || before[MEMBERSHIP].ids.has(scopeId)) invalid('The source creation returned a different or existing source.');
        }
        const after = await this._allSources(c), candidates = after.filter(source => !before[MEMBERSHIP].ids.has(source.scopeId)
          && source.connectorType === connectorType && sameUrl(source.originalUrl, originalUrl, connectorType));
        if (candidates.length !== 1 || returned && !sameIdentity(candidates[0], returned)) invalid('The newly created source could not be identified uniquely in the project.');
        const source = candidates[0]; scopeId = source.scopeId;
        const created = { accountId, projectId, operation: 'add', confirmed: true, source };
        if (connectorType === 'website' || !source.syncable) return { ...created, synchronization: { accepted: false, status: 'not_applicable', completed: false } };
        if (source.lastSyncStatus === 'running' || source.lastSyncStatus === 'pending') {
          try {
            const result = wait ? await this._waitSource(c, source, { timeout, interval })
              : { source, synchronization: synchronization(source) };
            return { ...created, ...result, synchronization: { accepted: false, alreadyRunning: true, ...result.synchronization } };
          } catch (error) {
            return { ...created, synchronization: { accepted: false, alreadyRunning: true, status: 'unverified', completed: false,
              errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN', delivery: 'not_attempted' } };
          }
        }
        // Adding the source is already verified. A failure in the separate
        // initial-sync request must never obscure that persisted source ID.
        try { return { ...created, ...await this._startSync(c, source, { wait, timeout, interval }) }; }
        catch (error) { return { ...created, synchronization: { accepted: error?.details?.delivery === 'accepted', status: 'unverified', completed: false, errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN', delivery: error?.details?.delivery ?? 'unknown' } }; }
      } catch (error) { throw uncertain(error, projectId, 'source add', scopeId); }
    });
  }
  async sourceRemove({ projectId, accountId, scopeId, confirm, shared = false, signal } = {}) {
    id(scopeId, 'scopeId'); boolean(shared, 'shared'); if (confirm !== scopeId) fail('INVALID_ARGUMENT', 'confirm must exactly match scopeId.');
    const c = await this._sourceContext(projectId, accountId, signal, true);
    if (!c.project.private && !shared) fail('SHARED_PROJECT_CONFIRMATION_REQUIRED', 'Removing a shared project source affects every member; pass shared: true to acknowledge this.');
    return this._locked(c, scopeId, async () => {
      const source = await this._exactSource(c, scopeId);
      await c.request('DELETE', `/projects/${encodeURIComponent(projectId)}/connector_scopes/${encodeURIComponent(scopeId)}`);
      try {
        const after = await this._allSources(c);
        if (after[MEMBERSHIP].unknown || after[MEMBERSHIP].ids.has(scopeId)) invalid('The project source removal could not be verified from complete membership.');
        return { accountId, projectId, scopeId, operation: 'remove', confirmed: true, removed: true, source };
      } catch (error) { throw uncertain(error, projectId, 'source remove', scopeId); }
    });
  }
  async sourceSync({ projectId, accountId, scopeId, wait = false, timeout = 60000, interval = 1000, signal } = {}) {
    id(scopeId, 'scopeId'); this._waitOptions(wait, timeout, interval);
    const c = await this._sourceContext(projectId, accountId, signal, true);
    return this._locked(c, scopeId, async () => ({ accountId, projectId, scopeId, operation: 'sync', ...await this._startSync(c, await this._exactSource(c, scopeId), { wait, timeout, interval }) }));
  }
  async sourceWait({ projectId, accountId, scopeId, timeout = 60000, interval = 1000, signal } = {}) {
    id(scopeId, 'scopeId'); this._waitOptions(true, timeout, interval);
    const c = await this._sourceContext(projectId, accountId, signal), source = await this._exactSource(c, scopeId);
    if (source.connectorType === 'website') fail('SOURCE_NOT_SYNCABLE', 'This project source does not support connector synchronization.');
    return { accountId, projectId, scopeId, ...await this._waitSource(c, source, { timeout, interval }) };
  }
}
