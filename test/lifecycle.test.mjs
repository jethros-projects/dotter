import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DotLifecycle } from '../src/lifecycle.mjs';

const DOT = 'account~dot', THREAD = 'root-thread', ENV = 'computer-1';
const PROFILE = { id: DOT, display_name: 'Dot', active_root_thread_id: THREAD, messaging_room_id: 'room', aeon_kind: 'orbit', status: 'active' };
const SNAPSHOT = { schema_version: 1, asset_pointer: 'sediment://avatar-id' };
function setup(responses = [], primary = { id: DOT }) {
  const calls = [];
  const client = { primary: async () => primary, transport: { request: async (method, route, options) => {
    calls.push({ method, route, options });
    if (!responses.length) throw new Error(`Unexpected request ${method} ${route}`);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  } } };
  return { lifecycle: new DotLifecycle(client), calls };
}
const failure = code => error => error.code === code;

test('creates one Dot with exact native creation body and safe profile', async () => {
  const { lifecycle, calls } = setup([{ ...PROFILE, private_reasoning: 'hidden' }]);
  const result = await lifecycle.create({ name: ' Fresh ', avatar: 'sunglasses', createAdditional: false });
  assert.deepEqual(calls[0], { method: 'POST', route: '/backend-api/tbo', options: { body: {
    display_name: 'Fresh', avatar: 'sunglasses', create_thread: true, create_additional: false, should_initialize: true
  }, signal: undefined } });
  assert.equal(result.id, DOT);
  assert.equal(result.threadId, THREAD);
  assert.ok(!JSON.stringify(result).includes('hidden'));
});

