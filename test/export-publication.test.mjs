import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';
import { FullDotClient } from '../src/advanced.mjs';

const ROOM = 'export-room';
const outputStream = () => ({ text: '', write(value) { this.text += value; } });
async function fixture(t, format, overwrite = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dot-export-publication-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, `history.${format}`);
  if (overwrite) await writeFile(output, 'original bytes', { mode: 0o600 });
  const calls = [], stdout = outputStream(), stderr = outputStream();
  const client = new FullDotClient({ transport: { async request(method, path, options) {
    calls.push({ method, path, options });
    assert.equal(method, 'GET'); assert.equal(path, `/backend-api/messaging/rooms/${ROOM}/messages`);
    assert.equal(calls.length, 1);
    return { items: [
      { id: 'visible-message', account_user_id: 'human', content: { text: 'Visible export content' }, created_at: '2026-10-18T12:00:00Z' },
      { id: 'hidden-message', account_user_id: 'human', content: { text: 'private-hidden-content' }, created_at: '2026-10-18T12:00:01Z', metadata: { is_hidden: true } },
    ] };
  } } });
  return { directory, output, calls, stdout, stderr,
    run: signal => run(['export', '--room', ROOM, '--output', output, '--format', format, ...(overwrite ? ['--overwrite'] : [])], {
      createClient: () => client, stdout, stderr, signal,
    }),
  };
}

function abortDuringFlush(t, directory, controller, reason) {
  const original = fs.open, handles = []; let flushed = 0;
  fs.open = async (path, ...args) => {
    const handle = await original(path, ...args);
    if (typeof path === 'string' && path.startsWith(`${directory}/.dot-cli-`) && path.endsWith('.tmp')) {
      handles.push(handle);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); flushed++; controller.abort(reason); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.open = original; syncBuiltinESMExports(); });
  return { handles, get flushed() { return flushed; } };
}

for (const format of ['json', 'md']) test(`CLI ${format} history export writes only visible content with its normal receipt`, async t => {
  const f = await fixture(t, format), result = await f.run();
  assert.deepEqual(result, { path: f.output, format, messageCount: 1, pagesRead: 1, truncated: false });
  assert.deepEqual(JSON.parse(f.stdout.text), result); assert.equal(f.stderr.text, '');
  const saved = await readFile(f.output, 'utf8');
  assert.match(saved, /Visible export content/); assert.doesNotMatch(saved, /private-hidden-content/);
  if (format === 'json') assert.equal(JSON.parse(saved).messages[0].id, 'visible-message');
  else assert.match(saved, /^## user — 2026-10-18T12:00:00Z\n\nVisible export content\n$/);
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), [`history.${format}`]);
});

for (const format of ['json', 'md']) for (const overwrite of [false, true]) {
  for (const [label, reason] of [['false', false], ['zero', 0], ['empty string', ''], ['null', null], ['Error', new Error('caller cancelled export')]]) {
    test(`CLI ${format} export cancellation during flush preserves ${overwrite ? 'existing output' : 'no output'} and exact ${label} reason`, async t => {
      const f = await fixture(t, format, overwrite), controller = new AbortController();
      const io = abortDuringFlush(t, f.directory, controller, reason);
      const outcome = await f.run(controller.signal).then(value => ({ value }), error => ({ error }));
      assert.equal(io.flushed, 1, 'cancellation must occur after real file write and flush');
      assert.equal(io.handles.length, 1);
      assert.equal(Object.hasOwn(outcome, 'error'), true, 'cancelled export must reject');
      assert.equal(outcome.error, reason);
      assert.equal(f.stdout.text, '', 'cancelled export must not print a successful receipt');
      assert.equal(f.stderr.text, '');
      if (overwrite) assert.equal(await readFile(f.output, 'utf8'), 'original bytes');
      else await assert.rejects(readFile(f.output), { code: 'ENOENT' });
      assert.deepEqual(await readdir(f.directory), overwrite ? [`history.${format}`] : []);
      for (const handle of io.handles) await assert.rejects(handle.stat(), { code: 'EBADF' });
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.signal, controller.signal);
    });
  }
}
