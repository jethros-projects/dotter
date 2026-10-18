import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DotNativeActions } from '../src/native-actions.mjs';

const NOW = 1000;
const sessionFile = '/in-memory/native-review.json';
const options = { roomId: 'room-1', messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', sessionFile };

function setup(t, { afterInspection, onState, openBrowser } = {}) {
  const files = new Map(), stateCalls = [], requests = [], opens = [];
  let authReads = 0;
  const auth = { accountId: 'account-1', accessToken: `header.${Buffer.from(JSON.stringify({ sub: 'subject-1' })).toString('base64url')}.signature` };
  const client = {
    resolveRoom: async room => room,
    transport: {
      authLoader: async () => { if (++authReads === 2) afterInspection?.(); return auth; },
      request: async (...args) => {
        requests.push(args); assert.equal(args[0], 'GET');
        return args[1].endsWith('/elicitation')
          ? { can_respond: true, runtime_status: 'pending', request_fingerprint: 'fingerprint-1', elicitation: {
            request_id: 'request-1', thread_id: 'thread-1', status: 'pending', params: {
              threadId: 'thread-1', mode: 'form', serverName: 'codex_apps', requestedSchema: { type: 'object', properties: {} }, _meta: { 'openai/location': {} }
            }
          } }
          : { items: [{ id: 'message-1', content: { type: 'text' } }] };
      }
    }
  };
  t.mock.method(fs, 'open', async (file, flags, mode) => {
    assert.equal(file, sessionFile); stateCalls.push('open');
    if (flags === 'wx') {
      assert.equal(mode, 0o600);
      return {
        async writeFile(data) { stateCalls.push('write'); files.set(file, data); onState?.('write'); },
        async sync() { stateCalls.push('sync'); onState?.('sync'); },
        async close() { stateCalls.push('close'); onState?.('close'); }
      };
    }
    assert.ok(files.has(file));
    return {
      async stat() { return { isFile: () => true, size: Buffer.byteLength(files.get(file)), mode: 0o100600, mtimeMs: 1, ctimeMs: 1 }; },
      async read(buffer) { const bytes = Buffer.from(files.get(file)); bytes.copy(buffer); return { bytesRead: bytes.length }; },
      async close() { stateCalls.push('close'); }
    };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const opener = async (...args) => { opens.push(args); return openBrowser?.(...args); };
  return { client, files, stateCalls, requests, opens, get authReads() { return authReads; },
    api: new DotNativeActions(client, { now: () => NOW, openBrowser: opener }) };
}

test('pre-aborted native start performs no identity, request, state or opener work', async t => {
  const controller = new AbortController(), reason = new Error('cancelled before start'); controller.abort(reason);
  const f = setup(t);
  await assert.rejects(f.api.start({ ...options, signal: controller.signal }), error => error === reason);
  assert.equal(f.authReads, 0); assert.deepEqual(f.requests, []); assert.deepEqual(f.stateCalls, []); assert.deepEqual(f.opens, []);
});

test('abort in the final inspection read prevents session creation and browser opening', async t => {
  const controller = new AbortController(), reason = new Error('cancelled during inspection');
  const f = setup(t, { afterInspection: () => controller.abort(reason) });
  await assert.rejects(f.api.start({ ...options, signal: controller.signal }), error => error === reason);
  assert.equal(f.requests.length, 2); assert.equal(f.authReads, 2); assert.deepEqual(f.stateCalls, []); assert.deepEqual(f.opens, []);
});

for (const phase of ['sync', 'close']) test(`abort during session ${phase} retains a valid bound journal without opening`, async t => {
  const controller = new AbortController(), reason = new Error(`cancelled during ${phase}`);
  const f = setup(t, { onState: value => { if (value === phase) controller.abort(reason); } });
  await assert.rejects(f.api.start({ ...options, signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.stateCalls, ['open', 'write', 'sync', 'close']); assert.deepEqual(f.opens, []);
  const saved = JSON.parse(f.files.get(sessionFile));
  assert.equal(saved.subject, 'subject-1'); assert.equal(saved.accountId, 'account-1'); assert.equal(saved.requestId, options.requestId);
  assert.equal(saved.bindingHash.length, 64); assert.equal(saved.expiresAt - saved.createdAt, 15 * 60 * 1000);
  const status = await f.api.status({ sessionFile });
  assert.equal(status.resolved, false); assert.equal(status.runtimeStatus, 'pending');
  assert.equal(status.requiresHumanReview, true); assert.equal(status.approvalOutcome, 'not_exposed');
});

for (const flag of [{ noOpen: true }, { openBrowser: false }]) test(`abort during state write rejects even when opening is disabled by ${Object.keys(flag)[0]}`, async t => {
  const controller = new AbortController(), reason = new Error('cancelled before no-open result');
  const f = setup(t, { onState: phase => { if (phase === 'sync') controller.abort(reason); } });
  await assert.rejects(f.api.start({ ...options, ...flag, signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.stateCalls, ['open', 'write', 'sync', 'close']); assert.deepEqual(f.opens, []);
});

test('concurrent state failure preserves the exact cancellation reason and closes the handle', async t => {
  const controller = new AbortController(), reason = { cancelled: 'during state write' };
  const f = setup(t, { onState: phase => { if (phase === 'sync') { controller.abort(reason); throw new Error('fsync wrapper error'); } } });
  await assert.rejects(f.api.start({ ...options, signal: controller.signal }), error => error === reason);
  assert.deepEqual(f.stateCalls, ['open', 'write', 'sync', 'close']); assert.deepEqual(f.opens, []);
});

for (const rejects of [false, true]) test(`custom opener ${rejects ? 'rejection' : 'resolution'} after abort cannot become a successful handoff`, async t => {
  const controller = new AbortController(), reason = new Error('cancelled in custom opener');
  const f = setup(t, { openBrowser: async (_url, { signal }) => {
    assert.equal(signal, controller.signal); controller.abort(reason);
    if (rejects) throw new Error('wrapped launcher failure');
  } });
  await assert.rejects(f.api.start({ ...options, signal: controller.signal }), error => error === reason);
  assert.equal(f.opens.length, 1); assert.ok(f.files.has(sessionFile)); assert.deepEqual(f.stateCalls, ['open', 'write', 'sync', 'close']);
});

for (const rejects of [false, true]) test(`injected opener ${rejects ? 'failure' : 'success'} keeps handoff distinct from approval`, async t => {
  const controller = new AbortController();
  const f = setup(t, { openBrowser: async (_url, { signal }) => {
    assert.equal(signal, controller.signal);
    if (rejects) throw new Error('private launcher detail');
  } });
  const result = await f.api.start({ ...options, signal: controller.signal });
  assert.equal(result.opened, !rejects); assert.equal(result.requiresHumanReview, true); assert.equal(result.runtimeStatus, 'pending');
  assert.equal(result.completionVerified, undefined); assert.ok(!JSON.stringify(result).includes('private launcher detail'));
  assert.equal(f.opens.length, 1);
  const review = new URL(f.opens[0][0]);
  assert.equal(review.origin, 'https://chatgpt.com'); assert.equal(review.pathname, '/elicitation');
  assert.equal(review.searchParams.get('request_id'), options.requestId);
  assert.ok(f.files.has(sessionFile)); assert.deepEqual(f.stateCalls, ['open', 'write', 'sync', 'close']);
});
