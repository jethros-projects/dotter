import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { DotBrowserAuthNative } from '../src/browser-auth-native.mjs';
import { parseV4Args, prepareV4Options, runV4Command } from '../src/v4-commands.mjs';

const SECRET = 'synthetic-private-browser-password';
const INPUT = JSON.stringify({ password: SECRET });
const REASONS = [['Error', new Error('caller cancelled')], ['false', false], ['zero', 0], ['empty string', ''], ['null', null]];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-auth-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, 'operation.json'), credentialsFile = join(directory, 'fields.json'), ledgerDirectory = join(directory, 'ledger');
  await writeFile(credentialsFile, INPUT, { mode: 0o600 });
  const source = { roomId: 'room-fixture', messageId: 'message-fixture', requestId: 'request-fixture', requestFingerprint: 'fingerprint-fixture',
    threadId: 'thread-fixture', challengeId: 'a'.repeat(32), origin: 'https://example.test', fields: [{ id: 'password', type: 'password', required: true }], options: [] };
  const calls = []; let identityReads = 0;
  const transport = {
    authLoader: async () => { identityReads++; return { accountId: 'account-fixture', accessToken: `header.${Buffer.from(JSON.stringify({ sub: 'user-fixture' })).toString('base64url')}.signature` }; },
    async request(method, route, options) {
      calls.push({ method, route, options });
      if (route.endsWith('/auth/prepare')) return { manual_fill_recovery_supported: true, operation: null, operation_id: null, password_managers: [] };
      if (route.endsWith('/credential-availability')) return { available: true, save_enabled: false, reuse_enabled: false, manual_fill_recovery_supported: true, items: [] };
      if (route.endsWith('/form-fill')) return { operation_id: options.body.operation_id, status: 'submitted' };
      throw new Error('Unexpected synthetic request');
    },
  };
  const client = new DotBrowserAuthNative({ transport }, { inspect: async () => structuredClone(source), ledgerDirectory });
  await client.claim({ stateFile, roomId: source.roomId, messageId: source.messageId, requestFingerprint: source.requestFingerprint, expectedOrigin: source.origin });
  const initialState = await readFile(stateFile, 'utf8');
  const initialLedger = Object.fromEntries(await Promise.all((await readdir(ledgerDirectory)).map(async name => [name, await readFile(join(ledgerDirectory, name), 'utf8')])));
  calls.length = 0; identityReads = 0;
  return { directory, stateFile, credentialsFile, ledgerDirectory, calls, transport, client, initialState, initialLedger,
    get identityReads() { return identityReads; },
    fill: options => client.fill({ stateFile, credentialsFile, ...options }) };
}

async function unchanged(f) {
  assert.equal(f.calls.length, 0, 'input failure must happen before any API request');
  assert.equal(f.identityReads, 0, 'input failure must happen before loading account credentials');
  assert.equal(await readFile(f.stateFile, 'utf8'), f.initialState);
  assert.equal(await readFile(f.credentialsFile, 'utf8'), INPUT);
  const ledger = Object.fromEntries(await Promise.all((await readdir(f.ledgerDirectory)).map(async name => [name, await readFile(join(f.ledgerDirectory, name), 'utf8')])));
  assert.deepEqual(ledger, f.initialLedger);
  await assert.rejects(stat(`${f.stateFile}.lock`), { code: 'ENOENT' });
}

function privateError(code = 'PRIVATE_INPUT_UNREADABLE') {
  return error => { assert.equal(error.code, code); assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(SECRET), false); return true; };
}
const outcome = promise => promise.then(value => ({ resolved: value }), error => ({ rejected: error }));
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 1000); })]); }
  finally { clearTimeout(timer); }
}
function quietInput() {
  const input = new PassThrough(), nativeIterator = input[Symbol.asyncIterator].bind(input);
  let enteredResolve, returned = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  input[Symbol.asyncIterator] = () => {
    const iterator = nativeIterator();
    return { next() { enteredResolve(); return iterator.next(); }, return(...args) { returned++; return iterator.return(...args); } };
  };
  return { input, entered, get returned() { return returned; } };
}

