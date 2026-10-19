import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '../src/index.mjs';
import { Transport } from '../src/transport.mjs';

const auth = { accessToken: 'fixture-token', accountId: 'fixture-account' };
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

test('an unused default transport closes offline and fences every network entrypoint', async () => {
  let loads = 0;
  const transport = new Transport({ authLoader: async () => { loads++; return auth; } });
  await transport.close(); await transport.close();
  const operations = [
    () => transport.request('GET', '/backend-api/offline'),
    () => transport.requestBytes('GET', '/backend-api/offline'),
    () => transport.requestMultipart('POST', '/backend-api/offline', { file: { bytes: Buffer.from('fixture'), name: 'fixture.txt', mimeType: 'text/plain' } }),
    () => transport.fetchSigned('https://files.oaiusercontent.com/fixture'),
    () => transport.uploadSigned('https://files.oaiusercontent.com/fixture?sig=synthetic', { bytes: Buffer.from('fixture') }),
    () => transport.requestRealtimeSdp(),
  ];
  for (const operation of operations) await assert.rejects(operation, { code: 'CLOSED', details: { delivery: 'not_sent' } });
  assert.equal(loads, 0);
});

test('transport close leaves a borrowed fetch callable and its close method untouched', async () => {
  let fetches = 0, fetchCloses = 0, loads = 0;
  const fetchImpl = async () => { fetches++; return Response.json({ fixture: true }); };
  fetchImpl.close = () => { fetchCloses++; };
  const transport = new Transport({ fetchImpl, authLoader: async () => { loads++; return auth; } });
  assert.deepEqual(await transport.request('GET', '/backend-api/offline'), { fixture: true });
  await transport.close(); await transport.close();
  await assert.rejects(transport.request('GET', '/backend-api/offline'), { code: 'CLOSED' });
  assert.deepEqual(await (await fetchImpl()).json(), { fixture: true });
  assert.equal(fetches, 2); assert.equal(loads, 1); assert.equal(fetchCloses, 0);
});

test('closing during authentication prevents a late credential result from opening a request', async () => {
  const started = deferred(), released = deferred();
  let fetches = 0;
  const transport = new Transport({
    authLoader: async () => { started.resolve(); return released.promise; },
    fetchImpl: async () => { fetches++; assert.fail('A closed transport must not dispatch.'); },
  });
  const request = transport.request('GET', '/backend-api/offline');
  const rejected = assert.rejects(request, { code: 'CLOSED', details: { delivery: 'not_sent' } });
  await started.promise; await transport.close(); released.resolve(auth);
  await rejected; assert.equal(fetches, 0);
});

test('SDK ownership closes a transferred default transport and maps its closed state', async () => {
  let loads = 0;
  const transport = new Transport({ authLoader: async () => { loads++; return auth; } });
  const owner = createClient({ transport, ownsTransport: true });
  await owner.close();
  const borrower = createClient({ transport });
  try {
    await assert.rejects(borrower.history({ roomId: 'fixture_room' }), { code: 'CLOSED', nativeCode: 'CLOSED', deliveryState: 'not_sent' });
    assert.equal(loads, 0);
  } finally { await borrower.close(); }
});

test('SDK close leaves a borrowed transport available to its owner', async () => {
  let fetchCloses = 0;
  const fetchImpl = async () => Response.json({ fixture: true });
  fetchImpl.close = () => { fetchCloses++; };
  const transport = new Transport({ fetchImpl, authLoader: async () => auth });
  const client = createClient({ transport });
  await client.close();
  assert.deepEqual(await transport.request('GET', '/backend-api/offline'), { fixture: true });
  await transport.close(); assert.equal(fetchCloses, 0);
});
