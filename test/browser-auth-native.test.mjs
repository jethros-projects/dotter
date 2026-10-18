import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, chmod, symlink, rm, mkdir, readdir, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DotBrowserAuthNative, browserAuthNativeCapabilities } from '../src/browser-auth-native.mjs';
import { commands } from '../src/command-sets/browser-auth-native.mjs';

const ORIGIN = 'https://accounts.example.test';
const CHALLENGE = 'a'.repeat(32);
const NOW = 1792281600000;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-auth-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'operation.json'), credentialsFile = join(dir, 'private.json'), ledgerDirectory = join(dir, 'ledger');
  await writeFile(credentialsFile, JSON.stringify({ username: 'private-user', password: 'PRIVATE_PASSWORD' }), { mode: 0o600 });
  const calls = [], opened = []; let subject = 'user-1', accountId = 'account-1', accountUserId = 'account-user-1';
  const source = { roomId: 'room-1', messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', threadId: 'thread-1', challengeId: CHALLENGE, origin: ORIGIN,
    fields: [{ id: 'username', type: 'email', label: 'Email', required: true }, { id: 'password', type: 'password', label: 'Password', required: true }], options: [], hasWebauthn: false, qrCodeRequiresApp: false };
  const available = { available: true, save_enabled: true, reuse_enabled: true, manual_save_supported: true, manual_fill_recovery_supported: true,
    manual_save_fields: { username: 'username', password: 'password' }, items: [{ credential_id: 'credential-1', origin: ORIGIN, selection_id: 'PRIVATE_SELECTION', expires_at: NOW / 1000 + 600 }], next_cursor: null };
  const manager = { provider: 'onepassword', state: 'waiting', access_handle: 'PRIVATE_HANDLE', operation_id: 'manager-operation', expires_at: NOW / 1000 + 600,
    approval_url: 'onepassword://grant-brokered-access?access_request_reference=PRIVATE_REFERENCE' };
  const prepared = { manual_fill_recovery_supported: true, operation_id: null, operation: null, password_managers: [{ provider: 'onepassword', interaction: 'external', state: 'connected' }] };
  let fillFailure = false;
  const transport = { authLoader: async () => ({ accountId, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject, 'https://api.openai.com/auth': { chatgpt_account_user_id: accountUserId } })).toString('base64url')}.signature` }),
    request: async (method, route, request) => {
      calls.push({ method, route, options: structuredClone(request) });
      if (options.request) { const handled = await options.request(method, route, request); if (handled !== undefined) return handled; }
      if (route.endsWith('/auth/prepare')) return structuredClone(prepared);
      if (route.endsWith('/credential-availability') || route.endsWith('/credential-candidates')) return structuredClone(available);
      if (route.endsWith('/form-fill')) { if (fillFailure) throw new Error('PRIVATE_PASSWORD'); return { status: 'submitted', operation_id: request.body.operation_id, save_status: request.body.remember ? 'saved' : 'not_requested' }; }
      if (route.endsWith('/reconcile')) return { operation_id: route.split('/').at(-2), fill_status: 'submitted', save_status: 'not_requested' };
      if (route.endsWith('/access-requests/status')) return { ...manager };
      if (route.endsWith('/access-requests')) return { ...manager };
      throw new Error('unexpected request');
    } };
  const client = new DotBrowserAuthNative({ transport }, { inspect: async () => structuredClone(source), now: () => NOW, openApproval: async url => opened.push(url), ledgerDirectory });
  return { dir, stateFile, credentialsFile, ledgerDirectory, calls, client, source, available, manager, prepared, opened,
    setSubject(value) { subject = value; }, setAccount(value) { accountId = value; }, setAccountUser(value) { accountUserId = value; }, failFill() { fillFailure = true; },
    claim: () => client.claim({ stateFile, roomId: source.roomId, messageId: source.messageId, requestFingerprint: source.requestFingerprint, expectedOrigin: source.origin }) };
}
const fills = f => f.calls.filter(call => call.route.endsWith('/form-fill'));

test('browser-auth durable claim binds identity, fingerprint, origin and field IDs privately', async t => {
  const f = await fixture(t); const first = await f.claim(), second = await f.claim();
  assert.equal(first.operationId, second.operationId); assert.equal(first.origin, ORIGIN); assert.equal(first.phase, 'claimed');
  assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600); assert.equal(f.calls.filter(call => call.route.endsWith('/auth/prepare')).length, 1);
  assert.doesNotMatch(await readFile(f.stateFile, 'utf8'), /PRIVATE_PASSWORD|PRIVATE_SELECTION|PRIVATE_HANDLE/);
});
test('shared challenge ledger rejects different state files even in different directories', async t => {
  const f = await fixture(t); const secondDir = join(f.dir, 'second'); await mkdir(secondDir);
  const secondFile = join(secondDir, 'other.json');
  const claims = await Promise.allSettled([f.claim(), f.client.claim({ stateFile: secondFile, roomId: 'room-1', messageId: 'message-1', requestFingerprint: 'fingerprint-1', expectedOrigin: ORIGIN })]);
  assert.equal(claims.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(claims.find(value => value.status === 'rejected').reason.code, 'CHALLENGE_ALREADY_CLAIMED');
  const winningFile = claims[0].status === 'fulfilled' ? f.stateFile : secondFile;
  await f.client.fill({ stateFile: winningFile, credentialsFile: f.credentialsFile }); assert.equal(fills(f).length, 1);
  const ledger = JSON.parse(await readFile(join(f.ledgerDirectory, (await readdir(f.ledgerDirectory))[0]), 'utf8'));
  assert.doesNotMatch(JSON.stringify(ledger), /PRIVATE_PASSWORD|private-user|PRIVATE_HANDLE|PRIVATE_SELECTION/);
});
test('separate CLI processes cannot submit the same challenge through different state files', async t => {
  const f = await fixture(t); const log = join(f.dir, 'calls.log');
  const script = `import { DotBrowserAuthNative } from ${JSON.stringify(new URL('../src/browser-auth-native.mjs', import.meta.url).href)};
