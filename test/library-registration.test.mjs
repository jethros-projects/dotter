import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryContent } from '../src/library-content.mjs';
import { Transport } from '../src/transport.mjs';
import { DotError } from '../src/errors.mjs';

const BASE = '/backend-api/files/library';
const FILE_ID = 'file_registration_test';
const NAME = 'registration-canary.txt';
const b64 = value => Buffer.from(value).toString('base64url');
const DRIVE = b64('drive-id');
const ITEM = b64('item-id');
const SITE = b64('tenant.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222');
const PARENT = 'external-box:folder:123';
const options = (parentDirectoryId = PARENT) => ({ fileId: FILE_ID, fileName: NAME, mimeType: 'text/plain', parentDirectoryId });
const entry = (parent = PARENT, extra = {}) => ({ id: 'library:registered', kind: 'file', file_id: FILE_ID,
  file_name: NAME, mime_type: 'text/plain', parent_directory_id: parent, ...extra });
const path = parent => ({ items: [{ id: parent, kind: 'directory', name: 'Destination' }], cursor: null });
const available = () => ({ providers: Object.fromEntries(['google_drive', 'box', 'dropbox', 'sharepoint'].map(provider => [provider,
  { capabilities: { library_browsing: { state: 'available' } } }])) });

function fixture({ preflight = path(PARENT), result = entry(), capabilities = available(), onCall } = {}) {
  const calls = [];
  const transport = { async request(method, route, args = {}) {
    const call = { method, route, ...args }; calls.push(call); await onCall?.(call);
    const response = method === 'GET' && route === `${BASE}/mounted/capabilities` ? capabilities
      : method === 'GET' && route === `${BASE}/directories/path` ? preflight
      : method === 'POST' && route === `${BASE}/files` ? result : new Error(`Unexpected ${method} ${route}`);
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(call) : response;
  } };
  return { library: new LibraryContent({ transport }), calls };
}

test('register-upload rejects native destinations and non-general file IDs before authentication', async () => {
  let authCalls = 0, networkCalls = 0;
  const transport = new Transport({ authLoader: async () => {
    authCalls++; return { accountId: 'account_test', accessToken: 'fake-token' };
  }, fetchImpl: async () => { networkCalls++; return Response.json({}); } });
  const library = new LibraryContent({ transport });
  const invalid = [
    { ...options(), parentDirectoryId: null },
    { ...options(), parentDirectoryId: undefined },
    { ...options(), parentDirectoryId: 'native-folder-id' },
    { ...options(), parentDirectoryId: 'library:native-folder' },
    { ...options(), fileId: 'CalpicoFile_room' },
    { ...options(), fileId: 'library:already_registered' },
    { ...options(), fileId: 'not-a-general-file' },
    { ...options(), fileId: 'external-box:file:123' },
  ];
  for (const input of invalid) await assert.rejects(library.registerUpload(input), { code: 'INVALID_ARGUMENT' });
  assert.equal(authCalls, 0); assert.equal(networkCalls, 0);
});

const validParents = [
  'external-gdrive:account:account_1:root',
  'external-gdrive:folder:folder_123',
  'external-gdrive:account:account_1:folder:folder_123',
  'external-box:root',
  PARENT,
  'external-box:account:tenant%3A1:folder:123',
  'external-dropbox:root',
  'external-dropbox:folder:id:folder_123',
  'external-dropbox:account:tenant%3A1:folder:id:folder_123',
  `external-sharepoint:folder:v1:drive:${DRIVE}`,
  `external-sharepoint:folder:v1:item:${DRIVE}:${ITEM}`,
  `external-sharepoint:folder:v2:drive:${SITE}:${DRIVE}`,
  `external-sharepoint:account:tenant%3A1:folder:v2:item:${SITE}:${DRIVE}:${ITEM}`,
];

test('source-backed provider destination forms preflight freshly then register exactly one upload', async () => {
  for (const parent of validParents) {
    const { library, calls } = fixture({ preflight: path(parent), result: entry(parent) });
    const result = await library.registerUpload(options(parent));
    assert.equal(result.file_id, FILE_ID); assert.equal(result.parent_directory_id, parent);
    assert.deepEqual(calls.map(call => [call.method, call.route]), [['GET', `${BASE}/mounted/capabilities`], ['GET', `${BASE}/directories/path`], ['POST', `${BASE}/files`]]);
    assert.deepEqual(calls[0].query, { provider: parent.startsWith('external-gdrive:') ? 'google_drive' : parent.split(':')[0].slice(9) });
    assert.deepEqual(calls[1].query, { directory_id: parent });
    assert.deepEqual(calls[2].body, { parent_directory_id: parent, file_id: FILE_ID, file_name: NAME, mime_type: 'text/plain' });
  }
});

