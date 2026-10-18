import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { getEventListeners } from 'node:events';
import { writePrivate } from '../src/store.mjs';

async function fixture(t, existing = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dot-store-cancel-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'result');
  if (existing) await writeFile(output, 'original', { mode: 0o600 });
  return { directory, output };
}

async function rejectedWith(promise, reason) {
  const outcome = await promise.then(value => ({ value }), error => ({ error }));
  assert.equal(Object.hasOwn(outcome, 'error'), true, 'the write must reject');
  assert.equal(outcome.error, reason);
}

async function unchanged(directory, output, existing) {
  if (existing) assert.equal(await readFile(output, 'utf8'), 'original');
  else await assert.rejects(readFile(output), { code: 'ENOENT' });
  assert.deepEqual(await readdir(directory), existing ? ['result'] : []);
}

async function handlePrototype(directory) {
  const path = join(directory, '.probe'), handle = await open(path, 'wx');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close(); await rm(path); return prototype;
}

for (const overwrite of [false, true]) {
  test(`private writes retain normal ${overwrite ? 'replacement' : 'creation'} behavior with an optional signal`, async t => {
    const { directory, output } = await fixture(t, overwrite);
    const controller = new AbortController();
    assert.equal(await writePrivate(output, 'complete', { overwrite, signal: controller.signal }), output);
    assert.equal(await readFile(output, 'utf8'), 'complete');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['result']);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('private writes remain compatible when the options argument is omitted', async t => {
  const { output } = await fixture(t);
  assert.equal(await writePrivate(output, Buffer.from('default')), output);
  assert.equal(await readFile(output, 'utf8'), 'default');
});

for (const view of [new Uint8Array([90, 1, 2, 3, 90]).subarray(1, 4), new DataView(Uint8Array.from([90, 1, 2, 3, 90]).buffer, 1, 3)]) {
  test(`private writes retain the exact bytes of a ${view.constructor.name} subview`, async t => {
    const { output } = await fixture(t);
    await writePrivate(output, view);
    assert.deepEqual(await readFile(output), Buffer.from([1, 2, 3]));
  });
}

test('unsupported contents and sync or async iterables are rejected before opening a temporary file', async t => {
  const { directory, output } = await fixture(t);
  let consumed = false;
  function* sync() { consumed = true; yield 'unused'; }
  async function* async() { consumed = true; yield 'unused'; }
  for (const content of [undefined, null, 42, {}, ['unused'], new ArrayBuffer(2), sync(), async()]) {
    await assert.rejects(writePrivate(output, content), { code: 'INVALID_ARGUMENT' });
    await unchanged(directory, output, false);
  }
  assert.equal(consumed, false);
});

for (const reason of [null, false, 0, '', new Error('synthetic cancellation')]) {
  test(`an already-aborted private write preserves its ${typeof reason} reason without creating files`, async t => {
    const { directory, output } = await fixture(t);
    const controller = new AbortController(); controller.abort(reason);
    await rejectedWith(writePrivate(output, 'unwritten', { signal: controller.signal }), reason);
    await unchanged(directory, output, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const overwrite of [false, true]) {
  test(`cancelling an in-progress private write ${overwrite ? 'preserves the original' : 'does not publish a new file'}`, async t => {
    const { directory, output } = await fixture(t, overwrite);
    const prototype = await handlePrototype(directory), original = prototype.writeFile;
    const controller = new AbortController(), reason = false;
    let started, release, writeSignal;
    const pending = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(prototype, 'writeFile', async function (content, options) {
      await original.call(this, Buffer.from('partial'));
      writeSignal = options?.signal; started(); await gate;
      return original.call(this, content, options);
    });
    const operation = writePrivate(output, Buffer.from('unpublished remainder'), { overwrite, signal: controller.signal });
    const outcome = operation.then(value => ({ value }), error => ({ error }));
    await pending;
    const temporary = (await readdir(directory)).filter(name => name.endsWith('.tmp'));
    assert.equal(temporary.length, 1);
    assert.equal(await readFile(join(directory, temporary[0]), 'utf8'), 'partial');
    assert.equal(writeSignal, controller.signal);
    controller.abort(reason); release();
    assert.deepEqual(await outcome, { error: reason });
    await unchanged(directory, output, overwrite);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('cancellation during the final flush prevents replacement and cleans up the temporary file', async t => {
  const { directory, output } = await fixture(t, true);
  const probe = await open(output, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.sync, controller = new AbortController(), reason = 0;
  t.mock.method(prototype, 'sync', async function () { await original.call(this); controller.abort(reason); });
  await rejectedWith(writePrivate(output, 'unpublished', { overwrite: true, signal: controller.signal }), reason);
  await unchanged(directory, output, true);
});

test('cancellation while closing the temporary file still prevents publication', async t => {
  const { directory, output } = await fixture(t, true);
  const original = fs.open, controller = new AbortController(), reason = null;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); controller.abort(reason); });
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await rejectedWith(writePrivate(output, 'unpublished', { overwrite: true, signal: controller.signal }), reason);
    await unchanged(directory, output, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('cancellation during the final target check preserves the original file', async t => {
  const { directory, output } = await fixture(t, true);
  const original = fs.lstat, controller = new AbortController(), reason = ''; let inspections = 0;
  t.mock.method(fs, 'lstat', async (...args) => {
    const result = await original(...args);
    if (++inspections === 2) controller.abort(reason);
    return result;
  });
  syncBuiltinESMExports();
  try {
    await rejectedWith(writePrivate(output, 'unpublished', { overwrite: true, signal: controller.signal }), reason);
    assert.equal(inspections, 2);
    await unchanged(directory, output, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

for (const [overwrite, method] of [[false, 'link'], [true, 'rename']]) {
  test(`cancellation after atomic ${method} reports the committed write as successful`, async t => {
    const { directory, output } = await fixture(t, overwrite);
    const original = fs[method], controller = new AbortController();
    t.mock.method(fs, method, async (...args) => { const result = await original(...args); controller.abort(null); return result; });
    syncBuiltinESMExports();
    try {
      assert.equal(await writePrivate(output, 'committed', { overwrite, signal: controller.signal }), output);
      assert.equal(controller.signal.aborted, true);
      assert.equal(await readFile(output, 'utf8'), 'committed');
      assert.deepEqual(await readdir(directory), ['result']);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test('ordinary mid-write failures remain sanitized and preserve existing output', async t => {
  const { directory, output } = await fixture(t, true);
  const prototype = await handlePrototype(directory), original = prototype.writeFile;
  t.mock.method(prototype, 'writeFile', async function () { await original.call(this, Buffer.from('partial')); throw new Error('synthetic private contents'); });
  await assert.rejects(writePrivate(output, Buffer.from('unpublished remainder'), { overwrite: true }), error => error.code === 'WRITE_FAILED' && !error.message.includes('synthetic'));
  await unchanged(directory, output, true);
});
