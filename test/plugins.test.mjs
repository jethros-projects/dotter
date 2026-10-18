import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotPlugins } from '../src/plugins.mjs';
import { Transport } from '../src/transport.mjs';
import { commands, createClient } from '../src/command-sets/plugins.mjs';

const ROOT = '/backend-api/ps/plugins';
const plugin = { id: 'plugin-1', name: 'Example', release: { skills: [] } };
const ZIP = Buffer.from([80, 75, 3, 4, 0, 0]);
const error = code => exception => exception.code === code;
function setup(handler = call => call.method === 'GET' && call.route.endsWith('/plugin-1') ? plugin : {}) {
  const calls = [], transport = { authLoader: async () => ({ accountId: 'account-1' }), request: async (method, route, options) => { const call = { method, route, ...options }; calls.push(call); if (route === '/backend-api/accounts/check/v4-2023-04-27') return { accounts: { 'account-1': { can_access_with_session: true, account: { account_id: 'account-1', structure: 'workspace' } } } }; return handler(call, calls.length); } };
  transport.requestBytes = async (method, route, options) => { calls.push({ method, route, ...options }); return ZIP; };
  transport.uploadSigned = async (url, options) => { calls.push({ method: 'SIGNED_PUT', url, ...options }); return {}; };
  return { plugins: new DotPlugins({ transport }), calls, transport };
}
test('plugin manifest references implemented methods', () => { for (const spec of Object.values(commands)) assert.equal(typeof DotPlugins.prototype[spec.method], 'function'); assert.ok(createClient({ transport: { request() {} } }) instanceof DotPlugins); });
for (const [view, suffix] of [['installed', '/installed'], ['catalog', '/list'], ['created', '/workspace/created'], ['shared', '/workspace/shared']]) test(`list ${view} uses native route and pagination`, async () => {
  const { plugins, calls } = setup(() => ({ plugins: [plugin], pagination: { next_page_token: 'next' } }));
  const result = await plugins.list({ view, limit: 25, cursor: 'cursor' }); assert.equal(calls[0].route, ROOT + suffix); assert.equal(calls[0].query.limit, 25); assert.equal(calls[0].query.pageToken, 'cursor'); assert.equal(calls[0].expectedAccountId, 'account-1'); assert.equal(result.pagination.next_page_token, 'next');
});
test('catalog search scopes the query', async () => { const { plugins, calls } = setup(); await plugins.list({ view: 'catalog', q: 'calendar', scope: 'WORKSPACE' }); assert.equal(calls[0].route, `${ROOT}/search`); assert.equal(calls[0].query.q, 'calendar'); assert.equal(calls[0].query.scope, 'WORKSPACE'); });
test('invalid list options fail before auth or requests', async () => { const { plugins, calls } = setup(); for (const options of [{ view: 'other' }, { q: 'x' }, { limit: 0 }, { limit: 1001 }, { scope: 'root' }]) await assert.rejects(plugins.list(options), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); });
test('plugin details enforce ID and redact credentials', async () => { const { plugins } = setup(() => ({ ...plugin, client_secret: 'secret' })); assert.equal((await plugins.get({ pluginId: plugin.id })).client_secret, undefined); const other = setup(() => ({ ...plugin, id: 'different' })); await assert.rejects(other.plugins.get({ pluginId: plugin.id }), error('INVALID_RESPONSE')); });
test('batch validates requested identities and deduplicates', async () => { const { plugins, calls } = setup(() => ({ results: [{ requested_plugin_id: plugin.id, plugin }] })); await plugins.batch({ pluginIds: [plugin.id, plugin.id] }); assert.deepEqual(calls[0].body, { plugin_ids: [plugin.id] }); const bad = setup(() => ({ results: [{ requested_plugin_id: 'other' }] })); await assert.rejects(bad.plugins.batch({ pluginIds: [plugin.id] }), error('INVALID_RESPONSE')); });
test('batch bounds IDs before requests', async () => { const { plugins, calls } = setup(); for (const pluginIds of [[], Array(51).fill('x'), ['../x']]) await assert.rejects(plugins.batch({ pluginIds }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); });
test('skill retrieval never requests download URLs', async () => { const { plugins, calls } = setup(() => ({ skill_md_contents: 'hello' })); const result = await plugins.skill({ pluginId: plugin.id, skillName: 'review' }); assert.equal(result.skill_md_contents, 'hello'); assert.equal(calls[0].route, `${ROOT}/${plugin.id}/skills/review`); assert.equal(calls[0].query.includeDownloadUrls, false); });
for (const enabled of [true, false]) test(`skill ${enabled ? 'enable' : 'disable'} contract`, async () => { const { plugins, calls } = setup(); await plugins.setSkillEnabled({ pluginId: plugin.id, skillName: 'review', enabled }); assert.equal(calls[1].route, `${ROOT}/${plugin.id}/skills/review/${enabled ? 'enable' : 'disable'}`); assert.equal(calls[1].method, 'POST'); });
test('install preserves request ID and reports missing provider auth', async () => { const { plugins, calls } = setup(call => call.method === 'GET' ? plugin : { app_ids_needing_auth: ['connector-1'] }); const request = '12345678-1234-1234-1234-123456789abc'; const result = await plugins.install({ pluginId: plugin.id, installAttemptId: request }); assert.equal(calls[1].query.includeAppsNeedingAuth, true); assert.deepEqual(calls[1].body, { install_attempt_id: request }); assert.equal(result.installAttemptId, request); assert.deepEqual(result.result.app_ids_needing_auth, ['connector-1']); });
test('install does not retry a failed write', async () => { const { plugins, calls } = setup(call => { if (call.method === 'GET') return plugin; throw new Error('network failure'); }); await assert.rejects(plugins.install({ pluginId: plugin.id })); assert.equal(calls.filter(call => call.method === 'POST').length, 1); });
for (const enabled of [true, false]) test(`plugin ${enabled ? 'enable' : 'disable'} contract`, async () => { const { plugins, calls } = setup(); await plugins.setEnabled({ pluginId: plugin.id, enabled }); assert.equal(calls[1].route, `${ROOT}/${plugin.id}/${enabled ? 'enable' : 'disable'}`); });
for (const method of ['uninstall', 'delete']) test(`${method} requires exact confirmation`, async () => { const { plugins, calls } = setup(); await assert.rejects(plugins[method]({ pluginId: plugin.id, confirmPluginId: 'other' }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); await plugins[method]({ pluginId: plugin.id, confirmPluginId: plugin.id }); assert.equal(calls[1].method, method === 'delete' ? 'DELETE' : 'POST'); assert.equal(calls[1].route, ROOT + `/${plugin.id}` + (method === 'uninstall' ? '/uninstall' : '')); });
test('sharing replaces exact targets and uses correct editor role', async () => { const { plugins, calls } = setup(() => ({ can_refresh_from_source: false, current_user_permissions: ['chatgpt.plugin_share.write'] })); const targets = [{ principal_id: 'user-1', principal_type: 'user', role: 'editor' }]; await plugins.setShares({ pluginId: plugin.id, targets, discoverability: 'LISTED' }); assert.equal(calls[2].method, 'PUT'); assert.deepEqual(calls[2].body, { targets, discoverability: 'LISTED' }); });
test('sharing supports empty replacement and derives workspace discoverability', async () => { const { plugins, calls } = setup(() => ({})); await plugins.setShares({ pluginId: plugin.id, targets: [] }); assert.equal(calls[2].body.discoverability, 'PRIVATE'); await plugins.setShares({ pluginId: plugin.id, targets: [{ principal_type: 'workspace', principal_id: 'workspace-1', role: 'reader' }] }); assert.equal(calls[5].body.discoverability, 'UNLISTED'); });
test('sharing forbids owner change and unverified roles', async () => { const { plugins, calls } = setup(); for (const role of ['owner', 'writer']) await assert.rejects(plugins.setShares({ pluginId: plugin.id, targets: [{ principal_type: 'user', principal_id: 'user-1', role }] }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); });
test('sharing honors source-managed and account permissions', async () => { const managed = setup(() => ({ can_refresh_from_source: true })); await assert.rejects(managed.plugins.setShares({ pluginId: plugin.id, targets: [] }), error('SOURCE_MANAGED')); const denied = setup(() => ({ current_user_permissions: [] })); await assert.rejects(denied.plugins.setShares({ pluginId: plugin.id, targets: [] }), error('PERMISSION_REQUIRED')); assert.equal(denied.calls.length, 2); });
test('export writes private archive and refuses implicit overwrite', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); const file = join(folder, 'export.zip');
  try { const { plugins, calls } = setup(); const result = await plugins.exportArchive({ pluginId: plugin.id, output: file }); assert.deepEqual(await readFile(file), ZIP); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal(result.sizeBytes, ZIP.length); assert.equal(calls[1].maxBytes, 100 * 1024 * 1024); await assert.rejects(plugins.exportArchive({ pluginId: plugin.id, output: file }), error('OUTPUT_EXISTS')); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('export rejects nonarchive server data', async () => { const { plugins, transport } = setup(); transport.requestBytes = async () => Buffer.from('html'); await assert.rejects(plugins.exportArchive({ pluginId: plugin.id, output: '/tmp/not-written-by-dot.zip' }), error('INVALID_RESPONSE')); });
test('import performs one bounded signed upload then finalizes its reservation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); const file = join(folder, 'source.zip'); await writeFile(file, ZIP);
  try {
    const { plugins, calls } = setup(call => call.route.endsWith('/upload-url') ? { file_id: 'file-1', etag: 'revision', upload_url: 'https://files.oaiusercontent.com/blob?sig=private' } : { plugin_id: plugin.id });
    const result = await plugins.importArchive({ file }); assert.equal(calls.length, 3); assert.equal(calls[0].route, '/backend-api/public/plugins/workspace/upload-url'); assert.deepEqual(calls[0].body, { filename: 'source.zip', mime_type: 'application/zip', size_bytes: ZIP.length }); assert.equal(calls[1].method, 'SIGNED_PUT'); assert.deepEqual(calls[1].bytes, ZIP); assert.deepEqual(calls[2].body, { file_id: 'file-1', etag: 'revision' }); assert.deepEqual(result, { status: 'created', pluginId: plugin.id }); assert.equal(JSON.stringify(result).includes('private'), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('archive update validates confirmation and pins existing plugin', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); const file = join(folder, 'source.zip'); await writeFile(file, ZIP);
  try { const { plugins, calls } = setup(call => call.method === 'GET' ? plugin : call.route.endsWith('/upload-url') ? { file_id: 'file-1', etag: 'rev', upload_url: 'https://files.oaiusercontent.com/blob' } : {}); await assert.rejects(plugins.importArchive({ file, pluginId: plugin.id }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); await plugins.importArchive({ file, pluginId: plugin.id, confirmPluginId: plugin.id }); assert.equal(calls[1].body.plugin_id, plugin.id); assert.equal(calls[3].route, `/backend-api/public/plugins/workspace/${plugin.id}`); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('archive rejects symlinks and filename/magic mismatch before API use', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); await writeFile(join(folder, 'source.zip'), 'bad'); await symlink(join(folder, 'source.zip'), join(folder, 'link.zip'));
  try { const { plugins, calls } = setup(); await assert.rejects(plugins.importArchive({ file: join(folder, 'link.zip') }), error('FILE_READ_FAILED')); await assert.rejects(plugins.importArchive({ file: join(folder, 'source.zip') }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('archive upload failure never retries or finalizes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); const file = join(folder, 'source.zip'); await writeFile(file, ZIP);
  try { const { plugins, calls, transport } = setup(() => ({ file_id: 'file-1', etag: 'rev', upload_url: 'https://files.oaiusercontent.com/blob' })); let uploads = 0; transport.uploadSigned = async () => { uploads++; throw new Error('failed'); }; await assert.rejects(plugins.importArchive({ file })); assert.equal(calls.length, 1); assert.equal(uploads, 1); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('incomplete archive reservation stops before upload', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-')); const file = join(folder, 'source.zip'); await writeFile(file, ZIP);
  try { const { plugins, calls } = setup(() => ({ file_id: 'file-1', upload_url: 'https://files.oaiusercontent.com/blob' })); await assert.rejects(plugins.importArchive({ file }), error('INVALID_RESPONSE')); assert.equal(calls.length, 1); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('team APIs explicitly carry service-account and team scope', async () => { const { plugins, calls } = setup(); const args = { serviceAccountUserId: 'service-1', teamId: 'team-1', pluginId: plugin.id }; await plugins.teamList(args); await plugins.teamInstall(args); await plugins.teamUninstall({ ...args, confirmPluginId: plugin.id }); assert.equal(calls[0].route, '/backend-api/service-accounts/service-1/plugins/installed'); assert.equal(calls[1].route, `/backend-api/service-accounts/service-1/plugins/${plugin.id}/install`); assert.equal(calls[2].route, `/backend-api/service-accounts/service-1/plugins/${plugin.id}/uninstall`); assert.ok(calls.every(call => call.query.team_id === 'team-1' && call.expectedAccountId === 'account-1')); });
test('team plugin routes safely unwrap matching account-user composites', async () => { const { plugins, calls } = setup(); await plugins.teamList({ serviceAccountUserId: 'user-1__account-1', teamId: 'team-1' }); assert.equal(calls[0].route, '/backend-api/service-accounts/user-1/plugins/installed'); await assert.rejects(plugins.teamList({ serviceAccountUserId: 'user-1__other-account', teamId: 'team-1' }), error('ACCOUNT_CHANGED')); assert.equal(calls.length, 1); });
test('account mismatch stops plugin requests', async () => { const { plugins, calls } = setup(); await assert.rejects(plugins.home({ expectedAccountId: 'wrong' }), error('ACCOUNT_CHANGED')); assert.equal(calls.length, 0); });
test('plugin ID path traversal is rejected', async () => { const { plugins, calls } = setup(); for (const pluginId of ['../x', 'x/y', 'x?y', '']) await assert.rejects(plugins.get({ pluginId }), error('INVALID_ARGUMENT')); assert.equal(calls.length, 0); });
for (const [signedUrl, azure] of [
  ['https://storage.blob.core.windows.net/container/plugin.zip?sig=signed', true],
  ['https://sdmntprcentralus.oaiusercontent.com/files/example/raw?sig=signed', true],
  ['https://bucket.s3.us-east-1.amazonaws.com/plugin.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=signed', false],
  ['https://files.oaiusercontent.com/plugin.zip?sig=signed', true]
]) test(`archive import integrates real transport for ${new URL(signedUrl).hostname}`, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-transport-')), file = join(folder, 'source.zip'); await writeFile(file, ZIP);
  const calls = [];
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-1', accessToken: 'private-token' }), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (options.method === 'PUT') return new Response('', { status: 201 });
    const body = String(url).includes('/upload-url') ? { file_id: 'file-1', etag: 'etag', upload_url: signedUrl } : { plugin_id: plugin.id };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    await new DotPlugins({ transport }).importArchive({ file });
    assert.equal(calls.length, 3); assert.equal(calls[0].headers.Authorization, 'Bearer private-token'); assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].headers.Authorization, undefined); assert.equal(calls[1].headers['ChatGPT-Account-Id'], undefined); assert.equal(calls[1].headers.Cookie, undefined);
    assert.equal(calls[1].headers['Content-Type'], 'application/zip'); assert.equal(calls[1].headers['x-ms-blob-type'], azure ? 'BlockBlob' : undefined);
    assert.deepEqual(calls[1].body, ZIP); assert.equal(calls[1].redirect, 'manual'); assert.equal(calls[2].headers.Authorization, 'Bearer private-token');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

const token = subject => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;
async function uploadFixture(t, { phase = 'reserved', extra = {} } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'dot-plugin-journal-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'source.zip'), stateFile = join(folder, 'upload.json'); await writeFile(file, ZIP);
  const { createHash } = await import('node:crypto');
  const state = { schemaVersion: 1, kind: 'dot-plugin-archive-upload', phase, identity: { accountId: 'account-1', subject: 'user-1' }, source: { name: 'source.zip', sizeBytes: ZIP.length, sha256: createHash('sha256').update(ZIP).digest('hex') }, response: { file_id: 'file-1', etag: 'etag', upload_url: 'https://files.oaiusercontent.com/plugin.zip?sig=secret' }, ...extra };
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  const setupResult = setup(call => call.route.endsWith('/upload-url') ? state.response : { plugin_id: plugin.id });
  setupResult.transport.authLoader = async () => ({ accountId: 'account-1', accessToken: token('user-1') });
  return { folder, file, stateFile, state, ...setupResult };
}
test('CLI import requires exactly one journal before file/auth/API access', async () => {
  let auth = 0; const client = createClient({ transport: { request() { throw new Error('unexpected'); }, authLoader() { auth++; throw new Error('unexpected'); } } });
  await assert.rejects(client.importArchive({ file: '/missing.zip' }), error('INVALID_ARGUMENT'));
  await assert.rejects(client.importArchive({ file: '/missing.zip', stateFile: '/a', reservationFile: '/b' }), error('INVALID_ARGUMENT'));
  assert.equal(auth, 0);
});
test('captured reservation resumes one upload/finalization without reserving again', async t => {
  const { plugins, calls, file, stateFile } = await uploadFixture(t);
  const result = await plugins.importArchive({ file, reservationFile: stateFile });
  assert.deepEqual(result, { status: 'created', pluginId: plugin.id, resumed: true });
  assert.deepEqual(calls.map(x => x.method), ['SIGNED_PUT', 'POST']); assert.equal(calls[1].route, '/backend-api/public/plugins/workspace');
  const state = JSON.parse(await readFile(stateFile)); assert.equal(state.phase, 'complete'); assert.equal(state.response.upload_url, undefined); assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(await plugins.importArchive({ file, stateFile }), result); assert.equal(calls.length, 2);
});
test('fresh journal records every phase before the corresponding write', async t => {
  const { plugins, calls, transport, file, folder } = await uploadFixture(t), stateFile = join(folder, 'fresh.json');
  const phases = [];
  transport.request = async (method, route, options) => {
    phases.push(JSON.parse(await readFile(stateFile)).phase); calls.push({ method, route, ...options });
    return route.endsWith('/upload-url') ? { file_id: 'file-new', etag: 'etag', upload_url: 'https://files.oaiusercontent.com/plugin.zip?sig=secret' } : { plugin_id: plugin.id };
  };
  transport.uploadSigned = async () => { phases.push(JSON.parse(await readFile(stateFile)).phase); calls.push({ method: 'SIGNED_PUT' }); };
  await plugins.importArchive({ file, stateFile });
  assert.deepEqual(phases, ['reserving', 'uploading', 'finalizing']); assert.equal(JSON.parse(await readFile(stateFile)).phase, 'complete');
});
for (const phase of ['reserving', 'uploading', 'finalizing']) test(`uncertain ${phase} journal cannot repeat a write`, async t => {
  const { plugins, calls, file, stateFile } = await uploadFixture(t, { phase });
  await assert.rejects(plugins.importArchive({ file, stateFile }), e => e.code === 'RESERVATION_OUTCOME_UNKNOWN' && e.details.phase === phase); assert.equal(calls.length, 0);
  const status = await plugins.importStatus({ stateFile }); assert.equal(status.status, 'outcome_unknown'); assert.equal(status.canResume, false); assert.equal(JSON.stringify(status).includes('secret'), false);
});
test('uploaded journal skips upload and only finalizes once', async t => {
  const { plugins, calls, file, stateFile } = await uploadFixture(t, { phase: 'uploaded' }); await plugins.importArchive({ file, stateFile }); assert.deepEqual(calls.map(x => x.method), ['POST']);
});
for (const mismatch of ['account', 'subject', 'archive', 'name', 'size', 'target']) test(`upload journal binds ${mismatch} before writing`, async t => {
  const { plugins, calls, file, stateFile, state, transport } = await uploadFixture(t);
  if (mismatch === 'account') state.identity.accountId = 'other';
  if (mismatch === 'subject') transport.authLoader = async () => ({ accountId: 'account-1', accessToken: token('other') });
  if (mismatch === 'archive') state.source.sha256 = '0'.repeat(64);
  if (mismatch === 'name') state.source.name = 'other.zip';
  if (mismatch === 'size') state.source.sizeBytes++;
  if (mismatch === 'target') state.pluginId = plugin.id;
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(plugins.importArchive({ file, reservationFile: stateFile }), error(['account', 'subject'].includes(mismatch) ? 'ACCOUNT_CHANGED' : 'RESERVATION_MISMATCH')); assert.equal(calls.length, 0);
});
test('private journal rejects readable-by-others files and symlinks', async t => {
  const { plugins, calls, file, stateFile, folder } = await uploadFixture(t); const { chmod } = await import('node:fs/promises');
  await chmod(stateFile, 0o644); await assert.rejects(plugins.importArchive({ file, reservationFile: stateFile }), error('INVALID_RESERVATION'));
  await chmod(stateFile, 0o600); const link = join(folder, 'link.json'); await symlink(stateFile, link); await assert.rejects(plugins.importArchive({ file, reservationFile: link }), error('INVALID_RESERVATION')); assert.equal(calls.length, 0);
});
test('failed upload keeps the write barrier and does not finalize or retry', async t => {
  const { plugins, calls, transport, file, stateFile } = await uploadFixture(t); let uploads = 0;
  transport.uploadSigned = async () => { uploads++; throw new Error('network'); };
  await assert.rejects(plugins.importArchive({ file, stateFile })); assert.equal(JSON.parse(await readFile(stateFile)).phase, 'uploading');
  await assert.rejects(plugins.importArchive({ file, stateFile }), error('RESERVATION_OUTCOME_UNKNOWN')); assert.equal(uploads, 1); assert.equal(calls.length, 0);
});
test('failed finalization keeps its write barrier and cannot retry', async t => {
  const { plugins, calls, transport, file, stateFile } = await uploadFixture(t, { phase: 'uploaded' });
  transport.request = async () => { calls.push({ method: 'POST' }); throw new Error('network'); };
  await assert.rejects(plugins.importArchive({ file, stateFile })); assert.equal(JSON.parse(await readFile(stateFile)).phase, 'finalizing');
  await assert.rejects(plugins.importArchive({ file, stateFile }), error('RESERVATION_OUTCOME_UNKNOWN')); assert.equal(calls.length, 1);
});
test('missing reservation receipt cannot silently create a replacement', async t => {
  const { plugins, calls, file, folder } = await uploadFixture(t);
  await assert.rejects(plugins.importArchive({ file, reservationFile: join(folder, 'missing.json') }), error('INVALID_RESERVATION')); assert.equal(calls.length, 0);
});
test('incomplete reservation is captured and is never reserved again', async t => {
  const { plugins, calls, file, folder, transport } = await uploadFixture(t); const stateFile = join(folder, 'incomplete.json');
  transport.request = async () => { calls.push({ method: 'POST' }); return { file_id: 'known-file', etag: 'known-etag' }; };
  await assert.rejects(plugins.importArchive({ file, stateFile }), error('INVALID_RESPONSE'));
  const state = JSON.parse(await readFile(stateFile)); assert.equal(state.phase, 'reserving'); assert.equal(state.response.file_id, 'known-file');
  await assert.rejects(plugins.importArchive({ file, stateFile }), error('RESERVATION_OUTCOME_UNKNOWN')); assert.equal(calls.length, 1);
});
test('actual finalization with unsaved receipt reports the acknowledged plugin ID', async t => {
  const { plugins, transport, file, stateFile, folder } = await uploadFixture(t, { phase: 'uploaded' });
  const { rename } = await import('node:fs/promises'); const held = join(folder, 'held.json');
  transport.request = async () => { await rename(stateFile, held); await symlink(held, stateFile); return { plugin_id: plugin.id }; };
  await assert.rejects(plugins.importArchive({ file, stateFile }), e => e.code === 'IMPORT_RECEIPT_NOT_SAVED' && e.details.delivery === 'acknowledged' && e.details.stage === 'finalization' && e.details.pluginId === plugin.id);
  assert.equal(JSON.parse(await readFile(held)).phase, 'finalizing');
});
test('concurrent importers cannot share the same reservation', async t => {
  const { plugins, transport, file, stateFile } = await uploadFixture(t); let release; const pending = new Promise(r => { release = r; });
  let started; const start = new Promise(r => { started = r; }); transport.uploadSigned = async () => { started(); await pending; };
  const first = plugins.importArchive({ file, stateFile }); await start;
  await assert.rejects(plugins.importArchive({ file, stateFile }), error('RESERVATION_BUSY')); release(); await first;
});
test('journal binds the real transport before its first authenticated request', async t => {
  const { file, stateFile } = await uploadFixture(t, { phase: 'uploaded' }); let authReads = 0, writes = 0;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account-1', accessToken: token(++authReads <= 3 ? 'user-1' : 'user-2') }), fetchImpl: async () => { writes++; return new Response(JSON.stringify({ plugin_id: plugin.id }), { headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(new DotPlugins({ transport }).importArchive({ file, stateFile }), error('AUTH_IDENTITY_CHANGED'));
  assert.equal(authReads, 4); assert.equal(writes, 0); assert.equal(JSON.parse(await readFile(stateFile)).phase, 'finalizing');
});
test('resolve-app reads the native mapping with account and app binding', async () => {
  const appId='connector-1';const {plugins,calls}=setup(()=>({plugin_id:plugin.id,plugin:{...plugin,canonical_app_id:appId,connector_id:appId,client_secret:'private'}}));
  const result=await plugins.resolveApp({appId});assert.equal(calls[0].route,`${ROOT}/canonical-app/${appId}`);assert.equal(calls[0].method,'GET');assert.equal(calls[0].expectedAccountId,'account-1');assert.equal(calls[0].headers['X-Codex-Surface'],'other');assert.equal(result.pluginId,plugin.id);assert.equal(result.plugin.client_secret,undefined);
});
test('resolve-app supports an explicit absent mapping', async () => {
  const {plugins}=setup(()=>({plugin_id:null,plugin:null}));assert.deepEqual(await plugins.resolveApp({appId:'app-1'}),{appId:'app-1',pluginId:null,plugin:null});
});
for(const result of [{}, {plugin_id:null,plugin}, {plugin_id:plugin.id,plugin:{...plugin,id:'other'}}, {plugin_id:plugin.id,plugin:{...plugin,canonical_app_id:'other'}}, {plugin_id:plugin.id,plugin:{...plugin,connector_id:'other'}}])test('resolve-app rejects inconsistent response '+JSON.stringify(result),async()=>{
  const {plugins}=setup(()=>result);await assert.rejects(plugins.resolveApp({appId:'app-1'}),error('INVALID_RESPONSE'));
});
test('resolve-app validates app ID before network access',async()=>{const {plugins,calls}=setup();await assert.rejects(plugins.resolveApp({appId:'../other'}),error('INVALID_ARGUMENT'));assert.equal(calls.length,0);});
test('ordinary plugin mutations pin the user before their preflight read',async()=>{
  let authReads=0,requests=0;
  const transport=new Transport({authLoader:async()=>({accountId:'account-1',accessToken:token(++authReads===1?'user-1':'user-2')}),fetchImpl:async()=>{requests++;return new Response(JSON.stringify(plugin),{headers:{'content-type':'application/json'}});}});
  await assert.rejects(new DotPlugins({transport}).delete({pluginId:plugin.id,confirmPluginId:plugin.id}),error('AUTH_IDENTITY_CHANGED'));assert.equal(requests,0);
});

