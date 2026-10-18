import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectFiles, projectFileCapabilities } from '../src/project-files.mjs';
import { commands, createClient } from '../src/command-sets/project-files.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct';
const projectId = 'g-p-abc';
const scoped = { accountId, projectId };
const attached = { ...scoped, libraryFileIds: ['library-1'] };
const membership = () => ({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } });
const authentication = (subject = 'user-1', selected = accountId) => ({ accountId: selected, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
const file = (overrides = {}) => ({ file_response_type: 'full_file_response', file_id: 'file-1', library_file_id: 'library-1', location: 'fs', name: 'x.txt', type: 'text/plain', ...overrides });
const library = (overrides = {}) => ({ id: 'library-1', file_id: 'file-1', file_name: 'x.txt', mime_type: 'text/plain', state: 'ready', kind: 'file', ...overrides });
function resource(files = [], gizmo = {}, other = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'X', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: 'user-1' }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global', ...gizmo }, files, ...other };
}
const settings = { flags: { file_library_enabled_for_registration_country: true } };
const status = value => new DotError('HTTP_ERROR', 'Request failed', { status: value });
const code = expected => error => error?.code === expected;
function setup(...responses) {
  const calls = [];
  let currentAuth = authentication(), currentMembership = membership();
  const transport = {
    authLoader: async () => currentAuth,
    request: async (method, path, options) => {
      const call = { method, path, options }; calls.push(call);
      if (path === '/backend-api/accounts/check/v4-2023-04-27') return currentMembership;
      const response = responses.shift();
      if (typeof response === 'function') return response(call);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { api: new ProjectFiles({ transport }), transport, calls, setAuth: value => { currentAuth = value; }, setMembership: value => { currentMembership = value; }, get operations() { return calls.filter(call => !call.path.includes('/accounts/check/')); } };
}
const attachSetup = (before = resource(), selected = library(), after = resource([file()])) => setup(before, settings, selected, before, { resource: after }, after);
const writes = h => h.operations.filter(call => call.method !== 'GET');

test('project-file manifest exposes exactly native membership operations with explicit accounts and exact removal confirmation', () => {
  assert.throws(() => new ProjectFiles({}), TypeError);
  assert.ok(createClient({ transport: { request() {} } }) instanceof ProjectFiles);
  assert.deepEqual(projectFileCapabilities().supported, ['list', 'attach-library', 'remove']);
  assert.equal(projectFileCapabilities().liveVerified, false);
  assert.equal(Object.keys(commands).length, 3);
  for (const definition of Object.values(commands)) {
    assert.equal(typeof setup().api[definition.method], 'function');
    assert.ok(definition.required.includes('accountId'));
    assert.equal(definition.flags['--account'].target, 'accountId');
  }
  assert.deepEqual(commands['account projects files attach-library'].required, ['accountId', 'libraryFileIds']);
  assert.equal(commands['account projects files attach-library'].flags['--ids'].type, 'list');
  assert.deepEqual(commands['account projects files remove'].confirmMatch, [['confirm', 'fileId']]);
});

test('all project-file operations require a selected account before any request', async () => {
  const h = setup();
  for (const [method, options] of [['list', { projectId }], ['attachLibrary', { projectId, libraryFileIds: ['library-1'] }], ['remove', { projectId, fileId: 'file-1', confirm: 'file-1' }]]) {
    await assert.rejects(h.api[method](options), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('list rereads membership on every call and returns safe metadata plus capacity', async () => {
  const stored = resource([file({ token: 'secret', download_url: 'https://secret.invalid' }), { id: 'opaque-1', contents: 'private-content' }], {}, { project_file_limits: { max_file_limit: 3 } });
  const h = setup(stored, stored);
  const result = await h.api.list(scoped); await h.api.list(scoped);
  assert.equal(h.calls.filter(call => call.path.includes('/accounts/check/')).length, 2);
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
  assert.deepEqual(result.capacity, { limit: 3, counted: 2, available: 1 });
  assert.deepEqual(result.items, [{ fileId: 'file-1', metadataAvailable: true, libraryFileId: 'library-1', name: 'x.txt', mimeType: 'text/plain' }, { id: 'opaque-1', metadataAvailable: false }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private-content/);
  assert.deepEqual(h.operations.map(call => call.options.query), [{ include_file_limits: true }, { include_file_limits: true }]);
});

test('list capacity excludes saved-message sources while retaining them in membership', async () => {
  const saved = { id: 'saved-1', metadata: { project_save: { creator_id: 'user-1', conversation_id: 'chat-1', message_id: 'message-1', conversation_title: 'Chat', save_id: 'save-1', title: 'Message' } } };
  const result = await setup(resource([file(), saved], {}, { project_file_limits: { max_file_limit: 1 } })).api.list(scoped);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.capacity, { limit: 1, counted: 1, available: 0 });
});

test('list accepts absent capacity without inventing an available limit', async () => {
  const result = await setup(resource([file()])).api.list(scoped);
  assert.deepEqual(result.capacity, { limit: null, counted: 1, available: null });
});

for (const [label, value] of [
  ['duplicate member IDs', resource([file(), file()])],
  ['nonarray files', resource({})],
  ['unsafe member ID', resource([{ id: '../escape' }])],
  ['unrelated project', resource([], { id: 'g-p-other' })],
  ['negative file limit', resource([], {}, { project_file_limits: { max_file_limit: -1 } })],
  ['fractional file limit', resource([], {}, { project_file_limits: { max_file_limit: 1.5 } })],
  ['string file limit', resource([], {}, { project_file_limits: { max_file_limit: '10' } })],
]) test(`list rejects ${label}`, async () => {
  await assert.rejects(setup(value).api.list(scoped), code('INVALID_RESPONSE'));
});

test('missing membership and changed authentication block project-file reads before resource access', async () => {
  const h = setup(); h.setMembership({});
  await assert.rejects(h.api.list(scoped), code('ACCOUNT_MEMBERSHIP_UNVERIFIED'));
  assert.equal(h.operations.length, 0);
  for (const auth of [authentication('user-1', 'other'), { accountId, accessToken: 'invalid' }]) {
    const rejected = setup(); rejected.setAuth(auth);
    await assert.rejects(rejected.api.list(scoped), code(auth.accountId === accountId ? 'AUTH_IDENTITY_REQUIRED' : 'ACCOUNT_CHANGED'));
    assert.equal(rejected.calls.length, 0);
  }
});

test('attach uses the verified native Library identifiers and metadata, then independently rereads the exact project', async () => {
  const h = attachSetup();
  const result = await h.api.attachLibrary(attached);
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [
    ['GET', '/backend-api/gizmos/g-p-abc'], ['GET', '/backend-api/settings/user'], ['GET', '/backend-api/files/library/files/library-1'],
    ['GET', '/backend-api/gizmos/g-p-abc'], ['POST', '/backend-api/projects/g-p-abc/files'], ['GET', '/backend-api/gizmos/g-p-abc'],
  ]);
  assert.deepEqual(writes(h)[0].options.body, { files: [{ file_id: 'file-1', library_file_id: 'library-1', location: 'fs', name: 'x.txt', type: 'text/plain' }] });
  assert.deepEqual(result.files, [{ fileId: 'file-1', requestedLibraryFileId: 'library-1', alreadyPresent: false, libraryMappingVerified: true }]);
  assert.equal(result.changed, true); assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
  assert.equal(result.membershipVerified, true); assert.equal(result.storageDeletionRequested, false);
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
});

test('Library hydration falls back to native node lookup only after HTTP 404', async () => {
  const h = setup(resource(), settings, status(404), library(), resource(), { resource: resource([file()]) }, resource([file()]));
  assert.equal((await h.api.attachLibrary(attached)).membershipVerified, true);
  assert.equal(h.operations[3].path, '/backend-api/files/library/files/library-1/node');
  for (const failure of [status(403), status(500), new DotError('EDGE_CHALLENGE', 'Blocked')]) {
    const rejected = setup(resource(), settings, failure);
    await assert.rejects(rejected.api.attachLibrary(attached), error => error === failure);
    assert.equal(rejected.operations.length, 3); assert.equal(writes(rejected).length, 0);
  }
});

for (const [label, value, expected] of [
  ['empty selection', [], 'INVALID_ARGUMENT'], ['repeated Library IDs', ['library-1', 'library-1'], 'INVALID_ARGUMENT'],
  ['too many Library IDs', Array.from({ length: 101 }, (_, i) => `library-${i}`), 'INVALID_ARGUMENT'],
  ['path in ID', ['../escape'], 'INVALID_ARGUMENT'], ['provider ID', ['external-provider-1'], 'UNSUPPORTED'],
]) test(`attach rejects ${label} before authentication or requests`, async () => {
  const h = setup(); await assert.rejects(h.api.attachLibrary({ ...scoped, libraryFileIds: value }), code(expected)); assert.equal(h.calls.length, 0);
});

for (const [label, value, expected] of [
  ['wrong Library identity', library({ id: 'library-other' }), 'INVALID_RESPONSE'],
  ['unsafe general file ID', library({ file_id: '../escape' }), 'INVALID_RESPONSE'],
  ['non-Files general ID', library({ file_id: 'library-1' }), 'INVALID_RESPONSE'],
  ['missing filename', library({ file_name: undefined }), 'INVALID_RESPONSE'],
  ['NUL filename', library({ file_name: 'x\0.txt' }), 'INVALID_RESPONSE'],
  ['invalid MIME metadata', library({ mime_type: 'not-a-mime' }), 'INVALID_RESPONSE'],
  ['directory', library({ kind: 'directory' }), 'PROJECT_FILE_UNAVAILABLE'],
  ['page artifact', library({ library_artifact_type: 'page' }), 'PROJECT_FILE_UNAVAILABLE'],
  ['site artifact', library({ library_artifact_type: 'site' }), 'PROJECT_FILE_UNAVAILABLE'],
  ['saved message artifact', library({ library_artifact_type: 'chat_message_snapshot' }), 'PROJECT_FILE_UNAVAILABLE'],
  ['hidden file', library({ hidden: true }), 'PROJECT_FILE_UNAVAILABLE'],
  ['nested hidden file', library({ metadata: { hidden: true } }), 'PROJECT_FILE_UNAVAILABLE'],
  ['trashed file', library({ trashed_at: 'now' }), 'PROJECT_FILE_UNAVAILABLE'],
  ['processing file', library({ state: 'processing' }), 'PROJECT_FILE_NOT_READY'],
  ['missing readiness', library({ state: undefined }), 'PROJECT_FILE_NOT_READY'],
]) test(`attach rejects ${label} without mutation`, async () => {
  const h = setup(resource(), settings, value);
  await assert.rejects(h.api.attachLibrary(attached), code(expected)); assert.equal(writes(h).length, 0);
});

test('missing MIME metadata uses native filename lookup and preserves unknown extensions as null', async () => {
  for (const [name, expected] of [['document.json', 'application/json'], ['IMAGE.PNG', 'image/png'], ['unknown.dot-clitest-extension', null]]) {
    const selected = library({ file_name: name, mime_type: undefined });
    const after = resource([file({ name, type: expected })]);
    const h = attachSetup(resource(), selected, after);
    assert.equal((await h.api.attachLibrary(attached)).membershipVerified, true);
    assert.equal(writes(h)[0].options.body.files[0].type, expected);
  }
});

test('explicit Library MIME type takes precedence over the filename extension', async () => {
  const h = attachSetup(resource(), library({ file_name: 'content.txt', mime_type: 'application/json' }));
  await h.api.attachLibrary(attached);
  assert.equal(writes(h)[0].options.body.files[0].type, 'application/json');
});

for (const [label, gizmo, other, expected] of [
  ['shared project', { share_recipient: 'workspace', sharing: { subjects: [{ id: 'member' }] } }, {}, 'PROJECT_LIBRARY_UNAVAILABLE'],
  ['outer shared project', {}, { hasSharingSubjects: true }, 'PROJECT_LIBRARY_UNAVAILABLE'],
  ['project-only memory', { memory_scope: 'project_v2' }, {}, 'PROJECT_LIBRARY_UNAVAILABLE'],
  ['missing write permission', { current_user_permission: { can_read: true, can_write: false } }, {}, 'PROJECT_PERMISSION_DENIED'],
  ['nonboolean write permission', { current_user_permission: { can_read: true, can_write: 'true' } }, {}, 'PROJECT_PERMISSION_DENIED'],
]) test(`attach rejects ${label} before Library hydration`, async () => {
  const h = setup(resource([], gizmo, other));
  await assert.rejects(h.api.attachLibrary(attached), code(expected)); assert.equal(h.operations.length, 1);
});

test('a private project writable by this account does not require ownership to attach files', async () => {
  const before = resource([], { author: { user_id: 'other' } });
  const after = resource([file()], { author: { user_id: 'other' } });
  assert.equal((await attachSetup(before, library(), after).api.attachLibrary(attached)).membershipVerified, true);
});

test('registration-country denial and malformed settings stop before Library hydration', async () => {
  for (const [value, expected] of [[{ flags: { file_library_enabled_for_registration_country: false } }, 'PROJECT_LIBRARY_UNAVAILABLE'], [{ flags: [] }, 'INVALID_RESPONSE'], [null, 'INVALID_RESPONSE']]) {
    const h = setup(resource(), value);
    await assert.rejects(h.api.attachLibrary(attached), code(expected)); assert.equal(h.operations.length, 2);
  }
});

test('fresh project permission and capacity are reread after Library hydration', async () => {
  const rejected = setup(resource(), settings, library(), resource([], { current_user_permission: { can_read: true, can_write: false } }));
  await assert.rejects(rejected.api.attachLibrary(attached), code('PROJECT_PERMISSION_DENIED')); assert.equal(writes(rejected).length, 0);
  const full = setup(resource(), settings, library(), resource([{ id: 'other-file' }], {}, { project_file_limits: { max_file_limit: 1 } }));
  await assert.rejects(full.api.attachLibrary(attached), code('PROJECT_FILE_LIMIT')); assert.equal(writes(full).length, 0);
});

test('saved-message sources do not consume a file slot during attachment', async () => {
  const saved = { id: 'saved-message', metadata: { project_save: { conversation_id: 'chat-1', message_id: 'message-1' } } };
  const before = resource([saved], {}, { project_file_limits: { max_file_limit: 1 } });
  const after = resource([saved, file()], {}, { project_file_limits: { max_file_limit: 1 } });
  const result = await attachSetup(before, library(), after).api.attachLibrary(attached);
  assert.deepEqual(result.capacity, { limit: 1, counted: 1, available: 0 });
});

test('Library selections sharing one general Files object produce one native attachment', async () => {
  const after = resource([file()]);
  const h = setup(resource(), settings, library(), library({ id: 'library-2' }), resource(), { resource: after }, after);
  const result = await h.api.attachLibrary({ ...scoped, libraryFileIds: ['library-1', 'library-2'] });
  assert.equal(writes(h)[0].options.body.files.length, 1); assert.equal(result.files.length, 1);
});

test('an already-attached general file is a verified no-op even when the project is full', async () => {
  const before = resource([file()], {}, { project_file_limits: { max_file_limit: 1 } });
  const h = setup(before, settings, library(), before);
  const result = await h.api.attachLibrary(attached);
  assert.equal(result.changed, false); assert.equal(result.requestAcknowledged, false); assert.equal(writes(h).length, 0);
  assert.deepEqual(result.files, [{ fileId: 'file-1', requestedLibraryFileId: 'library-1', alreadyPresent: true, libraryMappingVerified: true }]);
});

test('mixed existing/new selection posts only additions and preserves other project sources', async () => {
  const before = resource([file(), { id: 'opaque-1' }]);
  const second = library({ id: 'library-2', file_id: 'file-2', file_name: 'y.txt' });
  const after = resource([file(), { id: 'opaque-1' }, file({ file_id: 'file-2', library_file_id: 'library-2', name: 'y.txt' })]);
  const h = setup(before, settings, library(), second, before, { resource: after }, after);
  const result = await h.api.attachLibrary({ ...scoped, libraryFileIds: ['library-1', 'library-2'] });
  assert.deepEqual(writes(h)[0].options.body.files.map(item => item.file_id), ['file-2']);
  assert.deepEqual(result.files.map(item => item.alreadyPresent), [true, false]);
});

test('an existing general file is not reattached or silently remapped to a different Library identity', async () => {
  const before = resource([file({ library_file_id: 'another-library' })]);
  const h = setup(before, settings, library(), before);
  const result = await h.api.attachLibrary(attached);
  assert.equal(result.changed, false);
  assert.equal(result.files[0].alreadyPresent, true);
  assert.equal(result.files[0].libraryMappingVerified, false);
  assert.equal(writes(h).length, 0);
});

test('unknown attachment delivery makes one reconciliation GET and never resends the POST', async () => {
  const after = resource([file()]);
  const h = setup(resource(), settings, library(), resource(), new DotError('NETWORK_ERROR', 'Lost acknowledgement', { delivery: 'unknown' }), after);
  const result = await h.api.attachLibrary(attached);
  assert.equal(result.reconciled, true); assert.equal(result.requestAcknowledged, false); assert.equal(result.membershipVerified, true);
  assert.equal(writes(h).length, 1); assert.equal(h.operations.length, 6);
});

test('an accepted attachment with missing persisted member remains unconfirmed without retry', async () => {
  const h = setup(resource(), settings, library(), resource(), { resource: resource([file()]) }, resource());
  await assert.rejects(h.api.attachLibrary(attached), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(writes(h).length, 1); assert.equal(h.operations.length, 6);
});

for (const [label, after] of [
  ['another project', resource([file(), { id: 'other-file' }], { id: 'g-p-other' })],
  ['a conflicting Library mapping', resource([file({ library_file_id: 'other-library' }), { id: 'other-file' }])],
  ['a duplicate attachment identity', resource([file(), file(), { id: 'other-file' }])],
  ['loss of another project source', resource([file()])],
]) test(`attachment cannot claim success after ${label}`, async () => {
  const before = resource([{ id: 'other-file' }]);
  const h = setup(before, settings, library(), before, { resource: after }, after);
  await assert.rejects(h.api.attachLibrary(attached), code('MUTATION_UNCONFIRMED')); assert.equal(writes(h).length, 1);
});

test('malformed mutation acknowledgement cannot replace the required exact persisted readback', async () => {
  const h = setup(resource(), settings, library(), resource(), {}, status(503));
  await assert.rejects(h.api.attachLibrary(attached), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
  assert.equal(writes(h).length, 1); assert.equal(h.operations.at(-1).method, 'GET');
});

test('subject rotation during hydration stops before project refresh or POST', async () => {
  const h = setup(resource(), settings, () => { h.setAuth(authentication('user-2')); return library(); });
  await assert.rejects(h.api.attachLibrary(attached), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.operations.length, 3); assert.equal(writes(h).length, 0);
});

test('aborting during hydration stops before project refresh or POST', async () => {
  const controller = new AbortController();
  const h = setup(resource(), settings, () => { controller.abort(); return library(); });
  await assert.rejects(h.api.attachLibrary({ ...attached, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.operations.length, 3); assert.equal(writes(h).length, 0);
  assert.ok(h.calls.every(call => call.options.signal === controller.signal));
});

test('identity rotation after attachment cannot leak a follow-up request to another account', async () => {
  const after = resource([file()]);
  const h = setup(resource(), settings, library(), resource(), () => { h.setAuth(authentication('user-2')); return { resource: after }; });
  await assert.rejects(h.api.attachLibrary(attached), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'unknown');
  assert.equal(h.operations.length, 5); assert.equal(writes(h).length, 1);
});

test('remove requires exact confirmation and valid IDs before authentication', async () => {
  const h = setup();
  for (const options of [{ fileId: 'file-1' }, { fileId: 'file-1', confirm: 'file-2' }, { fileId: '../escape', confirm: '../escape' }]) {
    await assert.rejects(h.api.remove({ ...scoped, ...options }), code(options.fileId.includes('/') ? 'INVALID_ARGUMENT' : 'CONFIRMATION_REQUIRED'));
  }
  assert.equal(h.calls.length, 0);
});

test('saved-response backing files cannot be removed through the ordinary file-membership endpoint', async () => {
  const h = setup(resource([file({ metadata: { project_save: { save_id: 'save-1', conversation_id: 'conversation-1', message_id: 'message-1' } } })]));
  await assert.rejects(h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' }), code('PROJECT_SAVED_RESPONSE'));
  assert.equal(writes(h).length, 0);
});

test('remove sends only exact project membership DELETE and verifies other sources remain', async () => {
  const before = resource([file(), { id: 'other-file' }]);
  const after = resource([{ id: 'other-file' }]);
  const h = setup(before, { resource: after }, after);
  const result = await h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' });
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', '/backend-api/gizmos/g-p-abc'], ['DELETE', '/backend-api/projects/g-p-abc/files/file-1'], ['GET', '/backend-api/gizmos/g-p-abc']]);
  assert.equal(result.removedFromProject, true); assert.equal(result.membershipVerified, true); assert.equal(result.storageDeletionRequested, false);
  assert.equal(result.requestAcknowledged, true); assert.equal(result.reconciled, false);
  assert.equal(writes(h).length, 1); assert.equal(writes(h)[0].options.body, undefined);
});

test('remove supports opaque project members without claiming or requesting storage deletion', async () => {
  const h = setup(resource([{ id: 'opaque-1' }]), { resource: resource() }, resource());
  const result = await h.api.remove({ ...scoped, fileId: 'opaque-1', confirm: 'opaque-1' });
  assert.equal(result.fileId, 'opaque-1'); assert.equal(result.storageDeletionRequested, false);
});

test('remove rejects absent membership or missing write permission before DELETE', async () => {
  const missing = setup(resource([file()]));
  await assert.rejects(missing.api.remove({ ...scoped, fileId: 'file-2', confirm: 'file-2' }), code('PROJECT_FILE_NOT_FOUND'));
  assert.equal(writes(missing).length, 0);
  const denied = setup(resource([file()], { current_user_permission: { can_read: true, can_write: false } }));
  await assert.rejects(denied.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(writes(denied).length, 0);
});

test('unknown remove delivery gets exactly one readback and can reconcile exact absence', async () => {
  const after = resource([{ id: 'other-file' }]);
  const h = setup(resource([file(), { id: 'other-file' }]), new DotError('NETWORK_ERROR', 'Unknown delivery', { delivery: 'unknown' }), after);
  const result = await h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' });
  assert.equal(result.reconciled, true); assert.equal(result.requestAcknowledged, false); assert.equal(writes(h).length, 1); assert.equal(h.operations.length, 3);
});

for (const [label, after] of [
  ['requested member remains', resource([file(), { id: 'other-file' }])],
  ['another source disappears', resource()],
  ['wrong project is returned', resource([{ id: 'other-file' }], { id: 'g-p-other' })],
]) test(`remove fails closed when ${label}`, async () => {
  const h = setup(resource([file(), { id: 'other-file' }]), { resource: after }, after);
  await assert.rejects(h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' }), code('MUTATION_UNCONFIRMED'));
  assert.equal(writes(h).length, 1); assert.equal(h.operations.length, 3);
});

test('remove requires persisted absence even after a valid acknowledgement', async () => {
  const h = setup(resource([file()]), { resource: resource() }, resource([file()]));
  await assert.rejects(h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(writes(h).length, 1);
});

test('remove subject rotation and cancellation prevent further requests after DELETE', async () => {
  for (const rotate of [true, false]) {
    const controller = new AbortController();
    const h = setup(resource([file()]), () => { if (rotate) h.setAuth(authentication('user-2')); else controller.abort(); return { resource: resource() }; });
    await assert.rejects(h.api.remove({ ...scoped, fileId: 'file-1', confirm: 'file-1', signal: controller.signal }), code('MUTATION_UNCONFIRMED'));
    assert.equal(h.operations.length, 2); assert.equal(writes(h).length, 1);
  }
});

function workspace(h) {
  h.setMembership({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1', structure: 'workspace' }, can_access_with_session: true } } });
  return h;
}
const removal = { ...scoped, fileId: 'file-1', confirm: 'file-1' };
const workspaceOperations = [
  { method: 'attachLibrary', options: attached, responses: () => [resource(), settings, library(), resource(), { resource: resource([file()]) }, resource([file()])] },
  { method: 'remove', options: removal, responses: () => [resource([file()]), { resource: resource() }, resource()] },
];

for (const { method, options, responses } of workspaceOperations) {
  for (const [label, permissions] of [['explicit CRUD permission', ['chatgpt.workspace.project.crud']], ['unrestricted permissions', null]]) {
    test(`workspace ${method} accepts ${label} only after a fresh account policy read`, async () => {
      const h = workspace(setup({ permissions }, ...responses()));
      const result = await h.api[method](options);
      assert.equal(result.membershipVerified, true);
      assert.equal(h.operations[0].method, 'GET');
      assert.equal(h.operations[0].path, '/backend-api/accounts/acct/settings');
      assert.equal(h.operations[0].options.expectedAccountId, accountId);
      assert.equal(h.calls[0].path, '/backend-api/accounts/check/v4-2023-04-27');
      assert.equal(writes(h).length, 1);
    });
  }
  for (const [label, value, expected] of [
    ['denied policy', { permissions: [] }, 'PROJECT_PERMISSION_DENIED'],
    ['unrelated permission', { permissions: ['chatgpt.workspace.project.read'] }, 'PROJECT_PERMISSION_DENIED'],
    ['missing permissions', {}, 'PROJECT_ELIGIBILITY_UNVERIFIED'],
    ['undefined permissions', { permissions: undefined }, 'PROJECT_ELIGIBILITY_UNVERIFIED'],
    ['missing settings', null, 'PROJECT_ELIGIBILITY_UNVERIFIED'],
    ['nonarray permissions', { permissions: true }, 'INVALID_RESPONSE'],
    ['nonstrings in permission list', { permissions: ['chatgpt.workspace.project.crud', {}] }, 'INVALID_RESPONSE'],
  ]) test(`workspace ${method} rejects ${label} before reading a project or dispatching a mutation`, async () => {
    const h = workspace(setup(value));
    await assert.rejects(h.api[method](options), code(expected));
    assert.equal(h.operations.length, 1); assert.equal(writes(h).length, 0);
  });
  test(`workspace ${method} propagates policy-fetch failures without mutation or retry`, async () => {
    const failure = new DotError('EDGE_CHALLENGE', 'Blocked', { status: 403 });
    const h = workspace(setup(failure));
    await assert.rejects(h.api[method](options), error => error === failure);
    assert.equal(h.operations.length, 1); assert.equal(writes(h).length, 0);
  });
  test(`workspace ${method} does not reuse permission after the workspace revokes it`, async () => {
    const h = workspace(setup({ permissions: ['chatgpt.workspace.project.crud'] }, ...responses(), { permissions: [] }));
    await h.api[method](options);
    await assert.rejects(h.api[method](options), code('PROJECT_PERMISSION_DENIED'));
    assert.equal(h.calls.filter(call => call.path === '/backend-api/accounts/check/v4-2023-04-27').length, 2);
    assert.equal(h.operations.filter(call => call.path === '/backend-api/accounts/acct/settings').length, 2);
    assert.equal(writes(h).length, 1);
  });
  test(`workspace ${method} stops on identity change during its policy read`, async () => {
    const h = workspace(setup(() => { h.setAuth(authentication('user-2')); return { permissions: null }; }));
    await assert.rejects(h.api[method](options), code('AUTH_IDENTITY_CHANGED'));
    assert.equal(h.operations.length, 1); assert.equal(writes(h).length, 0);
  });
}

test('workspace file listing needs readable project membership without requesting mutation policy', async () => {
  const h = workspace(setup(resource([file()], { current_user_permission: { can_read: true, can_write: false } })));
  const result = await h.api.list(scoped);
  assert.equal(result.items.length, 1);
  assert.deepEqual(h.operations.map(call => call.path), ['/backend-api/gizmos/g-p-abc']);
});

test('personal file mutations do not request workspace policy', async () => {
  const attach = attachSetup(); await attach.api.attachLibrary(attached);
  const remove = setup(resource([file()]), { resource: resource() }, resource()); await remove.api.remove(removal);
  assert.ok([...attach.operations, ...remove.operations].every(call => call.path !== '/backend-api/accounts/acct/settings'));
});

for (const [label, value] of [['array', []], ['string', 'unlimited'], ['boolean', true], ['number', 5]]) {
  test(`a ${label} file-limit container cannot be treated as unlimited capacity`, async () => {
    const malformed = resource([], {}, { project_file_limits: value });
    await assert.rejects(setup(malformed).api.list(scoped), code('INVALID_RESPONSE'));
    const h = setup(resource(), settings, library(), malformed);
    await assert.rejects(h.api.attachLibrary(attached), code('INVALID_RESPONSE'));
    assert.equal(writes(h).length, 0);
  });
}

for (const [label, visibility] of [
  ['hidden visibility', { visibility: 'hidden' }],
  ['internal visibility', { visibility: 'internal' }],
  ['deleted visibility', { visibility: 'deleted' }],
  ['redacted visibility with mixed case', { visibility: 'ReDaCtEd' }],
  ['analysis channel', { channel: 'analysis' }],
  ['tool recipient', { recipient: 'tool' }],
]) {
  for (const nested of [false, true]) {
    test(`attachment excludes ${nested ? 'nested ' : ''}${label} before any write`, async () => {
      const selected = library(nested ? { metadata: { metadata: visibility } } : visibility);
      const h = setup(resource(), settings, selected);
      await assert.rejects(h.api.attachLibrary(attached), code('PROJECT_FILE_UNAVAILABLE'));
      assert.equal(writes(h).length, 0);
      assert.equal(h.operations.length, 3);
    });
  }
}

test('visible final and commentary Library metadata remains attachable to the all recipient', async () => {
  for (const channel of ['final', 'commentary']) {
    const h = attachSetup(resource(), library({ channel, recipient: 'all', metadata: { channel, recipient: 'all' } }));
    assert.equal((await h.api.attachLibrary(attached)).membershipVerified, true);
    assert.equal(writes(h).length, 1);
  }
});
