import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DotMessageWorkflows } from '../src/message-workflows.mjs';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const REF = 'ref-signed_token.1';
const token = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
function bundle(connect = false, overrides = {}) { return { version: 1, kind: connect ? 'connector_connect_no_link' : 'connector_auth', requests: [{ request_id: REF, connector_id: 'connector-1', action: connect ? 'connect' : 'reauthenticate', auth_reason: connect ? 'missing_link' : 'reauthentication_required', resume_on_success: true, ...(connect ? {} : { link_id: 'link-1' }), ...overrides }] }; }
function fake(responses = []) {
  const calls = []; const auth = { accountId: 'account-1', accessToken: token('user-1') };
  const transport = { authLoader: async () => auth, request: async (...args) => { calls.push(args); const value = responses.shift(); if (value instanceof Error) throw value; return value; } };
  return { calls, auth, transport, flows: new DotMessageWorkflows({ transport }, { now: () => NOW }) };
}
async function scratch(t) { const directory = await mkdtemp(path.join(tmpdir(), 'dot-message-')); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, sessionFile: path.join(directory, 'auth.json') }; }
async function start(t, connect = false) {
  const paths = await scratch(t);
  const f = fake([bundle(connect)]), request = await f.flows.connectorAuth({ reference: REF, connect });
  const authResult = { oauth_state_id: 'state-id', completion_token: 'super-private-completion', redirect_url: 'https://provider.example/authorize?state=state-private' };
  f.calls.length = 0;
  f.transport.request = async (...args) => { f.calls.push(args); return args[0] === 'GET' ? bundle(connect) : authResult; };
  const result = await f.flows.startConnectorAuth({ reference: REF, connect, requestFingerprint: request.requestFingerprint, sessionFile: paths.sessionFile });
  return { ...paths, ...f, request, result };
}

test('plugin suggestion read projects only visible metadata and account context', async () => {
  const { flows, calls } = fake([{ suggestions: [{ plugin_id: 'plugin-1', name: 'Calendar', app_ids: ['app-1'], secret: 'hidden' }] }]);
  const value = await flows.pluginSuggestions({ reference: REF });
  assert.equal(value.suggestions[0].pluginId, 'plugin-1'); assert.equal(value.accountId, 'account-1'); assert.equal(value.requestFingerprint.length, 64);
  assert.equal(value.suggestions[0].secret, undefined); assert.equal(calls[0][1], `/backend-api/messaging/plugin-suggestions/${REF}`);
});

test('plugin continuation rechecks fingerprint and sends only a suggested subset', async () => {
  const response = { suggestions: [{ plugin_id: 'plugin-1' }, { plugin_id: 'plugin-2' }] };
  const f = fake([response, response, {}]); const read = await f.flows.pluginSuggestions({ reference: REF });
  await f.flows.continuePlugins({ reference: REF, pluginIds: ['plugin-1', 'plugin-1'], requestFingerprint: read.requestFingerprint });
  assert.deepEqual(f.calls.at(-1)[2].body, { connected_plugin_ids: ['plugin-1'] });
  assert.equal(f.calls.filter(call => call[0] === 'POST').length, 1);
});

