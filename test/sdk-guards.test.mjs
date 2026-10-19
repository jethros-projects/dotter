import test from 'node:test';
import assert from 'node:assert/strict';
import { DotterClient } from '../src/sdk.mjs';
import { DotError } from '../src/errors.mjs';
import { createGuards } from '../src/sdk-guards.mjs';

function fixture(t, options = {}) {
  const client = new DotterClient({ transport: { async request() { throw new Error('Unexpected I/O'); } } });
  t.after(() => client.close());
  return { client, ...createGuards({
    assertOpen: () => client._assertOpen(),
    execute: (request, invoke) => client._execute(request, invoke),
    options,
  }) };
}

test('SDK guards preserve frozen receivers, private state, getters and stable handles', async t => {
  const guards = fixture(t);
  class Native {
    #calls = 0;
    get calls() { return this.#calls; }
    primary({ signal }) { this.#calls++; return { signal, calls: this.#calls }; }
    capabilities() { return { history: true }; }
  }
  const raw = Object.freeze(new Native());
  const advanced = guards.domain(raw);
  assert.equal(guards.domain(raw), advanced);
  assert.equal(guards.domain(advanced), advanced);
  const primary = advanced.primary;
  assert.equal(advanced.primary, primary);
  assert.equal((await primary()).calls, 1);
  assert.equal((await advanced.primary()).calls, 2);
  assert.equal(advanced.calls, 2);
  assert.deepEqual(advanced.capabilities(), { history: true });
  assert.throws(() => { advanced.calls = 99; }, TypeError);
  await guards.client.close();
  await assert.rejects(primary(), { code: 'CLOSED' });
  assert.throws(() => advanced.primary, { code: 'CLOSED' });
});

test('SDK transport guards inject signals and timeouts into every declared call shape', async t => {
  const shapes = [
    ['authLoader', []], ['requestRealtimeSdp', []],
    ['request', ['GET', '/backend-api/test']],
    ['requestMultipart', ['POST', '/backend-api/test']],
    ['requestBytes', ['GET', '/backend-api/test']],
    ...['fetchImpl', 'fetchSigned', 'uploadSigned', 'uploadSignedFile',
      'uploadEstuaryFile', 'uploadAzureBlock', 'commitAzureBlocks', '_uploadStorage']
      .map(name => [name, ['https://example.invalid/signed']]),
  ];
  for (const [name, prefix] of shapes) {
    const guards = fixture(t, { requestTimeoutMs: 1500 });
    const controller = new AbortController();
    const input = Object.freeze({ marker: name, signal: controller.signal });
    let received;
    const wire = Object.freeze({
      async request() {},
      async [name](...args) {
        assert.equal(this, wire);
        assert.deepEqual(args.slice(0, prefix.length), prefix);
        received = args[prefix.length];
        assert.equal(received.marker, name);
        assert.equal(received.timeoutMs, 1500);
        assert.ok(received.signal instanceof AbortSignal);
        assert.notEqual(received, input);
        return name;
      },
    });
    const transport = guards.transport(wire);
    assert.equal(transport[name], transport[name]);
    assert.equal(await transport[name](...prefix, input), name);
    assert.deepEqual(Object.keys(input), ['marker', 'signal']);
    assert.equal(received.signal.aborted, false);
    controller.abort();
    assert.equal(received.signal.aborted, true);
  }
});

test('SDK domain guards preserve options and positional signal helpers', async t => {
  const shapes = [
    ['primary', []], ['runtimeAction', ['pause']],
    ['mcpRequest', ['tools/list', Object.freeze({ cursor: 'next' })]],
    ['request', ['GET', '/backend-api/test']],
    ['readActivity', [Object.freeze({ accountId: 'account_1' })]],
    ['socketSession', ['wss://example.invalid/socket']],
  ];
  for (const [name, prefix] of shapes) {
    const guards = fixture(t);
    const controller = new AbortController();
    const input = Object.freeze({ signal: controller.signal, marker: name });
    let received;
    const raw = { [name](...args) {
      assert.equal(this, raw);
      assert.deepEqual(args.slice(0, prefix.length), prefix);
      received = args[prefix.length];
      assert.equal(received.marker, name);
      return received.signal;
    } };
    const signal = await guards.domain(raw)[name](...prefix, input);
    assert.ok(signal instanceof AbortSignal);
    assert.notEqual(received, input);
    controller.abort();
    assert.equal(signal.aborted, true);
    assert.deepEqual(Object.keys(input), ['signal', 'marker']);
  }
  for (const name of ['resolveRoom', 'resolveDot']) {
    const guards = fixture(t);
    const controller = new AbortController();
    const raw = { [name](id, signal) { return { id, signal }; } };
    const result = await guards.domain(raw)[name]('selected_1', controller.signal);
    assert.equal(result.id, 'selected_1');
    assert.ok(result.signal instanceof AbortSignal);
    controller.abort();
    assert.equal(result.signal.aborted, true);
  }
});

test('SDK transport guards preserve native exceptions for domain error recovery', async t => {
  const guards = fixture(t);
  const missing = new DotError('HTTP_ERROR', 'Native discovery failed.', { status: 404 });
  const identity = new DotError('AUTH_IDENTITY_CHANGED', 'Native identity changed.');
  const wire = guards.transport({
    async request() { throw missing; },
    assertIdentity() { throw identity; },
  });
  const raw = { transport: wire, async discover() {
    try { return await this.transport.request('GET', '/backend-api/test'); }
    catch (error) {
      assert.equal(error, missing);
      if (error.code === 'HTTP_ERROR' && error.details.status === 404) return { available: false };
      throw error;
    }
  }, async fail() { return this.transport.request('GET', '/backend-api/test'); } };
  const advanced = guards.domain(raw);
  assert.deepEqual(await advanced.discover(), { available: false });
  assert.throws(() => wire.assertIdentity({}), error => error === identity);
  await assert.rejects(advanced.fail(), error => error.code === 'NETWORK_ERROR' && error.nativeCode === 'HTTP_ERROR' && error.status === 404 && error.message !== missing.message);
});

test('SDK scoped transports preserve a local auth fence at the final request read', async t => {
  const guards = fixture(t);
  let accountId = 'selected', calls = 0;
  const originalAuthLoader = async () => ({ accountId });
  const raw = Object.freeze({
    authLoader: originalAuthLoader,
    async request(_method, _path, options) {
      const credentials = await this.authLoader(options);
      calls++;
      return credentials;
    },
  });
  const wire = guards.transport(raw);
  const scoped = Object.create(wire);
  scoped.authLoader = async options => {
    const credentials = await wire.authLoader(options);
    if (credentials.accountId !== 'selected') throw new DotError('AUTH_IDENTITY_CHANGED', 'The selected identity changed.');
    return credentials;
  };
  assert.equal(await scoped.authLoader({}).then(auth => auth.accountId), 'selected');
  assert.equal(scoped.request, scoped.request);
  assert.notEqual(scoped.request, wire.request);
  assert.equal((await scoped.request('GET', '/backend-api/test')).accountId, 'selected');
  accountId = 'changed';
  await assert.rejects(scoped.request('PATCH', '/backend-api/test'), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(calls, 1);
  assert.equal(raw.authLoader, originalAuthLoader);
  assert.throws(() => { wire.authLoader = originalAuthLoader; }, TypeError);
  const retained = scoped.request;
  await guards.client.close();
  await assert.rejects(retained('GET', '/backend-api/test'), { code: 'CLOSED' });
  assert.throws(() => { Object.create(wire).authLoader = originalAuthLoader; }, { code: 'CLOSED' });
});

test('SDK guards cache named child domains without wrapping opaque metadata or results', async t => {
  const guards = fixture(t);
  const opaque = Object.freeze({ inspect() { return 'metadata'; }, date: new Date(0) });
  const array = Object.freeze([opaque]), map = new Map([['one', opaque]]), set = new Set([opaque]);
  const wire = Object.freeze({ async request() { return opaque; } });
  const child = Object.freeze({ transport: wire, async get() { return opaque; } });
  const raw = { library: child, transport: wire, metadata: opaque, array, map, set };
  raw.client = raw;
  const advanced = guards.domain(Object.freeze(raw));
  assert.equal(advanced.library, advanced.library);
  assert.equal(advanced.client, advanced);
  assert.equal(advanced.transport, advanced.library.transport);
  assert.equal(advanced.transport, guards.transport(wire));
  assert.equal(advanced.metadata, opaque);
  assert.equal(advanced.array, array);
  assert.equal(advanced.map, map);
  assert.equal(advanced.set, set);
  assert.equal(await advanced.library.get(), opaque);
  assert.equal(raw.transport, wire);
  const retained = advanced.library.get;
  await guards.client.close();
  await assert.rejects(retained(), { code: 'CLOSED' });
  assert.throws(() => advanced.library, { code: 'CLOSED' });
});

test('SDK guarded pending requests settle on close and abort the actual wire signal', async t => {
  const guards = fixture(t);
  let received, begin;
  const started = new Promise(resolve => { begin = resolve; });
  const wire = { async request() {}, requestRealtimeSdp({ signal }) {
    received = signal;
    begin();
    return new Promise(() => {});
  } };
  const operation = guards.transport(wire).requestRealtimeSdp({ sdp: 'synthetic' });
  const rejection = assert.rejects(operation, { code: 'CLOSED' });
  await started;
  await guards.client.close();
  await rejection;
  assert.equal(received.aborted, true);
});

test('SDK guarded transport deadlines settle uncooperative I/O and preserve ownership', async t => {
  const guards = fixture(t, { requestTimeoutMs: 15 });
  let received, closes = 0;
  const wire = { async request(_method, _route, { signal }) {
    received = signal;
    return new Promise(() => {});
  }, close() { closes++; } };
  await assert.rejects(guards.transport(wire).request('GET', '/backend-api/test'), { code: 'TIMEOUT' });
  assert.equal(received.aborted, true);
  await guards.client.close();
  assert.equal(closes, 0);
});

test('SDK returned connection handles retain their signal until the client closes', async t => {
  const guards = fixture(t);
  const handle = {};
  let received;
  const advanced = guards.domain({ openConnection({ signal }) { received = signal; return handle; } });
  assert.equal(await advanced.openConnection(), handle);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.aborted, false);
  await guards.client.close();
  assert.equal(received.aborted, true);
});
