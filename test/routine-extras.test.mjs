import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutineExtras } from '../src/routine-extras.mjs';

function setup(...responses) {
  const calls = [];
  const extras = new RoutineExtras({ transport: { async request(...args) {
    calls.push(args);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } } });
  return { extras, calls };
}
const code = value => error => error.code === value;
const connector = { id: 'connector_1', name: 'Example', status: 'ENABLED' };

test('requires an API transport', () => assert.throws(() => new RoutineExtras({}), TypeError));

test('execution threads uses the native envelope and filters hidden records', async () => {
  const { extras, calls } = setup({ threads: [
    { thread_id: 'thread_1', created_at: 'now', title: 'not exposed by this endpoint', raw_messages: ['secret'] },
    { thread_id: 'hidden', metadata: { hidden: true } }
  ], cursor: 'next', has_more: true, internal: 'secret' });
  const signal = new AbortController().signal;
  assert.deepEqual(await extras.executionThreads({ routineId: 'routine_1', cursor: 'old', limit: 15, signal }), {
    threads: [{ thread_id: 'thread_1', created_at: 'now' }], cursor: 'next', has_more: true
  });
  assert.deepEqual(calls[0], ['GET', '/backend-api/automation/routine_1/execution_threads', { query: { limit: 15, cursor: 'old' }, signal }]);
});

test('execution thread pagination rejects malformed shapes', async () => {
  for (const response of [{}, { threads: [null] }, { threads: [{}] }, { threads: [], has_more: 'yes' }, { threads: [], cursor: {} }]) {
    const { extras } = setup(response);
    await assert.rejects(extras.executionThreads({ routineId: 'r' }), code('INVALID_RESPONSE'));
  }
});

