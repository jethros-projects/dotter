import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.mjs';
import { ConversationClient } from '../src/conversations.mjs';
import { readElicitation, respondElicitation } from '../src/actions.mjs';
import { DotMessageWorkflows } from '../src/message-workflows.mjs';
import { streamSSE } from '../src/stream-http.mjs';

const auth = (subject, suffix = '') => ({ accountId: 'shared-account', accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature${suffix}` });
function transportHarness({ switchAfter = 1, respond = () => ({}) } = {}) {
  let authReads = 0; const calls = [];
  const transport = new Transport({
    authLoader: async () => auth(++authReads > switchAfter ? 'switched-user' : 'original-user', String(authReads)),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(respond(url, options));
    }
  });
  return { transport, calls, get authReads() { return authReads; } };
}
const actionsClient = transport => ({ transport, resolveRoom: async room => room ?? 'room-1' });

test('conversation mutation pins the preflight user before its first HTTP request', async () => {
  const h = transportHarness({ respond: () => ({ success: true }) });
  await assert.rejects(new ConversationClient({ transport: h.transport }).rename({ conversationId: 'conversation-1', title: 'Title' }), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(h.authReads, 2); assert.equal(h.calls.length, 0);
});

for (const [name, operation] of [
  ['elicitation read', client => readElicitation(client, { roomId: 'room-1', messageId: 'message-1' })],
  ['elicitation response', client => respondElicitation(client, { roomId: 'room-1', messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', action: 'decline' })]
]) test(`${name} rejects a preflight user switch before reading a message`, async () => {
  const h = transportHarness();
  await assert.rejects(operation(actionsClient(h.transport)), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(h.authReads, 2); assert.equal(h.calls.length, 0);
});

test('message plugin suggestions pin the user before reading a private reference', async () => {
  const h = transportHarness({ respond: () => ({ suggestions: [] }) });
  await assert.rejects(new DotMessageWorkflows({ transport: h.transport }).pluginSuggestions({ reference: 'reference-1' }), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(h.authReads, 2); assert.equal(h.calls.length, 0);
});

test('message connector authentication pins the user before reading its bundle', async () => {
  const h = transportHarness();
  await assert.rejects(new DotMessageWorkflows({ transport: h.transport }).connectorAuth({ reference: 'reference-1' }), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(h.authReads, 2); assert.equal(h.calls.length, 0);
});

test('preflight identity permits refreshed tokens for the same account and user', async () => {
  const h = transportHarness({ switchAfter: Infinity, respond: () => ({ success: true }) });
  assert.equal((await new ConversationClient({ transport: h.transport }).rename({ conversationId: 'conversation-1', title: 'Title' })).confirmed, true);
  assert.equal(h.authReads, 2); assert.equal(h.calls.length, 1);
});

test('SSE refuses a different user already pinned by an HTTP request', async () => {
  const h = transportHarness(); let started = false;
  await h.transport.request('GET', '/backend-api/tbo/test');
  await assert.rejects(streamSSE(h.transport, 'GET', '/backend-api/tbo/test/activity/stream', {
    streamImpl: async function* () { started = true; yield { type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } }; }
  }), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(started, false); assert.equal(h.calls.length, 1);
});

test('SSE establishes the transport identity before a later HTTP request', async () => {
  const h = transportHarness(); let ready = false;
  await streamSSE(h.transport, 'GET', '/backend-api/tbo/test/activity/stream', {
    onReady: () => { ready = true; },
    streamImpl: async function* () { yield { type: 'response', status: 200, headers: { 'content-type': 'text/event-stream' } }; }
  });
  assert.equal(ready, true);
  await assert.rejects(h.transport.request('POST', '/backend-api/tbo/test', { body: {} }), { code: 'AUTH_IDENTITY_CHANGED' });
  assert.equal(h.calls.length, 0);
});
