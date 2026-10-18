import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DotOnboarding } from '../src/onboarding.mjs';
import { DotError } from '../src/errors.mjs';
import { commands } from '../src/command-sets/onboarding.mjs';

const jwt = sub => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.x`;
const old = { id: 'old', display_name: 'Old', avatar: 'default', root_thread_id: 'old-root', messaging_room_id: 'old-room' };
const fresh = { id: 'new', display_name: 'Banana', avatar: 'default', root_thread_id: 'new-root', messaging_room_id: 'new-room', status: 'active' };
const noRoom = { ...fresh, messaging_room_id: null };
const rejects = code => error => error.code === code;
const eligible = { accounts: { account: { account: { tbo_config: { tbo_available: true, plan_eligible: true, waitlist_info: 'NO_WAITLIST' } } } } };
function fixture(responses = [], eligibilityResponse = eligible) {
  const calls = [], eligibilityCalls = []; let auth = { accountId: 'account', accessToken: jwt('user'), refreshToken: 'DO_NOT_SAVE' };
  const transport = {
    authLoader: async () => auth,
    request: async (method, path, options) => {
      if (method === 'GET' && path === '/backend-api/accounts/check/v4-2023-04-27') {
        eligibilityCalls.push({ method, path, options });
        if (eligibilityResponse instanceof Error) throw eligibilityResponse;
        return eligibilityResponse;
      }
      calls.push({ method, path, options });
      const next = responses.shift();
      if (typeof next === 'function') return next({ method, path, options });
      if (next instanceof Error) throw next;
      if (next === undefined) throw Error('Unexpected request');
      return next;
    }
  };
  return { onboarding: new DotOnboarding({ transport }), calls, eligibilityCalls, transport, setAuth: value => { auth = value; } };
}
async function files(t) {
  const root = await mkdtemp(join(tmpdir(), 'dot-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, operationFile: join(root, 'state.json') };
}
async function uncertain(t, responses = [new Error('network failure')]) {
  const { operationFile, root } = await files(t);
  const f = fixture([{ items: [old] }, ...responses]);
  await assert.rejects(f.onboarding.create({ operationFile, name: 'Banana' }), rejects('ONBOARDING_CREATE_UNKNOWN'));
  return { ...f, operationFile, root };
}

test('native onboarding creation requests server initialization exactly once and verifies the current root and room', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [old] }, fresh, fresh]);
  const result = await f.onboarding.create({ operationFile, name: ' Banana ' });
  assert.equal(result.state, 'ready'); assert.equal(result.status, 'accepted');
  assert.equal(result.initialization, 'requested-with-create'); assert.equal(result.dotId, 'new');
  assert.equal(f.calls.length, 3);
  assert.equal(f.eligibilityCalls.length, 1);
  assert.equal(f.eligibilityCalls[0].options.expectedAccountId, 'account');
  assert.deepEqual(f.calls[1], { method: 'POST', path: '/backend-api/tbo', options: { body: { display_name: 'Banana', avatar: 'default', create_thread: true, create_additional: true, should_initialize: true }, timeoutMs: 540000, signal: undefined, expectedAccountId: 'account' } });
  assert.ok(f.calls.every(call => call.options.expectedAccountId === 'account'));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  const source = await readFile(operationFile, 'utf8');
  assert.equal(source.includes('DO_NOT_SAVE'), false); assert.equal(source.includes(jwt('user')), false); assert.equal(source.includes('"user"'), false);
  assert.equal((await stat(operationFile)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(source).beforeIds, ['old']);
});
test('eligibility selects the authenticated account and does not imply creation authorization', async () => {
  const f = fixture([], { ...eligible, accounts: { ...eligible.accounts, other: { account: { tbo_config: { tbo_available: false } } } }, account_ordering: ['other', 'account'] });
  assert.deepEqual(await f.onboarding.eligibility(), { accountId: 'account', available: true, planEligible: true, waitlist: 'none', creationAuthorizationVerified: false });
  assert.equal(f.calls.length, 0); assert.equal(f.eligibilityCalls.length, 1);
});
test('unavailable, missing and malformed eligibility stop creation before inventory or mutation', async t => {
  for (const [value, code] of [
    [{ accounts: { account: { account: { tbo_config: { tbo_available: false } } } } }, 'DOT_UNAVAILABLE'],
    [{ accounts: { other: eligible.accounts.account }, default_account_id: 'other' }, 'ACCOUNT_UNAVAILABLE'],
    [{ accounts: { account: { account: { tbo_config: { tbo_available: 'true' } } } } }, 'INVALID_RESPONSE'],
    [new DotError('EDGE_CHALLENGE', 'challenge', { status: 403 }), 'EDGE_CHALLENGE']
  ]) {
    const { operationFile } = await files(t), f = fixture([], value);
    await assert.rejects(f.onboarding.create({ operationFile }), rejects(code));
    assert.equal(f.calls.length, 0); assert.equal(f.eligibilityCalls.length, 1);
    await assert.rejects(stat(operationFile), { code: 'ENOENT' });
  }
});
test('missing room follows the native ensure-room route and confirms current identity afterwards', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, noRoom, noRoom, { messaging_room_id: 'new-room' }, fresh]);
  const result = await f.onboarding.create({ operationFile, name: 'Banana', createAdditional: false, avatar: 'default' });
  assert.equal(result.roomId, 'new-room');
  assert.equal(f.calls[1].options.body.create_additional, false);
  assert.deepEqual(f.calls[3], { method: 'POST', path: '/backend-api/tbo/new/messaging-room', options: { signal: undefined, expectedAccountId: 'account' } });
});
test('inventory is complete across pages and existing active roots may differ from original roots', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [{ ...old, active_root_thread_id: 'rebooted-root' }], cursor: 'next' }, { items: [{ ...old, id: 'another' }] }, fresh, fresh]);
  await f.onboarding.create({ operationFile, name: 'Banana' });
  assert.equal(f.calls[1].options.query.cursor, 'next');
  assert.deepEqual(JSON.parse(await readFile(operationFile, 'utf8')).beforeIds, ['old', 'another']);
});
test('creation has persisted pending intent before its first mutation', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, async () => {
    const journal = JSON.parse(await readFile(operationFile, 'utf8'));
    assert.equal(journal.state, 'create-pending'); assert.equal(journal.request.should_initialize, true);
    return fresh;
  }, fresh]);
  await f.onboarding.create({ operationFile });
});
test('uncertain creation stores its state and never retries the POST', async t => {
  const { calls, operationFile } = await uncertain(t);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'create-unknown');
});
test('known rejected creation retains its journal without retry or pretending success', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, new DotError('EDGE_CHALLENGE', 'blocked', { status: 403 })]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_REJECTED'));
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'create-rejected');
  assert.equal(f.calls.length, 2);
});
test('onboarding rejection preserves safe cause diagnostics in errors, journal and status', async t => {
  const { operationFile } = await files(t);
  const source = new DotError('EDGE_CHALLENGE', 'DO_NOT_SAVE', { status: 403, private: 'DO_NOT_SAVE' });
  const f = fixture([{ items: [] }, source, { items: [] }]);
  await assert.rejects(f.onboarding.create({ operationFile }), error => {
    assert.equal(error.code, 'ONBOARDING_REJECTED');
    assert.equal(error.details.causeCode, 'EDGE_CHALLENGE');
    assert.equal(error.details.status, 403);
    assert.equal(JSON.stringify(error.toJSON()).includes('DO_NOT_SAVE'), false);
    return true;
  });
  const text = await readFile(operationFile, 'utf8');
  assert.equal(text.includes('DO_NOT_SAVE'), false);
  assert.deepEqual(JSON.parse(text).failure, { causeCode: 'EDGE_CHALLENGE', status: 403 });
  const result = await f.onboarding.status({ operationFile });
  assert.deepEqual(result.failure, { causeCode: 'EDGE_CHALLENGE', status: 403 });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('cloud-aeon errors only count as a rejection when native semantics establish it', async t => {
  for (const [details, state] of [
    [{ status: 403, apiErrorFamily: 'cloud_aeon' }, 'create-unknown'],
    [{ status: 403, apiCode: 'cloud_aeon_recovery_required' }, 'create-unknown'],
    [{ status: 409, apiCode: 'cloud_aeon_recovery_required' }, 'create-rejected'],
    [{ status: 503, apiCode: 'cloud_aeon_creation_state_unavailable' }, 'create-rejected']
  ]) {
    const { operationFile } = await files(t);
    const f = fixture([{ items: [] }, new DotError('HTTP_ERROR', 'secret error text', details)]);
    await assert.rejects(f.onboarding.create({ operationFile }));
    assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, state);
    assert.equal(f.calls.length, 2);
  }
});
test('a returned existing Dot or missing root has unknown outcome, never accepted', async t => {
  for (const result of [old, { ...fresh, root_thread_id: null }, { ...fresh, id: '..' }]) {
    const { operationFile } = await files(t); const f = fixture([{ items: [old] }, result]);
    await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_CREATE_UNKNOWN'));
    assert.equal(f.calls.length, 2);
  }
});
test('status lists all new candidates without automatically selecting an ambiguous one', async t => {
  const { operationFile } = await uncertain(t);
  const f = fixture([{ items: [old, fresh, { ...fresh, id: 'new2', root_thread_id: 'new2-root' }, { ...fresh, id: 'other', display_name: 'Else' }] }]);
  const result = await f.onboarding.status({ operationFile });
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.map(value => value.matchesRequest), [true, true, false]);
  assert.equal(result.dotId, null); assert.equal(result.creationWillNotBeReplayed, true);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('resuming unknown creation requires an explicitly confirmed new candidate', async t => {
  const { operationFile } = await uncertain(t);
  const f = fixture([{ items: [old, fresh] }, fresh, fresh]);
  await assert.rejects(f.onboarding.resume({ operationFile }), rejects('ONBOARDING_CONFIRM_REQUIRED'));
  await assert.rejects(f.onboarding.resume({ operationFile, dotId: 'new', confirmDotId: 'wrong' }), rejects('INVALID_ARGUMENT'));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.onboarding.resume({ operationFile, dotId: 'new', confirmDotId: 'new' })).state, 'ready');
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('resume refuses old, missing, wrong-name, wrong-avatar or rootless candidates', async t => {
  const { operationFile } = await uncertain(t);
  for (const candidate of [old, { ...fresh, display_name: 'Other' }, { ...fresh, avatar: 'cat' }, { ...fresh, root_thread_id: null }]) {
    const f = fixture([{ items: [candidate] }]);
    await assert.rejects(f.onboarding.resume({ operationFile, dotId: candidate.id, confirmDotId: candidate.id }), rejects('ONBOARDING_CANDIDATE_MISMATCH'));
    assert.equal(f.calls.length, 1);
  }
});
test('ready operation status is read-only and resume cannot change its Dot', async t => {
  const { operationFile } = await files(t); const f = fixture([{ items: [] }, fresh, fresh, fresh]);
  await f.onboarding.create({ operationFile });
  const result = await f.onboarding.status({ operationFile });
  assert.equal(result.canResume, false); assert.equal(result.currentRoomId, 'new-room');
  await assert.rejects(f.onboarding.resume({ operationFile, dotId: 'other', confirmDotId: 'other' }), rejects('IDENTITY_MISMATCH'));
  assert.equal(f.calls.length, 4);
});
test('root or room changes stop reconciliation before further mutation', async t => {
  const { operationFile } = await files(t); const f = fixture([{ items: [] }, fresh, fresh]);
  await f.onboarding.create({ operationFile });
  for (const changed of [{ ...fresh, active_root_thread_id: 'changed' }, { ...fresh, messaging_room_id: 'changed' }, { ...fresh, id: 'other' }]) {
    const next = fixture([changed]);
    await assert.rejects(next.onboarding.status({ operationFile }), error => ['STALE_TARGET', 'INVALID_RESPONSE'].includes(error.code));
    assert.equal(next.calls.length, 1);
  }
});
test('unknown room result is reconciled by reads and never recreates the Dot', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, noRoom, noRoom, new Error('lost response')]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_ROOM_UNKNOWN'));
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'room-unknown');
  const next = fixture([fresh, fresh]);
  assert.equal((await next.onboarding.resume({ operationFile })).state, 'ready');
  assert.ok(next.calls.every(call => call.method === 'GET'));
});
test('unknown room with no visible room requires explicit retryRoom and makes at most one ensure request', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, noRoom, noRoom, new Error('lost response')]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_ROOM_UNKNOWN'));
  const read = fixture([noRoom]);
  await assert.rejects(read.onboarding.resume({ operationFile }), rejects('ONBOARDING_ROOM_RETRY_REQUIRED'));
  assert.equal(read.calls.length, 1);
  const retry = fixture([noRoom, noRoom, { messaging_room_id: 'new-room' }, fresh]);
  assert.equal((await retry.onboarding.resume({ operationFile, retryRoom: true })).state, 'ready');
  assert.equal(retry.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(retry.calls.find(call => call.method === 'POST').path, '/backend-api/tbo/new/messaging-room');
});
test('wrong ensure-room identity cannot advance the journal', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, noRoom, noRoom, { id: 'other', messaging_room_id: 'new-room' }]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_ROOM_UNKNOWN'));
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'room-unknown');
});
test('same-account user or account switch after an uncertain creation prevents all reconciliation requests', async t => {
  const { operationFile } = await uncertain(t);
  for (const auth of [{ accountId: 'other', accessToken: jwt('user') }, { accountId: 'account', accessToken: jwt('other') }]) {
    const f = fixture(); f.setAuth(auth);
    await assert.rejects(f.onboarding.status({ operationFile }), rejects('ACCOUNT_CHANGED'));
    await assert.rejects(f.onboarding.resume({ operationFile, dotId: 'new', confirmDotId: 'new' }), rejects('ACCOUNT_CHANGED'));
    assert.equal(f.calls.length, 0);
  }
});
test('identity switch between inventory and create prevents mutation', async t => {
  const { operationFile } = await files(t);
  const f = fixture([() => { f.setAuth({ accountId: 'account', accessToken: jwt('other') }); return { items: [] }; }]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_CREATE_UNKNOWN'));
  assert.equal(f.calls.length, 1);
});
test('identity switch after create prevents room creation and retains confirmed Dot identity', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, () => { f.setAuth({ accountId: 'other', accessToken: jwt('user') }); return noRoom; }]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ACCOUNT_CHANGED'));
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).dotId, 'new');
});
test('token refresh retaining subject is accepted without storing credentials', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, () => { f.setAuth({ accountId: 'account', accessToken: `${jwt('user')}.refreshed` }); return fresh; }, fresh]);
  assert.equal((await f.onboarding.create({ operationFile })).state, 'ready');
});
test('operation destination failures, existing files and symlinks reject before network', async t => {
  const { root, operationFile } = await files(t);
  const target = join(root, 'target'); await writeFile(target, 'preserve'); await symlink(target, operationFile);
  const f = fixture();
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('OPERATION_EXISTS'));
  assert.equal(await readFile(target, 'utf8'), 'preserve');
  await assert.rejects(f.onboarding.create({ operationFile: join(root, 'missing', 'state') }), rejects('OPERATION_FILE_FAILED'));
  const directory = join(root, 'directory'); await mkdir(directory);
  await assert.rejects(f.onboarding.create({ operationFile: directory }), rejects('OPERATION_EXISTS'));
  assert.equal(f.calls.length, 0);
});
test('a retained operation can never be overwritten and creation is never replayed', async t => {
  const { operationFile } = await uncertain(t); const f = fixture();
  const before = await readFile(operationFile, 'utf8');
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('OPERATION_EXISTS'));
  assert.equal(await readFile(operationFile, 'utf8'), before); assert.equal(f.calls.length, 0);
});
test('read refuses symlinks, public files, invalid schemas and oversized operation files', async t => {
  const { root, operationFile } = await uncertain(t);
  const alias = join(root, 'alias'); await symlink(operationFile, alias);
  const f = fixture();
  await assert.rejects(f.onboarding.status({ operationFile: alias }), rejects('INVALID_OPERATION_FILE'));
  const bad = join(root, 'bad'); await writeFile(bad, '{}', { mode: 0o600 });
  await assert.rejects(f.onboarding.status({ operationFile: bad }), rejects('INVALID_OPERATION_FILE'));
  const publicFile = join(root, 'public'); await writeFile(publicFile, await readFile(operationFile), { mode: 0o644 });
  // Creation modes are filtered by the caller's umask; this fixture must be public.
  await chmod(publicFile, 0o644); assert.equal((await stat(publicFile)).mode & 0o777, 0o644);
  await assert.rejects(f.onboarding.status({ operationFile: publicFile }), rejects('INVALID_OPERATION_FILE'));
  const huge = join(root, 'huge'); await writeFile(huge, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(f.onboarding.status({ operationFile: huge }), rejects('INVALID_OPERATION_FILE'));
  assert.equal(f.calls.length, 0);
});
test('concurrent writers and stale locks do not mutate or remove another owner lock', async t => {
  const { operationFile } = await files(t);
  await writeFile(`${operationFile}.lock`, 'owner', { mode: 0o600 }); const f = fixture();
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('OPERATION_LOCKED'));
  assert.equal(await readFile(`${operationFile}.lock`, 'utf8'), 'owner'); assert.equal(f.calls.length, 0);
});
test('input validation happens before network or file creation', async t => {
  const { operationFile } = await files(t); const f = fixture();
  for (const bad of [{ name: 'bad\nname' }, { avatar: '../bad' }, { createAdditional: 'yes' }, { shouldInitialize: false }, { createThread: false }]) await assert.rejects(f.onboarding.create({ operationFile, ...bad }), rejects('INVALID_ARGUMENT'));
  await assert.rejects(f.onboarding.create({ operationFile: '-' }), rejects('INVALID_ARGUMENT'));
  assert.equal(f.calls.length, 0);
});
test('missing signed-in subject fails before any API read or creation and clears unused reservation', async t => {
  const { operationFile } = await files(t); const f = fixture(); f.setAuth({ accountId: 'account', accessToken: 'opaque' });
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('AUTH_IDENTITY_MISSING'));
  await assert.rejects(stat(operationFile), { code: 'ENOENT' }); assert.equal(f.calls.length, 0);
});
test('construction performs no authentication and a missing auth loader fails when onboarding is used', async t => {
  const { operationFile } = await files(t); let requested = false;
  const onboarding = new DotOnboarding({ transport: { request: async () => { requested = true; } } });
  assert.equal(requested, false);
  await assert.rejects(onboarding.create({ operationFile }), rejects('AUTH_IDENTITY_MISSING'));
  assert.equal(requested, false); await assert.rejects(stat(operationFile), { code: 'ENOENT' });
});
test('cancellation before submission makes no request and removes its unused operation file', async t => {
  const { operationFile } = await files(t); const f = fixture(); const signal = AbortSignal.abort();
  await assert.rejects(f.onboarding.create({ operationFile, signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0); await assert.rejects(stat(operationFile), { code: 'ENOENT' });
});
test('cancellation during the create request persists an uncertain outcome without replaying', async t => {
  const { operationFile } = await files(t);
  const f = fixture([{ items: [] }, () => { throw new DOMException('Canceled', 'AbortError'); }]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('ONBOARDING_CREATE_UNKNOWN'));
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'create-unknown');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('cancellation after a confirmed create preserves identity and sends no room mutation', async t => {
  const { operationFile } = await files(t); const controller = new AbortController();
  const f = fixture([{ items: [] }, () => { controller.abort(); return noRoom; }]);
  await assert.rejects(f.onboarding.create({ operationFile, signal: controller.signal }), { name: 'AbortError' });
  const journal = JSON.parse(await readFile(operationFile, 'utf8'));
  assert.equal(journal.state, 'created'); assert.equal(journal.dotId, 'new');
  assert.equal(f.calls.length, 2);
});
test('repeated inventory cursor aborts before creation', async t => {
  const { operationFile } = await files(t); const f = fixture([{ items: [], cursor: 'loop' }, { items: [], cursor: 'loop' }]);
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('CURSOR_LOOP'));
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
test('command manifest exposes native create and read/reconcile commands without orphan raw initialize', () => {
  assert.deepEqual(Object.keys(commands), ['dot onboarding eligibility', 'dot onboarding create', 'dot onboarding status', 'dot onboarding resume']);
  assert.deepEqual(commands['dot onboarding create'].required, ['operationFile']);
  assert.equal(commands['dot onboarding create'].flags['--first-dot'].value, false);
});

test('onboarding active owner locks retain OPERATION_LOCKED regardless of age', async t => {
  const { operationFile } = await files(t), f = fixture();
  const lockFile = `${operationFile}.lock`, owner = { version: 1, token: randomUUID(), host: hostname(), pid: process.pid, uid: process.getuid?.() ?? null };
  await writeFile(lockFile, JSON.stringify(owner), { mode: 0o600 }); await utimes(lockFile, new Date(0), new Date(0));
  await assert.rejects(f.onboarding.create({ operationFile }), error => error.code === 'OPERATION_LOCKED' && error.details.ownerPid === process.pid);
  assert.deepEqual(JSON.parse(await readFile(lockFile, 'utf8')), owner); assert.equal(f.calls.length, 0);
});

test('onboarding interrupted recovery guards retain OPERATION_LOCKED and do not mutate', async t => {
  const { operationFile } = await files(t), f = fixture(), guardFile = `${operationFile}.lock.recovery-lock`;
  await writeFile(guardFile, 'unknown recovery owner', { mode: 0o600 });
  await assert.rejects(f.onboarding.create({ operationFile }), error => error.code === 'OPERATION_LOCKED' && error.details.recovery === 'guard_requires_review');
  assert.equal(await readFile(guardFile, 'utf8'), 'unknown recovery owner'); assert.equal(f.calls.length, 0);
});

test('killed onboarding create recovers its owner lock and reconciles without replaying create', { timeout: 10000 }, async t => {
  const { operationFile, root } = await files(t), log = join(root, 'create-calls.log');
  const script = `import { DotOnboarding } from ${JSON.stringify(new URL('../src/onboarding.mjs', import.meta.url).href)};
