import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProjects } from '../src/account-projects.mjs';
import { ConversationClient } from '../src/conversations.mjs';
import { ProjectFiles } from '../src/project-files.mjs';
import { SavedEntities, buildSavedEntityRequest } from '../src/saved-entities.mjs';
import { uploadRecoverable } from '../src/uploads.mjs';
import { classifyResponse } from '../src/transport.mjs';
import { DotError } from '../src/errors.mjs';

// Every request is an in-memory fixture. The failure cases enter these
// workflows after production response classification, without network I/O.
const accountId = 'fixture-account', projectId = 'g-p-fixture', subject = 'fixture-user';
const libraryId = 'library-fixture', fileId = 'file_fixture', shareId = 'share-fixture', roomId = 'room_fixture';
const scoped = { accountId, projectId };
const auth = { accountId, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` };
const membership = { accounts: { [accountId]: { account: { account_id: accountId, account_user_id: `${subject}__${accountId}`, structure: 'personal' }, can_access_with_session: true } } };
const project = (files = []) => ({ gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'Fixture' }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: subject }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global' }, files });
const library = { id: libraryId, file_id: fileId, file_name: 'fixture.txt', mime_type: 'text/plain', state: 'ready', kind: 'file' };
const member = { file_response_type: 'full_file_response', file_id: fileId, library_file_id: libraryId, location: 'fs', name: 'fixture.txt', type: 'text/plain' };
const spec = { kind: 'product', name: 'Fixture product', productId: 'product-fixture', url: 'https://example.test/product', query: 'fixture', provider: 'example' };
const target = buildSavedEntityRequest(spec).saved_target;
const savedNode = { id: libraryId, name: spec.name, kind: 'file', library_artifact_type: 'saved_entity', parent_directory_id: 'root-fixture', saved_entity: { saved_target: target } };
const savedStatus = { saved_targets: [target], saved_entities: [{ saved_target: target, library_file_id: libraryId, library_directory_id: 'root-fixture' }] };
const classified = (status, headers = {}, body = '{}') => classifyResponse(status, new Headers(headers), body);
const missing = () => classified(404, { 'content-type': 'application/json' });
const failures = [
  ['edge-header-404', () => classified(404, { 'cf-mitigated': 'challenge' })],
  ['edge-body-404', () => classified(404, { 'content-type': 'text/html' }, '<script src="/cdn-cgi/challenge-platform/fixture"></script>')],
  ['http-410', () => classified(410, { 'content-type': 'application/json' })],
  ['non-http-error-404', () => new DotError('FORBIDDEN', 'Fixture forbidden', { status: 404 })],
  ['unclassified-404', () => Object.assign(new Error('Fixture not classified'), { details: { status: 404 } })],
];

function fixture(responses) {
  const calls = []; let index = 0;
  const invoke = async (kind, method, route, options = {}) => {
    calls.push({ kind, method, route, options });
    assert.ok(index < responses.length, `Unexpected fixture request: ${method} ${route}`);
    const response = responses[index++];
    if (response instanceof Error) throw response;
    return structuredClone(response);
  };
  const transport = { authLoader: async () => auth, request: (...args) => invoke('json', ...args), requestMultipart: (...args) => invoke('multipart', ...args) };
  return { transport, calls, resolveRoom: async value => value ?? roomId };
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

for (const [label, failure] of failures) {
  test(`saved entity ${label} preserves the error without a node fallback`, async () => {
    const error = failure(), f = fixture([error]);
    await assert.rejects(new SavedEntities(f).get({ fileId: libraryId, accountId }), value => value === error);
    assert.deepEqual(f.calls.map(call => [call.method, call.route]), [['GET', `/backend-api/files/library/files/${libraryId}`]]);
  });

  test(`project attachment ${label} sends no node fallback or membership mutation`, async () => {
    const error = failure(), f = fixture([membership, project(), { flags: { file_library_enabled_for_registration_country: true } }, error]);
    await assert.rejects(new ProjectFiles(f).attachLibrary({ ...scoped, libraryFileIds: [libraryId] }), value => value === error);
    assert.equal(f.calls.length, 4); assert.equal(writes(f).length, 0);
    assert.equal(f.calls.at(-1).route, `/backend-api/files/library/files/${libraryId}`);
  });

  test(`project deletion ${label} cannot confirm absence or repeat its delete`, async () => {
    const error = failure(), f = fixture([membership, project(), '', error]);
    await assert.rejects(new AccountProjects(f).delete({ ...scoped, confirm: projectId, deleteChats: true }), value => value.code === 'MUTATION_UNCONFIRMED'
      && value.details.delivery === 'accepted' && value.details.verificationCode === (error.code ?? 'INVALID_RESPONSE'));
    assert.equal(f.calls.length, 4); assert.deepEqual(writes(f).map(call => [call.method, call.route]), [['DELETE', `/backend-api/gizmos/${projectId}`]]);
  });

  test(`share revocation ${label} cannot confirm absence or repeat its delete`, async () => {
    const error = failure(), f = fixture([{ items: [{ id: shareId }] }, { share_id: shareId }, '', error]);
    await assert.rejects(new ConversationClient(f).shareRevoke({ shareId, confirm: shareId, expectedAccountId: accountId }), value => value.code === 'MUTATION_UNCONFIRMED'
      && value.details.delivery === 'unknown' && value.details.verificationError === (error.code ?? 'UNKNOWN'));
    assert.equal(f.calls.length, 4); assert.deepEqual(writes(f).map(call => [call.method, call.route]), [['DELETE', `/backend-api/share/${shareId}`]]);
  });
}

test('saved entity genuine HTTP_ERROR 404 uses its node fallback and status read', async () => {
  const f = fixture([missing(), savedNode, savedStatus]);
  const result = await new SavedEntities(f).get({ fileId: libraryId, accountId });
  assert.equal(result.saved, true); assert.equal(result.fileId, libraryId);
  assert.deepEqual(f.calls.map(call => [call.method, call.route]), [['GET', `/backend-api/files/library/files/${libraryId}`], ['GET', `/backend-api/files/library/files/${libraryId}/node`], ['POST', '/backend-api/chat/frontend/v1/saved-entities/status']]);
});

test('project attachment genuine HTTP_ERROR 404 still hydrates then attaches once', async () => {
  const f = fixture([membership, project(), { flags: { file_library_enabled_for_registration_country: true } }, missing(), library, project(), { resource: project([member]) }, project([member])]);
  const result = await new ProjectFiles(f).attachLibrary({ ...scoped, libraryFileIds: [libraryId] });
  assert.equal(result.membershipVerified, true); assert.equal(result.changed, true);
  assert.equal(f.calls[4].route, `/backend-api/files/library/files/${libraryId}/node`);
  assert.deepEqual(writes(f).map(call => [call.method, call.route]), [['POST', `/backend-api/projects/${projectId}/files`]]);
});

test('project deletion genuine HTTP_ERROR 404 still confirms exact absence', async () => {
  const f = fixture([membership, project(), '', missing()]);
  const result = await new AccountProjects(f).delete({ ...scoped, confirm: projectId, deleteChats: true });
  assert.equal(result.confirmed, true); assert.equal(result.projectAbsenceVerified, true); assert.equal(result.projectId, projectId);
  assert.equal(f.calls.length, 4); assert.equal(writes(f).length, 1);
});

test('share revocation genuine HTTP_ERROR 404 still confirms exact absence', async () => {
  const f = fixture([{ items: [{ id: shareId }] }, { share_id: shareId }, '', missing()]);
  assert.deepEqual(await new ConversationClient(f).shareRevoke({ shareId, confirm: shareId, expectedAccountId: accountId }), { shareId, revoked: true, confirmed: true });
  assert.equal(f.calls.length, 4); assert.equal(writes(f).length, 1);
});

async function uploadFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dot-classified-upload-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { file: join(directory, 'fixture.txt'), stateFile: join(directory, 'upload.json'), roomId };
  await writeFile(options.file, 'fixture content\n', { mode: 0o600 });
  await uploadRecoverable(fixture([{ id: fileId, status: 'ready' }]), options);
  const state = JSON.parse(await readFile(options.stateFile, 'utf8')); state.phase = 'reserved'; state.fileStatus = 'uploading';
  const before = JSON.stringify(state); await writeFile(options.stateFile, before);
  return { directory, options, state, before };
}

for (const [label, failure] of failures) {
  test(`upload recovery ${label} preserves the journal without re-reservation or completion`, async t => {
    const { directory, options, state, before } = await uploadFixture(t), error = failure(), f = fixture([error]);
    await assert.rejects(uploadRecoverable(f, options), value => value === error);
    assert.deepEqual(f.calls.map(call => [call.kind, call.method, call.route]), [['json', 'GET', `/backend-api/messaging/rooms/${roomId}/files/uploads/${state.uploadId}`]]);
    assert.equal(await readFile(options.stateFile, 'utf8'), before);
    assert.deepEqual((await readdir(directory)).sort(), ['fixture.txt', 'upload.json']);
  });
}

test('upload recovery genuine HTTP_ERROR 404 re-reserves the same upload exactly once', async t => {
  const { options, state } = await uploadFixture(t), f = fixture([missing(), { id: fileId, status: 'ready' }]);
  const result = await uploadRecoverable(f, options);
  assert.equal(result.uploadId, state.uploadId); assert.equal(result.fileId, fileId);
  assert.deepEqual(f.calls.map(call => [call.kind, call.method]), [['json', 'GET'], ['json', 'POST']]);
  assert.equal(f.calls[1].options.body.upload_id, state.uploadId);
  assert.equal(JSON.parse(await readFile(options.stateFile, 'utf8')).phase, 'ready');
});