test('stale and unlisted plugin continuations never write', async () => {
  for (const [ids, fingerprint] of [[['other'], null], [['plugin-1'], 'stale']]) {
    const response = { suggestions: [{ plugin_id: 'plugin-1' }] }; const f = fake([response, response]);
    const read = await f.flows.pluginSuggestions({ reference: REF });
    await assert.rejects(f.flows.continuePlugins({ reference: REF, pluginIds: ids, requestFingerprint: fingerprint ?? read.requestFingerprint }), error => ['STALE_ACTION', 'INVALID_ARGUMENT'].includes(error.code));
    assert.equal(f.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('invalid opaque references are rejected before HTTP', async () => {
  for (const reference of ['../x', 'ref/other', 'a?b', '.', 'a%2fb']) {
    const f = fake(); await assert.rejects(f.flows.pluginSuggestions({ reference }), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
  }
});

test('connector bundle requires exact native request identity and state', async () => {
  for (const changes of [{ request_id: 'other' }, { action: 'connect' }, { auth_reason: 'missing_link' }, { resume_on_success: false }, { link_id: null }]) {
    const f = fake([bundle(false, changes)]); await assert.rejects(f.flows.connectorAuth({ reference: REF }), { code: 'ACTION_UNAVAILABLE' });
  }
  const f = fake([bundle(true)]); assert.equal((await f.flows.connectorAuth({ reference: REF, connect: true })).action, 'connect'); assert.ok(f.calls[0][1].endsWith('/connect'));
});

test('connector start saves private completion capability without returning it', async t => {
  const f = await start(t); const content = JSON.parse(await readFile(f.sessionFile));
  assert.equal(content.completionToken, 'super-private-completion'); assert.equal(content.subject, 'user-1'); assert.equal((await stat(f.sessionFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(f.result).includes('super-private-completion')); assert.ok(!JSON.stringify(f.result).includes('state-id'));
  const body = f.calls.find(call => call[0] === 'POST')[2].body;
  assert.equal(body.callback_url, 'https://chatgpt.com/connector_platform_oauth_redirect'); assert.ok(body.post_auth_url.startsWith('/connector-auth?request='));
});

test('connector start refuses stale fingerprint or reusing an existing session', async t => {
  const f = await start(t); f.transport.request = async (...args) => { f.calls.push(args); return bundle(); };
  await assert.rejects(f.flows.startConnectorAuth({ reference: REF, requestFingerprint: 'stale', sessionFile: f.sessionFile }), { code: 'STALE_ACTION' });
  await assert.rejects(f.flows.startConnectorAuth({ reference: REF, requestFingerprint: f.request.requestFingerprint, sessionFile: f.sessionFile }), { code: 'OUTPUT_EXISTS' });
  assert.equal(f.calls.filter(call => call[0] === 'POST').length, 1);
});

test('connector completion binds callback state, resulting link and exact request', async t => {
  const f = await start(t); f.calls.length = 0;
  f.transport.request = async (...args) => { f.calls.push(args); if (args[0] === 'GET') return bundle(); if (args[1].includes('oauth/callback')) return { link: { id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' } }; return { outcome: 'context_delivered' }; };
  const result = await f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from(['https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&code=secret-code']) });
  assert.equal(result.completed, true); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.at(-1)[2].body, { completion_token: 'super-private-completion' });
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!String(await readFile(f.sessionFile)).includes('super-private-completion'));
});

test('connect completion insists on an active OAuth link', async t => {
  const f = await start(t, true); f.calls.length = 0;
  f.transport.request = async (...args) => { f.calls.push(args); return args[0] === 'GET' ? bundle(true) : { link: { id: 'new-link', connector_id: 'connector-1', auth_status: 'ACTIVE', auth_type: 'API_KEY' } }; };
  await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from(['https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&code=s']) }), { code: 'ACTION_UNCONFIRMED' });
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(await readFile(f.sessionFile)).phase, 'callback_pending');
});

test('callback mismatch and provider cancellation prevent all writes', async t => {
  for (const callback of ['https://evil.example/?state=state-private', 'https://chatgpt.com/connector_platform_oauth_redirect?state=other', 'https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&error=denied']) {
    const f = await start(t); f.calls.length = 0; f.transport.request = async (...args) => { f.calls.push(args); return bundle(); };
    await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from([callback]) }), error => ['INVALID_ARGUMENT', 'OAUTH_CANCELLED'].includes(error.code));
    assert.equal(f.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('completion rejects a different user on the same account', async t => {
  const f = await start(t); f.auth.accessToken = token('user-2'); f.calls.length = 0;
  await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from([]) }), { code: 'ACCOUNT_CHANGED' }); assert.equal(f.calls.length, 0);
});

test('expired and already attempted sessions cannot silently replay', async t => {
  const f = await start(t); const state = JSON.parse(await readFile(f.sessionFile)); f.calls.length = 0;
  for (const changes of [{ expiresAt: NOW - 1 }, { phase: 'completing' }, { reference: 'other' }]) {
    await writeFile(f.sessionFile, JSON.stringify({ ...state, ...changes }));
    await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-' }), { code: 'INVALID_STATE' }); assert.equal(f.calls.length, 0);
  }
});

test('in-use lock, broad mode and symlink sessions fail before mutation', async t => {
  const f = await start(t); f.calls.length = 0; await writeFile(`${f.sessionFile}.lock`, 'busy');
  await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile }), { code: 'STATE_BUSY' }); await rm(`${f.sessionFile}.lock`);
  await chmod(f.sessionFile, 0o644); await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-' }), { code: 'INVALID_STATE' });
  const alias = path.join(f.directory, 'alias'); await symlink(f.sessionFile, alias); await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: alias })); assert.equal(f.calls.length, 0);
});

test('network completion failure retains non-replayable state and never retries', async t => {
  const f = await start(t); f.calls.length = 0;
  f.transport.request = async (...args) => { f.calls.push(args); if (args[0] === 'GET') return bundle(); if (args[1].includes('oauth/callback')) return { link: { id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' } }; throw new Error('network'); };
  await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from(['https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&code=s']) }));
  assert.equal(f.calls.filter(call => call[1].endsWith('/complete')).length, 1); assert.equal(JSON.parse(await readFile(f.sessionFile)).phase, 'completing');
});

test('pending continuation is reported as pending rather than success', async t => {
  const f = await start(t); f.transport.request = async (...args) => args[0] === 'GET' ? bundle() : args[1].includes('oauth/callback') ? { link: { id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' } } : { outcome: 'pending' };
  assert.equal((await f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from(['https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&code=s']) })).completed, false);
});

test('pending completion can be explicitly resumed once without replaying provider callback', async t => {
  const f = await start(t); f.calls.length = 0; let complete = 0;
  f.transport.request = async (...args) => {
    f.calls.push(args); if (args[0] === 'GET') return bundle();
    if (args[1].includes('oauth/callback')) return { link: { id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' } };
    return { outcome: ++complete === 1 ? 'pending' : 'started' };
  };
  await f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-', input: Readable.from(['https://chatgpt.com/connector_platform_oauth_redirect?state=state-private&code=s']) });
  assert.equal(JSON.parse(await readFile(f.sessionFile)).phase, 'completion_pending');
  await assert.rejects(f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, callbackFile: '-' }), { code: 'INVALID_STATE' });
  assert.equal((await f.flows.completeConnectorAuth({ reference: REF, sessionFile: f.sessionFile, resume: true })).completed, true);
  assert.equal(f.calls.filter(call => call[1].includes('oauth/callback')).length, 1);
  assert.equal(f.calls.filter(call => call[1].endsWith('/complete')).length, 2);
});