import { appendFile } from 'node:fs/promises';
const args=JSON.parse(process.argv[1]);
const client=new DotOnboarding({transport:{authLoader:async()=>({accountId:'account',accessToken:'x.'+Buffer.from(JSON.stringify({sub:'user'})).toString('base64url')+'.x'}),request:async(method,path)=>{
if(method==='GET'&&path==='/backend-api/accounts/check/v4-2023-04-27')return {accounts:{account:{account:{tbo_config:{tbo_available:true}}}}};
if(method==='GET'&&path==='/backend-api/tbo')return {items:[args.old]};
if(method==='POST'&&path==='/backend-api/tbo'){await appendFile(args.log,'create\\n');setInterval(()=>{},1000);process.stdout.write('create-started\\n');return new Promise(()=>{});}
throw Error('Unexpected request');}}});
await client.create({operationFile:args.operationFile,name:'Banana'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ operationFile, log, old })], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let text = '', error = ''; child.stdout.on('data', value => { text += value; if (text.includes('create-started\n')) resolve(); });
    child.stderr.on('data', value => { error += value; }); child.once('error', reject); child.once('exit', code => { if (code != null) reject(new Error(error || `child exited ${code}`)); });
  });
  const lockFile = `${operationFile}.lock`, owner = JSON.parse(await readFile(lockFile, 'utf8'));
  assert.equal(owner.pid, child.pid); assert.equal(owner.host, hostname()); assert.equal((await stat(lockFile)).mode & 0o777, 0o600);
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'create-pending');
  const f = fixture([{ items: [old, fresh] }, { items: [old, fresh] }, fresh, fresh]);
  const status = await f.onboarding.status({ operationFile }); assert.equal(status.creationWillNotBeReplayed, true); assert.equal(status.canResume, true);
  const result = await f.onboarding.resume({ operationFile, dotId: 'new', confirmDotId: 'new' }); assert.equal(result.state, 'ready');
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(readFile(lockFile), { code: 'ENOENT' }); await assert.rejects(readFile(`${lockFile}.recovery-lock`), { code: 'ENOENT' });
  await assert.rejects(f.onboarding.create({ operationFile }), rejects('OPERATION_EXISTS')); assert.ok(f.calls.every(call => call.method === 'GET'));
});