test('IDs and pagination cannot become routes or unbounded requests', async () => {
  const { extras, calls } = setup();
  for (const routineId of ['.', '..', '../a', 'a/b', 'a?b', 'a#b', '%2e%2e']) await assert.rejects(extras.executionThreads({ routineId }), code('INVALID_ARGUMENT'));
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.2 }, { cursor: '' }, { cursor: '\0' }, { cursor: {} }]) {
    await assert.rejects(extras.executionThreads({ routineId: 'r', ...options }), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('route IDs with colons remain one encoded segment', async () => {
  const { extras, calls } = setup({ threads: [] });
  await extras.executionThreads({ routineId: 'account~routine:1' });
  assert.equal(calls[0][1], '/backend-api/automation/account~routine%3A1/execution_threads');
});

test('mark read uses the freshly fetched run revision, without accepting a caller timestamp', async () => {
  const { extras, calls } = setup({ run: { id: 'run_1', updated_at: '2026-10-17T12:34:56Z' } }, {});
  assert.deepEqual(await extras.markRunRead({ routineId: 'r', runId: 'run_1', readAt: 'invented' }), {
    read: true, routineId: 'r', runId: 'run_1', readAt: '2026-10-17T12:34:56Z'
  });
  assert.deepEqual(calls[0].slice(0, 2), ['GET', '/backend-api/automation/r/runs/run_1']);
  assert.deepEqual(calls[1], ['POST', '/backend-api/automation/r/runs/run_1/read', { body: { read_at: '2026-10-17T12:34:56Z' }, signal: undefined }]);
});

test('mark read rejects mismatched, hidden, absent, or unusable current runs before writing', async () => {
  for (const run of [null, { id: 'other', updated_at: 'now' }, { id: 'run_1' }, { id: 'run_1', updated_at: '' },
    { id: 'run_1', updated_at: {} }, { id: 'run_1', updated_at: Infinity }, { id: 'run_1', updated_at: 'now', hidden: true }]) {
    const { extras, calls } = setup({ run });
    await assert.rejects(extras.markRunRead({ routineId: 'r', runId: 'run_1' }));
    assert.equal(calls.length, 1);
  }
});

test('mark read has no automatic write retry', async () => {
  const rejected = Object.assign(new Error('unavailable'), { code: 'EDGE_CHALLENGE' });
  const { extras, calls } = setup({ run: { id: 'run_1', updated_at: 1234 } }, rejected);
  await assert.rejects(extras.markRunRead({ routineId: 'r', runId: 'run_1' }), code('EDGE_CHALLENGE'));
  assert.equal(calls.length, 2);
});

test('latest backing run exposes the app-visible update and safe run metadata only', async () => {
  const { extras, calls } = setup({ last_backing_run: { id: 'run_1', status: 'completed', raw_messages: ['private'], chat_ref: { type: 'chatgpt', id: 'thread_1', secret: 'private' } },
    latest_update: { id: 'message_1', content_text: 'Visible result', created_at: 'now', raw_messages: ['private'], metadata: {} }, snapshot: { reasoning: 'private' } });
  assert.deepEqual(await extras.latestRun({ routineId: 'r' }), {
    last_backing_run: { id: 'run_1', status: 'completed', chat_ref: { type: 'chatgpt', id: 'thread_1' } },
    latest_update: { id: 'message_1', created_at: 'now', requires_user_action: false, content_text: 'Visible result' }
  });
  assert.deepEqual(calls[0], ['GET', '/backend-api/automation/r/latest_backing_run', { query: { include_snapshot: true }, allowNull: true, signal: undefined }]);
});

test('older latest backing run responses remain readable', async () => {
  const { extras } = setup({ id: 'message_1', content_text: 'Old shape', metadata: {} });
  assert.deepEqual(await extras.latestRun({ routineId: 'r' }), { last_backing_run: null, latest_update: { id: 'message_1', requires_user_action: false, content_text: 'Old shape' } });
});

test('latest backing update with a private pending action omits its content', async () => {
  const { extras } = setup({ latest_update: { id: 'm', content_text: 'private', metadata: { automation_requires_user_action: true, automation_last_backing_run_failed: true } } });
  assert.deepEqual(await extras.latestRun({ routineId: 'r' }), { last_backing_run: null, latest_update: { id: 'm', requires_user_action: true, last_run_failed: true } });
});

test('latest backing run excludes hidden, analysis, tool-routed and deleted updates', async () => {
  for (const flags of [{ hidden: true }, { metadata: { is_hidden: true } }, { channel: 'analysis' }, { metadata: { channel: 'analysis' } },
    { recipient: 'browser' }, { metadata: { recipient: 'python' } }, { deleted_at: 'now' }, { hidden: 1 },
    { channel: 'final', metadata: { channel: 'analysis' } }, { recipient: 'all', metadata: { recipient: 'python' } }]) {
    const { extras } = setup({ latest_update: { content_text: 'private', ...flags } });
    assert.deepEqual(await extras.latestRun({ routineId: 'r' }), { last_backing_run: null, latest_update: null });
  }
  const { extras } = setup({ hidden: true, latest_update: { content_text: 'private' } });
  assert.deepEqual(await extras.latestRun({ routineId: 'r' }), { last_backing_run: null, latest_update: null });
});

test('latest backing run never renders the skip-completion sentinel', async () => {
  const { extras } = setup({ content_text: ' \n::SKIP_COMPLETION::\n' });
  assert.equal((await extras.latestRun({ routineId: 'r' })).latest_update.content_text, undefined);
});

test('batch status exposes counts and enabled state only', async () => {
  const { extras, calls } = setup({ is_enabled: true, pending_event_count: 5, events: [{ secret: 'private' }] });
  assert.deepEqual(await extras.batchStatus({ routineId: 'r' }), { is_enabled: true, pending_event_count: 5 });
  assert.equal(calls[0][1], '/backend-api/automation/r/webhook_batch_state');
});

test('batch status cannot turn an invalid count into an empty queue', async () => {
  for (const response of [{}, { pending_event_count: -1 }, { pending_event_count: '3' }, { pending_event_count: 0, is_enabled: 'yes' }]) {
    const { extras } = setup(response);
    await assert.rejects(extras.batchStatus({ routineId: 'r' }), code('INVALID_RESPONSE'));
  }
});

test('flushing a queued event batch sends one UUID and reports its count', async () => {
  const requestId = '12345678-1234-1234-1234-123456789abc';
  const { extras, calls } = setup({ flushed_event_count: 5, raw_events: ['private'] });
  assert.deepEqual(await extras.flushBatch({ routineId: 'r', requestId }), { requestId, flushedEventCount: 5 });
  assert.deepEqual(calls[0], ['POST', '/backend-api/automation/r/webhook_batch/run_now', { body: { request_id: requestId }, idempotencyKey: requestId, signal: undefined }]);
});

test('flushing generates a UUID and allows an empty batch acknowledgement', async () => {
  const { extras, calls } = setup({ flushed_event_count: 0 });
  const result = await extras.flushBatch({ routineId: 'r' });
  assert.match(result.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(result.flushedEventCount, 0);
  assert.equal(calls[0][2].body.request_id, result.requestId);
});

test('malformed batch acknowledgements retain the request ID and ambiguous delivery', async () => {
  for (const response of [null, {}, { flushed_event_count: -1 }, { flushed_event_count: '5' }]) {
    const { extras, calls } = setup(response);
    await assert.rejects(extras.flushBatch({ routineId: 'r' }), error => error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown' && /^[0-9a-f-]{36}$/.test(error.details.requestId));
    assert.equal(calls.length, 1);
  }
});

test('bad batch request IDs cannot write', async () => {
  const { extras, calls } = setup();
  await assert.rejects(extras.flushBatch({ routineId: 'r', requestId: 'arbitrary' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('batch service failure propagates without retry', async () => {
  const { extras, calls } = setup(Object.assign(new Error('service failure'), { code: 'SERVICE_UNAVAILABLE' }));
  await assert.rejects(extras.flushBatch({ routineId: 'r' }), code('SERVICE_UNAVAILABLE'));
  assert.equal(calls.length, 1);
});

test('schedule policy preserves personal and explicit service-account query scopes', async () => {
  const policy = { minute_schedule_available: true, max_iterations_per_hour: -1, private: 'hidden' };
  const { extras, calls } = setup(policy, policy);
  assert.deepEqual(await extras.schedulePolicy(), { minute_schedule_available: true, max_iterations_per_hour: -1 });
  await extras.schedulePolicy({ serviceAccountId: 'service_1' });
  assert.deepEqual(calls.map(call => call[2].query), [{ service_account_id: undefined }, { service_account_id: 'service_1' }]);
  assert.ok(calls.every(call => call[1] === '/backend-api/automations/schedule_policy'));
});

test('invalid or malformed schedule policy does not imply unlimited scheduling', async () => {
  for (const response of [{}, { minute_schedule_available: true, max_iterations_per_hour: -2 }, { minute_schedule_available: 'true', max_iterations_per_hour: 1 }]) {
    const { extras } = setup(response);
    await assert.rejects(extras.schedulePolicy(), code('INVALID_RESPONSE'));
  }
  const { extras, calls } = setup();
  await assert.rejects(extras.schedulePolicy({ serviceAccountId: '../bad' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('connector details exclude credentials and nested authentication configuration', async () => {
  const { extras, calls } = setup({ ...connector, description: 'Example connector', supported_auth: [
    { type: 'OAUTH', token: 'secret', client_secret: 'private' }, { type: 'API_KEY', fields: ['private'] }
  ], client_secret: 'private', actions: [{ name: 'search', schema: 'not requested' }] });
  assert.deepEqual(await extras.connectorDetails({ connectorId: 'connector_1' }), { ...connector, description: 'Example connector', supported_auth: [{ type: 'OAUTH' }, { type: 'API_KEY' }] });
  assert.deepEqual(calls[0], ['GET', '/backend-api/aip/connectors/connector_1', { query: { include_actions: false }, headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, signal: undefined }]);
});

test('connector details cannot silently select a different connector', async () => {
  const { extras } = setup({ ...connector, id: 'other' });
  await assert.rejects(extras.connectorDetails({ connectorId: 'connector_1' }), code('INVALID_RESPONSE'));
});

test('connector health combines details and account status without credential exposure', async () => {
  const link = { id: 'link_1', connector_id: 'connector_1', auth_status: 'ACTIVE', connector_status: 'ENABLED', unavailable_reason: null,
    owner_profile: { email: 'owner@example.test', id: 'private' }, refresh_token: 'private' };
  const { extras, calls } = setup(connector, { link });
  assert.deepEqual(await extras.connectorHealth({ connectorId: 'connector_1', linkId: 'link_1' }), {
    connector, link: { id: 'link_1', connector_id: 'connector_1', auth_status: 'ACTIVE', connector_status: 'ENABLED', unavailable_reason: null, account_label: 'owner@example.test' }, state: 'connected'
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], '/backend-api/aip/connectors/connector_1/link');
});

test('connector health distinguishes disconnection, reauthentication, unavailable and unknown', async () => {
  const base = { id: 'link_1', connector_id: 'connector_1' };
  for (const [link, status, expected] of [[null, 'ENABLED', 'disconnected'], [{ ...base, auth_status: 'REAUTH_REQUIRED' }, 'ENABLED', 'needs_auth'],
    [{ ...base, auth_status: 'ACTIVE', unavailable_reason: 'unsupported_auth_strategy' }, 'ENABLED', 'unavailable'],
    [{ ...base, auth_status: 'ACTIVE' }, 'DISABLED_BY_ADMIN', 'unavailable'], [base, 'ENABLED', 'unknown']]) {
    const { extras } = setup({ ...connector, status }, { link });
    assert.equal((await extras.connectorHealth({ connectorId: 'connector_1' })).state, expected);
  }
});

test('connector health refuses another account or mismatched connector', async () => {
  for (const link of [{ id: 'other_link', connector_id: 'connector_1' }, null]) {
    const { extras } = setup(connector, { link });
    await assert.rejects(extras.connectorHealth({ connectorId: 'connector_1', linkId: 'link_1' }), code('ACCOUNT_MISMATCH'));
  }
  const { extras } = setup(connector, { link: { id: 'link_1', connector_id: 'other' } });
  await assert.rejects(extras.connectorHealth({ connectorId: 'connector_1' }), code('INVALID_RESPONSE'));
});

test('connector health refuses malformed link envelopes', async () => {
  for (const response of [{}, { link: {} }, { link: [] }]) {
    const { extras } = setup(connector, response);
    await assert.rejects(extras.connectorHealth({ connectorId: 'connector_1' }), code('INVALID_RESPONSE'));
  }
});

test('connector health validates selectors before either independent request', async () => {
  const { extras, calls } = setup();
  await assert.rejects(extras.connectorHealth({ connectorId: '../bad' }), code('INVALID_ARGUMENT'));
  await assert.rejects(extras.connectorHealth({ connectorId: 'connector_1', linkId: '../bad' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});


test('latest backing run normalizes the live no-run null response', async () => {
  const { extras, calls } = setup(null);
  assert.deepEqual(await extras.latestRun({ routineId: 'r' }), { last_backing_run: null, latest_update: null });
  assert.equal(calls[0][2].allowNull, true);
});
