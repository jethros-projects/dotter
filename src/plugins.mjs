import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { connectorPublicData } from './connectors-admin.mjs';
import { writePrivate } from './store.mjs';
import { withOperationLock } from './operation-lock.mjs';

// Hosted plugin contracts observed in ChatGPT.app 2026-10-18. Local Codex
// plugin installation is a separate protocol; these methods use account APIs.
const ROOT = '/backend-api/ps/plugins';
const HEADERS = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'plugin_management' };
const SERVICE = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'workspace_agents' };
const MAX_ARCHIVE = 100 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message, code = 'INVALID_ARGUMENT') { throw new DotError(code, message); }
function id(value, name = 'ID') { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/.test(value)) fail(`${name} must be an API-issued identifier.`); return value; }
function part(value, name) { return encodeURIComponent(id(value, name)); }
function text(value, name, max = 8192) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${name} must be nonempty text of at most ${max} characters.`); return value; }
function limit(value = 50) { if (!Number.isInteger(value) || value < 1 || value > 1000) fail('limit must be an integer from 1 to 1000.'); return value; }
function bool(value, name) { if (typeof value !== 'boolean') fail(`${name} must be boolean.`); return value; }
function serviceUser(value, accountId) {
  id(value, 'serviceAccountUserId');
  if (!value.includes('__')) return value;
  const suffix = `__${accountId}`;
  if (!value.endsWith(suffix)) fail('The service-account identity belongs to a different account.', 'ACCOUNT_CHANGED');
  return id(value.slice(0, -suffix.length), 'serviceAccountUserId');
}
function validatePlugin(value, pluginId) { if (!object(value) || value.id !== pluginId) fail('The plugin response did not match the requested plugin.', 'INVALID_RESPONSE'); return value; }
function archiveName(name) { if (!/\.(zip|tar\.gz|tgz)$/i.test(name) || /[\x00-\x1f\x7f\\/]/.test(name) || Buffer.byteLength(name) > 240) fail('Use a .zip, .tar.gz, or .tgz archive filename of at most 240 bytes.'); }
function archiveMagic(bytes, name) { return /\.zip$/i.test(name) ? bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && [[3, 4], [5, 6], [7, 8]].some(pair => bytes[2] === pair[0] && bytes[3] === pair[1]) : bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139; }
async function readArchive(file, signal) {
  text(file, 'archive file', 4096); const name = basename(file); archiveName(name); let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_ARCHIVE) fail('A plugin archive must be a regular file containing 1 byte to 100 MiB.');
    const bytes = Buffer.alloc(before.size + 1); let size = 0;
    while (size < bytes.length) { signal?.throwIfAborted(); const result = await handle.read(bytes, size, bytes.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    const after = await handle.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('The plugin archive changed while it was read.', 'FILE_CHANGED');
    const contents = bytes.subarray(0, size); if (!archiveMagic(contents, name)) fail('The archive bytes do not match its filename.');
    return { name, bytes: contents, mimeType: /\.zip$/i.test(name) ? 'application/zip' : 'application/gzip' };
  } catch (error) { if (error instanceof DotError || signal?.aborted) throw error; fail('Cannot read the plugin archive; use a regular file, not a symbolic link.', 'FILE_READ_FAILED'); }
  finally { await handle?.close(); }
}
const UPLOAD_PHASES = ['reserving', 'reserved', 'uploading', 'uploaded', 'finalizing', 'complete'];
async function reservationState(file, { allowMissing = false } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size > 65536 || before.mode & 0o077 || process.getuid && before.uid !== process.getuid()) fail('The upload reservation must be an owner-only regular file of at most 64 KiB.', 'INVALID_RESERVATION');
    const bytes = Buffer.alloc(65537); let size = 0;
    while (size < bytes.length) { const result = await handle.read(bytes, size, bytes.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    const after = await handle.stat();
    if (size > 65536 || size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('The upload reservation changed while being read.', 'INVALID_RESERVATION');
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!object(state) || state.schemaVersion !== 1 || state.kind !== 'dot-plugin-archive-upload' || !UPLOAD_PHASES.includes(state.phase) || !object(state.identity) || !object(state.source) || !object(state.response)) fail('Unsupported upload reservation format.', 'INVALID_RESERVATION');
    return state;
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; if (error instanceof DotError) throw error; fail('Cannot read the private upload reservation.', 'INVALID_RESERVATION'); }
  finally { await handle?.close(); }
}


export class DotPlugins {
  constructor(client) { if (typeof client?.transport?.request !== 'function') throw new TypeError('DotPlugins requires a DotClient.'); this.transport = client.transport; }
  async account(expectedAccountId) {
    if (expectedAccountId !== undefined) text(expectedAccountId, 'expectedAccountId', 1024);
    let accountId = expectedAccountId;
    if (typeof this.transport.authLoader === 'function') {
      const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
      if (expectedAccountId !== undefined && auth.accountId !== expectedAccountId) fail('The current account differs from the selected account.', 'ACCOUNT_CHANGED');
      this.transport.assertIdentity?.(auth);
      accountId = auth.accountId;
    }
    if (!accountId) fail('Plugin APIs require an explicit authenticated account.', 'AUTH_ACCOUNT_REQUIRED');
    return accountId;
  }
  request(method, route, accountId, options = {}) { return this.transport.request(method, route, { ...options, headers: options.headers ?? HEADERS, expectedAccountId: accountId }); }
  async list({ view = 'installed', scope = 'GLOBAL', q, limit: count = 50, cursor, includeExtensions = true, expectedAccountId, signal } = {}) {
    if (!['installed', 'catalog', 'created', 'shared'].includes(view)) fail('view must be installed, catalog, created, or shared.');
    count = limit(count); if (cursor !== undefined) text(cursor, 'cursor'); bool(includeExtensions, 'includeExtensions');
    if (!['GLOBAL', 'WORKSPACE'].includes(scope)) fail('scope must be GLOBAL or WORKSPACE.');
    if (q !== undefined) { text(q, 'q', 2048); if (view !== 'catalog') fail('Search is supported for the catalog view.'); }
    const route = view === 'catalog' ? q === undefined ? '/list' : '/search' : view === 'installed' ? '/installed' : `/workspace/${view}`;
    const query = { limit: count, pageToken: cursor, ...(view === 'catalog' ? { scope, q } : {}), ...(view === 'installed' ? { includeExtensions } : {}) };
    const accountId = await this.account(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}${route}`, accountId, { query, signal }));
  }
  async resolveApp({ appId, expectedAccountId, signal } = {}) {
    id(appId, 'appId'); const accountId = await this.account(expectedAccountId);
    const result = await this.request('GET', `${ROOT}/canonical-app/${part(appId, 'appId')}`, accountId, { headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, signal });
    if (!object(result) || !Object.hasOwn(result, 'plugin_id')) fail('The app lookup did not return a plugin mapping.', 'INVALID_RESPONSE');
    if (result.plugin_id === null) {
      if (result.plugin != null) fail('The app lookup returned a plugin without its ID.', 'INVALID_RESPONSE');
      return { appId, pluginId: null, plugin: null };
    }
    id(result.plugin_id, 'resolved plugin ID');
    if (result.plugin != null) {
      validatePlugin(result.plugin, result.plugin_id);
      for (const field of ['canonical_app_id', 'connector_id']) if (result.plugin[field] != null && result.plugin[field] !== appId) fail('The app lookup returned a plugin for a different app.', 'INVALID_RESPONSE');
    }
    return { appId, pluginId: result.plugin_id, plugin: result.plugin == null ? null : connectorPublicData(result.plugin) };
  }
  async home({ expectedAccountId, signal } = {}) { const accountId = await this.account(expectedAccountId); return connectorPublicData(await this.request('GET', `${ROOT}/home`, accountId, { signal })); }
  async raw(pluginId, accountId, signal) { return validatePlugin(await this.request('GET', `${ROOT}/${part(pluginId, 'pluginId')}`, accountId, { signal }), pluginId); }
  async get({ pluginId, expectedAccountId, signal } = {}) { id(pluginId, 'pluginId'); return connectorPublicData(await this.raw(pluginId, await this.account(expectedAccountId), signal)); }
  async batch({ pluginIds, expectedAccountId, signal } = {}) {
    if (!Array.isArray(pluginIds) || !pluginIds.length || pluginIds.length > 50) fail('pluginIds must contain 1 to 50 IDs.');
    const ids = [...new Set(pluginIds.map(value => id(value, 'pluginId')))]; const accountId = await this.account(expectedAccountId);
    const result = await this.request('POST', `${ROOT}/batch`, accountId, { body: { plugin_ids: ids }, signal });
    if (!Array.isArray(result?.results) || result.results.some(item => !ids.includes(item?.requested_plugin_id))) fail('Plugin batch response contained an unexpected plugin.', 'INVALID_RESPONSE');
    return connectorPublicData(result);
  }
  async skill({ pluginId, skillName, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); id(skillName, 'skillName'); const accountId = await this.account(expectedAccountId);
    return connectorPublicData(await this.request('GET', `${ROOT}/${part(pluginId)}/skills/${encodeURIComponent(skillName)}`, accountId, { query: { includeDownloadUrls: false }, signal }));
  }
  async setSkillEnabled({ pluginId, skillName, enabled, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); id(skillName, 'skillName'); bool(enabled, 'enabled');
    const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    await this.request('POST', `${ROOT}/${part(pluginId)}/skills/${encodeURIComponent(skillName)}/${enabled ? 'enable' : 'disable'}`, accountId, { signal });
    return { status: enabled ? 'enabled' : 'disabled', pluginId, skillName };
  }
  async install({ pluginId, installAttemptId = randomUUID(), expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(installAttemptId)) fail('installAttemptId must be a UUID.');
    const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    const result = await this.request('POST', `${ROOT}/${part(pluginId)}/install`, accountId, { query: { includeAppsNeedingAuth: true }, body: { install_attempt_id: installAttemptId }, signal });
    return { pluginId, installAttemptId, result: connectorPublicData(result), note: 'Provider authorization remains separate when apps need authentication.' };
  }
  async setEnabled({ pluginId, enabled, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); bool(enabled, 'enabled'); const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    await this.request('POST', `${ROOT}/${part(pluginId)}/${enabled ? 'enable' : 'disable'}`, accountId, { signal });
    return { status: enabled ? 'enabled' : 'disabled', pluginId };
  }
  async uninstall({ pluginId, confirmPluginId, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); if (confirmPluginId !== pluginId) fail('confirmPluginId must match pluginId to uninstall it.');
    const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    await this.request('POST', `${ROOT}/${part(pluginId)}/uninstall`, accountId, { signal }); return { status: 'uninstalled', pluginId };
  }
  async delete({ pluginId, confirmPluginId, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); if (confirmPluginId !== pluginId) fail('confirmPluginId must match pluginId to delete it.');
    const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    await this.request('DELETE', `${ROOT}/${part(pluginId)}`, accountId, { signal }); return { status: 'deleted', pluginId };
  }
  async _sharingAccount(expectedAccountId, signal) {
    const accountId = await this.account(expectedAccountId);
    signal?.throwIfAborted();
    // Native plugin sharing is available only for the selected workspace account.
    const data = await this.transport.request('GET', '/backend-api/accounts/check/v4-2023-04-27',
      { expectedAccountId: accountId, signal, maxBytes: 4 * 1024 * 1024 });
    await this.account(accountId);
    const accounts = data?.accounts;
    const membership = object(accounts) && Object.hasOwn(accounts, accountId) ? accounts[accountId] : undefined;
    const account = membership?.account;
    if (!object(membership) || !Object.hasOwn(membership, 'account') || membership.can_access_with_session !== true || !object(account)
      || account.account_id !== accountId || !['personal', 'workspace'].includes(account.structure)
      || account.is_deactivated !== undefined && typeof account.is_deactivated !== 'boolean' || account.is_deactivated === true) {
      fail('The service did not confirm accessible membership in the selected account.', 'ACCOUNT_MEMBERSHIP_UNVERIFIED');
    }
    if (account.structure !== 'workspace') fail('Plugin sharing requires an active workspace account.', 'WORKSPACE_REQUIRED');
    return accountId;
  }
  async shares({ pluginId, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); const accountId = await this._sharingAccount(expectedAccountId, signal);
    return connectorPublicData(await this.request('GET', `${ROOT}/${part(pluginId)}/shares`, accountId, { signal }));
  }
  async setShares({ pluginId, targets, discoverability, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); if (!Array.isArray(targets) || targets.length > 100) fail('targets must contain at most 100 share targets.');
    const normalized = targets.map(item => {
      if (!object(item) || Object.keys(item).some(key => !['principal_id', 'principal_type', 'role'].includes(key))) fail('Each share target requires principal_id, principal_type, and role.');
      id(item.principal_id, 'principal_id');
      if (!['user', 'group', 'workspace'].includes(item.principal_type) || !['reader', 'editor'].includes(item.role)) fail('Share targets support user/group/workspace principals and reader/editor roles; ownership is not changed here.');
      return { principal_id: item.principal_id, principal_type: item.principal_type, role: item.role };
    });
    const visibility = discoverability ?? (normalized.some(item => item.principal_type === 'workspace') ? 'UNLISTED' : 'PRIVATE');
    if (!['PRIVATE', 'UNLISTED', 'LISTED'].includes(visibility)) fail('discoverability must be PRIVATE, UNLISTED, or LISTED.');
    const accountId = await this._sharingAccount(expectedAccountId, signal);
    const current = await this.request('GET', `${ROOT}/${part(pluginId)}/shares`, accountId, { signal });
    if (current?.can_refresh_from_source === true) fail('Source-managed plugins must be shared at their source.', 'SOURCE_MANAGED');
    if (Array.isArray(current?.current_user_permissions) && !current.current_user_permissions.includes('chatgpt.plugin_share.write')) fail('This account cannot update plugin sharing.', 'PERMISSION_REQUIRED');
    return connectorPublicData(await this.request('PUT', `${ROOT}/${part(pluginId)}/shares`, accountId, { body: { targets: normalized, discoverability: visibility }, signal }));
  }
  async exportArchive({ pluginId, output, overwrite = false, expectedAccountId, signal } = {}) {
    id(pluginId, 'pluginId'); text(output, 'output', 4096); bool(overwrite, 'overwrite');
    const accountId = await this.account(expectedAccountId); await this.raw(pluginId, accountId, signal);
    const bytes = await this.transport.requestBytes('GET', `${ROOT}/${part(pluginId)}/archive`, { headers: HEADERS, expectedAccountId: accountId, maxBytes: MAX_ARCHIVE, signal });
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE || !archiveMagic(bytes, 'plugin.zip')) fail('The API returned an invalid plugin ZIP archive.', 'INVALID_RESPONSE');
    const path = await writePrivate(output, bytes, { overwrite }); return { pluginId, path, sizeBytes: bytes.length };
  }
  async importArchive({ file, pluginId, confirmPluginId, stateFile, reservationFile, expectedAccountId, signal } = {}) {
    if (pluginId !== undefined) { id(pluginId, 'pluginId'); if (confirmPluginId !== pluginId) fail('confirmPluginId must match pluginId to replace its source archive.'); }
    else if (confirmPluginId !== undefined) fail('confirmPluginId is only valid when replacing an existing plugin.');
    if (stateFile !== undefined && reservationFile !== undefined) fail('Use stateFile or reservationFile, not both.');
    const archive = await readArchive(file, signal);
    if (typeof this.transport.uploadSigned !== 'function') fail('The transport does not support signed plugin uploads.', 'UNSUPPORTED_TRANSPORT');
    const accountId = await this.account(expectedAccountId);
    if (pluginId !== undefined) await this.raw(pluginId, accountId, signal);
    if (stateFile !== undefined || reservationFile !== undefined) return this.importRecordedArchive({ archive, pluginId, stateFile: stateFile ?? reservationFile, allowCreate: stateFile !== undefined, accountId, signal });
    const session = await this.request('POST', '/backend-api/public/plugins/workspace/upload-url', accountId, { body: { filename: archive.name, mime_type: archive.mimeType, size_bytes: archive.bytes.length, ...(pluginId ? { plugin_id: pluginId } : {}) }, signal });
    if (!object(session) || typeof session.upload_url !== 'string' || typeof session.etag !== 'string' || !session.etag || !session.file_id) fail('The plugin upload reservation was incomplete.', 'INVALID_RESPONSE');
    id(session.file_id, 'upload file ID');
    await this.transport.uploadSigned(session.upload_url, { bytes: archive.bytes, contentType: archive.mimeType, signal });
    // The transport rechecks the selected account before finalizing. A failed
    // upload/finalization is never automatically retried or re-reserved.
    const result = await this.request('POST', `/backend-api/public/plugins/workspace${pluginId ? `/${part(pluginId)}` : ''}`, accountId, { body: { file_id: session.file_id, etag: session.etag }, signal });
    if (pluginId === undefined && !result?.plugin_id) fail('The server accepted the archive but did not return its plugin ID.', 'INVALID_RESPONSE');
    if (result?.plugin_id !== undefined && pluginId !== undefined && result.plugin_id !== pluginId) fail('The archive response contained a different plugin ID.', 'INVALID_RESPONSE');
    return { status: pluginId ? 'updated' : 'created', pluginId: pluginId ?? result.plugin_id };
  }
  async uploadIdentity(accountId) {
    const auth = typeof this.transport.authLoader === 'function' ? await this.transport.authLoader({ authFile: this.transport.authFile }) : null;
    let subject; try { subject = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub; } catch {}
    if (auth?.accountId !== accountId || typeof subject !== 'string' || !subject) fail('A plugin upload journal requires an authenticated account and JWT subject.', 'AUTH_IDENTITY_REQUIRED');
    this.transport.assertIdentity?.(auth);
    return { accountId, subject };
  }
  async importStatus({ stateFile, reservationFile, expectedAccountId } = {}) {
    if (stateFile !== undefined && reservationFile !== undefined) fail('Use stateFile or reservationFile, not both.');
    const file = stateFile ?? reservationFile; text(file, 'stateFile', 4096);
    const state = await reservationState(file), identity = await this.uploadIdentity(await this.account(expectedAccountId));
    if (state.identity.accountId !== identity.accountId || state.identity.subject !== identity.subject) fail('This upload journal belongs to another signed-in identity.', 'ACCOUNT_CHANGED');
    return { phase: state.phase, status: state.phase === 'complete' ? (state.pluginId ? 'updated' : 'created') : ['reserving', 'uploading', 'finalizing'].includes(state.phase) ? 'outcome_unknown' : 'ready_to_resume',
      pluginId: state.resultId ?? state.pluginId ?? null, source: { name: state.source.name, sizeBytes: state.source.sizeBytes, sha256: state.source.sha256 }, canResume: ['reserved', 'uploaded', 'complete'].includes(state.phase) };
  }
  async importRecordedArchive({ archive, pluginId, stateFile, allowCreate, accountId, signal }) {
    text(stateFile, 'stateFile', 4096);
    return withOperationLock(resolve(stateFile), async file => {
      let state = await reservationState(file, { allowMissing: allowCreate });
      const identity = await this.uploadIdentity(accountId);
      const source = { name: archive.name, sizeBytes: archive.bytes.length, sha256: createHash('sha256').update(archive.bytes).digest('hex') };
      const assertIdentity = async () => {
        const current = await this.uploadIdentity(accountId);
        if (current.accountId !== identity.accountId || current.subject !== identity.subject) fail('The signed-in identity changed during the upload.', 'ACCOUNT_CHANGED');
      };
      const save = async (phase, { acknowledgedStage, resultId, create = false } = {}) => {
        const next = { ...state, phase };
        try {
          const serialized = JSON.stringify(next, null, 2) + '\n';
          if (Buffer.byteLength(serialized) > 65536) fail('The upload receipt is too large to save safely.', 'INVALID_RESPONSE');
          await writePrivate(file, serialized, { overwrite: !create });
          state = next;
        } catch (cause) {
          throw new DotError('IMPORT_RECEIPT_NOT_SAVED', acknowledgedStage ? 'The service replied, but its upload receipt could not be saved. Do not repeat the operation; inspect the journal and existing resource.' : 'The upload journal could not be saved. No further request was sent.', {
            phase: state?.phase ?? null, stage: acknowledgedStage ?? phase, delivery: acknowledgedStage ? 'acknowledged' : 'not_sent', receiptSaved: false, ...(resultId ? { pluginId: resultId } : {}), reason: cause.code ?? 'WRITE_FAILED' });
        }
      };
      if (state) {
        if (state.identity.accountId !== identity.accountId || state.identity.subject !== identity.subject) fail('This upload journal belongs to another signed-in identity.', 'ACCOUNT_CHANGED');
        if (state.source.sha256 !== source.sha256 || state.source.name !== source.name || state.source.sizeBytes !== source.sizeBytes || (state.pluginId ?? undefined) !== pluginId) fail('This upload journal belongs to a different archive or target plugin.', 'RESERVATION_MISMATCH');
      } else {
        state = { schemaVersion: 1, kind: 'dot-plugin-archive-upload', identity, source, ...(pluginId ? { pluginId } : {}), phase: 'reserving', response: {} };
        await save('reserving', { create: true });
        await assertIdentity();
        const session = await this.request('POST', '/backend-api/public/plugins/workspace/upload-url', accountId, { body: { filename: archive.name, mime_type: archive.mimeType, size_bytes: archive.bytes.length, ...(pluginId ? { plugin_id: pluginId } : {}) }, signal });
        state.response = { file_id: session?.file_id, etag: session?.etag, upload_url: session?.upload_url };
        // Persist every captured reservation before validation or another write.
        await save('reserving', { acknowledgedStage: 'reservation' });
        if (!object(session) || typeof session.upload_url !== 'string' || typeof session.etag !== 'string' || !session.etag || !session.file_id) fail('The plugin upload reservation was incomplete. Inspect the saved receipt; do not reserve again.', 'INVALID_RESPONSE');
        id(session.file_id, 'upload file ID');
        await save('reserved', { acknowledgedStage: 'reservation' });
      }
      if (state.phase === 'complete') {
        id(state.resultId, 'completed plugin ID');
        if (pluginId !== undefined && state.resultId !== pluginId) fail('The completed upload journal belongs to a different plugin.', 'RESERVATION_MISMATCH');
        return { status: pluginId ? 'updated' : 'created', pluginId: state.resultId, resumed: true };
      }
      if (['reserving', 'uploading', 'finalizing'].includes(state.phase)) throw new DotError('RESERVATION_OUTCOME_UNKNOWN', 'The previous request outcome is unknown. Inspect the saved receipt and existing resource before any retry.', { phase: state.phase, delivery: 'unknown' });
      id(state.response.file_id, 'reservation file ID'); text(state.response.etag, 'reservation etag');
      if (state.phase === 'reserved') {
        if (typeof state.response.upload_url !== 'string') fail('The upload reservation has no upload URL.', 'INVALID_RESERVATION');
        await assertIdentity(); await save('uploading');
        await this.transport.uploadSigned(state.response.upload_url, { bytes: archive.bytes, contentType: archive.mimeType, signal });
        await save('uploaded', { acknowledgedStage: 'upload' });
      }
      await assertIdentity(); await save('finalizing');
      const result = await this.request('POST', `/backend-api/public/plugins/workspace${pluginId ? `/${part(pluginId)}` : ''}`, accountId, { body: { file_id: state.response.file_id, etag: state.response.etag }, signal });
      const resultId = pluginId ?? result?.plugin_id;
      state.finalizationResponse = { plugin_id: result?.plugin_id };
      await save('finalizing', { acknowledgedStage: 'finalization', resultId: typeof resultId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/.test(resultId) ? resultId : undefined });
      if (!resultId || result?.plugin_id !== undefined && pluginId !== undefined && result.plugin_id !== pluginId) fail('The archive response did not confirm the expected plugin ID. Inspect the existing resource before retrying.', 'INVALID_RESPONSE');
      id(resultId, 'completed plugin ID');
      state = { ...state, resultId, response: { file_id: state.response.file_id, etag: state.response.etag } };
      await save('complete', { acknowledgedStage: 'finalization', resultId });
      return { status: pluginId ? 'updated' : 'created', pluginId: resultId, resumed: true };
    }, { busyCode: 'RESERVATION_BUSY', failedCode: 'RESERVATION_BUSY', label: 'plugin upload' });
  }
  async teamList({ serviceAccountUserId, teamId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(teamId, 'teamId'); const accountId = await this.account(expectedAccountId);
    serviceAccountUserId = serviceUser(serviceAccountUserId, accountId);
    return connectorPublicData(await this.request('GET', `/backend-api/service-accounts/${part(serviceAccountUserId)}/plugins/installed`, accountId, { query: { team_id: teamId }, headers: SERVICE, signal }));
  }
  async teamInstall({ serviceAccountUserId, teamId, pluginId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(teamId, 'teamId'); id(pluginId, 'pluginId'); const accountId = await this.account(expectedAccountId);
    serviceAccountUserId = serviceUser(serviceAccountUserId, accountId);
    return connectorPublicData(await this.request('POST', `/backend-api/service-accounts/${part(serviceAccountUserId)}/plugins/${part(pluginId)}/install`, accountId, { query: { team_id: teamId }, headers: SERVICE, signal }));
  }
  async teamUninstall({ serviceAccountUserId, teamId, pluginId, confirmPluginId, expectedAccountId, signal } = {}) {
    id(serviceAccountUserId, 'serviceAccountUserId'); id(teamId, 'teamId'); id(pluginId, 'pluginId'); if (confirmPluginId !== pluginId) fail('confirmPluginId must match pluginId to uninstall from a service account.'); const accountId = await this.account(expectedAccountId);
    serviceAccountUserId = serviceUser(serviceAccountUserId, accountId);
    return connectorPublicData(await this.request('POST', `/backend-api/service-accounts/${part(serviceAccountUserId)}/plugins/${part(pluginId)}/uninstall`, accountId, { query: { team_id: teamId }, headers: SERVICE, signal }));
  }
}
