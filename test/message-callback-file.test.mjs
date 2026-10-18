import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, chmod, symlink, rename, mkdir, rm, open, stat, utimes } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotMessageWorkflows } from '../src/message-workflows.mjs';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const REF = 'callback-file-ref';
const SECRET = 'private-secret-callback';
const CALLBACK = `https://chatgpt.com/connector_platform_oauth_redirect?state=callback-state&code=${SECRET}`;
const BUNDLE = { version: 1, kind: 'connector_auth', requests: [{ request_id: REF, connector_id: 'connector-1', link_id: 'link-1',
  action: 'reauthenticate', auth_reason: 'reauthentication_required', resume_on_success: true }] };

async function fixture(t, content = CALLBACK) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-callback-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = join(directory, 'session.json'), callbackFile = join(directory, 'private-callback.txt');
  const calls = [];
  const transport = {
    authLoader: async () => ({ accountId: 'account-1', accessToken: `header.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.signature` }),
    async request(method, path, options) {
      calls.push({ method, path, options });
      if (method === 'GET') return structuredClone(BUNDLE);
      if (path === '/backend-api/aip/connectors/links/oauth/callback') return { link: { connector_id: 'connector-1', id: 'link-1', auth_status: 'ACTIVE' } };
      if (path.endsWith('/complete')) return { outcome: 'context_delivered' };
      throw new Error('Unexpected synthetic request');
    },
  };
  const flows = new DotMessageWorkflows({ transport }, { now: () => NOW });
  const request = await flows.connectorAuth({ reference: REF });
  const session = { version: 1, ...request, subject: 'user-1', phase: 'redirected', expiresAt: NOW + 60000,
    oauthState: 'callback-state', completionToken: 'private-completion-capability' };
  const initialSession = JSON.stringify(session);
  await writeFile(sessionFile, initialSession, { mode: 0o600 });
  await writeFile(callbackFile, content, { mode: 0o600 });
  calls.length = 0;
  return { directory, sessionFile, callbackFile, initialSession, calls,
    complete: (options = {}) => flows.completeConnectorAuth({ reference: REF, sessionFile, callbackFile, ...options }) };
}

async function unchanged(f) {
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0, 'invalid callback must never be submitted or completed');
  assert.equal(await readFile(f.sessionFile, 'utf8'), f.initialSession, 'invalid callback must retain the unattempted session');
  await assert.rejects(stat(`${f.sessionFile}.lock`), { code: 'ENOENT' });
}
function privateError(f, code = 'PRIVATE_INPUT_UNREADABLE') {
  return error => {
    assert.equal(error.code, code);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(SECRET), false);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(f.callbackFile), false);
    return true;
  };
}

