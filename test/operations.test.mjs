import test from 'node:test';
import assert from 'node:assert/strict';
import { DotOperations, capabilities } from '../src/operations.mjs';

function setup(...responses) {
  const calls = [], primaryCalls = [];
  const client = { primary: async options => { primaryCalls.push(options); return { id: 'dot_1' }; }, transport: {
    async request(...args) { calls.push(args); const response = responses.shift(); if (response instanceof Error) throw response;
      if (args[1] === '/backend-api/ps/mcp') {
        const connectorId = args[2].body.params._meta['x-codex-turn-metadata'].mcp_request_meta.selected_connector_ids[0];
        return { jsonrpc: '2.0', id: args[2].body.id, result: { ...response, ...(Array.isArray(response?.tools) ? { tools: response.tools.map(tool => ({ ...tool, inputSchema: tool.inputSchema ?? {}, _meta: { ...tool._meta, _codex_apps: { resource_uri: `/${connectorId}/link-1/${tool.name}` } } })) } : {}) } };
      }
      return response; }
  } };
  return { ops: new DotOperations(client), calls, primaryCalls, client };
}
const code = expected => error => error.code === expected;
const rule = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
const event = `BEGIN:VEVENT\n${rule}\nEND:VEVENT`;
const routine = { id: 'routine_1', title: 'News', prompt: 'Read the news', schedule: event, default_timezone: 'Europe/London',
  is_enabled: true, notifications_enabled: false, email_enabled: true, timing_mode: 'flexible_schedule', model: 'model_1', reasoning_effort: 'high', executor: 'cloud' };

test('capabilities identify real scope and unimplemented native features', () => {
  const result = capabilities();
  assert.ok(result.routines.supported.includes('run'));
  assert.equal(result.tools.liveVerified, false);
  assert.ok(result.unavailable.some(entry => entry.feature.includes('hosted events')));
  assert.throws(() => new DotOperations({}), TypeError);
});

test('routine list resolves the primary Dot and preserves one-page cursor', async () => {
  const { ops, calls, primaryCalls } = setup({ items: [routine], cursor: 'next' });
  const signal = new AbortController().signal;
  assert.deepEqual(await ops.listRoutines({ signal }), { items: [routine], cursor: 'next' });
  assert.equal(primaryCalls.length, 1);
  assert.deepEqual(calls[0], ['GET', '/backend-api/tbo/dot_1/automations', { query: { limit: 25, cursor: undefined }, signal }]);
});

