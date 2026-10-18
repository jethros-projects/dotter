import test from 'node:test';
import assert from 'node:assert/strict';
import { DotWidgets } from '../src/widgets.mjs';
import { DotError } from '../src/errors.mjs';
import { installClock } from './helpers/deterministic-clock.mjs';

const target = { threadId: 'thread-1', messageId: 'message-1', attachmentId: 'attachment-1' };
const token = sub => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
const pendingResult = state => ({ resultType: 'input_required', requestState: state, inputRequests: {} });
const completedResult = { content: [{ type: 'text', text: 'finished' }], isError: false };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { operation = 'tools/call', responses = [], sku = 'CODEX' } = {}) {
  const controller = new AbortController(), calls = [], listeners = [];
  const auth = { accountId: 'account-1', accessToken: token('user-1') };
  const message = { id: target.messageId, created_at: '2026-10-18T10:00:00Z', raw_messages: [], attachments: [{
    type: 'widget', product_sku: sku, attachment_id: target.attachmentId, original_message_id: 'original-1', messages: [
      { id: 'original-1', author: { role: 'assistant' }, metadata: { chatgpt_sdk: {
        html_asset_pointer: 'ui://widget/app', resolved_pineapple_uri: 'connectors://connector-1',
        attribution_id: 'connector-1', link_id: 'link-1', widget_session_id: 'session-1', action_name: 'render',
      } } },
      { id: 'tool-1', author: { role: 'tool' }, content: { parts: ['{"content":[]}'] } },
    ],
  }] };
  const links = [{ id: 'link-1', connector_id: 'connector-1', auth_status: 'ACTIVE' }];
  const actualCalls = () => calls.filter(call => call.route === '/backend-api/ps/mcp' && call.body.method === operation);
  let beforeRequest;
  const transport = {
    authLoader: async () => ({ ...auth }),
    async request(method, route, options = {}) {
      options.signal?.throwIfAborted();
      const call = { method, route, body: options.body && structuredClone(options.body), options };
      calls.push(call); await beforeRequest?.(call);
      options.signal?.throwIfAborted();
      if (route === '/backend-api/tbo/by-thread/thread-1') return { messaging_room_id: 'room-1' };
      if (route === '/backend-api/messaging/rooms/room-1/messages') return { items: [structuredClone(message)] };
      if (route === '/backend-api/aip/connectors/links/list_accessible') return { links: structuredClone(links) };
      if (route === '/backend-api/ecosystem/call_mcp' && options.body.method === 'resources/list') return { resources: [{ uri: 'ui://widget/data' }] };
      if (route !== '/backend-api/ps/mcp') throw new Error(`Unexpected fixture route: ${route}`);
      let result;
      if (options.body.method === operation) {
        const index = actualCalls().length - 1;
        for (const listener of [...listeners]) if (index + 1 >= listener.count) listener.resolve();
        const response = responses[Math.min(index, responses.length - 1)];
        result = typeof response === 'function' ? await response(call, index) : response;
        if (result instanceof Error) throw result;
      } else if (options.body.method === 'tools/list') result = { tools: [{
        name: 'example.render', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        _meta: { _codex_apps: { resource_uri: '/connector-1/link-1/render' } },
      }] };
      else throw new Error(`Unexpected fixture method: ${options.body.method}`);
      return { jsonrpc: '2.0', id: options.body.id, result: structuredClone(result) };
    },
  };
  const widgets = new DotWidgets({ transport });
  t.after(() => controller.abort());
  const h = {
    auth, message, links, calls, controller, widgets, actualCalls,
    set beforeRequest(fn) { beforeRequest = fn; },
    async start(extra = {}) {
      const inspected = await widgets.inspect(target);
      const args = { ...target, requestFingerprint: inspected.requestFingerprint, signal: controller.signal, ...extra };
      const request = operation === 'tools/call' ? widgets.call({ ...args, toolName: 'render', confirmTool: 'render', arguments: { text: 'hello' } })
        : operation === 'resources/read' ? widgets.readResource({ ...args, uri: 'ui://widget/data' }) : widgets.resourceTemplates(args);
      const result = {};
      result.done = request.then(value => { result.value = value; }, error => { result.error = error; });
      h.result = result; return result;
    },
    async reach(count) {
      if (actualCalls().length < count) await new Promise(resolve => listeners.push({ count, resolve }));
      await turn(); assert.equal(actualCalls().length, count);
    },
  };
  return h;
}

function onceOnly(calls) {
  assert.equal(calls.filter(call => !Object.hasOwn(call.body, 'requestState')).length, 1);
  assert.equal(new Set(calls.map(call => call.body.id)).size, calls.length);
  for (const call of calls.slice(1)) assert.deepEqual(call.body.inputResponses, {});
}

