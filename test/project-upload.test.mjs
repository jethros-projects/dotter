import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, symlink, rm, realpath, chmod, truncate, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectUpload, projectUploadCapabilities } from '../src/project-upload.mjs';
import { DotError } from '../src/errors.mjs';

const ACCOUNT = 'account_test';
const SUBJECT = 'subject_test';
const PROJECT = 'g-p-project_upload';
const FILE_ID = 'file_project_upload';
const CONTENT = Buffer.from('Native project upload verification\n');
const HASH = createHash('sha256').update(CONTENT).digest('hex');
const SIGNED_URL = 'https://files.oaiusercontent.com/project-test?sig=private-upload-secret';
const auth = (accountId = ACCOUNT, subject = SUBJECT) => ({ accountId, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.private-token` });
const membership = (structure = 'personal') => ({ accounts: { [ACCOUNT]: { account: { account_id: ACCOUNT, account_user_id: structure === 'personal' ? `${SUBJECT}__${ACCOUNT}` : SUBJECT, structure }, can_access_with_session: true } } });
const reserve = (extra = {}) => ({ file_id: FILE_ID, upload_url: SIGNED_URL, upload_headers: {}, ...extra });
const event = (name = 'file.processing.completed', extra = {}, fileId = FILE_ID) => JSON.stringify({ event: name, file_id: fileId, extra });
const member = (extra = {}) => ({ file_response_type: 'full_file_response', file_id: FILE_ID, name: 'canary.txt', size: CONTENT.length, type: 'text/plain', ...extra });
const project = (files = [], gizmo = {}, extra = {}) => ({ gizmo: { id: PROJECT, gizmo_type: 'snorlax', display: { name: 'Upload project', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: SUBJECT }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global', ...gizmo }, files, project_file_limits: { max_file_limit: 25 }, ...extra });
const unknown = () => new DotError('NETWORK_ERROR', 'Request delivery is unknown.', { delivery: 'unknown' });

async function setup(t, extra = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dot-project-upload-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'canary.txt'), stateFile = join(dir, 'upload.json');
  await writeFile(file, CONTENT);
  return { dir, file, stateFile, accountId: ACCOUNT, projectId: PROJECT, ...extra };
}

function client({ reserveResult = reserve(), stream = `${event()}\n`, uploadResult = { uploaded: true, sizeBytes: CONTENT.length },
  projectResult, initialProject = project(), attachResult, onCall, currentAuth = auth(), account = membership(),
  accountSettings = { permissions: null }, userSettings = { flags: { file_library_enabled_for_registration_country: true } },
  models = { models: [{ slug: 'gpt-4o', tags: [], product_features: { attachments: { type: 'retrieval', accepted_mime_types: ['text/plain'] } } }], default_model_slug: 'gpt-4o' },
  partResult = { uploaded: true }, commitResult = { committed: true } } = {}) {
  const calls = [];
  const api = { calls, currentAuth, currentProject: initialProject, account, transport: {
    async authLoader() { return api.currentAuth; },
    assertIdentity() {},
    async request(method, route, options = {}) {
      const call = { kind: 'request', method, route, ...options }; calls.push(call); await onCall?.(call);
      let value;
      if (method === 'GET' && route === '/backend-api/accounts/check/v4-2023-04-27') value = api.account;
      else if (method === 'GET' && route === `/backend-api/accounts/${ACCOUNT}/settings`) value = accountSettings;
      else if (method === 'GET' && route === '/backend-api/settings/user') value = userSettings;
      else if (method === 'GET' && route === '/backend-api/models') value = models;
      else if (method === 'GET' && route === `/backend-api/gizmos/${PROJECT}`) value = projectResult ?? api.currentProject;
      else if (method === 'POST' && route === '/backend-api/files') value = reserveResult;
      else if (method === 'POST' && route === '/backend-api/files/process_upload_stream') value = stream;
      else if (method === 'POST' && route === `/backend-api/projects/${PROJECT}/files`) {
        if (attachResult === undefined) {
          api.currentProject = { ...api.currentProject, files: [...api.currentProject.files, ...options.body.files.map(item => ({ file_response_type: 'full_file_response', ...item }))] };
          value = { resource: api.currentProject };
        } else value = attachResult;
      } else throw new Error(`Unexpected ${method} ${route}`);
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(call, api) : value;
    },
    async uploadSignedFile(url, options = {}) {
      const call = { kind: 'signed-upload', url, ...options }; calls.push(call); await onCall?.(call);
      if (uploadResult instanceof Error) throw uploadResult;
      return typeof uploadResult === 'function' ? uploadResult(call, api) : uploadResult;
    },
    async uploadEstuaryFile(url, options = {}) {
      const call = { kind: 'estuary-upload', url, ...options }; calls.push(call); await onCall?.(call);
      if (uploadResult instanceof Error) throw uploadResult;
      return typeof uploadResult === 'function' ? uploadResult(call, api) : uploadResult;
    },
    async uploadAzureBlock(url, options = {}) {
      const call = { kind: 'azure-block', url, ...options }; calls.push(call); await onCall?.(call);
      if (partResult instanceof Error) throw partResult;
      return typeof partResult === 'function' ? partResult(call, api) : partResult;
    },
    async commitAzureBlocks(url, options = {}) {
      const call = { kind: 'azure-commit', url, ...options }; calls.push(call); await onCall?.(call);
      if (commitResult instanceof Error) throw commitResult;
      return typeof commitResult === 'function' ? commitResult(call, api) : commitResult;
    },
  } };
  api.upload = new ProjectUpload(api);
  return api;
}
async function journal(options) { return JSON.parse(await readFile(options.stateFile, 'utf8')); }
const callsTo = (api, method, route) => api.calls.filter(call => call.method === method && call.route === route);
const writes = api => api.calls.filter(call => call.kind !== 'request' || call.method !== 'GET');

test('native project upload reserves project-scoped bytes and attaches only after processing succeeds', async t => {
  const options = await setup(t), api = client({ reserveResult: reserve({ upload_headers: { 'x-ms-version': '2020-04-08' } }) });
  const result = await api.upload.upload(options);
  const reservations = callsTo(api, 'POST', '/backend-api/files');
  const processing = callsTo(api, 'POST', '/backend-api/files/process_upload_stream');
  const attachments = callsTo(api, 'POST', `/backend-api/projects/${PROJECT}/files`);
  assert.equal(reservations.length, 1); assert.equal(processing.length, 1); assert.equal(attachments.length, 1);
  assert.equal(reservations[0].body.use_case, 'gizmo'); assert.equal(reservations[0].body.gizmo_id, PROJECT);
  assert.equal(reservations[0].body.file_name, 'canary.txt'); assert.equal(reservations[0].body.file_size, CONTENT.length);
  assert.deepEqual(reservations[0].headers, { 'chatgpt-project-id': PROJECT });
  assert.deepEqual(Object.keys(reservations[0].body).sort(), ['file_name', 'file_size', 'gizmo_id', 'mime_type', 'reset_rate_limits', 'supports_direct_azure_multipart', 'timezone_offset_min', 'use_case']);
  assert.notEqual(reservations[0].body.library_persistence_mode, 'required');
  assert.equal(processing[0].body.use_case, 'gizmo'); assert.equal(processing[0].body.entry_surface, 'project_sources');
  assert.notEqual(processing[0].body.library_persistence_mode, 'required');
  assert.equal(processing[0].body.file_id, FILE_ID);
  assert.deepEqual(processing[0].headers, { 'chatgpt-project-id': PROJECT });
  assert.equal(processing[0].body.gizmo_id, PROJECT);
  assert.equal(processing[0].body.index_for_retrieval, true);
  const bytes = api.calls.find(call => call.kind === 'signed-upload');
  assert.equal(bytes.url, SIGNED_URL); assert.equal(bytes.source.path, options.file); assert.equal(bytes.source.sizeBytes, CONTENT.length); assert.equal(bytes.source.sha256, HASH);
  assert.equal(bytes.contentType, 'text/plain'); assert.deepEqual(bytes.requiredHeaders, { 'x-ms-version': '2020-04-08' });
  assert.equal(Object.hasOwn(bytes, 'bytes'), false);
  assert.deepEqual(attachments[0].body.files.map(value => ({ file_id: value.file_id, name: value.name, type: value.type, location: value.location })), [{ file_id: FILE_ID, name: 'canary.txt', type: 'text/plain', location: 'fs' }]);
  assert.ok(api.calls.indexOf(bytes) > api.calls.indexOf(reservations[0]));
  assert.ok(api.calls.indexOf(processing[0]) > api.calls.indexOf(bytes));
  assert.ok(api.calls.indexOf(attachments[0]) > api.calls.indexOf(processing[0]));
  assert.equal(result.completed, true); assert.equal(result.projectId, PROJECT); assert.equal(result.fileId, FILE_ID);
  assert.equal(result.membershipVerified, true); assert.equal(result.remoteContentHashVerified, false);
  assert.equal(result.storageDeletionRequested, false); assert.equal(result.unattachedFileMayRemain, false);
  assert.equal((await journal(options)).phase, 'complete');
  assert.equal((await lstat(options.stateFile)).mode & 0o777, 0o600);
  assert.equal((await journal(options)).identity.subjectSha256, createHash('sha256').update(SUBJECT).digest('hex'));
  assert.equal((await journal(options)).identity.subject, undefined);
  assert.equal(api.calls.some(call => call.route?.includes('/files/library/')), false);
  assert.ok(api.calls.filter(call => call.kind === 'request').every(call => call.expectedAccountId === ACCOUNT));
});

test('capabilities declare bounded direct project upload and separate read-only recovery operations', () => {
  assert.throws(() => new ProjectUpload({}), TypeError);
  const capabilities = projectUploadCapabilities();
  assert.deepEqual(capabilities.supported, ['upload', 'status', 'reconcile']);
  assert.equal(capabilities.maxBytes, 512 * 1024 * 1024);
  assert.equal(capabilities.liveVerified, false);
});

test('processing may return temporary storage with no Library identity for a project file', async t => {
  const options = await setup(t), api = client({ stream: `${event('file.processing.file_ready')}\n${event('file.processing.completed', { library_persistence_result: 'temporary' })}\n` });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true);
  assert.equal(api.calls.some(call => call.route?.includes('/files/library/')), false);
  const body = callsTo(api, 'POST', `/backend-api/projects/${PROJECT}/files`)[0].body.files[0];
  assert.ok(body.library_file_id == null);
});

test('processing-provided Library mapping is preserved without requiring a Library read', async t => {
  const options = await setup(t), api = client({ stream: `${event('file.processing.completed', { metadata_object_id: 'library-project-1' })}\n` });
  await api.upload.upload(options);
  assert.equal(callsTo(api, 'POST', `/backend-api/projects/${PROJECT}/files`)[0].body.files[0].library_file_id, 'library-project-1');
  assert.equal(api.calls.some(call => call.route?.includes('/files/library/')), false);
});

test('each mutation starts only after its operation phase is durably saved', async t => {
  const options = await setup(t), seen = [];
  const api = client({ onCall: async call => {
    if (call.kind !== 'request' || call.method !== 'GET') seen.push([call.kind, call.route, (await journal(options)).phase]);
  } });
  await api.upload.upload(options);
  assert.deepEqual(seen.map(item => item[2]), ['reserving', 'uploading', 'processing', 'attaching']);
});

for (const [stage, configuration, phase] of [
  ['reservation', { reserveResult: unknown() }, 'reserving'],
  ['storage upload', { uploadResult: unknown() }, 'uploading'],
  ['processing', { stream: unknown() }, 'processing'],
]) test(`unknown ${stage} delivery remains non-replayable on the next invocation`, async t => {
  const options = await setup(t), first = client(configuration);
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, phase);
  const resumed = client();
  await assert.rejects(resumed.upload.upload(options));
  assert.equal(writes(resumed).length, 0);
});

test('unknown membership attachment can be reconciled by exact project membership without repeating writes', async t => {
  const options = await setup(t);
  const api = client({ attachResult: (_call, state) => { state.currentProject = project([member()]); throw unknown(); } });
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, 'attaching');
  const resumed = client({ initialProject: project([member()]) });
  const result = await resumed.upload.reconcile(options);
  assert.equal(result.completed, true); assert.equal(writes(resumed).length, 0);
  assert.equal((await journal(options)).phase, 'complete');
});

test('unknown attachment that is not present never triggers a second membership POST', async t => {
  const options = await setup(t), api = client({ attachResult: unknown() });
  await assert.rejects(api.upload.upload(options));
  const resumed = client();
  await assert.rejects(resumed.upload.upload(options));
  assert.equal(writes(resumed).length, 0);
});

for (const [label, stream] of [
  ['incomplete processing', `${event('file.processing.file_ready')}\n`],
  ['another general file', `${event('file.processing.completed', {}, 'file_other')}\n`],
  ['malformed NDJSON', '{not-json}\n'],
  ['explicit processing failure', `${event('file.processing.error', { error_code: 'internal_error' })}\n`],
  ['conflicting Library identities', `${event('file.processing.file_ready', { metadata_object_id: 'library-one' })}\n${event('file.processing.completed', { metadata_object_id: 'library-two' })}\n`],
]) test(`${label} cannot authorize project membership attachment`, async t => {
  const options = await setup(t), api = client({ stream });
  await assert.rejects(api.upload.upload(options));
  assert.equal(callsTo(api, 'POST', `/backend-api/projects/${PROJECT}/files`).length, 0);
  assert.equal((await journal(options)).phase, 'processing');
});

for (const [label, value] of [
  ['missing file ID', reserve({ file_id: null })],
  ['invalid general file ID', reserve({ file_id: '../other' })],
  ['untrusted storage origin', reserve({ upload_url: 'https://attacker.example/upload?sig=x' })],
  ['credential-bearing storage URL', reserve({ upload_url: 'https://user:pass@files.oaiusercontent.com/upload?sig=x' })],
  ['unsafe required headers', reserve({ upload_headers: { Authorization: 'Bearer secret' } })],
]) test(`${label} in a reservation cannot upload bytes`, async t => {
  const options = await setup(t), api = client({ reserveResult: value });
  await assert.rejects(api.upload.upload(options));
  assert.equal(api.calls.filter(call => call.kind !== 'request').length, 0);
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream').length, 0);
});

test('changed source bytes and wrong saved identity cannot resume an upload', async t => {
  for (const changed of ['source', 'account', 'subject', 'project']) {
    const options = await setup(t), first = client({ uploadResult: unknown() });
    await assert.rejects(first.upload.upload(options));
    if (changed === 'source') await writeFile(options.file, 'Different local data\n');
    const resumed = client({ currentAuth: changed === 'account' ? auth('other-account') : changed === 'subject' ? auth(ACCOUNT, 'other-subject') : auth() });
    await assert.rejects(resumed.upload.upload({ ...options, ...(changed === 'project' ? { projectId: 'g-p-other' } : {}) }));
    assert.equal(writes(resumed).length, 0);
  }
});

test('status and reconciliation reject a different signed-in subject for the saved upload', async t => {
  const options = await setup(t), first = client({ stream: unknown() });
  await assert.rejects(first.upload.upload(options));
  for (const method of ['status', 'reconcile']) {
    const changed = client({ currentAuth: auth(ACCOUNT, 'other-subject') });
    await assert.rejects(changed.upload[method](options));
    assert.equal(writes(changed).length, 0);
  }
});

test('completed resume and status never disclose authentication or signed storage credentials', async t => {
  const options = await setup(t), api = client();
  const result = await api.upload.upload(options);
  const status = await api.upload.status(options);
  const resumed = client({ initialProject: api.currentProject });
  const complete = await resumed.upload.upload(options);
  for (const output of [result, status, complete]) assert.doesNotMatch(JSON.stringify(output), /private-token|private-upload-secret|header\./);
  assert.equal(complete.completed, true); assert.equal(writes(resumed).length, 0);
  const state = await journal(options);
  assert.doesNotMatch(JSON.stringify(state), /private-token|header\./);
});

test('unsafe source and state files fail before any request or upload reservation', async t => {
  const options = await setup(t), link = join(options.dir, 'source-link.txt'), empty = join(options.dir, 'empty.txt'), large = join(options.dir, 'large.bin');
  await symlink(options.file, link); await writeFile(empty, ''); await writeFile(large, ''); await truncate(large, 512 * 1024 * 1024 + 1);
  for (const file of [link, empty, large, options.dir]) {
    const api = client(); await assert.rejects(api.upload.upload({ ...options, file })); assert.equal(writes(api).length, 0);
  }
  await symlink(options.file, options.stateFile);
  const linked = client(); await assert.rejects(linked.upload.upload(options)); assert.equal(writes(linked).length, 0);
  await rm(options.stateFile);
  await client().upload.upload(options);
  await chmod(options.stateFile, 0o644);
  const exposed = client(); await assert.rejects(exposed.upload.status(options)); assert.equal(writes(exposed).length, 0);
});

test('a live operation lock or lock symlink cannot start a second upload', async t => {
  const options = await setup(t), lock = `${options.stateFile}.lock`;
  await writeFile(lock, 'busy');
  const active = client(); await assert.rejects(active.upload.upload(options)); assert.equal(writes(active).length, 0);
  assert.equal(await readFile(lock, 'utf8'), 'busy');
  await rm(lock); await symlink(options.file, lock);
  const linked = client(); await assert.rejects(linked.upload.upload(options)); assert.equal(writes(linked).length, 0);
  assert.deepEqual(await readFile(options.file), CONTENT);
});

test('workspace policy denial, unreadable projects and capacity exhaustion cannot reserve or upload bytes', async t => {
  for (const config of [
    { account: membership('workspace'), accountSettings: { permissions: [] } },
    { initialProject: project([], { current_user_permission: { can_read: false, can_write: true } }) },
    { initialProject: project([], { current_user_permission: { can_read: true, can_write: false } }) },
    { initialProject: project([{ id: 'existing' }], {}, { project_file_limits: { max_file_limit: 1 } }) },
    { initialProject: project([], {}, { project_file_limits: [] }) },
  ]) {
    const options = await setup(t), api = client(config);
    await assert.rejects(api.upload.upload(options)); assert.equal(writes(api).length, 0);
  }
});

test('abort before reservation or identity rotation during processing never authorizes a new write', async t => {
  const options = await setup(t), controller = new AbortController(); controller.abort();
  const aborted = client(); await assert.rejects(aborted.upload.upload({ ...options, signal: controller.signal })); assert.equal(writes(aborted).length, 0);
  const rotated = client({ stream: (_call, state) => { state.currentAuth = auth(ACCOUNT, 'other-subject'); return `${event()}\n`; } });
  await assert.rejects(rotated.upload.upload(options));
  assert.equal(callsTo(rotated, 'POST', `/backend-api/projects/${PROJECT}/files`).length, 0);
});

test('model attachment policy is fetched with native query parameters before reservation and processing', async t => {
  const options = await setup(t), api = client();
  await api.upload.upload(options);
  const policyCalls = callsTo(api, 'GET', '/backend-api/models');
  assert.equal(policyCalls.length, 2);
  assert.ok(policyCalls.every(call => JSON.stringify(call.query) === JSON.stringify({ iim: false, include_icons: false, is_gizmo: false })));
  assert.ok(api.calls.indexOf(policyCalls[0]) < api.calls.indexOf(callsTo(api, 'POST', '/backend-api/files')[0]));
  assert.ok(api.calls.indexOf(policyCalls[1]) < api.calls.indexOf(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0]));
});

for (const [label, models] of [
  ['gpt4o-tagged model', { models: [{ slug: 'custom-four', tags: ['gpt4o'], product_features: { attachments: { type: 'retrieval', accepted_mime_types: ['text/plain'] } } }] }],
  ['explicit default model', { models: [{ slug: 'chosen-default', product_features: { attachments: { type: 'retrieval', accepted_mime_types: ['text/plain'] } } }], default_model_slug: 'chosen-default' }],
]) test(`indexing uses the native ${label} fallback when gpt-4o is unavailable`, async t => {
  const options = await setup(t), api = client({ models });
  await api.upload.upload(options);
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0].body.index_for_retrieval, true);
});

test('an unavailable retrieval MIME permits raw project attachment without falsely requesting indexing', async t => {
  const options = await setup(t), api = client({ models: { models: [{ slug: 'gpt-4o', product_features: { attachments: { type: 'retrieval', accepted_mime_types: ['application/pdf'] } } }] } });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.indexForRetrieval, false);
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0].body.index_for_retrieval, false);
});

test('native indexing extension mapping is distinct from the declared transfer MIME', async t => {
  const options = await setup(t), python = join(options.dir, 'example.py'); await writeFile(python, CONTENT);
  const api = client({ models: { models: [{ slug: 'gpt-4o', product_features: { attachments: { type: 'retrieval', accepted_mime_types: ['text/x-script.python'] } } }] } });
  await api.upload.upload({ ...options, file: python, mimeType: 'text/plain' });
  assert.equal(callsTo(api, 'POST', '/backend-api/files')[0].body.mime_type, 'text/plain');
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0].body.index_for_retrieval, true);
});

test('project-specific spreadsheet ingestion can enable retrieval independently of the catalog MIME list', async t => {
  const options = await setup(t), csv = join(options.dir, 'table.csv'); await writeFile(csv, CONTENT);
  const api = client({ initialProject: project([], { use_injest_path: true }), models: { models: [{ slug: 'gpt-4o', product_features: { attachments: { type: 'retrieval', accepted_mime_types: [] } } }] } });
  const result = await api.upload.upload({ ...options, file: csv });
  assert.equal(result.indexForRetrieval, true);
});

test('processing uses a fresh catalog policy after bytes are uploaded', async t => {
  const options = await setup(t); let policyRead = 0;
  const api = client({ models: () => ({ models: [{ slug: 'gpt-4o', product_features: { attachments: { type: 'retrieval', accepted_mime_types: ++policyRead === 1 ? ['text/plain'] : [] } } }] }) });
  const result = await api.upload.upload(options);
  assert.equal(result.indexForRetrieval, false);
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0].body.index_for_retrieval, false);
});

for (const [label, models] of [
  ['missing model collection', {}],
  ['duplicate model identities', { models: [{ slug: 'gpt-4o' }, { slug: 'gpt-4o' }] }],
  ['nonarray model tags', { models: [{ slug: 'gpt-4o', tags: 'gpt4o' }] }],
  ['malformed MIME list', { models: [{ slug: 'gpt-4o', product_features: { attachments: { type: 'retrieval', accepted_mime_types: {} } } }] }],
]) test(`${label} prevents an unverifiable upload reservation`, async t => {
  const options = await setup(t), api = client({ models });
  await assert.rejects(api.upload.upload(options));
  assert.equal(writes(api).length, 0);
});

const policyModel = (slug, retrieval = true, extra = {}) => ({ slug, tags: [], product_features: { attachments: { type: 'retrieval', accepted_mime_types: retrieval ? ['text/plain'] : ['application/pdf'] } }, ...extra });

for (const [label, catalog] of [
  ['preferred gpt-4o before explicit default', { models: [policyModel('other', false), policyModel('gpt-4o')], default_model_slug: 'other' }],
  ['gpt4o-tagged model before explicit default', { models: [policyModel('other', false), policyModel('tagged', true, { tags: ['gpt4o'] })], default_model_slug: 'other' }],
  ['instant preset through a matching auto category', { models: [policyModel('instant', false), policyModel('automatic')], versions: [{ id: 'v1', slugs: ['instant', 'automatic'], intelligence_presets: [{ lane: 'instant', model_slug: 'instant' }] }], categories: [{ model_lane: 'auto', default_model: 'automatic' }] }],
  ['instant preset ignores auto categories outside its version', { models: [policyModel('instant'), policyModel('wrong-auto', false)], versions: [{ id: 'v1', slugs: ['instant'], intelligence_presets: [{ lane: 'instant', model_slug: 'instant' }] }], categories: [{ model_lane: 'auto', default_model: 'wrong-auto' }] }],
  ['thinking preset directly', { models: [policyModel('other', false), policyModel('thinking')], versions: [{ id: 'v1', slugs: ['thinking'], intelligence_presets: [{ lane: 'thinking', model_slug: 'thinking' }] }] }],
  ['built-in o3 preset', { models: [policyModel('other', false), policyModel('o3')], versions: [{ id: 'o3', slugs: ['o3'] }] }],
  ['last enabled category default', { models: [policyModel('first', false), policyModel('last')], categories: [{ default_model: 'first' }, { default_model: 'last' }, { default_model: 'first', disabled_by_admin: true }] }],
  ['last category first supported model', { models: [policyModel('first', false), policyModel('supported')], categories: [{ default_model: 'first' }, { supported_models: [null, 'supported', 'first'] }] }],
  ['first available model after null entries', { models: [null, policyModel('first'), policyModel('later', false)] }],
]) test(`native default-model selection uses ${label}`, async t => {
  const options = await setup(t), api = client({ models: catalog });
  const result = await api.upload.upload(options);
  assert.equal(result.indexForRetrieval, true);
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0].body.index_for_retrieval, true);
});

test('empty or unresolved native model policy permits an unindexed project source', async t => {
  for (const models of [{ models: [] }, { models: [{ slug: 'unselected' }] }, { models: [policyModel('available')], default_model_slug: 'missing' }]) {
    const options = await setup(t), api = client({ models });
    const result = await api.upload.upload(options);
    assert.equal(result.completed, true); assert.equal(result.indexForRetrieval, false);
  }
});

test('project product_features cannot substitute for a native model attachment policy', async t => {
  const options = await setup(t), product_features = { attachments: { type: 'retrieval', accepted_mime_types: ['text/plain'] } };
  const api = client({ initialProject: project([], { product_features }, { product_features }), models: { models: [{ slug: 'gpt-4o' }] } });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.indexForRetrieval, false);
});

test('raw-file fallback requires an exact prior ready event and explicit fallback availability', async t => {
  const options = await setup(t), api = client({ stream: `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: true, library_persistence_result: 'temporary' })}\n` });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.retrievalIndexingUnavailable, true); assert.equal(result.indexed, false);
  for (const stream of [event('file.indexing.error', { raw_file_fallback_available: true }), `${event('file.processing.file_ready')}\n${event('file.indexing.error', { raw_file_fallback_available: false })}`]) {
    const rejectedOptions = await setup(t), rejected = client({ stream });
    await assert.rejects(rejected.upload.upload(rejectedOptions));
    assert.equal(callsTo(rejected, 'POST', `/backend-api/projects/${PROJECT}/files`).length, 0);
  }
});

for (const [label, bad] of [
  ['wrong name', member({ name: 'different.txt' })],
  ['wrong byte count', member({ size: CONTENT.length + 1 })],
  ['different MIME', member({ type: 'application/pdf' })],
]) test(`accepted attachment with ${label} remains incomplete until matching readback`, async t => {
  const options = await setup(t), api = client({ attachResult: (_call, state) => { state.currentProject = project([bad]); return { resource: state.currentProject }; } });
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, 'attached');
  const resumed = client({ initialProject: project([bad]) });
  await assert.rejects(resumed.upload.reconcile(options));
  assert.equal(writes(resumed).length, 0);
});

for (const [label, value, fields, metadataAvailable] of [
  ['missing byte count', member({ size: undefined }), ['file_id', 'name', 'type'], true],
  ['missing all optional full-file metadata', { file_response_type: 'full_file_response', file_id: FILE_ID }, ['file_id'], true],
  ['opaque native file identity', { id: FILE_ID }, ['file_id'], false],
]) test(`exact membership with ${label} completes and reports only the fields actually verified`, async t => {
  const options = await setup(t), api = client({ attachResult: (_call, state) => { state.currentProject = project([value]); return { resource: state.currentProject }; } });
  const result = await api.upload.upload(options);
  assert.equal(result.completed, true); assert.equal(result.membershipVerified, true);
  assert.deepEqual(result.verifiedFields, fields); assert.equal(result.metadataAvailable, metadataAvailable);
  assert.equal(result.remoteContentHashVerified, false);
  const status = await api.upload.status(options);
  assert.deepEqual(status.verifiedFields, fields); assert.equal(status.metadataAvailable, metadataAvailable);
  assert.equal(status.remoteContentHashVerified, false);
});

test('a processing-supplied Library mapping must match the exact final project member', async t => {
  const options = await setup(t), api = client({ stream: event('file.processing.completed', { metadata_object_id: 'library-expected' }), attachResult: (_call, state) => { state.currentProject = project([member({ library_file_id: 'library-other' })]); return { resource: state.currentProject }; } });
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, 'attached');
});

test('losing a previous project source cannot be certified as a successful attachment', async t => {
  const options = await setup(t), api = client({ initialProject: project([{ id: 'existing' }]), attachResult: (_call, state) => { state.currentProject = project([member()]); return { resource: state.currentProject }; } });
  await assert.rejects(api.upload.upload(options));
  const resumed = client({ initialProject: project([member()]) });
  await assert.rejects(resumed.upload.reconcile(options));
  assert.equal(writes(resumed).length, 0);
});

test('read-only reconciliation cannot infer a valid processing receipt from project membership alone', async t => {
  const options = await setup(t), first = client({ stream: unknown() });
  await assert.rejects(first.upload.upload(options));
  const resumed = client({ initialProject: project([member()]) });
  const result = await resumed.upload.reconcile(options);
  assert.equal(result.completed, false); assert.equal(result.reconciled, false);
  assert.equal(writes(resumed).length, 0);
});

test('a failed reservation receipt save stops before any bytes are uploaded', async t => {
  const options = await setup(t), backup = join(options.dir, 'saved-journal.json');
  const api = client({ reserveResult: async () => { await rename(options.stateFile, backup); await symlink(options.file, options.stateFile); return reserve(); } });
  await assert.rejects(api.upload.upload(options));
  assert.equal(api.calls.filter(call => call.kind !== 'request').length, 0);
  assert.deepEqual(await readFile(options.file), CONTENT);
});

const azureUrl = 'https://project-test.blob.core.windows.net/uploads/source?sig=private-azure-secret';
const partSize = Math.ceil(CONTENT.length / 2);
const multipartReservation = (changes = {}) => reserve({ upload_url: azureUrl, direct_library_upload_strategy: { kind: 'direct_azure_multipart', part_size_bytes: partSize, part_count: 2, max_part_concurrency: 1 }, ...changes });

test('server-issued Azure multipart streams verified ranges and commits ordered deterministic block IDs', async t => {
  const options = await setup(t), api = client({ reserveResult: multipartReservation() });
  const result = await api.upload.upload(options);
  const blocks = api.calls.filter(call => call.kind === 'azure-block'), commits = api.calls.filter(call => call.kind === 'azure-commit');
  assert.equal(blocks.length, 2); assert.equal(commits.length, 1); assert.equal(api.calls.some(call => call.kind === 'signed-upload'), false);
  assert.deepEqual(blocks.map(call => call.offset), [0, partSize]);
  assert.deepEqual(blocks.map(call => call.length), [partSize, CONTENT.length - partSize]);
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    assert.equal(block.blockId, Buffer.from(String(index).padStart(8, '0')).toString('base64'));
    assert.equal(block.sha256, createHash('sha256').update(CONTENT.subarray(block.offset, block.offset + block.length)).digest('hex'));
    assert.equal(block.source.path, options.file); assert.equal(Object.hasOwn(block, 'bytes'), false);
  }
  assert.deepEqual(commits[0].blockIds, blocks.map(call => call.blockId));
  assert.ok(api.calls.indexOf(commits[0]) < api.calls.indexOf(callsTo(api, 'POST', '/backend-api/files/process_upload_stream')[0]));
  assert.equal(result.completed, true); assert.equal(result.transfer.uploadedParts, 2);
});

test('partial multipart requires explicit resume and repeats only unacknowledged blocks', async t => {
  const options = await setup(t); let blockNumber = 0;
  const first = client({ reserveResult: multipartReservation(), partResult: () => { if (++blockNumber === 2) throw unknown(); return { uploaded: true }; } });
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, 'uploading_parts');
  const implicit = client(); await assert.rejects(implicit.upload.upload(options)); assert.equal(writes(implicit).length, 0);
  const resumed = client(); const result = await resumed.upload.upload({ ...options, resumeParts: true });
  assert.equal(result.completed, true);
  assert.equal(resumed.calls.filter(call => call.kind === 'azure-block').length, 1);
  assert.equal(resumed.calls.find(call => call.kind === 'azure-block').blockId, Buffer.from('00000001').toString('base64'));
  assert.equal(callsTo(resumed, 'POST', '/backend-api/files').length, 0);
});

test('uncertain Azure commit is never repeated even with explicit multipart resume', async t => {
  const options = await setup(t), first = client({ reserveResult: multipartReservation(), commitResult: unknown() });
  await assert.rejects(first.upload.upload(options)); assert.equal((await journal(options)).phase, 'committing');
  const resumed = client(); await assert.rejects(resumed.upload.upload({ ...options, resumeParts: true }));
  const reconciliation = await resumed.upload.reconcile(options);
  assert.equal(reconciliation.completed, false); assert.equal(writes(resumed).length, 0);
});

test('malformed multipart plans never send a block or fall back to whole-file upload', async t => {
  for (const strategy of [{ kind: 'unknown' }, { kind: 'direct_azure_multipart', part_size_bytes: partSize, part_count: 3, max_part_concurrency: 1 }]) {
    const options = await setup(t), api = client({ reserveResult: multipartReservation({ direct_library_upload_strategy: strategy }) });
    await assert.rejects(api.upload.upload(options));
    assert.equal(api.calls.filter(call => call.kind !== 'request').length, 0);
  }
});

test('the 512 MiB boundary is represented by a file-backed source rather than a byte buffer', async t => {
  const options = await setup(t), largeFile = join(options.dir, 'boundary.bin');
  await writeFile(largeFile, ''); await truncate(largeFile, 512 * 1024 * 1024);
  const api = client(); const result = await api.upload.upload({ ...options, file: largeFile });
  const upload = api.calls.find(call => call.kind === 'signed-upload');
  assert.equal(upload.source.sizeBytes, 512 * 1024 * 1024); assert.equal(Object.hasOwn(upload, 'bytes'), false);
  assert.equal(result.sizeBytes, 512 * 1024 * 1024); assert.equal(result.completed, true);
});

test('permission revocation or capacity exhaustion after reservation stops before bytes are sent', async t => {
  for (const changedProject of [project([], { current_user_permission: { can_read: true, can_write: false } }), project([{ id: 'new-file' }], {}, { project_file_limits: { max_file_limit: 1 } })]) {
    const options = await setup(t), api = client({ reserveResult: (_call, state) => { state.currentProject = changedProject; return reserve(); } });
    await assert.rejects(api.upload.upload(options));
    assert.equal((await journal(options)).phase, 'reserved');
    assert.equal(writes(api).length, 1); assert.equal(api.calls.some(call => call.kind !== 'request'), false);
  }
});

test('permission revocation after byte transfer stops processing and attachment', async t => {
  const options = await setup(t), api = client({ uploadResult: (_call, state) => { state.currentProject = project([], { current_user_permission: { can_read: true, can_write: false } }); return { uploaded: true }; } });
  await assert.rejects(api.upload.upload(options));
  assert.equal((await journal(options)).phase, 'uploaded');
  assert.equal(callsTo(api, 'POST', '/backend-api/files/process_upload_stream').length, 0);
  assert.equal(callsTo(api, 'POST', `/backend-api/projects/${PROJECT}/files`).length, 0);
});

test('read-only policy failure after byte transfer can resume without reserving or uploading again', async t => {
  const options = await setup(t); let read = 0;
  const first = client({ models: () => { if (++read > 1) throw new DotError('EDGE_CHALLENGE', 'Blocked'); return { models: [{ slug: 'gpt-4o' }] }; } });
  await assert.rejects(first.upload.upload(options));
  assert.equal((await journal(options)).phase, 'uploaded');
  const resumed = client(); const result = await resumed.upload.upload(options);
  assert.equal(result.completed, true);
  assert.equal(callsTo(resumed, 'POST', '/backend-api/files').length, 0);
  assert.equal(resumed.calls.some(call => call.kind !== 'request'), false);
  assert.equal(callsTo(resumed, 'POST', '/backend-api/files/process_upload_stream').length, 1);
});

test('tampered complete receipts cannot claim a verified upload', async t => {
  const options = await setup(t), api = client(); await api.upload.upload(options);
  const saved = await journal(options); delete saved.attachment.verified;
  await writeFile(options.stateFile, JSON.stringify(saved), { mode: 0o600 });
  const checked = client(); await assert.rejects(checked.upload.status(options), error => error.code === 'INVALID_UPLOAD_STATE');
  assert.equal(checked.calls.length, 0);
});

for (const [label, change] of [
  ['unapproved field names', { verifiedFields: ['file_id', 'private-upload-secret'] }],
  ['duplicate field names', { verifiedFields: ['file_id', 'file_id'] }],
  ['invalid verified fields container', { verifiedFields: 'file_id' }],
  ['forged remote content proof', { remoteContentHashVerified: true }],
  ['nonboolean metadata evidence', { metadataAvailable: 'yes' }],
]) test(`status rejects readback evidence containing ${label} before exposing its contents`, async t => {
  const options = await setup(t), api = client(); await api.upload.upload(options);
  const saved = await journal(options); Object.assign(saved.attachment.readback, change);
  await writeFile(options.stateFile, JSON.stringify(saved), { mode: 0o600 });
  const checked = client();
  await assert.rejects(checked.upload.status(options), error => error.code === 'INVALID_UPLOAD_STATE' && !JSON.stringify(error).includes('private-upload-secret'));
  assert.equal(checked.calls.length, 0);
});

test('an uncertain upload reports a possible retained file without requesting storage deletion', async t => {
  const options = await setup(t), api = client({ uploadResult: unknown() });
  await assert.rejects(api.upload.upload(options));
  const status = await api.upload.status(options);
  assert.equal(status.completed, false); assert.equal(status.unattachedFileMayRemain, true);
  assert.equal(status.storageDeletionRequested, false); assert.equal(status.membershipVerified, false);
  assert.deepEqual(status.verifiedFields, []); assert.equal(status.remoteContentHashVerified, false);
  assert.equal(api.calls.some(call => call.method === 'DELETE'), false);
});