test('composite Dot and dotted IDs remain one safe route segment', async () => {
  const { ops, calls, client } = setup({ items: [] }, { items: [] });
  client.primary = async () => ({ id: 'account-uuid~dot.id' });
  await ops.listRoutines();
  assert.equal(calls[0][1], '/backend-api/tbo/account-uuid~dot.id/automations');
  await ops.listRoutines({ dotId: 'explicit~dot.id' });
  assert.equal(calls[1][1], '/backend-api/tbo/explicit~dot.id/automations');
  for (const dotId of ['.', '..', '%2e%2e', 'foo/bar', 'foo?bar', 'foo#bar', 'foo\\bar']) {
    await assert.rejects(ops.listRoutines({ dotId }), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 2);
});

test('all-account routine list is explicit and filters are validated', async () => {
  const { ops, calls, primaryCalls } = setup({ items: [] });
  await ops.listRoutines({ all: true, filter: 'paused', cursor: 'a', limit: 10 });
  assert.deepEqual(calls[0].slice(0, 2), ['GET', '/backend-api/automations']);
  assert.deepEqual(calls[0][2].query, { limit: 10, cursor: 'a', filter: 'paused' });
  assert.equal(primaryCalls.length, 0);
  for (const options of [{ filter: 'paused' }, { all: true, filter: 'typo' }, { all: true, dotId: 'dot_1' }, { all: 'true' }, { limit: 101 }, { limit: 0 }]) {
    await assert.rejects(ops.listRoutines(options), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 1);
});

test('routine detail rejects malformed IDs and unexpected response shapes', async () => {
  const { ops, calls } = setup({ title: 'missing ID' });
  await assert.rejects(ops.getRoutine({ routineId: '../other' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  await assert.rejects(ops.getRoutine({ routineId: 'r' }), code('INVALID_RESPONSE'));
});

test('create sends the exact account-cloud save contract', async () => {
  const { ops, calls } = setup({ ...routine, id: 'new' });
  const result = await ops.createRoutine({ title: ' News ', prompt: ' Read the news ', schedule: rule, timeZone: 'Europe/London', emoji: '🗞️', threadMode: 'new_chat' });
  assert.equal(result.id, 'new');
  assert.deepEqual(calls[0], ['POST', '/backend-api/automations/save', { body: {
    title: 'News', prompt: 'Read the news', schedule: event, default_timezone: 'Europe/London', jawbone_id: null,
    is_enabled: true, notifications_enabled: true, email_enabled: false, timing_mode: 0,
    model: null, reasoning_effort: null, emoji: '🗞️', thread_mode: 'new_chat'
  }, signal: undefined }]);
});

test('invalid create options cannot make network requests', async () => {
  const { ops, calls } = setup();
  const valid = { title: 'News', prompt: 'News', schedule: rule, timeZone: 'Europe/London' };
  for (const patch of [{ title: '' }, { prompt: '\0' }, { schedule: '* * * * *' }, { schedule: 'BEGIN:VEVENT\nRRULE:FREQ=DAILY' },
    { timeZone: 'Mars/Olympus' }, { enabled: 'yes' }, { timingMode: 5 }, { threadMode: 'arbitrary' }, { dotId: 'dot_1' }, { model: {} }]) {
    await assert.rejects(ops.createRoutine({ ...valid, ...patch }), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('update reads current config then preserves unspecified server settings', async () => {
  const { ops, calls } = setup(routine, { ...routine, title: 'Updated' });
  const result = await ops.updateRoutine({ routineId: 'routine_1', title: 'Updated' });
  assert.equal(result.title, 'Updated');
  assert.equal(calls[0][0], 'GET');
  assert.deepEqual(calls[1][2].body, { jawbone_id: 'routine_1', title: 'Updated', prompt: 'Read the news', schedule: event,
    default_timezone: 'Europe/London', is_enabled: true, notifications_enabled: false, email_enabled: true, timing_mode: 1, model: 'model_1', reasoning_effort: 'high' });
});

test('update permits explicit nullable model overrides and condition-watch timing', async () => {
  const { ops, calls } = setup(routine, routine);
  await ops.updateRoutine({ routineId: 'routine_1', model: null, reasoningEffort: 'high', emoji: null, enabled: false, timingMode: 'condition_watch' });
  assert.deepEqual({ ...calls[1][2].body, schedule: undefined, prompt: undefined, title: undefined, default_timezone: undefined }, {
    jawbone_id: 'routine_1', title: undefined, prompt: undefined, schedule: undefined, default_timezone: undefined,
    is_enabled: false, notifications_enabled: false, email_enabled: true, timing_mode: 2, model: null, reasoning_effort: 'high', emoji: null
  });
});

test('empty updates and local executor edits cannot write', async () => {
  const { ops, calls } = setup({ ...routine, executor: 'local' });
  await assert.rejects(ops.updateRoutine({ routineId: 'routine_1' }), code('INVALID_ARGUMENT'));
  await assert.rejects(ops.updateRoutine({ routineId: 'routine_1', prompt: 'change' }), code('UNSUPPORTED'));
  assert.equal(calls.length, 1);
});

test('pause and resume preserve the native status contract', async () => {
  const { ops, calls } = setup(routine, routine);
  await ops.setRoutineEnabled({ routineId: 'routine_1', enabled: false });
  await ops.setRoutineEnabled({ routineId: 'routine_1', enabled: true });
  assert.deepEqual(calls.map(call => call[2].body), [{ jawbone_id: 'routine_1', is_enabled: false }, { jawbone_id: 'routine_1', is_enabled: true }]);
  assert.ok(calls.every(call => call[1] === '/backend-api/automations/set_status'));
});

test('delete sends one explicit removal, with no retry', async () => {
  const { ops, calls } = setup({});
  assert.deepEqual(await ops.deleteRoutine({ routineId: 'routine_1' }), { deleted: true, routineId: 'routine_1' });
  assert.deepEqual(calls[0], ['POST', '/backend-api/automations/remove', { body: { automation_id: 'routine_1' }, signal: undefined }]);
  assert.equal(calls.length, 1);
});

test('run validates idempotency and refuses the local executor', async () => {
  const { ops, calls } = setup({ ...routine, executor: 'local' });
  await assert.rejects(ops.runRoutine({ routineId: 'routine_1', idempotencyKey: 'invalid' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  await assert.rejects(ops.runRoutine({ routineId: 'routine_1' }), code('UNSUPPORTED'));
  assert.equal(calls.length, 1);
});

test('run sends a stable UUID once and distinguishes receipt from persisted result IDs', async () => {
  const key = '12345678-1234-1234-1234-123456789abc';
  const { ops, calls } = setup(routine, { run_id: 'run_1' });
  assert.deepEqual(await ops.runRoutine({ routineId: 'routine_1', idempotencyKey: key }), { run_id: 'run_1', idempotencyKey: key, resultLookup: { command: 'routine runs', idField: 'runs[].id', note: 'The accepted run_id may differ from the persisted result ID. Use a run ID returned by routine runs with routine result.' } });
  assert.deepEqual(calls[1], ['POST', '/backend-api/automation/routine_1/run', { body: { idempotency_key: key }, idempotencyKey: key, signal: undefined }]);
});

test('ambiguous run acknowledgment reports unknown delivery and original key', async () => {
  const { ops, calls } = setup(routine, {});
  await assert.rejects(ops.runRoutine({ routineId: 'routine_1' }), error => error.code === 'INVALID_RESPONSE'
    && error.details.delivery === 'unknown' && /^[0-9a-f-]{36}$/.test(error.details.idempotencyKey));
  assert.equal(calls.length, 2);
});

test('run history exposes only safe metadata', async () => {
  const { ops, calls } = setup({ runs: [{ id: 'run_1', status: 'completed', started_at: 'now', raw_messages: ['secret'], reasoning: 'secret',
    chat_ref: { id: 'conversation_1', type: 'chatgpt', secret: 'secret' } }], cursor: 'next', internal: 'secret' });
  const result = await ops.routineRuns({ routineId: 'routine_1', limit: 5 });
  assert.deepEqual(result, { runs: [{ id: 'run_1', status: 'completed', started_at: 'now', chat_ref: { id: 'conversation_1', type: 'chatgpt' } }], cursor: 'next' });
  assert.equal(calls[0][2].query.include_chat_ref, true);
});

test('run detail includes only app-visible summary and hides private pending actions', async () => {
  const run = { id: 'run_1', status: 'completed', analysis: 'secret' };
  const { ops, calls } = setup({ run, latest_update: { content_text: 'Visible answer', created_at: 'now', raw_messages: ['secret'], metadata: {} } },
    { last_run: run, latest_update: { run, latest_update: { content_text: 'Private details', metadata: { automation_requires_user_action: true } } } });
  assert.deepEqual(await ops.routineRun({ routineId: 'routine_1', runId: 'run_1' }), {
    latest_update: { run: { id: 'run_1', status: 'completed' }, requires_user_action: false, content_text: 'Visible answer', created_at: 'now' }
  });
  const latest = await ops.routineRun({ routineId: 'routine_1' });
  assert.equal(latest.latest_update.requires_user_action, true);
  assert.equal(latest.latest_update.content_text, undefined);
  assert.equal(calls[1][1], '/backend-api/automation/routine_1/runs/latest');
});

test('task list uses data and next_cursor, filtering nested internals', async () => {
  const { ops, calls } = setup({ data: [{ id: 'task_1', title: 'Do it', latest_update: 'Done', updates: [{ reasoning: 'hidden' }], internal: 'secret' }], next_cursor: 'next' });
  assert.deepEqual(await ops.listTasks({ dotId: 'dot_1' }), { data: [{ id: 'task_1', title: 'Do it', latest_update: 'Done' }], next_cursor: 'next' });
  assert.equal(calls[0][1], '/backend-api/tbo/dot_1/tasks');
});

test('task detail projects only UI summary fields', async () => {
  const { ops, calls } = setup({ id: 'task_1', title: 'Do it', status: 'completed', internal_update: { private: 'secret' }, raw_messages: [] });
  assert.deepEqual(await ops.getTask({ taskId: 'task_1' }), { id: 'task_1', title: 'Do it', status: 'completed' });
  assert.equal(calls[0][1], '/backend-api/tbo/dot_1/tasks/task_1');
});

test('hidden task records cannot expose title or update content', async () => {
  const hiddenTask = { id: 'private', title: 'secret', latest_update: 'secret', metadata: { hidden: true } };
  const { ops } = setup({ data: [hiddenTask, { id: 'visible', title: 'Visible' }] }, hiddenTask);
  assert.deepEqual(await ops.listTasks(), { data: [{ id: 'visible', title: 'Visible' }], next_cursor: null });
  await assert.rejects(ops.getTask({ taskId: 'private' }), code('NOT_VISIBLE'));
});

test('threads exclude hidden attachments and internal transcript fields', async () => {
  const { ops, calls } = setup({ items: [{ thread_id: 'thread_1', created_at: 'now', title: 'Work', raw_messages: ['secret'] }, { thread_id: 'hidden', is_hidden: true }], cursor: null });
  assert.deepEqual(await ops.listThreads(), { items: [{ thread_id: 'thread_1', created_at: 'now', title: 'Work' }], cursor: null });
  assert.equal(calls[0][2].query.include_hidden, false);
});

test('connector actions use the observed path only', async () => {
  const { ops, calls } = setup({ actions: [{ name: 'search' }] });
  assert.deepEqual(await ops.connectorActions({ connectorId: 'connector_1' }), { actions: [{ name: 'search' }] });
  assert.equal(calls[0][1], '/backend-api/aip/connectors/connector_1/actions');
});

test('connector discovery uses the no-refresh accessible-links contract and returns account selectors', async () => {
  const { ops, calls } = setup({ links: [{
    id: 'implicit_link::connector_1', connector_id: 'connector_1', name: 'Example account', auth_type: 'OAUTH', auth_status: 'ACTIVE',
    connector_status: 'ENABLED', unavailable_reason: null, created_at: '2026-10-17', owner_profile: { email: 'owner@example.test', secret: 'excluded' },
    actions: ['search', 'read', { private: 'excluded' }], refresh_token: 'excluded', credential: 'excluded', owners: [{ id: 'excluded' }]
  }] });
  const signal = new AbortController().signal;
  assert.deepEqual(await ops.listConnectors({ signal }), { links: [{
    id: 'implicit_link::connector_1', connectorId: 'connector_1', appUri: 'connectors://connector_1', name: 'Example account',
    authType: 'OAUTH', authStatus: 'ACTIVE', connectorStatus: 'ENABLED', unavailableReason: null,
    createdAt: '2026-10-17', accountLabel: 'owner@example.test', actions: ['search', 'read']
  }] });
  assert.deepEqual(calls[0], ['POST', '/backend-api/aip/connectors/links/list_accessible', {
    body: { principals: [], link_refresh_strategy: 'NONE' }, headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, signal
  }]);
});

test('connector discovery preserves each account and filters without guessing a preferred one', async () => {
  const links = [
    { id: 'a', connector_id: 'connector_1', owner_profile: { name: 'First' }, auth_status: 'ACTIVE' },
    { id: 'b', connector_id: 'connector_1', name: 'Second', auth_status: 'EXPIRED' },
    { id: 'c', connector_id: 'connector_2', name: 'Other' }
  ];
  const { ops, calls } = setup({ links });
  const result = await ops.listConnectors({ connectorId: 'connector_1' });
  assert.deepEqual(result.links.map(link => [link.id, link.accountLabel, link.authStatus]), [['a', 'First', 'ACTIVE'], ['b', 'Second', 'EXPIRED']]);
  await assert.rejects(ops.listConnectors({ connectorId: 'bad/id' }), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 1);
});

test('connector discovery rejects malformed inventory envelopes and unidentified links', async () => {
  const { ops } = setup({}, { links: [{ name: 'No IDs' }] });
  await assert.rejects(ops.listConnectors(), code('INVALID_RESPONSE'));
  await assert.rejects(ops.listConnectors(), code('INVALID_RESPONSE'));
});

test('tool catalog routes to one explicitly selected connected app', async () => {
  const { ops, calls } = setup({ tools: [], nextCursor: 'next' });
  assert.deepEqual(await ops.toolList({ appUri: 'connectors://connector_1', linkId: 'implicit_link::connector_1', conversationId: 'conversation_1', threadId: 'thread_1', cursor: 'page' }), { tools: [], nextCursor: 'next' });
  assert.equal(calls[0][1], '/backend-api/ps/mcp');
  assert.equal(calls[0][2].body.method, 'tools/list');
  assert.deepEqual(calls[0][2].body.params._meta['x-codex-turn-metadata'], { mcp_request_meta: { selected_connector_ids: ['connector_1'] }, thread_id: 'thread_1', chatgpt_conversation_id: 'conversation_1' });
  assert.equal(calls[0][2].maxBytes, 32 * 1024 * 1024);
});

test('tool call first locates the exact tool across catalog pages', async () => {
  const { ops, calls } = setup({ tools: [], nextCursor: 'next' }, { tools: [{ name: 'search', inputSchema: { required: ['query'] } }] }, { content: [{ type: 'text', text: 'Found' }] });
  assert.deepEqual(await ops.toolCall({ connectorId: 'connector_1', name: 'search', arguments: { query: 'hello' } }), { content: [{ type: 'text', text: 'Found' }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[1][2].body.params.cursor, 'next');
  assert.deepEqual(calls[2][2].body.params, { name: 'search', arguments: { query: 'hello' }, _meta: { 'openai/connector_id': 'connector_1', 'openai/action_name': 'search' } });
});

test('unavailable, disabled and malformed tools cannot be invoked', async () => {
  for (const tool of [null, { name: 'search', is_enabled: false }, { name: 'search', inputSchema: { required: ['query'] } }]) {
    const { ops, calls } = setup({ tools: tool ? [tool] : [] });
    await assert.rejects(ops.toolCall({ connectorId: 'connector_1', name: 'search' }));
    assert.equal(calls.length, 1);
  }
  const { ops, calls } = setup();
  for (const options of [{ appUri: 'https://example.test', name: 'search' }, { connectorId: '../escape', name: 'search' },
    { connectorId: 'connector_1', name: 'other/search' }, { connectorId: 'connector_1', name: 'search', arguments: [] }]) {
    await assert.rejects(ops.toolCall(options), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('tool catalog cursor loops fail closed before any invocation', async () => {
  const { ops, calls } = setup({ tools: [], nextCursor: 'same' }, { tools: [], nextCursor: 'same' });
  await assert.rejects(ops.toolCall({ connectorId: 'connector_1', name: 'search' }), code('CURSOR_LOOP'));
  assert.equal(calls.length, 2);
});

test('resources, templates, reads and prompts forward their supported methods', async () => {
  const { ops, calls } = setup({ resources: [] }, { resourceTemplates: [] }, { contents: [{ uri: 'file://demo', text: 'hello' }] }, { prompts: [] });
  const options = { connectorId: 'connector_1' };
  await ops.resourceList(options); await ops.resourceTemplates(options); await ops.resourceRead({ ...options, uri: 'file://demo' }); await ops.promptList(options);
  assert.deepEqual(calls.map(call => call[2].body.method), ['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list']);
  assert.equal(calls[2][2].body.params.uri, 'file://demo');
  await assert.rejects(ops.mcpRequest('arbitrary/execute', {}, options), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 4);
});

test('malformed resource and task envelopes are rejected', async () => {
  const { ops } = setup({}, { data: 'wrong' });
  await assert.rejects(ops.resourceList({ connectorId: 'connector_1' }), code('INVALID_RESPONSE'));
  await assert.rejects(ops.listTasks(), code('INVALID_RESPONSE'));
});

test('API authorization failures propagate without retries or fallback routes', async () => {
  const denied = Object.assign(new Error('Not permitted'), { code: 'FORBIDDEN' });
  const { ops, calls } = setup(denied);
  await assert.rejects(ops.listRoutines(), code('FORBIDDEN'));
  assert.equal(calls.length, 1);
});

const gmail = { connector_type: 'gmail', webhook_name: 'message', params: {} };
const slack = { connector_type: 'slack', webhook_name: 'message', params: { channel_ids: ['C1'] } };
const github = { connector_type: 'github', webhook_name: 'pull_request', params: { repository: 'owner/repo' } };
const eventRoutine = { ...routine, schedule: '', timing_mode: 'condition_watch', source_conversation_is_work_mode: true,
  webhook_triggers: [{ ...slack, id: 'retained-trigger', presentation: { display_name: 'Slack' } }],
  shared_automation_post_id: 'shared-post', import_metadata: { original_post: 'shared-post' } };

test('event-trigger authoring refuses every explicit trigger value before requests', async () => {
  for (const triggers of [[gmail], [slack, github], [], {}, null, undefined]) {
    const { ops, calls } = setup();
    for (const method of ['createRoutine', 'updateRoutine']) {
      await assert.rejects(ops[method]({ routineId: 'r', title: 'Alerts', prompt: 'Summarize', schedule: rule, triggers }),
        error => error.code === 'UNSUPPORTED' && /Event-trigger authoring is unavailable/.test(error.message));
    }
    assert.equal(calls.length, 0);
  }
});

test('unrelated event updates preserve empty schedule, triggers and import metadata by omission', async () => {
  const { ops, calls } = setup({ ...eventRoutine, team_id: 'team-1', thread_mode: 'existing_chat' }, eventRoutine);
  await ops.updateRoutine({ routineId: routine.id, title: 'New title' });
  const body = calls[1][2].body;
  assert.equal(body.schedule, '');
  assert.equal(body.timing_mode, 2);
  assert.equal(body.title, 'New title');
  assert.equal(body.team_id, 'team-1');
  assert.equal(body.thread_mode, 'existing_chat');
  for (const key of ['triggers', 'webhook_triggers', 'shared_automation_post_id', 'import_metadata']) assert.equal(Object.hasOwn(body, key), false);
});

test('event schedule cannot replace existing triggers implicitly', async () => {
  const { ops, calls } = setup(eventRoutine, eventRoutine);
  await assert.rejects(ops.updateRoutine({ routineId: routine.id, schedule: rule }), code('UNSUPPORTED'));
  await assert.rejects(ops.updateRoutine({ routineId: routine.id, timingMode: 'exact_schedule' }), code('UNSUPPORTED'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call[0] === 'GET'));
});

test('existing routine trigger metadata remains readable', async () => {
  const { ops, calls } = setup(eventRoutine);
  const read = await ops.getRoutine({ routineId: routine.id });
  assert.deepEqual(read.webhook_triggers, eventRoutine.webhook_triggers);
  assert.equal(calls[0][0], 'GET');
});

test('explicit thread mode updates use the native field without resetting other settings', async () => {
  const { ops, calls } = setup(routine, routine);
  await ops.updateRoutine({ routineId: routine.id, threadMode: 'existing_chat' });
  assert.equal(calls[1][2].body.thread_mode, 'existing_chat');
  assert.equal(calls[1][2].body.model, routine.model);
});
