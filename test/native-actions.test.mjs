import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run } from '../src/cli.mjs';
import { DotNativeActions, resolveBrowserAuthChallenge } from '../src/native-actions.mjs';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const CHALLENGE = 'x'.repeat(32);
const token = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
const options = { roomId: 'room-1', messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', expectedAccountId: 'account-1' };
function browser(overrides = {}) { return { codex_approval_kind: 'browser_auth', browser_auth_challenge_id: CHALLENGE, origin: 'https://example.com', reason: 'Sign in', fields: [{ id: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' }, { id: 'password', label: 'Password', type: 'password', required: true }], options: [{ id: 'password', label: 'Password', field_ids: ['email', 'password'] }], screenshot: { tabId: '12' }, ...overrides }; }
function params(kind = 'location') {
  const base = { threadId: 'thread-1', turnId: 'turn-1', mode: 'form', message: 'Review this request', serverName: 'codex_apps', requestedSchema: { type: 'object', properties: {} } };
  if (kind === 'location') base._meta = { 'openai/location': {} };
  if (kind === 'verification') Object.assign(base, { mode: 'openai/userVerification', title: 'Approve request', description: 'Sign in with the device', challenge: Buffer.from('private-challenge').toString('base64url') });
  if (kind === 'wallet') { base._meta = { codex_approval_kind: 'wallet_enrollment' }; base.requestedSchema = { type: 'object', properties: { registration_id: { type: 'string' } }, required: ['registration_id'] }; }
  if (kind === 'browser') base._meta = browser();
  if (kind === 'otp') { base.serverName = 'cua_repl'; base._meta = { codex_approval_kind: 'browser_email_otp', connector_id: 'browser-use', origin: 'https://example.com', frame_origin: 'https://example.com', browser_auth_challenge_id: CHALLENGE, otp_handle: 'a'.repeat(21) + 'A' }; base.requestedSchema = { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] }; }
  return base;
}
function fake(kind = 'location') {
  const calls = [], opens = []; const auth = { accountId: 'account-1', accessToken: token('user-1') };
  const response = { can_respond: true, runtime_status: 'pending', request_fingerprint: 'fingerprint-1', elicitation: { request_id: 'request-1', thread_id: 'thread-1', turn_id: 'turn-1', status: 'pending', params: params(kind) } };
  const page = { items: [{ id: 'message-1', content: { type: 'text' } }] };
  const transport = { authLoader: async () => auth, request: async (...args) => { calls.push(args); return args[0] === 'POST' ? { status: 'applied' } : args[1].endsWith('/elicitation') ? structuredClone(response) : structuredClone(page); } };
  const client = { transport, resolveRoom: async room => room };
  return { calls, opens, auth, response, page, client, api: new DotNativeActions(client, { now: () => NOW, openBrowser: async url => opens.push(url) }) };
}
async function file(t) { const dir = await mkdtemp(path.join(tmpdir(), 'dot-native-')); t.after(() => rm(dir, { recursive: true, force: true })); return path.join(dir, 'session.json'); }

for (const [kind, expected] of [['location', 'location'], ['verification', 'userVerification'], ['wallet', 'walletEnrollment'], ['browser', 'browserAuth'], ['otp', 'browserEmailOtp']]) test(`inspect ${kind} exposes reviewed metadata only`, async () => {
  const f = fake(kind); const result = await f.api.inspect(options);
  assert.equal(result.kind, expected); assert.equal(result.requestFingerprint, options.requestFingerprint); assert.equal(result.requiresHumanReview, true);
  assert.ok(!JSON.stringify(result).includes('private-challenge')); assert.ok(!JSON.stringify(result).includes('otp_handle')); assert.ok(!JSON.stringify(result).includes('a'.repeat(21) + 'A'));
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call[0] === 'GET' && call[2].expectedAccountId === 'account-1'));
});

test('native start binds private session and opens the exact first-party review URL', async t => {
  const f = fake('verification'), sessionFile = await file(t);
  const result = await f.api.start({ ...options, sessionFile });
  const url = new URL(f.opens[0]); assert.equal(url.origin, 'https://chatgpt.com'); assert.equal(url.pathname, '/elicitation');
  assert.deepEqual(Object.fromEntries(url.searchParams), { thread_id: 'thread-1', request_id: 'request-1', room_id: 'room-1', message_id: 'message-1' });
  const session = JSON.parse(await readFile(sessionFile, 'utf8'));
  assert.equal(session.subject, 'user-1'); assert.equal(session.bindingHash.length, 64); assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  assert.ok(!String(await readFile(sessionFile)).includes('private-challenge')); assert.equal(result.opened, true);
  assert.ok(f.calls.every(call => call[0] === 'GET'));
});

test('no-open start never opens a browser and refuses to overwrite session files', async t => {
  const f = fake(), sessionFile = await file(t);
  assert.equal((await f.api.start({ ...options, sessionFile, noOpen: true })).opened, false); assert.equal(f.opens.length, 0);
  await assert.rejects(f.api.start({ ...options, sessionFile, noOpen: true }), { code: 'OUTPUT_EXISTS' });
});

test('failed browser launch retains manual URL and does not replay a request', async t => {
  const f = fake(), sessionFile = await file(t); f.api.openBrowser = async () => { throw new Error('private error'); };
  const result = await f.api.start({ ...options, sessionFile }); assert.equal(result.opened, false); assert.ok(result.reviewUrl.startsWith('https://chatgpt.com/elicitation?')); assert.ok(!JSON.stringify(result).includes('private error'));
  assert.ok(f.calls.every(call => call[0] === 'GET'));
});

test('completion reports only a verified resolution, never infers approval outcome', async t => {
  const f = fake(), sessionFile = await file(t); await f.api.start({ ...options, sessionFile, noOpen: true });
  await assert.rejects(f.api.complete({ sessionFile }), { code: 'ACTION_PENDING' });
  f.response.runtime_status = 'resolved'; f.response.can_respond = false; f.response.elicitation.status = 'resolved';
  const result = await f.api.complete({ sessionFile }); assert.equal(result.resolved, true); assert.equal(result.completionVerified, true); assert.equal(result.approvalOutcome, 'not_exposed');
  assert.ok(f.calls.every(call => call[0] === 'GET'));
});

test('expired server request is not called completed', async t => {
  const f = fake(), sessionFile = await file(t); await f.api.start({ ...options, sessionFile, noOpen: true }); f.response.runtime_status = 'expired';
  const result = await f.api.status({ sessionFile }); assert.equal(result.expired, true); assert.equal(result.resolved, false);
  await assert.rejects(f.api.complete({ sessionFile }), { code: 'ACTION_EXPIRED' });
});

test('status rejects changed account, same-account subject, fingerprint, or request parameters', async t => {
  for (const change of ['account', 'subject', 'fingerprint', 'parameters', 'request']) {
    const f = fake(), sessionFile = await file(t); await f.api.start({ ...options, sessionFile, noOpen: true });
    if (change === 'account') f.auth.accountId = 'other';
    if (change === 'subject') f.auth.accessToken = token('other');
    if (change === 'fingerprint') f.response.request_fingerprint = 'other';
    if (change === 'parameters') f.response.elicitation.params.message = 'different';
    if (change === 'request') f.response.elicitation.request_id = 'other';
    await assert.rejects(f.api.status({ sessionFile }), error => ['ACCOUNT_CHANGED', 'STALE_ACTION'].includes(error.code));
  }
});

test('session TTL, permissions, symlinks and oversized files fail closed', async t => {
  for (const mode of ['expired', 'perms', 'symlink', 'large']) {
    const f = fake(); let sessionFile = await file(t); await f.api.start({ ...options, sessionFile, noOpen: true });
    if (mode === 'expired') { const state = JSON.parse(await readFile(sessionFile)); state.expiresAt = NOW - 1; await writeFile(sessionFile, JSON.stringify(state)); }
    if (mode === 'perms') await chmod(sessionFile, 0o644);
    if (mode === 'large') await writeFile(sessionFile, 'x'.repeat(20000));
    if (mode === 'symlink') { const alias = `${sessionFile}.alias`; await symlink(sessionFile, alias); sessionFile = alias; }
    f.calls.length = 0; await assert.rejects(f.api.status({ sessionFile }), { code: 'INVALID_STATE' }); assert.equal(f.calls.length, 0);
  }
});

test('native resolver rejects unavailable or hidden messages and stale identities', async () => {
  for (const change of ['hidden', 'recipient', 'thread', 'fingerprint', 'pending', 'request']) {
    const f = fake();
    if (change === 'hidden') f.page.items[0].metadata = { hidden: true };
    if (change === 'recipient') f.page.items[0].recipient = 'tool';
    if (change === 'thread') f.response.elicitation.params.threadId = 'other';
    if (change === 'fingerprint') f.response.request_fingerprint = 'other';
    if (change === 'pending') f.response.can_respond = false;
    if (change === 'request') f.response.elicitation.request_id = 'other';
    await assert.rejects(f.api.start({ ...options, sessionFile: '/should-not-create-native-session.json' }));
    assert.ok(f.calls.every(call => call[0] === 'GET'));
  }
});

test('browser resolver uses only canonical server origin, options and field IDs', async () => {
  const f = fake('browser'); const result = await resolveBrowserAuthChallenge(f.client, { ...options, challengeId: CHALLENGE });
  assert.equal(result.conversationId, 'thread-1'); assert.equal(result.subject, 'user-1'); assert.equal(result.origin, 'https://example.com'); assert.equal(result.targetTabId, '12');
  assert.deepEqual(result.options, [{ id: 'password', label: 'Password', fieldIds: ['email', 'password'] }]);
  assert.equal(result.metadata.webauthn, false); assert.equal(result.canRespond, true);
});

for (const [name, changes] of [
  ['bad origin', { origin: 'https://example.com/path' }], ['userinfo', { origin: 'https://user@example.com' }], ['bad field', { fields: [{ id: '__proto__', type: 'password', label: 'Password', required: true }] }],
  ['duplicate fields', { fields: [{ id: 'x', type: 'text', label: 'One', required: true }, { id: 'x', type: 'text', label: 'Two', required: false }] }],
  ['unknown choice field', { options: [{ id: 'one', label: 'One', field_ids: ['missing'] }] }], ['bad challenge', { browser_auth_challenge_id: 'short' }], ['invalid QR flag', { qrCode: 'yes' }],
]) test(`browser resolver rejects ${name}`, async () => {
  const f = fake('browser'); Object.assign(f.response.elicitation.params._meta, changes);
  await assert.rejects(resolveBrowserAuthChallenge(f.client, options), { code: 'INVALID_RESPONSE' });
});

test('browser resolver binds challenge, fingerprint and current user even across reads', async () => {
  const f = fake('browser'); await assert.rejects(resolveBrowserAuthChallenge(f.client, { ...options, challengeId: 'other' }), { code: 'STALE_ACTION' });
  const original = f.client.transport.request; f.client.transport.request = async (...args) => { const value = await original(...args); if (args[1].endsWith('/elicitation')) f.auth.accessToken = token('other'); return value; };
  await assert.rejects(resolveBrowserAuthChallenge(f.client, options), { code: 'ACCOUNT_CHANGED' });
});

test('email-code approval verifies native parameters, confirmation, and one applied response', async () => {
  const f = fake('otp'); const result = await f.api.approveEmailOtp({ ...options, confirm: 'request-1' });
  assert.equal(result.applied, true); const writes = f.calls.filter(call => call[0] === 'POST'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][2].body, { request_fingerprint: 'fingerprint-1', result: { action: 'accept', content: { approved: true }, _meta: null } });
  assert.ok(!JSON.stringify(result).includes('otp_handle'));
});

test('email-code approval refuses cross-origin frames, HTTP, malformed handles, wrong schemas and missing confirmation', async () => {
  for (const change of ['frame', 'http', 'handle', 'schema', 'confirm', 'kind']) {
    const f = fake(change === 'kind' ? 'location' : 'otp');
    if (change === 'frame') f.response.elicitation.params._meta.frame_origin = 'https://other.example';
    if (change === 'http') Object.assign(f.response.elicitation.params._meta, { origin: 'http://example.com', frame_origin: 'http://example.com' });
    if (change === 'handle') f.response.elicitation.params._meta.otp_handle = 'bad';
    if (change === 'schema') f.response.elicitation.params.requestedSchema.properties.another = { type: 'string' };
    await assert.rejects(f.api.approveEmailOtp({ ...options, confirm: change === 'confirm' ? 'other' : 'request-1' }));
    assert.equal(f.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('email-code uncertain network or non-applied responses never retry', async () => {
  for (const network of [true, false]) {
    const f = fake('otp'), original = f.client.transport.request;
    f.client.transport.request = async (...args) => { if (args[0] !== 'POST') return original(...args); f.calls.push(args); if (network) throw new Error('network failed'); return { status: 'unknown' }; };
    await assert.rejects(f.api.approveEmailOtp({ ...options, confirm: 'request-1' })); assert.equal(f.calls.filter(call => call[0] === 'POST').length, 1);
  }
});

test('native command manifest exposes real methods and exact-ID confirmation', async () => {
  const { commands, createClient } = await import('../src/command-sets/native-actions.mjs'); const f = fake(); const client = createClient(f.client);
  assert.equal(Object.keys(commands).length, 5);
  for (const descriptor of Object.values(commands)) assert.equal(typeof client[descriptor.method], 'function');
  assert.deepEqual(commands['actions native approve-email-code'].confirmMatch, [['confirm', 'requestId']]);
  assert.deepEqual(commands['actions native start'].required, ['requestId', 'requestFingerprint', 'sessionFile']);
});

test('native email-code approval rejects private channel/recipient metadata and deletedAt', async () => {
  for (const hidden of [{ metadata: { channel: 'analysis' } }, { metadata: { recipient: 'python' } }, { deletedAt: NOW }]) {
    const f = fake('otp'); Object.assign(f.page.items[0], hidden);
    await assert.rejects(f.api.approveEmailOtp({ ...options, confirm: options.requestId }), { code: 'MESSAGE_UNAVAILABLE' });
    assert.equal(f.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('native request classifiers require root object schemas', async () => {
  for (const kind of ['otp', 'wallet', 'browser', 'location']) {
    for (const type of [undefined, 'array', 'string']) {
      const f = fake(kind); f.response.elicitation.params.requestedSchema.type = type;
      await assert.rejects(f.api.inspect(options), { code: 'INVALID_RESPONSE' });
      assert.equal(f.calls.filter(call => call[0] === 'POST').length, 0);
    }
  }
});

test('browser resolver signals WebAuthn object presence without returning the object', async () => {
  const f = fake('browser'); f.response.elicitation.params._meta.webauthn = { challenge: 'DO_NOT_EXPOSE', rpId: 'example.com' };
  const result = await resolveBrowserAuthChallenge(f.client, options);
  assert.equal(result.hasWebauthn, true); assert.equal(result.metadata.webauthn, true);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPOSE')); assert.ok(!JSON.stringify(result).includes('rpId'));
  f.response.elicitation.params._meta.webauthn = null;
  assert.equal((await resolveBrowserAuthChallenge(f.client, options)).hasWebauthn, false);
});

test('conflicting resolved and expired terminal statuses never verify completion', async t => {
  for (const [runtime, request] of [['expired', 'resolved'], ['resolved', 'expired'], ['expired', 'applied'], ['applied', 'expired']]) {
    const f = fake(), sessionFile = await file(t); await f.api.start({ ...options, sessionFile, noOpen: true });
    f.response.runtime_status = runtime; f.response.elicitation.status = request;
    const result = await f.api.status({ sessionFile }); assert.equal(result.resolved, false); assert.equal(result.expired, true);
    await assert.rejects(f.api.complete({ sessionFile }), { code: 'ACTION_EXPIRED' });
  }
});

test('native sessions reject FIFOs without waiting for a writer', { timeout: 2000, skip: process.platform === 'win32' }, async t => {
  const sessionFile = await file(t); await promisify(execFile)('mkfifo', [sessionFile]);
  const f = fake(); await assert.rejects(f.api.status({ sessionFile }), { code: 'INVALID_STATE' }); assert.equal(f.calls.length, 0);
});

test('CLI --no-open survives dispatcher conversion and never opens human review', async t => {
  const f = fake(), sessionFile = await file(t); const output = { write() {} }; let passed;
  await run(['actions', 'native', 'start', options.messageId, '--room', options.roomId, '--request', options.requestId, '--fingerprint', options.requestFingerprint, '--session-file', sessionFile, '--no-open'], {
    createClient: async () => f.client, stdout: output, stderr: output,
    v4Invoke: async (set, method, args) => { assert.equal(set, 'native-actions'); passed = args; return f.api[method](args); }
  });
  assert.equal(passed.openBrowser, false); assert.equal(passed.noOpen, undefined); assert.equal(f.opens.length, 0);
});
