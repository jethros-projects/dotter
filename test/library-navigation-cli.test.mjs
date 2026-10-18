import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));
const httpHelper = fileURLToPath(new URL('../src/http.py', import.meta.url));
const accountId = 'synthetic-navigation-account';
const token = 'synthetic-navigation-token';
const base = '/backend-api/files/library';

// Execute the source checkout's real entry point, parser, command registry,
// wrappers, authentication loader, Transport, and pythonFetch envelope logic.
// A local Python-executable stub returns controlled responses without running
// http.py or contacting the service. PATH only selects the local stub; it is
// not a general network sandbox.
async function cli(t, args, { status = 200, value = {}, raw, missingAuth = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-library-navigation-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, 'auth.json');
  const logFile = join(directory, 'requests.ndjson');
  const executable = join(directory, 'python3');
  if (!missingAuth) await writeFile(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: accountId, access_token: token } }), { mode: 0o600 });
  const reply = { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(raw ?? JSON.stringify(value)).toString('base64') };
  // Node 22.0 treats this extensionless executable as CommonJS.
  await writeFile(executable, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const request = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args: process.argv.slice(2), request }) + '\\n', { mode: 0o600 });
process.stdout.write(${JSON.stringify(JSON.stringify(reply))});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args, '--auth-file', authFile, '--json'], {
      cwd: directory,
      env: { PATH: directory, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  let calls = [];
  try { calls = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(result.signal, null, 'CLI must complete without a signal or timeout');
  assert.equal(result.stderr, '', 'JSON mode must not leak diagnostics to stderr');
  assert.doesNotMatch(result.stdout, new RegExp(`${token}|${accountId}|server-secret|signed-secret`));
  return { ...result, output: JSON.parse(result.stdout), calls };
}

function request(result, method, pathname, body, query = {}) {
  assert.equal(result.calls.length, 1, 'one command must send exactly one request, with no retries or discovery');
  const call = result.calls[0];
  assert.deepEqual(call.args, ['-I', httpHelper]);
  const url = new URL(call.request.url);
  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.pathname, pathname);
  assert.deepEqual(Object.fromEntries(url.searchParams), query);
  assert.equal(url.hash, '');
  assert.equal(call.request.method, method);
  assert.equal(call.request.headers.Authorization, `Bearer ${token}`);
  assert.equal(call.request.headers['ChatGPT-Account-Id'], accountId);
  assert.equal(call.request.headers.Accept, 'application/json');
  assert.equal(call.request.headers['chatgpt-project-id'], undefined, 'Library navigation is account-scoped');
  assert.equal(call.request.headers['OAI-Product-Sku'], undefined);
  assert.equal(call.request.headers['Idempotency-Key'], undefined);
  assert.equal(call.request.maxBytes, 256 * 1024);
  assert.equal(call.request.timeoutMs, 30_000);
  assert.equal(call.request.signedFile, false);
  assert.equal(call.request.signedUpload, false);
  if (body === undefined) {
    assert.equal(call.request.body, undefined);
    assert.equal(call.request.headers['Content-Type'], undefined);
  } else {
    assert.deepEqual(JSON.parse(call.request.body), body);
    assert.equal(call.request.headers['Content-Type'], 'application/json');
  }
}

for (const [label, destination, expected] of [
  ['folder', ['--directory', 'directory:parent~1'], 'directory:parent~1'],
  ['root', ['--root'], null],
]) {
  test(`binary CLI moves a Library file to ${label} with exact account scope`, async t => {
    const result = await cli(t, ['library', 'move', 'library:file~1', ...destination], { value: { success: true, secret: 'server-secret' } });
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, { fileId: 'library:file~1', moved: true });
    request(result, 'PATCH', `${base}/files/library%3Afile~1/move`, { directory_id: expected });
  });
}

for (const [label, destination, expected] of [
  ['parent', ['--parent', 'directory:parent~1'], 'directory:parent~1'],
  ['root', ['--root'], null],
]) {
  test(`binary CLI moves a Library directory to ${label} and projects safe metadata`, async t => {
    const record = { id: 'directory:child~1', kind: 'directory', name: 'Reports', parent_directory_id: expected };
    const result = await cli(t, ['library', 'move-directory', record.id, ...destination], {
      value: { ...record, signed_url: 'signed-secret', metadata: { secret: 'server-secret' } },
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, record);
    request(result, 'PATCH', `${base}/directories/directory%3Achild~1`, { parent_directory_id: expected });
  });
}

for (const [label, selection, query] of [
  ['selected folder', ['directory:child~1'], { directory_id: 'directory:child~1' }],
  ['implicit root', [], {}],
  ['explicit root', ['--root'], {}],
]) {
  test(`binary CLI reads the ${label} path without a mutation`, async t => {
    const root = { id: 'directory:root', kind: 'directory', name: 'Library', is_root: true };
    const result = await cli(t, ['library', 'directory-path', ...selection], {
      value: { items: [{ ...root, signed_url: 'signed-secret' }, { id: 'hidden', hidden: true, name: 'server-secret' }], cursor: null },
    });
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, { items: [root], cursor: null });
    request(result, 'GET', `${base}/directories/path`, undefined, query);
  });
}