test('creation rejects invalid booleans and conflicting appearance before a request', async () => {
  const { lifecycle, calls } = setup();
  await assert.rejects(lifecycle.create({ createThread: 'true' }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.create({ avatar: 'default', avatarType: 'codex-pet' }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('creation propagates uncertain write without retrying', async () => {
  const error = Object.assign(new Error('network'), { code: 'NETWORK_ERROR', details: { delivery: 'unknown' } });
  const { lifecycle, calls } = setup([error]);
  await assert.rejects(lifecycle.create(), candidate => candidate === error);
  assert.equal(calls.length, 1);
});

test('delete requires an exact explicit ID confirmation before network', async () => {
  const { lifecycle, calls } = setup([{ completed: true }]);
  await assert.rejects(lifecycle.remove({ dotId: DOT, confirmDotId: 'another' }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.deepEqual(await lifecycle.remove({ dotId: DOT, confirmDotId: DOT }), { dotId: DOT, status: 'deletion-requested' });
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].route, `/backend-api/tbo/${DOT}`);
});

test('IDs reject traversal, line breaks, and encoded slash', async () => {
  const { lifecycle, calls } = setup();
  for (const dotId of ['..', '.', 'dot/a', 'dot%2fa', 'dot\n']) await assert.rejects(lifecycle.setPrimary({ dotId }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('set and clear primary use selection and generation contracts', async () => {
  const response = { selection: { thread_id: THREAD, generation: 'gen1', available: true, token: 'secret' }, unknown: 'hidden' };
  const { lifecycle, calls } = setup([response, { selection: null }]);
  assert.deepEqual(await lifecycle.setPrimary({ dotId: DOT }), { selection: { thread_id: THREAD, generation: 'gen1', available: true } });
  assert.deepEqual(calls[0].options.body, { tbo_id: DOT });
  await assert.rejects(lifecycle.clearPrimary({ generation: 'gen1' }), failure('INVALID_ARGUMENT'));
  assert.deepEqual(await lifecycle.clearPrimary({ generation: 'gen1', confirm: true }), { selection: null });
  assert.deepEqual(calls[1].options.query, { generation: 'gen1' });
});

test('avatar updates allow native pet snapshots and do not return arbitrary server fields', async () => {
  const { lifecycle, calls } = setup([{ ...PROFILE, avatar_type: 'codex-pet', secret: 'private' }]);
  const result = await lifecycle.avatar({ dotId: DOT, avatarType: 'codex-pet', avatarManifest: { pet_id: 'custom:pet', snapshot: SNAPSHOT } });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].route, `/backend-api/cloud-aeons/${DOT}`);
  assert.deepEqual(calls[0].options.body, { avatar_type: 'codex-pet', avatar_manifest: { pet_id: 'custom:pet', snapshot: SNAPSHOT }, avatar_url: SNAPSHOT.asset_pointer });
  assert.equal(result.avatarType, 'codex-pet');
  assert.ok(!('secret' in result));
});

test('pet avatar mutation requires an uploaded snapshot and separate rename', async () => {
  const { lifecycle, calls } = setup();
  await assert.rejects(lifecycle.avatar({ dotId: DOT, avatarType: 'codex-pet', avatarManifest: { pet_id: 'custom:pet' } }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.avatar({ dotId: DOT, name: 'New name', avatarType: 'codex-pet', avatarManifest: { pet_id: 'custom:pet', snapshot: SNAPSHOT } }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('legacy avatar and plain rename stay on the tbo mutation route', async () => {
  const { lifecycle, calls } = setup([PROFILE, PROFILE]);
  await lifecycle.avatar({ dotId: DOT, avatar: 'default' });
  await lifecycle.avatar({ dotId: DOT, name: 'Renamed' });
  assert.ok(calls.every(call => call.route === `/backend-api/tbo/${DOT}`));
  assert.deepEqual(calls[1].options.body, { display_name: 'Renamed' });
});

test('avatar rejects remote URLs, unknown types and malformed manifests before network', async () => {
  const { lifecycle, calls } = setup();
  await assert.rejects(lifecycle.avatar({ dotId: DOT, avatarType: 'codex-pet', avatarManifest: { pet_id: 'p', snapshot: SNAPSHOT }, avatarUrl: 'https://example.com/image' }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.avatar({ dotId: DOT, avatarType: 'custom', avatarManifest: {} }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.avatar({ dotId: DOT, avatarType: 'rendered-interactive', avatarManifest: {} }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.avatar({ dotId: DOT }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('rendered avatar validates snapshot and strips unknown manifest fields', async () => {
  const { lifecycle, calls } = setup([PROFILE]);
  await lifecycle.avatar({ dotId: DOT, avatarType: 'rendered-interactive', avatarManifest: {
    schema_version: 1, resource_bundle_id: 'a'.repeat(64), appearance: { shape: 'circle', eyes: 'oval' }, snapshot: SNAPSHOT, extra: 'drop'
  } });
  assert.equal(calls[0].route, `/backend-api/tbo/${DOT}`);
  assert.ok(!('extra' in calls[0].options.body.avatar_manifest));
});

test('avatar snapshot multipart includes PNG and optional validated manifest', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dot-avatar-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(path, 'image.png');
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]));
  const { lifecycle, calls } = setup([{ snapshot: SNAPSHOT, secret: 'omit' }]);
  const avatarManifest = { schema_version: 1, resource_bundle_id: 'b'.repeat(64), appearance: { color: 'blue' } };
  const result = await lifecycle.uploadAvatarSnapshot({ file, avatarManifest });
  assert.deepEqual(result, { snapshot: SNAPSHOT, avatarManifest: { ...avatarManifest, snapshot: SNAPSHOT } });
  const body = calls[0].options.bodyBytes.toString('latin1');
  assert.match(body, /name="file"; filename="avatar.png"/);
  assert.match(body, /Content-Type: image\/png/);
  assert.match(body, /name="avatar_manifest"/);
  assert.match(body, /"appearance":\{"color":"blue"\}/);
  assert.equal(calls[0].route, '/backend-api/cloud-aeons/avatar-snapshots');
});

test('avatar snapshot rejects symlinks and non-PNG data with zero API calls', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dot-avatar-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(path, 'image.png'), alias = join(path, 'alias.png');
  await writeFile(file, 'this is not a PNG'); await symlink(file, alias);
  const { lifecycle, calls } = setup();
  await assert.rejects(lifecycle.uploadAvatarSnapshot({ file: alias }), failure('FILE_READ_FAILED'));
  await assert.rejects(lifecycle.uploadAvatarSnapshot({ file }), failure('INVALID_FILE'));
  assert.equal(calls.length, 0);
});

test('avatar snapshot rejects secret-bearing server URL', async t => {
  const path = await mkdtemp(join(tmpdir(), 'dot-avatar-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const file = join(path, 'image.png');
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const { lifecycle } = setup([{ snapshot: { schema_version: 1, asset_pointer: 'https://example.com/?token=secret' } }]);
  await assert.rejects(lifecycle.uploadAvatarSnapshot({ file }), failure('INVALID_RESPONSE'));
});

test('room repair and root resolution use current primary fallback', async () => {
  const { lifecycle, calls } = setup([{ messaging_room_id: 'room-1', hidden: 'omit' }, { root_thread_id: THREAD }]);
  assert.deepEqual(await lifecycle.ensureRoom(), { dotId: DOT, roomId: 'room-1' });
  assert.deepEqual(await lifecycle.rootThread(), { dotId: DOT, threadId: THREAD });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].route, `/backend-api/tbo/${DOT}/root-thread`);
});

test('reboot is primary-only and requires confirmation, reports requested not recovered', async () => {
  const { lifecycle, calls } = setup([Buffer.alloc(0)]);
  await assert.rejects(lifecycle.reboot({ dotId: DOT }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.deepEqual(await lifecycle.reboot({ dotId: DOT, confirmDotId: DOT }), { dotId: DOT, status: 'reboot-requested' });
  assert.equal(calls[0].route, '/backend-api/cloud-aeons/primary/reboot');
  assert.equal(calls[0].options.responseType, 'bytes');
  const other = setup([], { id: 'other' });
  await assert.rejects(other.lifecycle.reboot({ dotId: DOT, confirmDotId: DOT }), failure('PRIMARY_MISMATCH'));
  assert.equal(other.calls.length, 0);
});

test('environment status includes thread query and only visible capabilities', async () => {
  const { lifecycle, calls } = setup([PROFILE, { environmentId: ENV, status: 'ready', private_reasoning: 'hidden', capabilities: [
    { type: 'remote_desktop', status: 'ready', token: 'secret' }, { type: 'internal', hidden: true }
  ] }]);
  assert.deepEqual(await lifecycle.environmentStatus({ dotId: DOT }), { dotId: DOT, threadId: THREAD, environmentId: ENV, status: 'ready', capabilities: [{ type: 'remote_desktop', status: 'ready' }] });
  assert.deepEqual(calls[1].options.query, { thread_id: THREAD });
});

test('environment recreation fails closed for stale thread and missing confirmation', async () => {
  const { lifecycle, calls } = setup([PROFILE]);
  await assert.rejects(lifecycle.recreateEnvironment({ dotId: DOT }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  await assert.rejects(lifecycle.recreateEnvironment({ dotId: DOT, threadId: 'old', confirmDotId: DOT }), failure('STALE_TARGET'));
  assert.equal(calls.length, 1);
});

test('environment recreation passes verified active thread and does not retry', async () => {
  const { lifecycle, calls } = setup([PROFILE, { status: 'queued' }]);
  assert.deepEqual(await lifecycle.recreateEnvironment({ dotId: DOT, confirmDotId: DOT }), { dotId: DOT, threadId: THREAD, status: 'recreation-requested' });
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(calls[1].options.query, { thread_id: THREAD });
});

test('computer list verifies echoed thread and excludes hidden fields', async () => {
  const { lifecycle } = setup([PROFILE, { thread_id: THREAD, computers: [{ kind: 'user', environment_id: ENV, display_name: 'Mac', status: 'connected', is_attached: true, connection_secret: 'x' }, { hidden: true, environment_id: 'private' }] }]);
  assert.deepEqual((await lifecycle.listComputers({ dotId: DOT })).computers, [{ kind: 'user', environment_id: ENV, display_name: 'Mac', status: 'connected', is_attached: true }]);
  const bad = setup([PROFILE, { thread_id: 'other', computers: [] }]);
  await assert.rejects(bad.lifecycle.listComputers({ dotId: DOT }), failure('STALE_TARGET'));
});

for (const [method, action] of [['connectComputer', 'connect'], ['replaceComputer', 'connect-and-replace'], ['disconnectComputer', 'disconnect']]) {
  test(`${method} validates catalog and uses exact native endpoint`, async () => {
    const { lifecycle, calls } = setup([PROFILE, PROFILE, { thread_id: THREAD, computers: [{ kind: 'user', environment_id: ENV }] }, { completed: true }]);
    const result = await lifecycle[method]({ dotId: DOT, environmentId: ENV, confirmEnvironmentId: ENV });
    assert.equal(result.status, `${action}-requested`);
    assert.equal(calls.at(-1).route, `/backend-api/tbo/${DOT}/computers/${ENV}/${action}`);
    assert.deepEqual(calls.at(-1).options.query, { expected_thread_id: THREAD });
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });
}

test('replace and disconnect require explicit confirmation before reads', async () => {
  const { lifecycle, calls } = setup();
  await assert.rejects(lifecycle.replaceComputer({ dotId: DOT, environmentId: ENV }), failure('INVALID_ARGUMENT'));
  await assert.rejects(lifecycle.disconnectComputer({ dotId: DOT, environmentId: ENV, confirmEnvironmentId: 'other' }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('computer target absent from current catalog never mutates', async () => {
  const { lifecycle, calls } = setup([PROFILE, PROFILE, { thread_id: THREAD, computers: [{ kind: 'cloud', environment_id: ENV }] }]);
  await assert.rejects(lifecycle.connectComputer({ dotId: DOT, environmentId: ENV }), failure('COMPUTER_UNAVAILABLE'));
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('activity projects only visible user-facing state and preview', async () => {
  const { lifecycle, calls } = setup([{ data: [
    { thread_id: THREAD, title: 'Task', status: 'completed', outcome: 'succeeded', preview: { turn_id: 'turn', text: 'Visible summary', reasoning: 'private', image: { url: 'signed-secret' } }, image_url: 'signed-secret', reasoning: 'private' },
    { thread_id: 'hidden', metadata: { is_hidden: true }, preview: { text: 'secret' } },
    { thread_id: 'skip', preview: { text: '  ::SKIP_COMPLETION::  ' } }
  ], next_cursor: 'cursor' }]);
  assert.deepEqual(await lifecycle.activity({ dotId: DOT, cursor: 'previous' }), { dotId: DOT, data: [
    { thread_id: THREAD, title: 'Task', status: 'completed', outcome: 'succeeded', preview: { turn_id: 'turn', text: 'Visible summary' } },
    { thread_id: 'skip', preview: {} }
  ], nextCursor: 'cursor' });
  assert.deepEqual(calls[0].options.query, { limit: 5, cursor: 'previous' });
});

test('doctor check-in and explicit recurring setup use separate routes', async () => {
  const { lifecycle, calls } = setup([{ workflow_url: 'https://chatgpt.com/workflow/one', private: 'omit' }, { schedule_url: 'https://chatgpt.com/tasks/two' }]);
  await assert.rejects(lifecycle.doctorSetup({ threadId: THREAD }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.deepEqual(await lifecycle.doctorCheckIn({ threadId: THREAD }), { workflow_url: 'https://chatgpt.com/workflow/one' });
  assert.deepEqual(await lifecycle.doctorSetup({ threadId: THREAD, confirm: true }), { schedule_url: 'https://chatgpt.com/tasks/two' });
  assert.match(calls[0].route, /\/doctor\/check-in$/);
  assert.match(calls[1].route, /\/doctor\/setup$/);
});

test('doctor response does not expose credential-bearing links', async () => {
  const { lifecycle } = setup([{ schedule_url: 'https://chatgpt.com/?token=secret', workflow_url: 'https://user:password@example.com/one' }]);
  assert.deepEqual(await lifecycle.doctorCheckIn({ threadId: THREAD }), {});
});

test('safety review returns only the explicit product explanation and stable fingerprint', async () => {
  const { lifecycle } = setup([{ detailed_explanation: ' Needs review ', private_reasoning: 'hidden', token: 'secret' }]);
  const result = await lifecycle.safetyReview({ dotId: DOT });
  assert.equal(result.explanation, 'Needs review');
  assert.match(result.reviewFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('reviewed resume requires exact confirmation and current review fingerprint', async () => {
  const review = setup([{ detailed_explanation: 'Needs review' }]);
  const { reviewFingerprint } = await review.lifecycle.safetyReview({ dotId: DOT });
  const { lifecycle, calls } = setup([PROFILE, { detailed_explanation: 'Needs review' }, { status: 'applied', thread_id: THREAD }]);
  await assert.rejects(lifecycle.resumeReviewed({ dotId: DOT, reviewFingerprint }), failure('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.deepEqual(await lifecycle.resumeReviewed({ dotId: DOT, confirmDotId: DOT, reviewFingerprint }), { dotId: DOT, threadId: THREAD, status: 'applied' });
  assert.deepEqual(calls[2].options.body, { clear_safety_flag: true });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('changed review cannot trigger a resume write', async () => {
  const { lifecycle, calls } = setup([PROFILE, { detailed_explanation: 'New finding' }]);
  await assert.rejects(lifecycle.resumeReviewed({ dotId: DOT, confirmDotId: DOT, reviewFingerprint: '0'.repeat(64) }), failure('REVIEW_CHANGED'));
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('reviewed resume does not claim success for another thread or unconfirmed status', async () => {
  const review = setup([{ detailed_explanation: 'Finding' }]);
  const { reviewFingerprint } = await review.lifecycle.safetyReview({ dotId: DOT });
  const { lifecycle, calls } = setup([PROFILE, { detailed_explanation: 'Finding' }, { status: 'unconfirmed', thread_id: THREAD }]);
  await assert.rejects(lifecycle.resumeReviewed({ dotId: DOT, confirmDotId: DOT, reviewFingerprint }), failure('RESUME_UNCONFIRMED'));
  assert.equal(calls.length, 3);
});


for (const [label, options, route] of [
  ['legacy avatar', { avatar: 'default' }, '/backend-api/tbo/'],
  ['rename', { name: 'Renamed' }, '/backend-api/tbo/'],
  ['pet avatar', { avatarType: 'codex-pet', avatarManifest: { pet_id: 'custom:pet', snapshot: SNAPSHOT } }, '/backend-api/cloud-aeons/'],
]) {
  test(`a ${label} response for another Dot remains an uncertain write`, async () => {
    const { lifecycle, calls } = setup([{ ...PROFILE, id: 'another-dot' }]);
    await assert.rejects(lifecycle.avatar({ dotId: DOT, ...options }), error => error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].route, route + encodeURIComponent(DOT));
  });
}
