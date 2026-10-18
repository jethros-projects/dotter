import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.mjs';

const signed = 'https://storage.blob.core.windows.net/file?sig=test';
function setup() {
  const calls = [];
  let authLoads = 0;
  const transport = new Transport({
    authLoader: async () => { authLoads++; return { accessToken: 'test-token', accountId: 'account_1' }; },
    fetchImpl: async (url, options) => { calls.push({ url: String(url), ...options }); return new Response('{}', { status: 200 }); },
  });
  return { transport, calls, authLoads: () => authLoads };
}

test('signed reservation headers replace storage defaults without duplicate casing or account credentials', async () => {
  const { transport, calls, authLoads } = setup();
  const requiredHeaders = Object.freeze({ 'CONTENT-TYPE': 'text/plain', 'X-MS-VERSION': '2024-11-04', 'Content-MD5': 'YWJj' });
  await transport.uploadSigned(signed, { bytes: Buffer.from('canary'), requiredHeaders });
  assert.equal(authLoads(), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['Content-Type'], 'text/plain');
  assert.equal(calls[0].headers['x-ms-version'], '2024-11-04');
  assert.equal(calls[0].headers['content-md5'], 'YWJj');
  assert.equal(calls[0].headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(Object.keys(calls[0].headers).filter(name => name.toLowerCase() === 'content-type').length, 1);
  assert.ok(!Object.keys(calls[0].headers).some(name => /authorization|cookie|account/i.test(name)));
  assert.deepEqual(requiredHeaders, { 'CONTENT-TYPE': 'text/plain', 'X-MS-VERSION': '2024-11-04', 'Content-MD5': 'YWJj' });
});

test('unsafe, ambiguous and unsupported reservation headers fail before a signed upload', async () => {
  for (const requiredHeaders of [
    { Authorization: 'secret' }, { Cookie: 'session=secret' }, { Host: 'other.example' },
    { 'ChatGPT-Account-Id': 'account_1' }, { 'X-MS-Copy-Source': 'https://other.example/private' },
    { 'Content-Type': 'text/plain\r\nAuthorization: secret' }, { 'content-md5': 1 }, { 'content-md5': '🥚' },
    { 'content-type': 'text/plain', 'Content-Type': 'text/html' }, [], null,
  ]) {
    const { transport, calls, authLoads } = setup();
    await assert.rejects(transport.uploadSigned(signed, { bytes: Buffer.from('canary'), requiredHeaders }), { code: 'INVALID_HEADERS' });
    assert.equal(calls.length, 0);
    assert.equal(authLoads(), 0);
  }
});

test('AWS signed upload accepts explicit checksum while retaining its storage-specific defaults', async () => {
  const { transport, calls } = setup();
  await transport.uploadSigned('https://bucket.s3.amazonaws.com/file?X-Amz-Signature=test&X-Amz-Algorithm=AWS4-HMAC-SHA256', {
    bytes: Buffer.from('canary'), requiredHeaders: { 'x-amz-checksum-sha256': 'hash' },
  });
  assert.equal(calls[0].headers['x-amz-checksum-sha256'], 'hash');
  assert.equal(calls[0].headers['x-ms-blob-type'], undefined);
});

test('attach-auth header is allowed only for exact estuary POST or existing Library redirect routes', async () => {
  const { transport, calls } = setup();
  await transport.request('POST', '/backend-api/estuary/upload_content_bytes', {
    headers: { 'X-OpenAI-Attach-Auth': '1' }, bodyBytes: Buffer.from('multipart'), contentType: 'multipart/form-data; boundary=test',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-OpenAI-Attach-Auth'], '1');
  for (const [method, route] of [
    ['GET', '/backend-api/estuary/upload_content_bytes'],
    ['POST', '/backend-api/estuary/upload_content_bytes/other'],
    ['POST', '/backend-api/other'],
  ]) await assert.rejects(transport.request(method, route, { headers: { 'X-OpenAI-Attach-Auth': '1' } }), { code: 'INVALID_HEADERS' });
  assert.equal(calls.length, 1);
});
