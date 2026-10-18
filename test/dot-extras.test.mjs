import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotExtras } from '../src/dot-extras.mjs';
import { Transport } from '../src/transport.mjs';

function setup(responses = []) {
  const calls = [], client = { primary: async () => ({ id: 'dot' }), transport: {
    authLoader: async () => ({ accountId: 'account', accessToken: 'token' }),
    request: async (method, route, options) => { calls.push({ method, route, options }); const value = responses.shift(); if (value instanceof Error) throw value; if (value == null) throw Error('Unexpected request'); return value; },
    requestMultipart: Transport.prototype.requestMultipart,
  } };
  return { extras: new DotExtras(client), calls, client };
}
const rejects = code => error => error.code === code;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dot-reference-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'photo.png'); await writeFile(file, png); return { root, file };
}

test('hidden thread discovery is explicit and returns identity metadata only', async () => {
  const page = { items: [{ thread_id: 'visible', title: 'Visible', preview: 'drop' }, { thread_id: 'hidden', title: 'secret', hidden: true, preview: 'secret', raw_messages: ['secret'] }], cursor: 'next' };
  const { extras, calls } = setup([page, page]);
  assert.deepEqual((await extras.listThreads()).items, [{ thread_id: 'visible', hidden: false, title: 'Visible' }]);
  const result = await extras.listThreads({ includeHidden: true });
  assert.equal(result.metadataOnly, true); assert.deepEqual(result.items[1], { thread_id: 'hidden', hidden: true });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(calls[0].options.query.include_hidden, false); assert.equal(calls[1].options.query.include_hidden, true);
});
test('nested hidden flags, analysis channel and targeted recipients cannot leak thread titles', async () => {
  const items = [{ thread_id: 'a', title: 'private', metadata: { is_hidden: true } }, { thread_id: 'b', title: 'private', channel: 'analysis' }, { thread_id: 'c', title: 'private', metadata: { recipient: 'tool' } }];
  const { extras } = setup([{ items }]); const result = await extras.listThreads({ includeHidden: true });
  assert.equal(result.items.length, 3); assert.equal(JSON.stringify(result).includes('private'), false);
});
test('thread options reject invalid values before network', async () => {
  const { extras, calls } = setup();
  for (const options of [{ dotId: '..' }, { includeHidden: 'yes' }, { limit: 101 }, { cursor: 'bad\n' }]) await assert.rejects(extras.listThreads(options), rejects('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});
test('conditional avatar sends native guard and validates returned identity', async () => {
  const { extras, calls } = setup([{ id: 'dot', avatar: 'default', secret: 'drop' }, { id: 'other' }]);
  assert.deepEqual(await extras.avatar({ avatar: 'default', onlyIfDefault: true }), { id: 'dot', avatar: 'default' });
  assert.deepEqual(calls[0].options.body, { avatar: 'default', only_if_default_avatar: true });
  await assert.rejects(extras.avatar({ avatar: 'default', onlyIfDefault: true }), rejects('INVALID_RESPONSE'));
});
test('conditional avatar rejects unsupported cross-type or rename updates', async () => {
  const { extras, calls } = setup();
  for (const options of [{ avatar: 'default', onlyIfDefault: 'true' }, { avatar: 'default', onlyIfDefault: true, name: 'New' }, { onlyIfDefault: true, avatarType: 'codex-pet' }]) await assert.rejects(extras.avatar(options), rejects('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});
test('pending deletion recovery requires explicit semantics and has no fake completed result', async () => {
  const { extras, calls } = setup([{ completed: true }]);
  await assert.rejects(extras.recoverDeletions(), rejects('INVALID_ARGUMENT'));
  assert.deepEqual(await extras.recoverDeletions({ confirm: true }), { status: 'deletion-recovery-requested' });
  assert.deepEqual(calls[0], { method: 'POST', route: '/backend-api/tbo/deletion-recovery', options: { signal: undefined } });
});
test('legacy primary selection uses thread contract and exact response identity', async () => {
  const { extras, calls } = setup([{ selection: { thread_id: 'thread', generation: 'g', private: 'drop' } }, { selection: { thread_id: 'other' } }]);
  assert.deepEqual(await extras.setPrimaryThread({ threadId: 'thread' }), { selection: { thread_id: 'thread', generation: 'g' } });
  assert.deepEqual(calls[0].options.body, { thread_id: 'thread' });
  assert.equal(calls[0].route, '/backend-api/cloud-aeons/primary');
  await assert.rejects(extras.setPrimaryThread({ threadId: 'thread' }), rejects('INVALID_RESPONSE'));
});
test('photo list projects only documented fields and canonical asset pointers', async () => {
  const { extras } = setup([{ items: [{ id: 'photo', kind: 'self', asset_pointer: 'sediment://bucket#file_abc#thumbnail', created_at: 'date', url: 'https://secret' }] }]);
  assert.deepEqual(await extras.listReferencePhotos(), { items: [{ id: 'photo', kind: 'self', created_at: 'date', asset_pointer: 'sediment://file_abc' }] });
});
test('native image-tag responses project the nested image asset identity', async () => {
  const { extras } = setup([{ items: [{ id: 'photo', kind: 'self', owner_user_id: 'private-owner', image_asset_pointer: { content_type: 'image/png', asset_pointer: 'sediment://bucket#file_native#thumbnail', size_bytes: 94, width: 16, height: 16, metadata: { private: 'drop' } } }] }]);
  assert.deepEqual(await extras.listReferencePhotos(), { items: [{ id: 'photo', kind: 'self', asset_pointer: 'sediment://file_native' }] });
});
test('conflicting flat and nested reference-photo asset identities fail closed', async () => {
  const { extras } = setup([{ items: [{ id: 'photo', asset_pointer: 'sediment://file_old', image_asset_pointer: { asset_pointer: 'sediment://file_new' } }] }]);
  await assert.rejects(extras.listReferencePhotos(), rejects('INVALID_RESPONSE'));
});
test('photo upload uses multipart then tag creation, pins account and strips response secrets', async t => {
  const { file } = await fixture(t);
  const { extras, calls } = setup([{ asset_pointer: 'sediment://bucket#file_new#thumbnail' }, { id: 'photo', kind: 'full_body_likeness', asset_pointer: 'sediment://file_new', secret: 'drop' }]);
  const result = await extras.uploadReferencePhoto({ file, kind: 'full_body_likeness' });
  assert.equal(result.id, 'photo'); assert.equal('secret' in result, false);
  assert.equal(calls[0].route, '/backend-api/calpico/chatgpt/profile_files'); assert.match(calls[0].options.bodyBytes.toString('latin1'), /name="file"; filename="reference-photo.png"/);
  assert.deepEqual(calls[1].options.body, { kind: 'full_body_likeness', asset_pointer: 'sediment://file_new' });
  assert.ok(calls.every(call => call.options.expectedAccountId === 'account'));
});
test('photo replacement checks current membership before uploading and only patches asset', async t => {
  const { file } = await fixture(t);
  const { extras, calls } = setup([{ items: [{ id: 'photo' }] }, { asset_pointer: 'sediment://file_new' }, { id: 'photo', kind: 'self' }]);
  await extras.updateReferencePhoto({ file, imageTagId: 'photo' });
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[1].method, 'POST'); assert.equal(calls[2].method, 'PATCH');
  assert.deepEqual(calls[2].options.body, { asset_pointer: 'sediment://file_new' });
});
test('photo replacement refuses absent photo before upload', async t => {
  const { file } = await fixture(t); const { extras, calls } = setup([{ items: [] }]);
  await assert.rejects(extras.updateReferencePhoto({ file, imageTagId: 'missing' }), rejects('PHOTO_UNAVAILABLE')); assert.equal(calls.length, 1);
});
test('photo upload rejects wrong kind, nonimage and symlink before network', async t => {
  const { file, root } = await fixture(t); const alias = join(root, 'alias'); await symlink(file, alias); const bad = join(root, 'bad'); await writeFile(bad, 'not an image');
  const { extras, calls } = setup();
  await assert.rejects(extras.uploadReferencePhoto({ file, kind: 'unknown' }), rejects('INVALID_ARGUMENT'));
  await assert.rejects(extras.uploadReferencePhoto({ file: alias }), rejects('FILE_READ_FAILED'));
  await assert.rejects(extras.uploadReferencePhoto({ file: bad }), rejects('INVALID_FILE'));
  assert.equal(calls.length, 0);
});
test('upload account switch blocks tag creation after uploaded file without retry', async t => {
  const { file } = await fixture(t); const { extras, client, calls } = setup([{ asset_pointer: 'sediment://file_new' }]); let accountId = 'account';
  client.transport.authLoader = async () => ({ accountId, accessToken: 'token' });
  const old = client.transport.request; client.transport.request = async (...args) => { const result = await old(...args); accountId = 'changed'; return result; };
  await assert.rejects(extras.uploadReferencePhoto({ file }), rejects('ACCOUNT_CHANGED')); assert.equal(calls.length, 1);
});
test('photo upload refuses a signed URL response and cannot tag it', async t => {
  const { file } = await fixture(t); const { extras, calls } = setup([{ asset_pointer: 'https://secret?token=key' }]);
  await assert.rejects(extras.uploadReferencePhoto({ file }), rejects('INVALID_RESPONSE')); assert.equal(calls.length, 1);
});
test('photo deletion requires exact target confirmation and does not retry failure', async () => {
  const error = new Error('network'); const { extras, calls } = setup([error]);
  await assert.rejects(extras.removeReferencePhoto({ imageTagId: 'photo', confirmImageTagId: 'other' }), rejects('INVALID_ARGUMENT'));
  await assert.rejects(extras.removeReferencePhoto({ imageTagId: 'photo', confirmImageTagId: 'photo' }), candidate => candidate === error);
  assert.equal(calls.length, 1);
});

test('Dot extras command manifest points only to implemented methods and exact destructive confirmation', async () => {
  const { commands, createClient } = await import('../src/command-sets/dot-extras.mjs');
  const { client } = setup(); const extras = createClient(client);
  for (const descriptor of Object.values(commands)) assert.equal(typeof extras[descriptor.method], 'function');
  assert.deepEqual(commands['account reference-photos delete'].confirmMatch, [['confirmImageTagId', 'imageTagId']]);
  assert.deepEqual(commands['dot avatar-default'].defaults, { onlyIfDefault: true });
  assert.equal(Object.keys(commands).some(name => name.includes('initialize')), false);
});
