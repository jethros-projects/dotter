import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createClient } from '../src/index.mjs';

const FILE = 'library:fixture', REFERENCE = 'reference_fixture', PLUGIN = 'plugin_fixture';
const bytes = Buffer.from('Synthetic file contents\n');
const archive = Buffer.from([80, 75, 3, 4, 0, 0]);
const report = { fileId: FILE, tool: 'export', structuredContent: { text: 'Synthetic report contents' } };
const cases = [
  ...['download', 'content', 'thumbnail'].map(method => ({ domain: 'libraryContent', method, input: { fileId: FILE }, bytes })),
  { domain: 'libraryContent', method: 'deepResearchExport', input: { fileId: FILE }, bytes: Buffer.from(`${JSON.stringify(report, null, 2)}\n`) },
  { domain: 'libraryProviders', method: 'referenceThumbnail', input: { referenceImageId: REFERENCE }, bytes },
  { domain: 'plugins', method: 'exportArchive', input: { pluginId: PLUGIN, expectedAccountId: 'account_fixture' }, bytes: archive },
];
function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The advanced file fixture did not settle.')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(t, spec, overwrite, beforeBytes = () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-advanced-publication-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'saved.bin'), calls = [];
  if (overwrite) await writeFile(output, 'original bytes', { mode: 0o600 });
  const api = createClient({ transport: {
    async request(method, route, options) {
      calls.push({ method, route, options });
      if (spec.method === 'deepResearchExport') {
        assert.equal(method, 'POST');
        assert.equal(route, `/backend-api/files/library/files/${encodeURIComponent(FILE)}/deep-research/tools/export`);
        await beforeBytes(options);
        return { structuredContent: report.structuredContent };
      }
      assert.equal(method, 'GET');
      if (spec.domain === 'plugins') {
        assert.equal(route, `/backend-api/ps/plugins/${PLUGIN}`);
        return { id: PLUGIN, name: 'Synthetic plugin' };
      }
      const key = spec.method === 'content' ? 'content_url'
        : ['thumbnail', 'referenceThumbnail'].includes(spec.method) ? 'thumbnail_url' : 'download_url';
      assert.equal(route, spec.domain === 'libraryProviders'
        ? `/backend-api/files/library/reference-images/${REFERENCE}/thumbnail_url`
        : `/backend-api/files/library/files/${encodeURIComponent(FILE)}/${key}`);
      return { [key]: '/backend-api/estuary/content?id=fixture' };
    },
    async requestBytes(method, route, options) {
      calls.push({ method, route, options });
      assert.equal(method, 'GET');
      assert.equal(route, spec.domain === 'plugins' ? `/backend-api/ps/plugins/${PLUGIN}/archive` : '/backend-api/estuary/content');
      await beforeBytes(options);
      return spec.bytes;
    },
  } });
  t.after(() => api.close());
  return { directory, output, calls,
    run: signal => api.advanced[spec.domain][spec.method]({ ...spec.input, output, overwrite, signal }),
  };
}

for (const spec of cases) for (const overwrite of [false, true]) {
  const label = `${spec.domain}.${spec.method}`;
  test(`advanced ${label} cancellation waits for cleanup with overwrite=${overwrite}`, async t => {
    const f = await fixture(t, spec, overwrite), controller = new AbortController();
    const originalOpen = fs.open, originalUnlink = fs.unlink, started = deferred(), release = deferred(), handles = [];
    const temporary = path => typeof path === 'string' && path.startsWith(`${f.directory}/.dot-cli-`) && path.endsWith('.tmp');
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
      assert.equal(settled, false, 'cancellation must wait for atomic file cleanup');
      assert.ok((await readdir(f.directory)).some(name => name.endsWith('.tmp')));
    } finally { release.resolve(); }
    const outcome = await bounded(operation);
    assert.equal(outcome.error.code, 'ABORTED');
    assert.equal(handles.length, 1);
    for (const handle of handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
    if (overwrite) assert.equal(await readFile(f.output, 'utf8'), 'original bytes');
    else await assert.rejects(readFile(f.output), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.directory), overwrite ? ['saved.bin'] : []);
    assert.ok(f.calls.every(call => call.options.signal instanceof AbortSignal && call.options.signal.aborted));
  });

  test(`advanced ${label} keeps its receipt after atomic ${overwrite ? 'rename' : 'link'}`, async t => {
    const f = await fixture(t, spec, overwrite), controller = new AbortController();
    const method = overwrite ? 'rename' : 'link', original = fs[method];
    fs[method] = async (source, destination, ...args) => {
      const result = await original(source, destination, ...args);
      if (destination === f.output) controller.abort(0);
      return result;
    };
    syncBuiltinESMExports();
    t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
    const result = await bounded(f.run(controller.signal));
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.path, f.output);
    assert.deepEqual(await readFile(f.output), spec.bytes);
    assert.equal((await stat(f.output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(f.directory), ['saved.bin']);
  });
}

for (const spec of cases) test(`advanced ${spec.domain}.${spec.method} still cancels uncooperative network reads`, async t => {
  const started = deferred(), controller = new AbortController();
  const f = await fixture(t, spec, false, () => { started.resolve(); return new Promise(() => {}); });
  const operation = f.run(controller.signal);
  await bounded(started.promise); controller.abort(0);
  await assert.rejects(bounded(operation), { code: 'ABORTED' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('advanced plugin archive cancellation interrupts held auth without later dispatch or output', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dotter-archive-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const started = deferred(), release = deferred(), controller = new AbortController();
  let authSignal, requests = 0;
  const api = createClient({ transport: {
    async authLoader({ signal }) {
      authSignal = signal; started.resolve(); return release.promise;
    },
    async request() { requests++; assert.fail('Cancelled authentication must not dispatch an archive request.'); },
  } });
  t.after(() => api.close());
  t.after(() => release.resolve({ accessToken: 'fixture', accountId: 'account_fixture' }));
  const operation = api.advanced.plugins.exportArchive({
    pluginId: PLUGIN, expectedAccountId: 'account_fixture', output: join(directory, 'archive.zip'), signal: controller.signal,
  });
  await bounded(started.promise);
  assert.ok(authSignal instanceof AbortSignal);
  controller.abort(0);
  await assert.rejects(bounded(operation), { code: 'ABORTED' });
  assert.equal(authSignal.aborted, true);
  release.resolve({ accessToken: 'fixture', accountId: 'account_fixture' });
  await nextTurn();
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(directory), []);
});
