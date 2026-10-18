import test from 'node:test';
import assert from 'node:assert/strict';
import { actionManifest, listActions, readElicitation, respondElicitation, reactToMessage, markRoomRead, readEmail, unsupportedAction } from '../src/actions.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string', enum: ['yes', 'no'] }, count: { type: 'integer', minimum: 1 } }, required: ['answer'], additionalProperties: false };
function request(overrides = {}) {
  return { request_id: 'request-1', thread_id: 'thread-1', turn_id: 'turn-1', status: 'pending',
    params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'example', mode: 'form', message: 'Choose an answer', requestedSchema: schema }, ...overrides };
}
function inspection(overrides = {}) { return { elicitation: request(), request_fingerprint: 'fingerprint-1', runtime_status: 'pending', can_respond: true, ...overrides }; }
function fake(responses) {
  const calls = [];
  return { calls, resolveRoom: async value => value ?? 'room-1', transport: { request: async (...args) => {
    calls.push(args);
    if (args[2]?.query?.around && !responses[0]?.items) return { items: [{ ...message, id: args[2].query.around }] };
    const response = responses.shift(); if (response instanceof Error) throw response; return response;
  } } };
}
const answer = { roomId: 'room-1', messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', action: 'accept', content: { answer: 'yes' } };
const message = { id: 'message-1', account_user_id: 'user-1', created_at: '2026-10-17T09:10:11Z', content: { text: 'Visible' } };

test('read elicitation uses inspect=true and projects only user-facing request fields', async () => {
  const client = fake([inspection({ secret: 'do-not-expose' })]);
  const result = await readElicitation(client, { messageId: 'message-1' });
  assert.equal(result.requestFingerprint, 'fingerprint-1');
  assert.equal(result.message, 'Choose an answer');
  assert.equal(result.secret, undefined);
  assert.deepEqual(client.calls[1], ['GET', '/backend-api/messaging/rooms/room-1/messages/message-1/elicitation', { query: { inspect: true }, signal: undefined }]);
});

test('real composite Calpico message IDs are retained in lookup and encoded in routes', async () => {
  const messageId = 'room-1~room-1~CalpicoMessage~Sentinel_01234567-89ab-cdef-0123-456789abcdef';
  const client = fake([inspection()]);
  const result = await readElicitation(client, { messageId });
  assert.equal(result.messageId, messageId);
  assert.equal(client.calls[0][2].query.around, messageId);
  assert.equal(client.calls[1][1], `/backend-api/messaging/rooms/room-1/messages/${encodeURIComponent(messageId)}/elicitation`);
  const encoded = fake([inspection()]);
  await readElicitation(encoded, { messageId: 'message:1~suffix' });
  assert.ok(encoded.calls[1][1].includes('/message%3A1~suffix/'));
});

test('elicitation inspection and responses reject an outer hidden message', async () => {
  for (const metadata of [{ is_hidden: true }, { hidden: true }, { is_visually_hidden_from_conversation: true }]) {
    for (const operation of [client => readElicitation(client, { messageId: 'message-1' }), client => respondElicitation(client, answer)]) {
      const client = fake([{ items: [{ ...message, metadata }] }]);
      await assert.rejects(operation(client), { code: 'MESSAGE_UNAVAILABLE' });
      assert.equal(client.calls.length, 1);
    }
  }
});

test('respond rechecks the current request and posts once with the verified fingerprint', async () => {
  const client = fake([inspection(), { status: 'applied' }]);
  assert.equal((await respondElicitation(client, answer)).applied, true);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls[2], ['POST', '/backend-api/messaging/rooms/room-1/messages/message-1/elicitation/response', {
    body: { request_fingerprint: 'fingerprint-1', result: { action: 'accept', content: { answer: 'yes' }, _meta: null } }, signal: undefined
  }]);
});

test('stale fingerprints, changed IDs and unavailable requests never write', async () => {
  for (const value of [inspection({ request_fingerprint: 'other' }), inspection({ elicitation: request({ request_id: 'other' }) }), inspection({ can_respond: false }), inspection({ runtime_status: 'resolved' })]) {
    const client = fake([value]);
    await assert.rejects(respondElicitation(client, answer), error => ['STALE_ACTION', 'ACTION_UNAVAILABLE'].includes(error.code));
    assert.equal(client.calls.length, 2);
  }
});

