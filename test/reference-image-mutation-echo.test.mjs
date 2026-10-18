import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryProviders } from '../src/library-providers.mjs';

const BASE = '/backend-api/files/library/reference-images';
const KEY = '12345678-1234-1234-1234-123456789abc';
const requested = { entityName: 'Corner cafe', entityType: 'place' };
const manual = { ...requested, assetPointer: 'sediment://file_1', idempotencyKey: KEY };
const suggestion = { ...requested, requestKind: 'suggestion_library', entityDescription: 'Synthetic corner cafe', imageIndex: 2, libraryFileId: 'lib-1', sourceConversationId: 'chat-1', sourceMessageId: 'message-1', suggestionMessageId: 'message-2' };
const matching = { id: 'ref:1', entity_name: requested.entityName, entity_type: requested.entityType };

function fixture(response) {
  const calls = [];
  const api = new LibraryProviders({ transport: { async request(method, route, options) {
    calls.push({ method, route, ...options });
    if (response instanceof Error) throw response;
    return response;
  } } });
  return { api, calls };
}

function unknownReceipt(error) {
  assert.equal(error.code, 'INVALID_RESPONSE');
  assert.equal(error.details.delivery, 'unknown');
  assert.equal(error.details.referenceImageId, 'ref:1');
  assert.match(error.message, /Check reference images before retrying/);
  return true;
}

for (const [label, echo] of [
  ['existing name', { ...matching, entity_name: 'Previous saved label' }],
  ['existing type', { ...matching, entity_type: 'asset' }],
  ['existing name and type', { ...matching, entity_name: 'Existing reference', entity_type: 'pet' }]
]) test(`manual creation does not falsely confirm a deduplicated reference with ${label}`, async () => {
  const { api, calls } = fixture(echo);
  await assert.rejects(api.createReferenceImage(manual), unknownReceipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].route, BASE);
  assert.equal(calls[0].idempotencyKey, KEY);
  assert.equal(calls[0].body.entity_name, requested.entityName);
  assert.equal(calls[0].body.entity_type, requested.entityType);
});

test('manual creation keeps matching native receipt metadata and strips private URLs', async () => {
  const { api, calls } = fixture({ ...matching, entity_description: 'Synthetic reference', asset_pointer: 'sediment://file_1', thumbnail_asset_pointer: 'sediment://thumb_1', content_url: 'https://private.invalid/image', thumbnail_url: 'https://private.invalid/thumb', private_token: 'never' });
  assert.deepEqual(await api.createReferenceImage(manual), { ...matching, entity_description: 'Synthetic reference', asset_pointer: 'sediment://file_1', thumbnail_asset_pointer: 'sediment://thumb_1', hasContent: true, hasThumbnail: true });
  assert.equal(calls.length, 1);
});

for (const [label, echo] of [
  ['name only', { id: 'ref:1', entity_name: requested.entityName }],
  ['type only', { id: 'ref:1', entity_type: requested.entityType }],
  ['neither optional field', { id: 'ref:1' }]
]) test(`sparse native reference receipt retains compatibility with ${label}`, async () => {
  const { api, calls } = fixture(echo);
  const result = await api.createReferenceImage(manual);
  assert.deepEqual(result, { ...echo, hasContent: false, hasThumbnail: false });
  assert.equal(calls.length, 1);
  // Missing fields stay missing; the CLI does not invent requested values.
  for (const key of ['entity_name', 'entity_type']) assert.equal(Object.hasOwn(result, key), Object.hasOwn(echo, key));
});

test('suggestion creation preserves a matching message-bound reference receipt', async () => {
  const { api, calls } = fixture(matching);
  assert.deepEqual(await api.createReferenceImage(suggestion), { ...matching, hasContent: false, hasThumbnail: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.request_kind, 'suggestion_library');
  assert.equal(calls[0].body.source_message_id, 'message-1');
  assert.equal(calls[0].body.suggestion_message_id, 'message-2');
  assert.equal(calls[0].idempotencyKey, undefined);
});

test('suggestion creation reports an explicit contradictory returned label after one write', async () => {
  const { api, calls } = fixture({ ...matching, entity_name: 'Other suggestion' });
  await assert.rejects(api.createReferenceImage(suggestion), unknownReceipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

for (const [label, echo] of [
  ['stale label', { ...matching, entity_name: 'Before rename' }],
  ['stale type', { ...matching, entity_type: 'asset' }]
]) test(`reference update rejects ${label} without a second write`, async () => {
  const { api, calls } = fixture(echo);
  await assert.rejects(api.updateReferenceImage({ referenceImageId: 'ref:1', ...requested }), unknownReceipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].route, `${BASE}/ref%3A1`);
  assert.deepEqual(calls[0].body, { entity_name: requested.entityName, entity_type: requested.entityType });
});

test('reference update still enforces the exact requested reference identity', async () => {
  const { api, calls } = fixture({ ...matching, id: 'other' });
  await assert.rejects(api.updateReferenceImage({ referenceImageId: 'ref:1', ...requested }), { code: 'INVALID_RESPONSE' });
  assert.equal(calls.length, 1);
});

test('reference update accepts an exact label/type echo and optional metadata', async () => {
  const { api, calls } = fixture({ ...matching, updated_at: '2026-10-18T10:00:00Z' });
  assert.deepEqual(await api.updateReferenceImage({ referenceImageId: 'ref:1', ...requested }), { ...matching, updated_at: '2026-10-18T10:00:00Z', hasContent: false, hasThumbnail: false });
  assert.equal(calls.length, 1);
});

test('transport mutation failures pass through unchanged and are not retried', async () => {
  const error = Object.assign(new Error('Unknown transport completion'), { code: 'NETWORK_ERROR', details: { delivery: 'unknown' } });
  const { api, calls } = fixture(error);
  await assert.rejects(api.createReferenceImage(manual), value => value === error);
  assert.equal(calls.length, 1);
});

test('explicit null mutation labels are contradictory rather than omitted echoes', async () => {
  const { api, calls } = fixture({ ...matching, entity_name: null });
  await assert.rejects(api.updateReferenceImage({ referenceImageId: 'ref:1', ...requested }), unknownReceipt);
  assert.equal(calls.length, 1);
});