// The selected callback still uses a real FileHandle. Hooks only force precise
// filesystem races/errors and count close/read behavior; every other file and
// the session writer use the ordinary built-in implementation.
function instrument(t, f, hooks = {}) {
  const original = fs.promises.open;
  const calls = { flags: [], handles: [], closes: 0, readFileBytes: 0, readBytes: 0, readSizes: [] };
  fs.promises.open = async (file, ...args) => {
    if (file !== f.callbackFile) return original(file, ...args);
    calls.flags.push(args[0]);
    if (hooks.open) await hooks.open();
    const handle = await original(file, ...args);
    calls.handles.push(handle);
    return new Proxy(handle, { get(target, key) {
      if (key === 'stat') return async (...values) => {
        const result = await target.stat(...values);
        return hooks.stat ? hooks.stat(result, target, values) : result;
      };
      if (key === 'readFile') return async (...values) => {
        if (hooks.beforeRead) await hooks.beforeRead(target);
        const result = await target.readFile(...values); calls.readFileBytes += Buffer.byteLength(result);
        if (hooks.afterRead) await hooks.afterRead(target);
        return result;
      };
      if (key === 'read') return async (...values) => {
        if (hooks.beforeRead) await hooks.beforeRead(target);
        const result = await target.read(...values); calls.readBytes += result.bytesRead; calls.readSizes.push(values[2]);
        if (hooks.afterRead) await hooks.afterRead(target);
        return result;
      };
      if (key === 'close') return async () => {
        calls.closes++; await target.close(); if (hooks.close) await hooks.close();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = original; syncBuiltinESMExports(); });
  return calls;
}
async function closed(calls) {
  assert.equal(calls.closes, calls.handles.length);
  for (const handle of calls.handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
}

test('private callback file completes the exact pending message request without exposing capabilities', async t => {
  const f = await fixture(t, `${CALLBACK}\n`), io = instrument(t, f);
  const result = await f.complete();
  assert.deepEqual(result, { accountId: 'account-1', reference: REF, outcome: 'context_delivered', completed: true });
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [
    ['GET', `/backend-api/messaging/connector-auth/${REF}`],
    ['POST', '/backend-api/aip/connectors/links/oauth/callback'],
    ['POST', `/backend-api/messaging/connector-auth/${REF}/complete`],
  ]);
  assert.deepEqual(f.calls[1].options.body, { full_redirect_url: CALLBACK });
  assert.equal(f.calls[1].options.expectedAccountId, 'account-1');
  assert.deepEqual(f.calls[2].options.body, { completion_token: 'private-completion-capability' });
  assert.equal((await readFile(f.sessionFile, 'utf8')).includes('private-completion-capability'), false);
  assert.equal(await readFile(f.callbackFile, 'utf8'), `${CALLBACK}\n`, 'the user-provided callback file is not deleted or overwritten');
  await assert.rejects(stat(`${f.sessionFile}.lock`), { code: 'ENOENT' }); await closed(io);
});

for (const size of [65536, 65537]) test(`private callback file enforces the ${size}-byte boundary`, async t => {
  const prefix = 'https://chatgpt.com/connector_platform_oauth_redirect?state=callback-state&code=';
  const f = await fixture(t, prefix + 'a'.repeat(size - Buffer.byteLength(prefix))), io = instrument(t, f);
  if (size === 65536) assert.equal((await f.complete()).completed, true);
  else { await assert.rejects(f.complete(), privateError(f)); await unchanged(f); }
  await closed(io);
});

for (const mode of [0o644, 0o640, 0o604, 0o620]) test(`private callback rejects permission mode ${mode.toString(8)}`, async t => {
  const f = await fixture(t); await chmod(f.callbackFile, mode); const io = instrument(t, f);
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('callback ownership must match the process user, even when permissions are private', async t => {
  const f = await fixture(t), io = instrument(t, f, { stat(value) {
    value.uid = typeof value.uid === 'bigint' ? BigInt(process.getuid() + 1) : process.getuid() + 1;
    return value;
  } });
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('missing callback file fails with a sanitized error and leaves the session retryable', async t => {
  const f = await fixture(t); await rm(f.callbackFile); const io = instrument(t, f);
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('callback symbolic links are rejected without reading the link target', async t => {
  const f = await fixture(t); await rename(f.callbackFile, join(f.directory, 'target'));
  await symlink(join(f.directory, 'target'), f.callbackFile); const io = instrument(t, f);
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); assert.equal(io.handles.length, 0);
});

test('callback directories are rejected and their handles are closed', async t => {
  const f = await fixture(t); await rm(f.callbackFile); await mkdir(f.callbackFile, { mode: 0o700 }); const io = instrument(t, f);
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('callback FIFOs are opened nonblocking and rejected before any read', async t => {
  const f = await fixture(t); await rm(f.callbackFile); await promisify(execFile)('mkfifo', [f.callbackFile]); await chmod(f.callbackFile, 0o600);
  // Keep a writer present so an old blocking implementation also terminates;
  // the requested O_NONBLOCK flag independently proves it cannot wait on one.
  const writer = await open(f.callbackFile, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => writer.close());
  const io = instrument(t, f);
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
  assert.ok(io.flags.every(flags => (flags & constants.O_NONBLOCK) !== 0));
  assert.equal(io.readFileBytes + io.readBytes, 0);
});

for (const stage of ['stat', 'beforeRead', 'close']) test(`callback ${stage} errors are sanitized and always close the descriptor`, async t => {
  const f = await fixture(t), io = instrument(t, f, { [stage]() { throw new Error(SECRET); } });
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('a callback file replaced after opening is rejected before submission', async t => {
  const f = await fixture(t); let replaced = false;
  const io = instrument(t, f, { async stat(value) {
    if (!replaced) { replaced = true; await rename(f.callbackFile, join(f.directory, 'held-callback')); await writeFile(f.callbackFile, CALLBACK, { mode: 0o600 }); }
    return value;
  } });
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('a callback file replaced after reading is rejected before submission', async t => {
  const f = await fixture(t); let replaced = false;
  const io = instrument(t, f, { async afterRead() {
    if (!replaced) { replaced = true; await rename(f.callbackFile, join(f.directory, 'held-callback')); await writeFile(f.callbackFile, CALLBACK, { mode: 0o600 }); }
  } });
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('a same-size in-place callback rewrite during the read is rejected', async t => {
  const f = await fixture(t); let rewritten = false;
  const io = instrument(t, f, { async afterRead() {
    if (!rewritten) {
      rewritten = true; await writeFile(f.callbackFile, CALLBACK.replace(SECRET, 'x'.repeat(SECRET.length)));
      await utimes(f.callbackFile, new Date(NOW), new Date(NOW));
    }
  } });
  await assert.rejects(f.complete(), privateError(f)); await unchanged(f); await closed(io);
});

test('a callback that grows after stat is read within a fixed 64 KiB plus one-byte bound', async t => {
  const f = await fixture(t); let grown = false;
  const io = instrument(t, f, { async beforeRead() {
    if (!grown) { grown = true; await writeFile(f.callbackFile, Buffer.alloc(2 * 1024 * 1024, 0x61)); }
  } });
  await assert.rejects(f.complete(), error => { assert.ok(['PRIVATE_INPUT_UNREADABLE', 'INVALID_ARGUMENT'].includes(error.code)); return true; });
  await unchanged(f); await closed(io);
  assert.equal(io.readFileBytes, 0, 'readFile must not allocate an arbitrarily grown file');
  assert.equal(io.readBytes, 65537); assert.ok(io.readSizes.length > 0); assert.ok(io.readSizes.every(size => size <= 65537));
});

for (const [label, content] of [['invalid UTF-8', Buffer.from([0xc3, 0x28])], ['empty input', ''], ['NUL byte', `${CALLBACK}\0`],
  ['mismatched state', CALLBACK.replace('callback-state', 'other-state')]]) {
  test(`private callback ${label} cannot submit a provider callback`, async t => {
    const f = await fixture(t, content), io = instrument(t, f);
    await assert.rejects(f.complete(), privateError(f, 'INVALID_ARGUMENT')); await unchanged(f); await closed(io);
  });
}

function quietInput() {
  const input = new PassThrough();
  const nativeIterator = input[Symbol.asyncIterator].bind(input);
  let enteredResolve, returned = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  input[Symbol.asyncIterator] = () => {
    const iterator = nativeIterator();
    return {
      next() { enteredResolve(); return iterator.next(); },
      return(...args) { returned++; return iterator.return(...args); },
    };
  };
  return { input, entered, get returned() { return returned; } };
}

for (const [label, reason] of [['Error', new Error('caller cancelled')], ['false', false], ['zero', 0], ['empty string', ''], ['null', null]]) {
  test(`quiet callback stdin abort preserves ${label} and releases its iterator`, async t => {
    const f = await fixture(t), controller = new AbortController(), source = quietInput();
    const result = f.complete({ callbackFile: '-', input: source.input, signal: controller.signal })
      .then(value => ({ resolved: value }), error => ({ rejected: error }));
    let timer;
    try {
      await source.entered; controller.abort(reason);
      const outcome = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 250); })]);
      assert.deepEqual(outcome, { rejected: reason });
      assert.equal(source.input.destroyed, true);
      assert.equal(source.returned, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await unchanged(f);
    } finally { clearTimeout(timer); source.input.destroy(); await result; }
  });
}

test('an already-aborted callback read never opens the selected disk file', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(false);
  const io = instrument(t, f);
  const outcome = await f.complete({ signal: controller.signal }).then(value => ({ resolved: value }), error => ({ rejected: error }));
  assert.deepEqual(outcome, { rejected: false }); assert.deepEqual(io.flags, []); await unchanged(f);
});

test('abort during disk callback reading preserves null and closes the descriptor without submission', async t => {
  const f = await fixture(t), controller = new AbortController();
  const io = instrument(t, f, { beforeRead() { controller.abort(null); } });
  const outcome = await f.complete({ signal: controller.signal }).then(value => ({ resolved: value }), error => ({ rejected: error }));
  assert.deepEqual(outcome, { rejected: null }); await unchanged(f); await closed(io);
});

test('quiet callback iterators without destroy can be cancelled and receive return()', async t => {
  const f = await fixture(t), controller = new AbortController();
  let enteredResolve, finish, returned = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const input = { [Symbol.asyncIterator]() { return { next() { enteredResolve(); return new Promise(resolve => { finish = resolve; }); }, async return() { returned++; return { done: true }; } }; } };
  const result = f.complete({ callbackFile: '-', input, signal: controller.signal }).then(value => ({ resolved: value }), error => ({ rejected: error }));
  let timer;
  try {
    await entered; controller.abort(0);
    const outcome = await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 250); })]);
    assert.deepEqual(outcome, { rejected: 0 }); assert.equal(returned, 1); await unchanged(f);
  } finally { clearTimeout(timer); finish({ done: true }); await result; }
});

for (const stage of ['factory', 'read']) test(`callback stdin ${stage} errors are sanitized and detach the abort listener`, async t => {
  const f = await fixture(t), controller = new AbortController(); let returned = 0;
  const input = { [Symbol.asyncIterator]() {
    if (stage === 'factory') throw new Error(SECRET);
    return { async next() { throw new Error(SECRET); }, async return() { returned++; return { done: true }; } };
  } };
  await assert.rejects(f.complete({ callbackFile: '-', input, signal: controller.signal }), privateError(f));
  assert.equal(returned, stage === 'read' ? 1 : 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
});
