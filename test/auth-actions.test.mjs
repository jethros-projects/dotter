import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import path from 'node:path';
import { refreshLogin } from '../src/auth-actions.mjs';
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;


const metadata = { status: 'ready', mode: 'chatgpt', authFile: '/tmp/test-codex/auth.json', hasAccountSelector: true, expiresAt: '2030-01-01T00:00:00.000Z' };
function harness(options = {}) {
  const writes = [], launches = [], statusCalls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString('utf8').trim())); callback(); } });
  child.killCount = 0;
  child.kill = () => { child.killCount++; };
  const spawnImpl = (...args) => { launches.push(args); return child; };
  const status = async args => { statusCalls.push(args); return metadata; };
  const run = () => refreshLogin({ spawnImpl, status, timeoutMs: 500, ...options });
  const reply = value => child.stdout.write(JSON.stringify(value) + '\n');
  const complete = () => { reply({ id: 1, result: { capabilities: {} } }); reply({ id: 2, result: { account: { type: 'chatgpt' } } }); };
  return { child, writes, launches, statusCalls, spawnImpl, status, run, reply, complete };
}
function initializeMessage() {
  return { id: 1, method: 'initialize', params: { clientInfo: { name: 'dotter', version: PACKAGE_VERSION } } };
}

test('refresh does not report success unless the resulting file login is usable', async () => {
  const fixture = harness({ status: async () => ({ status: 'unavailable', error: { code: 'AUTH_EXPIRED' } }) });
  const pending = fixture.run(); fixture.complete();
  await assert.rejects(pending, { code: 'AUTH_REFRESH_UNUSABLE' });
});

test('refresh follows initialize, initialized, account/read(refreshToken=true) in order', async () => {
  const fixture = harness();
  const pending = fixture.run();
  assert.deepEqual(fixture.writes, [initializeMessage()]);
  assert.equal(fixture.statusCalls.length, 0);
  fixture.reply({ id: 1, result: {} });
  assert.deepEqual(fixture.writes, [initializeMessage(), { method: 'initialized' }, { id: 2, method: 'account/read', params: { refreshToken: true } }]);
  assert.equal(fixture.statusCalls.length, 0);
  fixture.reply({ id: 2, result: { account: { type: 'chatgpt' } } });
  const result = await pending;
  assert.deepEqual(result, { refreshed: true, ...metadata });
  assert.deepEqual(fixture.statusCalls, [{ authFile: undefined }]);
  assert.equal(fixture.child.killCount, 1);
  assert.deepEqual(fixture.launches[0].slice(0, 2), ['codex', ['app-server']]);
  assert.deepEqual(fixture.launches[0][2].stdio, ['pipe', 'pipe', 'ignore']);
});

test('refresh returns metadata only and never forwards or returns tokens from app-server output', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.reply({ id: 1, result: { accessToken: 'secret-initialize-access' } });
  fixture.reply({ method: 'account/updated', params: { accessToken: 'secret-notification-access' } });
  fixture.reply({ id: 2, result: { account: { type: 'chatgpt', accessToken: 'secret-account-access', refreshToken: 'secret-refresh', email: 'private@example.test' }, accessToken: 'secret-result-access' } });
  const result = await pending;
  assert.deepEqual(Object.keys(result).sort(), ['authFile', 'expiresAt', 'hasAccountSelector', 'mode', 'refreshed', 'status']);
  assert.ok(!JSON.stringify([result, fixture.writes]).includes('secret-'));
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
});

test('an explicit Codex auth.json sets child CODEX_HOME without changing parent environment', async () => {
  const authFile = path.join('work', 'test-codex-home', 'auth.json');
  const original = process.env.CODEX_HOME;
  const fixture = harness({ authFile });
  const pending = fixture.run(); fixture.complete(); await pending;
  assert.equal(fixture.launches[0][2].env.CODEX_HOME, path.dirname(path.resolve(authFile)));
  assert.equal(process.env.CODEX_HOME, original);
  assert.deepEqual(fixture.statusCalls, [{ authFile }]);
});