import { appendFile } from 'node:fs/promises';
const args=JSON.parse(process.argv[1]);
const transport={authLoader:async()=>({accountId:'account-1',accessToken:'header.'+Buffer.from(JSON.stringify({sub:'user-1','https://api.openai.com/auth':{chatgpt_account_user_id:'account-user-1'}})).toString('base64url')+'.signature'}),request:async(method,route,options)=>{
if(route.endsWith('/auth/prepare'))return {manual_fill_recovery_supported:true,password_managers:[]};
if(route.endsWith('/credential-availability'))return {available:true,save_enabled:true,reuse_enabled:true,manual_fill_recovery_supported:true,items:[]};
if(route.endsWith('/form-fill')){await appendFile(args.log,'posted\\n');return {status:'submitted',operation_id:options.body.operation_id};}
throw Error('Unexpected');}};
const client=new DotBrowserAuthNative({transport},{ledgerDirectory:args.ledgerDirectory,inspect:async()=>args.source});
try{await client.claim({stateFile:args.stateFile,roomId:'room-1',messageId:'message-1',requestFingerprint:'fingerprint-1',expectedOrigin:args.source.origin});await client.fill({stateFile:args.stateFile,credentialsFile:args.credentialsFile});process.stdout.write('ok');}catch(e){process.stdout.write(e.code??'error');}`;
  const run = stateFile => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ stateFile, credentialsFile: f.credentialsFile, ledgerDirectory: f.ledgerDirectory, source: f.source, log })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { error += value; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const results = await Promise.all([run(f.stateFile), run(join(f.dir, 'other.json'))]);
  assert.equal(results.filter(value => value === 'ok').length, 1); assert.ok(results.some(value => value === 'CHALLENGE_ALREADY_CLAIMED' || value === 'INVALID_STATE'));
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});
test('default challenge resolver uses fresh visible message and native elicitation contracts', async t => {
  const f = await fixture(t, { request: (method, route) => {
    if (route === '/backend-api/messaging/rooms/room-1/messages') return { items: [{ id: 'message-1', content: { type: 'elicitation' } }] };
    if (route.endsWith('/elicitation')) return { can_respond: true, runtime_status: 'pending', request_fingerprint: 'fingerprint-1', elicitation: { request_id: 'request-1', thread_id: 'thread-1', turn_id: null, status: 'pending', params: { threadId: 'thread-1', turnId: null, mode: 'form', serverName: 'browser', message: 'Sign in', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'browser_auth', browser_auth_challenge_id: CHALLENGE, origin: ORIGIN, reason: 'Sign in', fields: [{ id: 'password', label: 'Password', type: 'password', required: true }] } } } };
  } });
  f.client.client.resolveRoom = async value => value;
  const client = new DotBrowserAuthNative(f.client.client, { now: () => NOW, ledgerDirectory: f.ledgerDirectory });
  const inspected = await client.inspectChallenge({ roomId: 'room-1', messageId: 'message-1' }); assert.equal(inspected.challengeId, CHALLENGE);
  const claim = await client.claim({ stateFile: f.stateFile, roomId: 'room-1', messageId: 'message-1', requestFingerprint: inspected.requestFingerprint, expectedOrigin: inspected.origin });
  assert.equal(claim.phase, 'claimed'); assert.equal(f.calls.filter(call => call.route.endsWith('/elicitation')).length, 2);
});
test('browser-auth claim rejects changed fingerprints and noncanonical destinations', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.claim({ stateFile: f.stateFile, roomId: 'room-1', messageId: 'message-1', requestFingerprint: 'wrong', expectedOrigin: ORIGIN }), { code: 'STALE_ACTION' });
  await assert.rejects(f.client.claim({ stateFile: f.stateFile, roomId: 'room-1', messageId: 'message-1', requestFingerprint: 'fingerprint-1', expectedOrigin: 'https://user:secret@example.test' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});
test('browser-auth supports an explicitly pinned HTTP origin from the native challenge', async t => {
  const f = await fixture(t); f.source.origin = 'http://localhost:8080'; const result = await f.claim(); assert.equal(result.origin, 'http://localhost:8080');
  await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }); assert.equal(fills(f).length, 1);
});
test('claim adopts an existing server operation and cannot silently submit it again', async t => {
  const f = await fixture(t); f.prepared.operation_id = 'existing-operation'; f.prepared.operation = { operation_id: 'existing-operation', fill_status: 'unknown', save_status: 'unknown' };
  const result = await f.claim(); assert.equal(result.operationId, 'existing-operation'); assert.equal(result.phase, 'submitting');
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'OPERATION_ALREADY_ATTEMPTED' });
  assert.equal(fills(f).length, 0);
});
test('manual fill sends the exact supported contract once and never writes credential values', async t => {
  const f = await fixture(t); const claim = await f.claim();
  const result = await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile });
  assert.equal(result.fillStatus, 'submitted'); assert.equal(result.phase, 'settled'); assert.equal(result.recoveryAvailable, true);
  assert.deepEqual(fills(f)[0].options.body, { conversation_id: 'thread-1', challenge_id: CHALLENGE, operation_id: claim.operationId, fields: { username: 'private-user', password: 'PRIVATE_PASSWORD' } });
  assert.doesNotMatch(JSON.stringify(result) + await readFile(f.stateFile, 'utf8'), /PRIVATE_PASSWORD|private-user/);
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'OPERATION_ALREADY_ATTEMPTED' }); assert.equal(fills(f).length, 1);
});
test('manual fill saving requires explicit remember and server-provided field mapping', async t => {
  const f = await fixture(t); await f.claim(); const result = await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile, remember: true });
  assert.equal(result.saveStatus, 'saved'); assert.equal(fills(f)[0].options.body.remember, true); assert.deepEqual(fills(f)[0].options.body.save_fields, { username: 'username', password: 'password' });
  const g = await fixture(t); await g.claim(); g.available.manual_save_supported = false;
  await assert.rejects(g.client.fill({ stateFile: g.stateFile, credentialsFile: g.credentialsFile, remember: true }), { code: 'SAVE_UNAVAILABLE' }); assert.equal(fills(g).length, 0);
});
test('a missing save receipt remains unknown after explicitly requesting saving', async t => {
  const f = await fixture(t, { request: (method, route, request) => route.endsWith('/form-fill') ? { status: 'submitted', operation_id: request.body.operation_id } : undefined });
  await f.claim(); const result = await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile, remember: true }); assert.equal(result.saveStatus, 'unknown');
});
test('manual fill without server recovery support does not invent operation-id support', async t => {
  const f = await fixture(t); await f.claim(); f.available.manual_fill_recovery_supported = false;
  const result = await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }); assert.equal(result.recoveryAvailable, false);
  assert.equal(fills(f)[0].options.body.operation_id, undefined);
  await assert.rejects(f.client.recover({ stateFile: f.stateFile }), { code: 'RECOVERY_UNAVAILABLE' });
});
test('credential input is private UTF-8 JSON, rejects symlinks and broad permissions', async t => {
  const f = await fixture(t); await f.claim(); await chmod(f.credentialsFile, 0o644);
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'PRIVATE_INPUT_REQUIRED' });
  await chmod(f.credentialsFile, 0o600); const link = join(f.dir, 'link.json'); await symlink(f.credentialsFile, link);
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: link }), { code: 'PRIVATE_INPUT_UNREADABLE' });
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: '-', input: { isTTY: true } }), { code: 'PRIVATE_INPUT_REQUIRED' }); assert.equal(fills(f).length, 0);
});
test('credential input supports non-echoing piped JSON', async t => {
  const f = await fixture(t); await f.claim(); await f.client.fill({ stateFile: f.stateFile, credentialsFile: '-', input: Readable.from([JSON.stringify({ username: 'private-user', password: 'PRIVATE_PASSWORD' })]) });
  assert.equal(fills(f).length, 1);
});
test('manual fill validates active option and missing/unknown fields before submission', async t => {
  const f = await fixture(t); f.source.options = [{ id: 'login', label: 'Login', fieldIds: ['username', 'password'] }]; await f.claim();
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'INVALID_ARGUMENT' });
  await writeFile(f.credentialsFile, JSON.stringify({ username: 'private-user', unknown: 'PRIVATE_PASSWORD' }));
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile, selectedOption: 'login' }), { code: 'PRIVATE_INPUT_INVALID' });
  assert.equal(fills(f).length, 0);
});
test('sign-in input cannot escape offered field IDs through prototype keys or nonstrings', async t => {
  const f = await fixture(t); await f.claim();
  for (const value of ['{"__proto__":"secret"}', '{"password":{}}', '{"constructor":"secret"}']) {
    await writeFile(f.credentialsFile, value); await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'PRIVATE_INPUT_INVALID' });
  }
  assert.equal(fills(f).length, 0);
});
test('origin, challenge, fingerprint and signed-in subject changes invalidate the claim', async t => {
  for (const field of ['origin', 'challengeId', 'requestFingerprint']) {
    const f = await fixture(t); await f.claim(); f.source[field] = field === 'origin' ? 'https://other.test' : field === 'challengeId' ? 'b'.repeat(32) : 'new';
    await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'STALE_ACTION' }); assert.equal(fills(f).length, 0);
  }
  const f = await fixture(t); await f.claim(); f.setSubject('user-2');
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'ACCOUNT_CHANGED' }); assert.equal(fills(f).length, 0);
});
test('ambiguous submission is durably recorded and only reconciled, never retried', async t => {
  const f = await fixture(t); await f.claim(); f.failFill();
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), error => error.code === 'AUTH_SUBMISSION_UNCONFIRMED' && error.details.delivery === 'unknown' && !error.message.includes('PRIVATE_PASSWORD'));
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).phase, 'submitting');
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'OPERATION_ALREADY_ATTEMPTED' });
  const recovered = await f.client.recover({ stateFile: f.stateFile }); assert.equal(recovered.fillStatus, 'submitted'); assert.equal(fills(f).length, 1);
});
test('accepted fill with a receipt write failure gives a private recovery state and confirmed delivery', async t => {
  const f = await fixture(t); await f.claim(); const originalSave = f.client.save.bind(f.client);
  f.client.save = async (file, state, options) => { if (state.phase === 'settled') throw new Error('disk full'); return originalSave(file, state, options); };
  let failure; try { await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'AUTH_RECEIPT_NOT_SAVED'); assert.equal(failure.details.delivery, 'received'); assert.equal(failure.details.fillStatus, 'submitted');
  assert.ok(failure.details.recoveryStateFile); assert.equal((await stat(failure.details.recoveryStateFile)).mode & 0o777, 0o600); assert.equal(fills(f).length, 1);
  f.client.save = originalSave; const recovered = await f.client.recover({ stateFile: failure.details.recoveryStateFile }); assert.equal(recovered.fillStatus, 'submitted');
  await assert.rejects(f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }), { code: 'CHALLENGE_ALREADY_CLAIMED' });
});
test('manager start receipt write failure preserves the received handle only in private recovery state', async t => {
  const f = await fixture(t); await f.claim(); const originalSave = f.client.save.bind(f.client);
  f.client.save = async (file, state, options) => { if (state.phase === 'manager_waiting') throw new Error('disk full'); return originalSave(file, state, options); };
  let failure; try { await f.client.startManager({ stateFile: f.stateFile }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'AUTH_RECEIPT_NOT_SAVED'); assert.equal(failure.details.operationId, 'manager-operation'); assert.equal(failure.details.delivery, 'received');
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_HANDLE|PRIVATE_REFERENCE/); assert.ok(failure.details.recoveryStateFile);
  f.client.save = originalSave; const result = await f.client.managerStatus({ stateFile: failure.details.recoveryStateFile }); assert.equal(result.managerStatus, 'waiting');
});
test('reconcile rejects cross-operation identity even after the source fingerprint changes', async t => {
  const f = await fixture(t, { request: (method, route) => route.endsWith('/reconcile') ? { operation_id: 'wrong', fill_status: 'submitted', save_status: 'saved' } : undefined });
  await f.claim(); await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile }); f.source.requestFingerprint = 'gone';
  await assert.rejects(f.client.recover({ stateFile: f.stateFile }), { code: 'INVALID_RESPONSE' });
});
for (const phase of ['settled', 'submitting']) {
  test(`reconcile succeeds from ${phase} state after the native card disappears without inspecting or resubmitting`, async t => {
    const f = await fixture(t); const claimed = await f.claim();
    if (phase === 'submitting') f.failFill();
    const submit = f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile });
    if (phase === 'submitting') await assert.rejects(submit, { code: 'AUTH_SUBMISSION_UNCONFIRMED' });
    else await submit;
    assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).phase, phase);
    const before = f.calls.length; let inspections = 0;
    f.client.inspect = async () => { inspections++; throw new Error('The native card no longer exists'); };
    const recovered = await f.client.recover({ stateFile: f.stateFile });
    assert.equal(inspections, 0); assert.equal(fills(f).length, 1); assert.equal(f.calls.length, before + 1);
    assert.deepEqual(f.calls.at(-1), { method: 'POST', route: `/backend-api/flora/browser/credential-operations/${claimed.operationId}/reconcile`, options: {
      body: { conversation_id: 'thread-1', challenge_id: CHALLENGE }, signal: undefined, expectedAccountId: 'account-1' } });
    assert.equal(recovered.operationId, claimed.operationId); assert.equal(recovered.phase, 'settled'); assert.equal(recovered.fillStatus, 'submitted');
    assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).phase, 'settled');
    assert.doesNotMatch(JSON.stringify(recovered), /PRIVATE_PASSWORD|PRIVATE_SELECTION|PRIVATE_HANDLE/);
  });
}
test('reconcile and adopted operations require an exact operation-id echo', async t => {
  const f = await fixture(t, { request: (method, route) => route.endsWith('/reconcile') ? { fill_status: 'submitted', save_status: 'saved' } : undefined });
  await f.claim(); await f.client.fill({ stateFile: f.stateFile, credentialsFile: f.credentialsFile });
  await assert.rejects(f.client.recover({ stateFile: f.stateFile }), { code: 'INVALID_RESPONSE' });
  const g = await fixture(t); g.prepared.operation_id = 'existing'; g.prepared.operation = { fill_status: 'submitted', save_status: 'saved' };
  await assert.rejects(g.claim(), { code: 'INVALID_RESPONSE' });
});
test('saved credential reuse keeps capability private and pinned to exact origin', async t => {
  const f = await fixture(t); const claim = await f.claim(); const result = await f.client.reuse({ stateFile: f.stateFile, credentialId: 'credential-1' });
  assert.deepEqual(fills(f)[0].options.body, { conversation_id: 'thread-1', challenge_id: CHALLENGE, operation_id: claim.operationId, saved_credential_selection_id: 'PRIVATE_SELECTION' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SELECTION/); const state = JSON.parse(await readFile(f.stateFile, 'utf8')); assert.equal(state.selectionId, 'PRIVATE_SELECTION');
  await f.client.recover({ stateFile: f.stateFile }); assert.equal(f.calls.at(-1).options.body.selection_id, 'PRIVATE_SELECTION');
});
test('saved credential reuse rejects expired or wrong-origin selections', async t => {
  for (const change of [{ expires_at: NOW / 1000 - 1 }, { origin: 'https://other.test' }]) {
    const f = await fixture(t); await f.claim(); Object.assign(f.available.items[0], change);
    await assert.rejects(f.client.reuse({ stateFile: f.stateFile, credentialId: 'credential-1' }), { code: 'CREDENTIAL_UNAVAILABLE' }); assert.equal(fills(f).length, 0);
  }
});
test('saved credential reuse pages candidates and rejects repeated cursors', async t => {
  let pages = 0;
  const f = await fixture(t, { request: (method, route) => route.endsWith('/credential-candidates') ? (++pages, { items: [{ credential_id: 'credential-1', origin: ORIGIN, selection_id: 'PRIVATE_SELECTION', expires_at: NOW / 1000 + 30 }], next_cursor: null }) : undefined });
  await f.claim(); f.available.items = []; f.available.next_cursor = 'opaque+/='; await f.client.reuse({ stateFile: f.stateFile, credentialId: 'credential-1' }); assert.equal(pages, 1);
  const g = await fixture(t); await g.claim(); g.available.items = []; g.available.next_cursor = 'same';
  await assert.rejects(g.client.reuse({ stateFile: g.stateFile, credentialId: 'credential-1' }), { code: 'INVALID_RESPONSE' });
});
test('password-manager starts with token-derived account-user identity and private capability state', async t => {
  const f = await fixture(t); await f.claim(); const result = await f.client.startManager({ stateFile: f.stateFile });
  const request = f.calls.find(call => call.route.endsWith('/access-requests')); assert.deepEqual(request.options.body, { conversation_id: 'thread-1', challenge_id: CHALLENGE, expected_account_user_id: 'account-user-1' });
  assert.equal(result.phase, 'manager_waiting'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HANDLE|PRIVATE_REFERENCE/); assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
  await f.client.openManagerApproval({ stateFile: f.stateFile }); assert.deepEqual(f.opened, ['onepassword://grant-brokered-access?access_request_reference=PRIVATE_REFERENCE']);
});
test('password-manager access requires native account-user claims and connected manager', async t => {
  const f = await fixture(t); await f.claim(); f.setAccountUser(null);
  await assert.rejects(f.client.startManager({ stateFile: f.stateFile }), { code: 'ACCOUNT_CHANGED' });
  const g = await fixture(t); g.setAccountUser(null); await g.claim();
  await assert.rejects(g.client.startManager({ stateFile: g.stateFile }), { code: 'ACCOUNT_USER_REQUIRED' });
  const h = await fixture(t); await h.claim(); h.prepared.password_managers[0].state = 'disconnected';
  await assert.rejects(h.client.startManager({ stateFile: h.stateFile }), { code: 'PASSWORD_MANAGER_UNAVAILABLE' });
});
test('password-manager status validates access handle and operation identity', async t => {
  for (const field of ['access_handle', 'operation_id']) {
    const f = await fixture(t); await f.claim(); await f.client.startManager({ stateFile: f.stateFile }); f.manager[field] = 'wrong';
    await assert.rejects(f.client.managerStatus({ stateFile: f.stateFile }), { code: 'INVALID_RESPONSE' }); assert.equal(fills(f).length, 0);
  }
});
test('password-manager polls preserve a validated approval link when status omits it', async t => {
  const f = await fixture(t); await f.claim(); await f.client.startManager({ stateFile: f.stateFile });
  delete f.manager.approval_url; delete f.manager.expires_at;
  const result = await f.client.managerStatus({ stateFile: f.stateFile }); assert.equal(result.approvalAvailable, true);
  await f.client.openManagerApproval({ stateFile: f.stateFile }); assert.equal(f.opened.length, 1);
});
test('independent ledger detects altered private approval URLs and capability fields', async t => {
  const f = await fixture(t); await f.claim(); await f.client.startManager({ stateFile: f.stateFile });
  const state = JSON.parse(await readFile(f.stateFile, 'utf8')); state.manager.approvalUrl = 'onepassword://grant-brokered-access?access_request_reference=OTHER';
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(f.client.openManagerApproval({ stateFile: f.stateFile }), { code: 'INVALID_STATE' }); assert.equal(f.opened.length, 0);
});
test('password-manager fill waits for approval, rechecks once and submits exactly once', async t => {
  const f = await fixture(t); await f.claim(); await f.client.startManager({ stateFile: f.stateFile });
  await assert.rejects(f.client.useManager({ stateFile: f.stateFile }), { code: 'APPROVAL_REQUIRED' });
  f.manager.state = 'approved'; const result = await f.client.useManager({ stateFile: f.stateFile });
  assert.deepEqual(fills(f)[0].options.body, { conversation_id: 'thread-1', challenge_id: CHALLENGE, operation_id: 'manager-operation', password_manager_access: { provider: 'onepassword', access_handle: 'PRIVATE_HANDLE' } });
  assert.equal(result.fillStatus, 'submitted'); assert.doesNotMatch(await readFile(f.stateFile, 'utf8'), /PRIVATE_HANDLE|PRIVATE_REFERENCE/);
  assert.equal(fills(f)[0].options.timeoutMs, 130000);
  assert.equal(f.calls.find(call => call.route.endsWith('/access-requests')).options.timeoutMs, 65000);
  assert.equal(f.calls.find(call => call.route.endsWith('/access-requests/status')).options.timeoutMs, 65000);
  await assert.rejects(f.client.useManager({ stateFile: f.stateFile }), { code: 'INVALID_STATE' }); assert.equal(fills(f).length, 1);
});
test('password-manager approval links cannot become arbitrary URLs', async t => {
  for (const url of ['https://evil.test/?access_request_reference=x', 'onepassword://grant-brokered-access?access_request_reference=x&other=y', 'onepassword://evil?access_request_reference=x']) {
    const f = await fixture(t); await f.claim(); f.manager.approval_url = url;
    await assert.rejects(f.client.startManager({ stateFile: f.stateFile }), { code: 'AUTH_SUBMISSION_UNCONFIRMED' }); assert.equal(f.opened.length, 0);
  }
});
test('password-manager expired lease never reaches form fill or opens app', async t => {
  const f = await fixture(t); await f.claim(); await f.client.startManager({ stateFile: f.stateFile });
  f.client.now = () => NOW + 700000;
  await assert.rejects(f.client.openManagerApproval({ stateFile: f.stateFile }), { code: 'APPROVAL_UNAVAILABLE' });
  const result = await f.client.managerStatus({ stateFile: f.stateFile }); assert.equal(result.managerStatus, 'expired'); assert.equal(fills(f).length, 0);
});
test('state and locking reject broad permissions and concurrent use', async t => {
  const f = await fixture(t); await f.claim(); await chmod(f.stateFile, 0o644);
  await assert.rejects(f.client.state({ stateFile: f.stateFile }), { code: 'INVALID_STATE' }); await chmod(f.stateFile, 0o600);
  await writeFile(f.stateFile + '.lock', '', { mode: 0o600 }); await assert.rejects(f.client.recover({ stateFile: f.stateFile }), { code: 'STATE_BUSY' });
});
test('native browser-auth descriptors expose private-input flows without proof upload flags', () => {
  assert.equal(commands['remote auth fill'].flags['--credentials'].type, 'secretPath');
  assert.ok(commands['remote auth password-manager use']); assert.ok(commands['remote auth recover']);
  assert.doesNotMatch(JSON.stringify(commands), /--proof|--password|--token|--assertion/);
  assert.match(browserAuthNativeCapabilities().nativeProofs, /must be completed by the native provider/);
});

test('interrupted 1Password start exposes safe recovery limits and never starts or fills twice', async t => {
  const f = await fixture(t, { request: (method, route) => { if (route.endsWith('/access-requests')) throw new Error('NETWORK_RESPONSE_LOST'); } });
  await f.claim();
  await assert.rejects(f.client.startManager({ stateFile: f.stateFile }), error => error.code === 'AUTH_SUBMISSION_UNCONFIRMED' && error.details.phase === 'manager_starting' && error.details.canResubmit === false && error.details.remoteOperationIdKnown === false);
  const state = await f.client.state({ stateFile: f.stateFile }); assert.equal(state.phase, 'manager_starting');
  assert.deepEqual(state.recovery, { supported: false, reason: 'manager_receipt_missing', requestMayHaveStarted: true, canResubmit: false, nextAction: 'Review the original request in the native app or password manager. Start again only for a new browser-auth challenge.' });
  const before = f.calls.length;
  for (const method of ['recover', 'managerStatus', 'openManagerApproval', 'useManager']) {
    await assert.rejects(f.client[method]({ stateFile: f.stateFile }), error => error.code === 'PASSWORD_MANAGER_RECOVERY_UNAVAILABLE' && error.details.canResubmit === false);
  }
  await assert.rejects(f.client.startManager({ stateFile: f.stateFile }), { code: 'OPERATION_ALREADY_ATTEMPTED' });
  assert.equal(f.calls.length, before); assert.equal(fills(f).length, 0);
  assert.equal(f.calls.filter(call => call.route.endsWith('/access-requests')).length, 1);
  assert.equal(f.calls.some(call => call.route.endsWith('/reconcile')), false);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_HANDLE|PRIVATE_REFERENCE/);
});

test('new operation locks record local ownership and active locks never expire by age', async t => {
  const f = await fixture(t); await f.claim();
  const file = `${f.stateFile}.lock`, value = { version: 1, token: randomUUID(), host: hostname(), pid: process.pid, uid: process.getuid?.() ?? null };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await utimes(file, new Date(0), new Date(0));
  await assert.rejects(f.client.recover({ stateFile: f.stateFile }), error => error.code === 'STATE_BUSY' && error.details.ownerPid === process.pid && error.details.recovery === 'owner_active_or_unknown');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), value);
});

test('unknown, foreign-host and interrupted recovery locks are never guessed stale', async t => {
  for (const kind of ['legacy', 'foreign', 'malformed', 'recovery']) {
    const f = await fixture(t); await f.claim();
    const file = kind === 'recovery' ? `${f.stateFile}.lock.recovery-lock` : `${f.stateFile}.lock`;
    const record = kind === 'legacy' ? '' : kind === 'malformed' ? '{bad' : JSON.stringify({ version: 1, token: randomUUID(), host: 'other-host', pid: 2147483647, uid: process.getuid?.() ?? null });
    await writeFile(file, record, { mode: 0o600 }); await utimes(file, new Date(0), new Date(0));
    await assert.rejects(f.client.recover({ stateFile: f.stateFile }), { code: 'STATE_BUSY' });
    assert.equal(await readFile(file, 'utf8'), record);
    assert.equal((await f.client.state({ stateFile: f.stateFile })).phase, 'claimed');
  }
});

test('a killed fill process leaves a verifiable lock that recovers by reconciliation without replay', { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.claim();
  const script = `import { DotBrowserAuthNative } from ${JSON.stringify(new URL('../src/browser-auth-native.mjs', import.meta.url).href)};