for (const [label, reason] of REASONS) test(`pre-aborted browser credential input preserves ${label} without touching input or claim`, async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(reason);
  let factories = 0, destroyed = 0;
  const input = { [Symbol.asyncIterator]() { factories++; throw new Error(SECRET); }, destroy() { destroyed++; } };
  assert.deepEqual(await outcome(f.fill({ credentialsFile: '-', input, signal: controller.signal })), { rejected: reason });
  assert.equal(factories, 0); assert.equal(destroyed, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await unchanged(f);
});

for (const [label, reason] of REASONS) test(`stalled browser credential stdin cancels with ${label} and releases its iterator`, async t => {
  const f = await fixture(t), controller = new AbortController(), source = quietInput();
  const result = outcome(f.fill({ credentialsFile: '-', input: source.input, signal: controller.signal }));
  try {
    await source.entered; controller.abort(reason);
    assert.deepEqual(await within(result), { rejected: reason });
    assert.equal(source.input.destroyed, true); assert.equal(source.returned, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
  } finally { source.input.destroy(); await result; }
});

for (const cleanup of ['returns pending promise', 'throws', 'rejects']) test(`browser credential cancellation does not wait when iterator cleanup ${cleanup}`, async t => {
  const f = await fixture(t), controller = new AbortController(); let enteredResolve, finish, returned = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const input = { [Symbol.asyncIterator]() { return {
    next() { enteredResolve(); return new Promise(resolve => { finish = resolve; }); },
    return() { returned++; if (cleanup === 'throws') throw new Error(SECRET); return cleanup === 'rejects' ? Promise.reject(new Error(SECRET)) : new Promise(() => {}); },
  }; } };
  const result = outcome(f.fill({ credentialsFile: '-', input, signal: controller.signal }));
  try {
    await entered; controller.abort(false);
    assert.deepEqual(await within(result), { rejected: false }); assert.equal(returned, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
  } finally { finish({ done: true }); await result; }
});

test('browser credential cancellation during iterator creation does not start a read', async t => {
  const f = await fixture(t), controller = new AbortController(); let reads = 0, returned = 0;
  const input = { [Symbol.asyncIterator]() {
    controller.abort(0);
    return { next() { reads++; return { done: false, value: INPUT }; }, return() { returned++; return { done: true }; } };
  } };
  assert.deepEqual(await outcome(f.fill({ credentialsFile: '-', input, signal: controller.signal })), { rejected: 0 });
  assert.equal(reads, 0); assert.equal(returned, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
});

test('a late rejection from a cancelled browser credential read is handled', async t => {
  const f = await fixture(t), controller = new AbortController(); let enteredResolve, rejectRead;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const input = { [Symbol.asyncIterator]() { return {
    next() { enteredResolve(); return new Promise((_, reject) => { rejectRead = reject; }); },
    return() { return { done: true }; },
  }; } };
  const result = outcome(f.fill({ credentialsFile: '-', input, signal: controller.signal }));
  await entered; controller.abort(null);
  assert.deepEqual(await within(result), { rejected: null });
  rejectRead(new Error(SECRET)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
});

for (const stage of ['factory', 'read']) test(`browser credential stdin ${stage} errors are sanitized and release listeners`, async t => {
  const f = await fixture(t), controller = new AbortController(); let returned = 0;
  const input = { [Symbol.asyncIterator]() {
    if (stage === 'factory') throw new Error(SECRET);
    return { next() { throw new Error(SECRET); }, return() { returned++; return { done: true }; } };
  } };
  await assert.rejects(f.fill({ credentialsFile: '-', input, signal: controller.signal }), privateError());
  assert.equal(returned, stage === 'read' ? 1 : 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
});

test('browser credential stdin size rejection closes the iterator without changing source buffers', async t => {
  const f = await fixture(t), controller = new AbortController(), buffer = Buffer.alloc(65537, 0x61); let returned = 0;
  const input = { [Symbol.asyncIterator]() { return { next: async () => ({ done: false, value: buffer }), return() { returned++; return { done: true }; } }; } };
  await assert.rejects(f.fill({ credentialsFile: '-', input, signal: controller.signal }), privateError('PRIVATE_INPUT_INVALID'));
  assert.equal(returned, 1); assert.equal(buffer.every(value => value === 0x61), true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
});

for (const Storage of [ArrayBuffer, SharedArrayBuffer]) test(`cancelled browser credential input does not wipe caller-owned ${Storage.name}`, async t => {
  const f = await fixture(t), controller = new AbortController(), source = new Storage(Buffer.byteLength(INPUT));
  new Uint8Array(source).set(Buffer.from(INPUT)); let reads = 0, enteredResolve, finish;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const input = { [Symbol.asyncIterator]() { return {
    next() { if (++reads === 1) return Promise.resolve({ done: false, value: source }); enteredResolve(); return new Promise(resolve => { finish = resolve; }); },
    return() { return { done: true }; },
  }; } };
  const result = outcome(f.fill({ credentialsFile: '-', input, signal: controller.signal }));
  try {
    await entered; controller.abort(false);
    assert.deepEqual(await within(result), { rejected: false }); assert.equal(Buffer.from(source).toString(), INPUT);
    await unchanged(f);
  } finally { finish({ done: true }); await result; }
});

test('valid browser credential stdin still submits once and removes its abort listener', async t => {
  const f = await fixture(t), controller = new AbortController(), buffer = Buffer.from(INPUT);
  const result = await f.fill({ credentialsFile: '-', input: Readable.from([buffer]), signal: controller.signal });
  assert.equal(result.fillStatus, 'submitted'); assert.equal(result.phase, 'settled');
  assert.equal(f.calls.filter(call => call.route.endsWith('/form-fill')).length, 1);
  assert.deepEqual(f.calls.at(-1).options.body.fields, { password: SECRET });
  assert.equal(buffer.toString(), INPUT); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(JSON.stringify(result).includes(SECRET), false); assert.equal((await readFile(f.stateFile, 'utf8')).includes(SECRET), false);
});

test('real browser-auth command dispatch passes caller cancellation to private stdin', async t => {
  const f = await fixture(t), controller = new AbortController(), source = quietInput();
  const options = await prepareV4Options(parseV4Args('remote', ['auth', 'fill', f.stateFile, '--credentials', '-']));
  const result = outcome(runV4Command({ transport: f.transport }, options, { stdin: source.input, signal: controller.signal }));
  try {
    await source.entered; controller.abort(null);
    assert.deepEqual(await within(result), { rejected: null }); assert.equal(source.returned, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); await unchanged(f);
  } finally { source.input.destroy(); await result; }
});

function instrument(t, f, hooks = {}) {
  const original = fs.promises.open, calls = { opened: 0, reads: 0, closed: 0 };
  fs.promises.open = async (file, ...args) => {
    if (file !== f.credentialsFile) return original(file, ...args);
    calls.opened++; const handle = await original(file, ...args); hooks.afterOpen?.();
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (...values) => { calls.reads++; hooks.beforeRead?.(); const result = await target.read(...values); hooks.afterRead?.(); return result; };
      if (key === 'stat') return async (...values) => { const result = await target.stat(...values); hooks.afterStat?.(); return result; };
      if (key === 'close') return async () => { calls.closed++; await target.close(); hooks.afterClose?.(); };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  syncBuiltinESMExports(); t.after(() => { fs.promises.open = original; syncBuiltinESMExports(); });
  return calls;
}

test('pre-aborted browser credential file is never opened', async t => {
  const f = await fixture(t), controller = new AbortController(), io = instrument(t, f); controller.abort(0);
  assert.deepEqual(await outcome(f.fill({ signal: controller.signal })), { rejected: 0 });
  assert.equal(io.opened, 0); assert.equal(io.reads, 0); assert.equal(io.closed, 0); await unchanged(f);
});

for (const stage of ['afterOpen', 'afterStat', 'afterRead', 'afterClose']) test(`browser credential file cancellation ${stage} closes its descriptor and preserves the claim`, async t => {
  const f = await fixture(t), controller = new AbortController();
  const io = instrument(t, f, { [stage]() { controller.abort(null); } });
  assert.deepEqual(await outcome(f.fill({ signal: controller.signal })), { rejected: null });
  assert.equal(io.opened, 1); assert.equal(io.closed, 1); assert.equal(io.reads, stage === 'afterClose' ? 2 : stage === 'afterRead' ? 1 : 0); await unchanged(f);
});

test('credential descriptor cleanup failure does not replace the caller cancellation reason', async t => {
  const f = await fixture(t), controller = new AbortController();
  const io = instrument(t, f, { afterRead() { controller.abort(''); }, afterClose() { throw new Error(SECRET); } });
  assert.deepEqual(await outcome(f.fill({ signal: controller.signal })), { rejected: '' });
  assert.equal(io.closed, 1); await unchanged(f);
});