test('widget tool polling waits a full second and carries each acknowledged state without replay', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { sku: 'TPP', responses: [pendingResult('private-1'), pendingResult('private-2'), completedResult] });
  const result = await h.start(); await h.reach(1);
  assert.equal(clock.scheduledCount, 1); clock.tick(999); await turn(); assert.equal(h.actualCalls().length, 1);
  clock.tick(1); await h.reach(2); clock.tick(1000); await result.done;
  assert.equal(result.error, undefined); assert.equal(result.value.content[0].text, 'finished');
  const calls = h.actualCalls(); assert.equal(calls.length, 3); onceOnly(calls);
  assert.deepEqual(calls.slice(1).map(call => call.body.requestState), ['private-1', 'private-2']);
  for (const call of calls) {
    assert.equal(call.options.headers['OAI-Product-Sku'], 'TPP');
    assert.equal(call.options.expectedAccountId, 'account-1');
    assert.deepEqual(call.body.params, calls[0].body.params);
  }
  assert.equal(calls[0].body.params.name, 'example.render');
  assert.doesNotMatch(JSON.stringify(result.value), /private-[12]|requestState|inputResponses/);
  assert.equal(clock.scheduledCount, 0);
});

test('a stable pending widget state may advance to completion on a later poll', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('stable'), pendingResult('stable'), completedResult] });
  const result = await h.start(); await h.reach(1); clock.tick(1000); await h.reach(2); clock.tick(1000); await result.done;
  assert.equal(result.error, undefined); assert.equal(h.actualCalls()[2].body.requestState, 'stable'); onceOnly(h.actualCalls());
  assert.equal(clock.scheduledCount, 0);
});

test('widget resource reads retain the exact URI and connection through background continuation', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { operation: 'resources/read', responses: [pendingResult('resource-state'), { contents: [{ uri: 'ui://widget/data', text: 'ready' }] }] });
  const result = await h.start(); await h.reach(1); clock.tick(1000); await result.done;
  assert.equal(result.error, undefined); assert.equal(result.value.contents[0].text, 'ready'); onceOnly(h.actualCalls());
  assert.deepEqual(h.actualCalls()[1].body.params, h.actualCalls()[0].body.params);
  assert.equal(h.actualCalls()[1].body.params.uri, 'ui://widget/data');
  assert.equal(h.actualCalls()[1].body.params._meta.link_id, 'link-1');
  assert.equal(clock.scheduledCount, 0);
});

test('resource-template background completion returns its catalog without private state', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { operation: 'resources/templates/list', responses: [pendingResult('template-state'), { resourceTemplates: [{ uriTemplate: 'ui://widget/{id}' }] }] });
  const result = await h.start(); await h.reach(1); clock.tick(1000); await result.done;
  assert.equal(result.error, undefined); assert.equal(result.value.resourceTemplates[0].uriTemplate, 'ui://widget/{id}');
  assert.doesNotMatch(JSON.stringify(result.value), /template-state/); onceOnly(h.actualCalls());
});

test('the thirty-second widget response may finish without an extra request', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [...Array.from({ length: 31 }, (_, i) => pendingResult(`state-${i}`)), completedResult] });
  const result = await h.start(); await h.reach(1);
  for (let round = 2; round <= 32; round++) { clock.tick(1000); await h.reach(round); }
  await result.done; assert.equal(result.error, undefined); assert.equal(result.value.content[0].text, 'finished');
  onceOnly(h.actualCalls()); assert.equal(clock.scheduledCount, 0);
});

test('thirty-two pending widget responses stop without a thirty-third request or leftover delay', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('still-pending')] });
  const result = await h.start(); await h.reach(1);
  for (let round = 2; round <= 32; round++) { clock.tick(1000); await h.reach(round); }
  await result.done; assert.equal(result.error?.code, 'CONTINUATION_LIMIT'); assert.equal(result.value, undefined);
  assert.equal(clock.scheduledCount, 0); clock.tick(60000); await turn(); assert.equal(h.actualCalls().length, 32); onceOnly(h.actualCalls());
});

test('human input on the exhausted thirty-second response cannot extend the native continuation limit', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [...Array.from({ length: 31 }, () => pendingResult('pending')), {
    resultType: 'input_required', requestState: 'private-final-state', inputRequests: { prompt: { message: 'private-final-question' } },
  }] });
  const result = await h.start(); await h.reach(1);
  for (let round = 2; round <= 32; round++) { clock.tick(1000); await h.reach(round); }
  await result.done; assert.equal(result.error?.code, 'CONTINUATION_LIMIT'); assert.equal(result.value, undefined);
  assert.doesNotMatch(JSON.stringify(result.error), /private-final/); assert.equal(clock.scheduledCount, 0); onceOnly(h.actualCalls());
});

test('background completion that next requires human input stops without guessing or exposing capabilities', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('background'), { resultType: 'input_required', requestState: 'private-human-state', inputRequests: { prompt: { message: 'private-question' } } }] });
  const result = await h.start(); await h.reach(1); clock.tick(1000); await result.done;
  assert.equal(result.error, undefined); assert.equal(result.value.status, 'input_required'); assert.equal(result.value.requiresNativeContinuation, true);
  assert.doesNotMatch(JSON.stringify(result.value), /private-human-state|private-question|inputRequests/);
  assert.equal(clock.scheduledCount, 0); clock.tick(60000); await turn(); assert.equal(h.actualCalls().length, 2); onceOnly(h.actualCalls());
});