const args=JSON.parse(process.argv[1]);
const transport={authLoader:async()=>({accountId:'account-1',accessToken:'header.'+Buffer.from(JSON.stringify({sub:'user-1','https://api.openai.com/auth':{chatgpt_account_user_id:'account-user-1'}})).toString('base64url')+'.signature'}),request:async(method,route)=>{
if(route.endsWith('/credential-availability'))return {available:true,save_enabled:true,reuse_enabled:true,manual_fill_recovery_supported:true,items:[]};
if(route.endsWith('/form-fill')){setInterval(()=>{},1000);process.stdout.write('submitted\\n');return new Promise(()=>{});}
throw Error('Unexpected');}};
const client=new DotBrowserAuthNative({transport},{ledgerDirectory:args.ledgerDirectory,inspect:async()=>args.source});
await client.fill({stateFile:args.stateFile,credentialsFile:args.credentialsFile});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ stateFile: f.stateFile, credentialsFile: f.credentialsFile, ledgerDirectory: f.ledgerDirectory, source: f.source })], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    let text = '', error = ''; child.stdout.on('data', value => { text += value; if (text.includes('submitted\n')) resolve(); });
    child.stderr.on('data', value => { error += value; }); child.once('error', reject); child.once('exit', code => { if (code != null) reject(new Error(error || `child exited ${code}`)); });
  });
  const file = `${f.stateFile}.lock`, lock = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(lock.pid, child.pid); assert.equal(lock.host, hostname()); assert.equal(lock.uid, process.getuid?.() ?? null); assert.match(lock.token, /^[0-9a-f-]{36}$/i);
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).phase, 'submitting');
  const result = await f.client.recover({ stateFile: f.stateFile }); assert.equal(result.fillStatus, 'submitted');
  assert.equal(fills(f).length, 0); assert.equal(f.calls.filter(call => call.route.endsWith('/reconcile')).length, 1);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(readFile(`${file}.recovery-lock`), { code: 'ENOENT' });
});