test('unscoped Drive roots, invalid provider folder shapes and noncanonical SharePoint components never reach the API', async () => {
  const parents = [
    'external-gdrive:root', 'external-gdrive:account:tenant%3A1:root',
    'external-box:folder:0', 'external-box:folder:001', 'external-box:folder:not-numeric',
    'external-dropbox:folder:not-an-id', 'external-dropbox:collection:id:123',
    'external-onedrive:root', 'external-onedrive:folder:v3:anything',
    'external-sharepoint:root', `external-sharepoint:folder:v1:site:${SITE}`,
    `external-sharepoint:folder:v1:drive:${DRIVE}=`,
    `external-sharepoint:folder:v2:item:${b64('not-a-canonical-site')}:${DRIVE}:${ITEM}`,
    `external-sharepoint:folder:v1:item:${DRIVE}`,
    'external-box:account:tenant%3a1:folder:123',
  ];
  for (const parent of parents) {
    const { library, calls } = fixture();
    await assert.rejects(library.registerUpload(options(parent)), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls.length, 0);
  }
});

test('preflight requires the exact destination as the final directory in the returned path', async () => {
  for (const items of [[], [{ id: 'external-box:folder:456', kind: 'directory' }],
    [{ id: PARENT, kind: 'file' }], [{ id: PARENT, kind: 'directory' }, { id: 'external-box:folder:456', kind: 'directory' }]]) {
    const { library, calls } = fixture({ preflight: { items, cursor: null } });
    await assert.rejects(library.registerUpload(options()));
    assert.equal(calls.length, 2); assert.equal(calls.every(call => call.method === 'GET'), true);
  }
});

test('each registration refreshes the directory preflight instead of reusing a prior success', async () => {
  let preflights = 0;
  const { library, calls } = fixture({ preflight: () => ++preflights === 1 ? path(PARENT) : path('external-box:folder:456') });
  await library.registerUpload(options());
  await assert.rejects(library.registerUpload(options()));
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST', 'GET', 'GET']);
});

test('registration verifies returned underlying ID, name and destination and filters private metadata', async () => {
  for (const mismatch of [{ file_id: 'file_different' }, { file_name: 'different.txt' }, { parent_directory_id: 'external-box:folder:456' }]) {
    const { library, calls } = fixture({ result: entry(PARENT, mismatch) });
    await assert.rejects(library.registerUpload(options()), { code: 'INVALID_RESPONSE' });
    assert.equal(calls.length, 3);
  }
  const { library } = fixture({ result: entry(PARENT, { download_url: 'https://files.oaiusercontent.com/f?sig=secret', token: 'private' }) });
  const result = await library.registerUpload(options());
  assert.equal(result.download_url, undefined); assert.equal(result.token, undefined);
});

test('permission failures or uncertain registration writes do not retry or fall back to another endpoint', async () => {
  for (const status of [403, 404]) {
    const error = new DotError('HTTP_ERROR', `HTTP ${status}`, { status });
    const { library, calls } = fixture({ preflight: error });
    await assert.rejects(library.registerUpload(options()), error);
    assert.equal(calls.length, 2);
  }
  const error = new DotError('NETWORK_ERROR', 'Unknown registration outcome', { delivery: 'unknown' });
  const { library, calls } = fixture({ result: error });
  await assert.rejects(library.registerUpload(options()), error);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST']);
});

test('provider browsing must be currently available before checking or registering a destination', async () => {
  for (const capabilities of [{}, { providers: {} }, { providers: { box: { capabilities: { library_browsing: { state: 'unavailable' } } } } }]) {
    const { library, calls } = fixture({ capabilities });
    await assert.rejects(library.registerUpload(options()));
    assert.equal(calls.length, 1); assert.equal(calls[0].route, `${BASE}/mounted/capabilities`);
  }
});

test('minimal native registration acknowledgments and paths may omit optional metadata', async () => {
  const { library, calls } = fixture({ preflight: { items: [{ id: PARENT }], cursor: null }, result: { id: 'external-box:file:789' } });
  assert.deepEqual(await library.registerUpload(options()), { id: 'external-box:file:789' });
  assert.equal(calls.length, 3);
});