test('invalid field types, missing required fields, enums and unknown fields never write', async () => {
  for (const content of [{}, { answer: 'maybe' }, { answer: 'yes', count: 0 }, { answer: 'yes', count: 1.2 }, { answer: 'yes', other: true }]) {
    const client = fake([inspection()]);
    await assert.rejects(respondElicitation(client, { ...answer, content }), { code: 'INVALID_ARGUMENT' });
    assert.equal(client.calls.length, 2);
  }
});

test('decline and cancel use null fields without response content', async () => {
  for (const action of ['decline', 'cancel']) {
    const client = fake([inspection(), { status: 'applied' }]);
    await respondElicitation(client, { ...answer, action, content: undefined });
    assert.deepEqual(client.calls[2][2].body.result, { action, content: null, _meta: null });
  }
});

test('an unconfirmed result is not retried or reported as applied', async () => {
  const client = fake([inspection(), { status: 'unknown', secret: 'access-token' }]);
  await assert.rejects(respondElicitation(client, answer), error => error.code === 'ACTION_UNCONFIRMED' && !error.message.includes('access-token'));
  assert.equal(client.calls.filter(call => call[0] === 'POST').length, 1);
});

test('network write failure is passed through once', async () => {
  const failure = Object.assign(new Error('safe error'), { code: 'NETWORK_ERROR' });
  const client = fake([inspection(), failure]);
  await assert.rejects(respondElicitation(client, answer), failure);
  assert.equal(client.calls.filter(call => call[0] === 'POST').length, 1);
});