const invalid = [
  ['move without destination', ['move', 'file_1'], 'INVALID_ARGUMENT', 1],
  ['move with root and folder', ['move', 'file_1', '--root', '--directory', 'dir_1'], 'INVALID_ARGUMENT', 1],
  ['move with invalid file ID', ['move', '../file', '--root'], 'INVALID_ARGUMENT', 1],
  ['move with invalid folder ID', ['move', 'file_1', '--directory', 'dir?other'], 'INVALID_ARGUMENT', 1],
  ['move-directory without destination', ['move-directory', 'dir_1'], 'INVALID_ARGUMENT', 1],
  ['move-directory with root and parent', ['move-directory', 'dir_1', '--root', '--parent', 'parent_1'], 'INVALID_ARGUMENT', 1],
  ['move-directory into itself', ['move-directory', 'dir_1', '--parent', 'dir_1'], 'INVALID_ARGUMENT', 1],
  ['move-directory with invalid directory ID', ['move-directory', 'dir/child', '--root'], 'INVALID_ARGUMENT', 1],
  ['move-directory with invalid parent ID', ['move-directory', 'dir_1', '--parent', '..'], 'INVALID_ARGUMENT', 1],
  ['directory-path with root and folder', ['directory-path', 'dir_1', '--root'], 'INVALID_ARGUMENT', 1],
  ['directory-path with invalid folder ID', ['directory-path', 'dir%2Fchild'], 'INVALID_ARGUMENT', 1],
  ['move with no file', ['move', '--root'], 'USAGE_ERROR', 2],
  ['move-directory with no directory', ['move-directory', '--root'], 'USAGE_ERROR', 2],
  ['directory-path with extra positional', ['directory-path', 'dir_1', 'dir_2'], 'USAGE_ERROR', 2],
  ['move with repeated destination', ['move', 'file_1', '--directory', 'dir_1', '--directory', 'dir_2'], 'USAGE_ERROR', 2],
  ['move with a room selector', ['move', 'file_1', '--root', '--room', 'room_1'], 'USAGE_ERROR', 2],
];
for (const [label, args, code, exitCode] of invalid) {
  test(`binary CLI rejects ${label} before authentication or any request`, async t => {
    const result = await cli(t, ['library', ...args], { missingAuth: true });
    assert.equal(result.code, exitCode);
    assert.equal(result.output.error.code, code);
    assert.deepEqual(result.calls, []);
  });
}

test('binary CLI never reports an unconfirmed file move as successful or retries it', async t => {
  const result = await cli(t, ['library', 'move', 'file_1', '--root'], { value: { success: false } });
  assert.equal(result.code, 1);
  assert.equal(result.output.error.code, 'MUTATION_UNCONFIRMED');
  assert.equal(result.output.error.fileId, 'file_1');
  assert.equal(result.output.error.delivery, 'unknown');
  request(result, 'PATCH', `${base}/files/file_1/move`, { directory_id: null });
});

for (const [label, value, expectedCode] of [
  ['mismatched directory identity', { id: 'wrong_directory', kind: 'directory' }, 'INVALID_RESPONSE'],
  ['hidden directory metadata', { id: 'dir_1', kind: 'directory', hidden: true }, 'NOT_VISIBLE'],
]) {
  test(`binary CLI rejects ${label} after exactly one directory move`, async t => {
    const result = await cli(t, ['library', 'move-directory', 'dir_1', '--root'], { value });
    assert.equal(result.code, 1);
    assert.equal(result.output.error.code, expectedCode);
    request(result, 'PATCH', `${base}/directories/dir_1`, { parent_directory_id: null });
  });
}

for (const [name, args, method, pathname, body] of [
  ['move', ['move', 'file_1', '--root'], 'PATCH', `${base}/files/file_1/move`, { directory_id: null }],
  ['move-directory', ['move-directory', 'dir_1', '--root'], 'PATCH', `${base}/directories/dir_1`, { parent_directory_id: null }],
  ['directory-path', ['directory-path', '--root'], 'GET', `${base}/directories/path`, undefined],
]) {
  test(`binary CLI preserves a forbidden ${name} response without leaking the server body or retrying`, async t => {
    const result = await cli(t, ['library', ...args], { status: 403, value: { error: 'server-secret' } });
    assert.equal(result.code, 4);
    assert.equal(result.output.error.code, 'FORBIDDEN');
    assert.equal(result.output.error.status, 403);
    assert.equal(result.output.error.delivery, method === 'GET' ? undefined : 'unknown');
    request(result, method, pathname, body);
  });
}

test('binary CLI rejects an invalid directory-path response after one read', async t => {
  const result = await cli(t, ['library', 'directory-path', '--root'], { value: { items: 'server-secret' } });
  assert.equal(result.code, 1);
  assert.equal(result.output.error.code, 'INVALID_RESPONSE');
  request(result, 'GET', `${base}/directories/path`);
});