for (const name of ['user cancellation', 'caller deadline']) test(`${name} during widget polling clears the delay and sends no continuation`, { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('pending')] });
  const result = await h.start(); await h.reach(1);
  const reason = new DOMException(name, name === 'caller deadline' ? 'TimeoutError' : 'AbortError');
  if (name === 'caller deadline') { setTimeout(() => h.controller.abort(reason), 500); clock.tick(500); }
  else h.controller.abort(reason);
  await result.done; assert.equal(result.error, reason); assert.equal(clock.scheduledCount, 0);
  clock.tick(60000); await turn(); assert.equal(h.actualCalls().length, 1); onceOnly(h.actualCalls());
});

for (const [name, mutate, code] of [
  ['selected account changes', h => { h.auth.accountId = 'account-2'; }, 'ACCOUNT_CHANGED'],
  ['signed-in user changes', h => { h.auth.accessToken = token('user-2'); }, 'ACCOUNT_CHANGED'],
  ['visible widget is closed', h => { h.message.attachments[0].messages[1].metadata = { chatgpt_sdk: { is_widget_closed: true } }; }, 'STALE_ACTION'],
  ['exact connection becomes inactive', h => { h.links[0].auth_status = 'EXPIRED'; }, 'CONNECTION_UNAVAILABLE'],
]) test(`widget polling stops if ${name}`, { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('private-pending')] });
  const result = await h.start(); await h.reach(1); mutate(h); clock.tick(1000); await result.done;
  assert.equal(result.error?.code, code); assert.equal(result.value, undefined); assert.equal(clock.scheduledCount, 0);
  assert.equal(h.actualCalls().length, 1); onceOnly(h.actualCalls());
});

test('a timeout of an acknowledged widget continuation never restarts its original tool call', { timeout: 10000 }, async t => {
  const clock = installClock(t), failure = new DotError('NETWORK_ERROR', 'The API request timed out.', { delivery: 'unknown' });
  const h = fixture(t, { responses: [pendingResult('accepted-state'), failure] });
  const result = await h.start(); await h.reach(1); clock.tick(1000); await result.done;
  assert.equal(result.error, failure); assert.equal(result.error.details.delivery, 'unknown'); assert.equal(result.value, undefined);
  clock.tick(60000); await turn(); assert.equal(h.actualCalls().length, 2); onceOnly(h.actualCalls()); assert.equal(clock.scheduledCount, 0);
});

test('a failed revalidation read stops polling before another widget invocation', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('accepted-state')] });
  const result = await h.start(); await h.reach(1);
  const failure = new DotError('EDGE_CHALLENGE', 'Read unavailable');
  h.beforeRequest = call => { if (call.route.includes('/messages')) throw failure; };
  clock.tick(1000); await result.done; assert.equal(result.error, failure); assert.equal(h.actualCalls().length, 1);
  assert.equal(clock.scheduledCount, 0); onceOnly(h.actualCalls());
});

test('an identity change during continuation revalidation is caught before sending', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('accepted-state')] });
  const result = await h.start(); await h.reach(1);
  h.beforeRequest = call => { if (call.route.endsWith('/links/list_accessible')) h.auth.accessToken = token('user-2'); };
  clock.tick(1000); await result.done; assert.equal(result.error?.code, 'ACCOUNT_CHANGED'); assert.equal(h.actualCalls().length, 1);
  assert.equal(clock.scheduledCount, 0); onceOnly(h.actualCalls());
});

test('contradictory duplicate exact links cannot authorize another widget poll', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [pendingResult('accepted-state'), completedResult] });
  const result = await h.start(); await h.reach(1);
  h.links.push({ ...h.links[0], auth_status: 'EXPIRED' });
  clock.tick(1000); await result.done;
  assert.equal(result.error?.code, 'INVALID_RESPONSE'); assert.equal(result.value, undefined);
  assert.equal(h.actualCalls().length, 1); assert.equal(clock.scheduledCount, 0); onceOnly(h.actualCalls());
});

test('an ambiguous connection list cannot authorize the initial widget operation', { timeout: 10000 }, async t => {
  const clock = installClock(t), h = fixture(t, { responses: [completedResult] });
  h.links.push({ ...h.links[0] });
  const result = await h.start(); await result.done;
  assert.equal(result.error?.code, 'INVALID_RESPONSE'); assert.equal(result.value, undefined);
  assert.equal(h.actualCalls().length, 0); assert.equal(clock.scheduledCount, 0);
});

test('invalid background continuation states fail before allocating a delay or sending again', { timeout: 10000 }, async t => {
  const clock = installClock(t);
  for (const response of [pendingResult(undefined), pendingResult(42), pendingResult('x'.repeat(65537)), { ...pendingResult('state'), inputRequests: [] }]) {
    const h = fixture(t, { responses: [response] }), result = await h.start(); await result.done;
    assert.equal(result.error?.code, 'INVALID_RESPONSE'); assert.equal(h.actualCalls().length, 1); assert.equal(clock.scheduledCount, 0);
  }
});