test('abort after inspection prevents an action write', async () => {
  const controller = new AbortController();
  const client = fake([inspection()]);
  const send = client.transport.request;
  client.transport.request = async (...args) => { const result = await send(...args); if (args[1].endsWith('/elicitation')) controller.abort(); return result; };
  await assert.rejects(respondElicitation(client, { ...answer, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(client.calls.length, 2);
});

test('native browser, location and wallet requests are explicitly unsupported', async () => {
  for (const metadata of [{ 'openai/location': {} }, { codex_approval_kind: 'wallet_enrollment' }, { codex_approval_kind: 'browser_auth' }, { codex_approval_kind: 'browser_email_otp' }]) {
    const value = request(); value.params._meta = metadata;
    const client = fake([inspection({ elicitation: value })]);
    await assert.rejects(respondElicitation(client, answer), { code: 'UNSUPPORTED_ACTION' });
    assert.equal(client.calls.length, 2);
  }
});

test('persistence must be explicitly offered by the read request', async () => {
  const value = request(); value.params._meta = { persist: ['session'] };
  const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
  await respondElicitation(client, { ...answer, persist: 'session' });
  assert.deepEqual(client.calls[2][2].body.result._meta, { persist: 'session' });
  const denied = fake([inspection({ elicitation: value })]);
  await assert.rejects(respondElicitation(denied, { ...answer, persist: 'always' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(denied.calls.length, 2);
});

test('malformed request identities are not exposed or accepted', async () => {
  const value = request(); value.params.threadId = 'other';
  const client = fake([inspection({ elicitation: value })]);
  await assert.rejects(readElicitation(client, { messageId: 'message-1' }), { code: 'INVALID_RESPONSE' });
});

test('list skips hidden messages and never returns raw tool output or analysis', async () => {
  const client = fake([{ items: [
    { ...message, content: { text: 'Visible', elicitation: request() } },
    { ...message, id: 'hidden-1', channel: 'analysis', content: { elicitation: request() } },
    { ...message, id: 'hidden-2', metadata: { hidden: true }, content: { elicitation: request() } },
    { ...message, id: 'email-1', content: { email: { provider: 'botmail', subject: 'Hello', body_preview: 'Preview', recipient_role: 'to' } } },
    { id: 'widget-1', raw_messages: [], attachments: [{ type: 'widget', attachment_id: 'widget-attachment', messages: [
      { author: { role: 'tool' }, metadata: { chatgpt_sdk: { resource_name: 'example', tool_title: 'Example' } }, content: { parts: ['private tool output'] } },
      { author: { role: 'assistant' }, channel: 'analysis', content: { parts: ['hidden reasoning'] } }
    ] }] }
  ], next_cursor: 'next' }]);
  const result = await listActions(client);
  assert.equal(result.actions.length, 3);
  assert.equal(result.actions[2].resourceName, 'example');
  assert.equal(result.actions[2].supported, false);
  assert.equal(result.nextCursor, 'next');
  assert.ok(!JSON.stringify(result).includes('private tool output'));
  assert.ok(!JSON.stringify(result).includes('hidden reasoning'));
});

test('reaction set and clear verify the message and issue only the selected mutation', async () => {
  for (const reaction of ['👍', '👨‍👩‍👧', null]) {
    const client = fake([{ items: [message] }, {}]);
    assert.equal((await reactToMessage(client, { messageId: 'message-1', reaction })).accepted, true);
    assert.equal(client.calls[1][0], reaction === null ? 'DELETE' : 'POST');
    assert.equal(client.calls[1][1], '/backend-api/messaging/rooms/room-1/messages/message-1/reactions');
  }
});

test('invalid reaction and hidden reaction targets cause no write', async () => {
  for (const reaction of ['', undefined, 'ok', '👍👍']) {
    const client = fake([]);
    await assert.rejects(reactToMessage(client, { messageId: 'message-1', reaction }), { code: 'INVALID_ARGUMENT' });
    assert.equal(client.calls.length, 0);
  }
  const client = fake([{ items: [{ ...message, channel: 'analysis' }] }]);
  await assert.rejects(reactToMessage(client, { messageId: 'message-1', reaction: '👍' }), { code: 'MESSAGE_UNAVAILABLE' });
  assert.equal(client.calls.length, 1);
});

test('mark read uses the exact timestamp on the read message', async () => {
  const client = fake([{ items: [message] }, {}]);
  const result = await markRoomRead(client, { messageId: 'message-1' });
  assert.equal(result.lastReadAt, message.created_at);
  assert.deepEqual(client.calls[1][2].body, { last_read_at: message.created_at });
});

test('read email returns only the rendered detail projection and truncation flags', async () => {
  const client = fake([{ items: [{ ...message, content: { email: { provider: 'botmail' } } }] }, {
    from_address: 'sender@example.com', to_addresses: ['recipient@example.com'], cc_addresses: [], subject: 'Hi',
    sent_at: message.created_at, attachment_names: ['report.pdf'], body_text: 'Hello', body_text_truncated: true,
    body_text_total_utf8_bytes: 1000, raw_messages: ['hidden'], access_token: 'do-not-expose'
  }]);
  const result = await readEmail(client, { messageId: 'message-1' });
  assert.equal(result.email.body_text, 'Hello');
  assert.equal(result.email.body_text_truncated, true);
  assert.equal(result.email.raw_messages, undefined);
  assert.equal(result.email.access_token, undefined);
});

test('unsupported parity features are explicit and never pretend to work', () => {
  assert.equal(actionManifest.widgetRespond.command, undefined);
  for (const name of ['widgetRespond', 'draftSend', 'draftEdit', 'draftDiscard', 'computerHandback', 'computerDismiss']) {
    assert.equal(actionManifest[name].supported, false);
    assert.throws(() => unsupportedAction(name), { code: 'UNSUPPORTED_ACTION' });
  }
});

test('path injection and invalid pagination fail before requests', async () => {
  const client = fake([]);
  await assert.rejects(readElicitation(client, { roomId: 'room-1', messageId: '../secret' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(listActions(client, { limit: 21 }), { code: 'INVALID_ARGUMENT' });
  assert.equal(client.calls.length, 0);
});

test('decline and cancel remain available for native-only requests', async () => {
  for (const mode of ['url', 'openai/userVerification']) for (const action of ['decline', 'cancel']) {
    const value = request(); value.params.mode = mode;
    const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
    await respondElicitation(client, { ...answer, content: undefined, action });
    assert.deepEqual(client.calls.at(-1)[2].body.result, { action, content: null, _meta: null });
  }
});

test('primitive forms support openaiForm, openai/form and metadata legacy schemas', async () => {
  for (const mode of ['openaiForm', 'openai/form', 'form']) {
    const value = request(); value.params.mode = mode;
    if (mode === 'form') value.params._meta = { 'openai/elicitation': { requestedSchema: schema } };
    const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
    assert.equal((await respondElicitation(client, answer)).applied, true);
  }
});

test('native choice arrays and simple string patterns validate without coercion', async () => {
  const requestedSchema = { type: 'object', properties: { choices: { type: 'array', items: { anyOf: [{ const: 'alpha', title: 'Alpha' }, { const: 'beta', title: 'Beta' }] }, minItems: 1, uniqueItems: true }, code: { type: 'string', pattern: '^[A-Z]{2}$' } }, required: ['choices', 'code'] };
  for (const [content, valid] of [[{ choices: ['alpha'], code: 'AB' }, true], [{ choices: ['no'], code: 'AB' }, false], [{ choices: ['alpha'], code: 'ab' }, false]]) {
    const value = request(); value.params.requestedSchema = requestedSchema;
    const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
    if (valid) assert.equal((await respondElicitation(client, { ...answer, content })).applied, true);
    else { await assert.rejects(respondElicitation(client, { ...answer, content }), { code: 'INVALID_ARGUMENT' }); assert.equal(client.calls.length, 2); }
  }
});

test('resource pickers serialize only selected server-provided URIs', async () => {
  const value = request(); value.params.mode = 'openaiForm'; value.params.requestedSchema = { type: 'object', properties: {
    source: { type: 'string', format: 'uri', 'x-openai-input': { type: 'resource', options: [{ uri: 'resource://known' }] } }
  }, required: ['source'] };
  const allowed = fake([inspection({ elicitation: value }), { status: 'applied' }]);
  await respondElicitation(allowed, { ...answer, content: { source: 'resource://known' } });
  assert.deepEqual(allowed.calls.at(-1)[2].body.result.content, { source: 'resource://known' });
  const rejected = fake([inspection({ elicitation: value })]);
  await assert.rejects(respondElicitation(rejected, { ...answer, content: { source: 'file:///etc/passwd' } }), { code: 'INVALID_ARGUMENT' });
  assert.equal(rejected.calls.length, 2);
});

test('legacy image picker accepts an offered image ID without downloading image data', async () => {
  const value = request(); value.params.mode = 'openai/form'; value.params.requestedSchema = { type: 'object', properties: {
    photo: { type: 'openai/imagePicker', items: [{ id: 'photo-1', title: 'Photo', image: 'data:image/png;base64,AA==' }] }
  }, required: ['photo'] };
  const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
  await respondElicitation(client, { ...answer, content: { photo: 'photo-1' } });
  assert.deepEqual(client.calls.at(-1)[2].body.result.content, { photo: 'photo-1' });
});

test('invalid patterns and prototype-bearing form content never write', async () => {
  for (const content of [Object.assign(Object.create({ bad: true }), { answer: 'yes' }), { answer: 'yes', constructor: 'bad' }]) {
    const client = fake([]); await assert.rejects(respondElicitation(client, { ...answer, content }), { code: 'INVALID_ARGUMENT' }); assert.equal(client.calls.length, 0);
  }
  const value = request(); value.params.requestedSchema.properties.answer.pattern = '(a+)+';
  const client = fake([inspection({ elicitation: value })]);
  await assert.rejects(respondElicitation(client, answer), { code: 'INVALID_ARGUMENT' });
  delete value.params.requestedSchema.properties.answer.pattern;
  assert.equal(client.calls.length, 2);
});

test('action response validates advanced schemas before one fingerprint-bound mutation', async () => {
  const value = request(); value.params.requestedSchema = { type: 'object', $defs: { approved: { const: true } }, properties: { approved: { $ref: '#/$defs/approved' } }, required: ['approved'], allOf: [{ not: { required: ['unexpected'] } }] };
  const client = fake([inspection({ elicitation: value }), { status: 'applied' }]);
  await respondElicitation(client, { ...answer, content: { approved: true } });
  assert.equal(client.calls.filter(call => call[0] === 'POST').length, 1);
  assert.equal(client.calls.at(-1)[2].body.request_fingerprint, 'fingerprint-1');
  const invalid = fake([inspection({ elicitation: value })]);
  await assert.rejects(respondElicitation(invalid, { ...answer, content: { approved: false } }), { code: 'INVALID_ARGUMENT' });
  assert.equal(invalid.calls.filter(call => call[0] === 'POST').length, 0);
});

test('form response stays bound to the original signed-in user and account', async () => {
  const jwt = subject => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;
  for (const change of ['account', 'subject']) {
    const client = fake([inspection(), { status: 'applied' }]); let accountId = 'account-1', subject = 'user-1';
    client.transport.authLoader = async () => ({ accountId, accessToken: jwt(subject) });
    const original = client.transport.request;
    client.transport.request = async (...args) => {
      const value = await original(...args);
      if (args[1].endsWith('/elicitation')) { if (change === 'account') accountId = 'account-2'; else subject = 'user-2'; }
      return value;
    };
    await assert.rejects(respondElicitation(client, answer), { code: 'ACCOUNT_CHANGED' });
    assert.equal(client.calls.filter(call => call[0] === 'POST').length, 0);
    assert.equal(client.calls[0][2].expectedAccountId, 'account-1');
  }
});