test('arbitrary cache basenames are rejected before launching Codex or reading status', async () => {
  for (const authFile of ['/tmp/token.json', '/tmp/auth.json.backup', '/tmp/auth.json/other', '/tmp/my-auth.json']) {
    const fixture = harness({ authFile });
    await assert.rejects(fixture.run(), { code: 'INVALID_ARGUMENT' });
    assert.equal(fixture.launches.length, 0);
    assert.equal(fixture.statusCalls.length, 0);
  }
});

test('partial JSON chunks, malformed lines and unrelated notifications do not disrupt refresh', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.child.stdout.write('not json\n{"id":1,"res');
  assert.equal(fixture.writes.length, 1);
  fixture.child.stdout.write('ult":{}}\n');
  fixture.reply({ method: 'unrelated', params: { message: 'ignored' } });
  fixture.reply({ id: 7, result: {} });
  fixture.reply({ id: 2, result: { account: { type: 'chatgpt' } } });
  assert.equal((await pending).refreshed, true);
  assert.equal(fixture.writes.length, 3);
});

test('initialize refusal returns a sanitized error and never asks for account refresh', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.reply({ id: 1, error: { message: 'secret-access-token', data: { refresh_token: 'secret-refresh' } } });
  await assert.rejects(pending, error => error.code === 'AUTH_REFRESH_FAILED' && !JSON.stringify(error).includes('secret-'));
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.statusCalls.length, 0);
  assert.equal(fixture.child.killCount, 1);
});

test('failed account refresh and missing account use safe errors', async () => {
  for (const response of [{ id: 2, error: { message: 'secret-token' } }, { id: 2, result: { account: null, access_token: 'secret-token' } }]) {
    const fixture = harness();
    const pending = fixture.run(); fixture.reply({ id: 1, result: {} }); fixture.reply(response);
    await assert.rejects(pending, error => error.code === 'AUTH_REFRESH_FAILED' && !JSON.stringify(error).includes('secret-token'));
    assert.equal(fixture.statusCalls.length, 0);
    assert.equal(fixture.child.killCount, 1);
  }
});

test('child process error and early exit are sanitized and kill once', async () => {
  for (const event of ['error', 'exit']) {
    const fixture = harness();
    const pending = fixture.run();
    fixture.child.emit(event, new Error('secret-token-in-os-error'));
    await assert.rejects(pending, error => error.code === 'AUTH_REFRESH_FAILED' && !JSON.stringify(error).includes('secret-token'));
    assert.equal(fixture.child.killCount, 1);
    assert.equal(fixture.statusCalls.length, 0);
  }
});

test('timeout kills the child and does not read login metadata', async () => {
  const fixture = harness({ timeoutMs: 10 });
  await assert.rejects(fixture.run(), { code: 'AUTH_REFRESH_TIMEOUT' });
  assert.equal(fixture.child.killCount, 1);
  assert.equal(fixture.statusCalls.length, 0);
});

test('oversized app-server output fails safely', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.child.stdout.write('secret-token'.repeat(100_000));
  await assert.rejects(pending, error => error.code === 'AUTH_REFRESH_FAILED' && !JSON.stringify(error).includes('secret-token'));
  assert.equal(fixture.child.killCount, 1);
});

test('synchronous spawn errors are sanitized', async () => {
  await assert.rejects(refreshLogin({ spawnImpl: () => { throw new Error('secret-token-in-spawn'); }, status: async () => metadata }),
    error => error.code === 'AUTH_REFRESH_FAILED' && !JSON.stringify(error).includes('secret-token'));
});

test('out-of-order account replies cannot complete refresh before initialization', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.reply({ id: 2, result: { account: { type: 'chatgpt' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.statusCalls.length, 0);
  fixture.complete();
  assert.equal((await pending).refreshed, true);
});

test('duplicate initialization replies do not submit duplicate account refreshes', async () => {
  const fixture = harness();
  const pending = fixture.run();
  fixture.reply({ id: 1, result: {} });
  fixture.reply({ id: 1, result: {} });
  fixture.reply({ id: 2, result: { account: { type: 'chatgpt' } } });
  await pending;
  assert.equal(fixture.writes.filter(entry => entry.method === 'account/read').length, 1);
  assert.equal(fixture.writes.filter(entry => entry.method === 'initialized').length, 1);
});
