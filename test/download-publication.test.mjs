import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createClient } from '../src/index.mjs';
import { run } from '../src/cli.mjs';

const ROOM = 'fixture_room', FILE = 'fixture_file';
const bytes = Buffer.from('Synthetic download contents\n');
const stream = () => ({ text: '', write(value) { this.text += value; } });
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The download fixture did not settle.')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(t, mode, overwrite, readBytes = () => bytes) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-download-publication-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'download.txt'), stdout = stream(), stderr = stream();
  if (overwrite) await writeFile(output, 'original bytes', { mode: 0o600 });
  const api = createClient({ transport: {
    async request(method, path) {
      assert.equal(method, 'GET');
      assert.equal(path, `/backend-api/messaging/rooms/${ROOM}/files/${FILE}`);
      return { id: FILE, name: 'download.txt', mime_type: 'text/plain', size_bytes: bytes.length,
        download_url: '/backend-api/estuary/content?id=fixture' };
    },
    async requestBytes(method, path, options) {
      assert.equal(method, 'GET'); assert.equal(path, '/backend-api/estuary/content');
      return readBytes(options);
    },
  } });
  t.after(() => api.close());
  return { directory, output, stdout, stderr,
    run(signal) {
      const input = { roomId: ROOM, fileId: FILE, output, overwrite };
      if (mode === 'SDK') return api.download(input, { signal });
      if (mode === 'advanced') return api.advanced.download({ ...input, signal });
      return run(['download', FILE, '--room', ROOM, '--output', output, '--json', ...(overwrite ? ['--overwrite'] : [])], {
        createClient: () => api, signal, stdout, stderr,
      });
    },
  };
}

for (const mode of ['SDK', 'advanced', 'CLI']) for (const overwrite of [false, true]) {
  test(`${mode} cancelled download waits for temporary cleanup with overwrite=${overwrite}`, async t => {
    const f = await fixture(t, mode, overwrite), controller = new AbortController();
    const originalOpen = fs.open, originalUnlink = fs.unlink, started = deferred(), release = deferred(), handles = [];
    const temporary = path => typeof path === 'string' && path.startsWith(`${f.directory}/.dot-download-`) && path.endsWith('.part');
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (temporary(path)) {
        handles.push(handle);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); controller.abort(0); };
      }
      return handle;
    };
    fs.unlink = async (path, ...args) => {
      if (temporary(path)) { started.resolve(); await release.promise; }
      return originalUnlink(path, ...args);
    };
    syncBuiltinESMExports();
    t.after(() => { release.resolve(); fs.open = originalOpen; fs.unlink = originalUnlink; syncBuiltinESMExports(); });
    let settled = false;
    const operation = f.run(controller.signal).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await bounded(started.promise); await nextTurn();
      assert.equal(settled, false, 'cancellation must wait for native file cleanup');
      assert.ok((await readdir(f.directory)).some(name => name.endsWith('.part')));
    } finally { release.resolve(); }
    const outcome = await bounded(operation);
    assert.equal(outcome.error.code, 'ABORTED');
    assert.equal(handles.length, 1);
    for (const handle of handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
    if (overwrite) assert.equal(await readFile(f.output, 'utf8'), 'original bytes');
    else await assert.rejects(readFile(f.output), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.directory), overwrite ? ['download.txt'] : []);
    assert.equal(f.stdout.text, '');
  });

  test(`${mode} download retains its receipt after atomic ${overwrite ? 'rename' : 'link'} commits`, async t => {
    const f = await fixture(t, mode, overwrite), controller = new AbortController();
    const method = overwrite ? 'rename' : 'link', original = fs[method];
    fs[method] = async (source, destination, ...args) => {
      const value = await original(source, destination, ...args);
      if (destination === f.output) controller.abort(0);
      return value;
    };
    syncBuiltinESMExports();
    t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
    const result = await f.run(controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.output ?? result.path, f.output);
    assert.equal(result.sizeBytes, bytes.length);
    assert.deepEqual(await readFile(f.output), bytes);
    assert.deepEqual(await readdir(f.directory), ['download.txt']);
    if (mode === 'CLI') assert.deepEqual(JSON.parse(f.stdout.text), result);
  });
}

for (const mode of ['SDK', 'advanced', 'CLI']) test(`${mode} download still cancels an uncooperative network read promptly`, async t => {
  const started = deferred(), controller = new AbortController();
  const f = await fixture(t, mode, false, () => { started.resolve(); return new Promise(() => {}); });
  const operation = f.run(controller.signal);
  await bounded(started.promise); controller.abort(0);
  await assert.rejects(bounded(operation), { code: 'ABORTED' });
  assert.deepEqual(await readdir(f.directory), []);
});
