import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutineManagement } from '../src/routine-management.mjs';
import { commands, createClient } from '../src/command-sets/routine-management.mjs';

function setup(...responses) {
  const calls = [];
  const client = { transport: { async request(...args) {
    calls.push(args); const result = responses.shift(); if (result instanceof Error) throw result; return result;
  } } };
  return { management: new RoutineManagement(client), calls, client };
}
const code = expected => error => error.code === expected;
const share = { post_id: 'post-1', permalink: 'https://chatgpt.com/s/post-1', created_at: 'today' };

test('routine query forwards explicit filters and cursor to server search', async () => {
  const { management, calls } = setup({ items: [{ id: 'routine-1', title: 'News', status: 'active',
    schedule: { kind: 'scheduled', next_run_at: 'tomorrow', secret: 'excluded' }, owner: { type: 'team', id: 'team-1', secret: 'excluded' },
    raw_messages: ['excluded'], reasoning: 'excluded' }, { id: 'hidden', title: 'excluded', hidden: true }], cursor: 'page-2' });
  const signal = new AbortController().signal;
  assert.deepEqual(await management.query({ scope: 'team', query: 'news', status: 'active', sort: 'title_asc', limit: 10, cursor: 'page-1', signal }), {
    items: [{ id: 'routine-1', title: 'News', status: 'active', schedule: { kind: 'scheduled', next_run_at: 'tomorrow' }, owner: { id: 'team-1', type: 'team' } }], cursor: 'page-2'
  });
  assert.deepEqual(calls[0], ['POST', '/backend-api/automations/query', { body: { scope: 'team', q: 'news', status: 'active', limit: 10, sort: 'title_asc', cursor: 'page-1' }, signal }]);
});

test('routine query defaults to personal scope and no mutation semantics', async () => {
  const { management, calls } = setup({ items: [] });
  assert.deepEqual(await management.query(), { items: [], cursor: null });
  assert.deepEqual(calls[0][2].body, { scope: 'personal', q: '', status: 'all', limit: 25, cursor: null });
});

test('query rejects invalid filters and bounds before network access', async () => {
  const { management, calls } = setup();
  for (const options of [{ scope: 'everyone' }, { query: 'x'.repeat(257) }, { query: '\0' }, { status: 'done' }, { sort: 'descending' },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }]) await assert.rejects(management.query(options), code('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('query rejects malformed response envelopes and metadata', async () => {
  const { management } = setup(null, { items: {} }, { items: [{}] }, { items: [], cursor: false });
  for (let i = 0; i < 4; i++) await assert.rejects(management.query(), code('INVALID_RESPONSE'));
});

test('current share validates routine identity and removes unrelated fields', async () => {
  const { management, calls } = setup({ automation_id: 'routine:1', current_share: { ...share, token: 'excluded' }, secret: 'excluded' });
  assert.deepEqual(await management.currentShare({ routineId: 'routine:1' }), { automation_id: 'routine:1', current_share: share });
  assert.equal(calls[0][1], '/backend-api/share/automation/routine%3A1/current');
});

test('current share can be absent but cannot belong to a different routine', async () => {
  const { management } = setup({ automation_id: 'r', current_share: null }, { automation_id: 'other', current_share: share }, { automation_id: 'r' });
  assert.deepEqual(await management.currentShare({ routineId: 'r' }), { automation_id: 'r', current_share: null });
  await assert.rejects(management.currentShare({ routineId: 'r' }), code('INVALID_RESPONSE'));
  await assert.rejects(management.currentShare({ routineId: 'r' }), code('INVALID_RESPONSE'));
});

test('share create and refresh issue one native request each', async () => {
  const { management, calls } = setup(share, share);
  assert.deepEqual(await management.createShare({ routineId: 'r' }), share);
  assert.deepEqual(await management.refreshShare({ routineId: 'r' }), share);
  assert.deepEqual(calls, [
    ['POST', '/backend-api/share/automation', { body: { automation_id: 'r' }, signal: undefined }],
    ['POST', '/backend-api/share/automation/r/refresh', { signal: undefined }]
  ]);
});

test('share revoke does not retry or fabricate a newly issued link', async () => {
  const { management, calls } = setup({});
  assert.deepEqual(await management.revokeShare({ routineId: 'r' }), { revoked: true, routineId: 'r' });
  assert.deepEqual(calls, [['DELETE', '/backend-api/share/automation/r', { signal: undefined }]]);
});

test('malformed share mutation acknowledgement retains unknown delivery', async () => {
  const { management, calls } = setup({});
  await assert.rejects(management.createShare({ routineId: 'r' }), error => error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown');
  assert.equal(calls.length, 1);
});

test('shares reject non-HTTPS or credential-bearing returned links', async () => {
  const { management } = setup({ ...share, permalink: 'http://chatgpt.com/s/a' }, { ...share, permalink: 'https://token:secret@chatgpt.com/s/a' });
  await assert.rejects(management.createShare({ routineId: 'r' }), code('INVALID_RESPONSE'));
  await assert.rejects(management.refreshShare({ routineId: 'r' }), code('INVALID_RESPONSE'));
});

test('shared metadata includes source and model settings without provider internals', async () => {
  const data = { post: { id: 'post-1', title: 'Daily news', permissions: { can_read: true, can_write: false }, internal: 'excluded' },
    automation: { title: 'News', prompt: 'Summarize', source_automation_id: 'source-1', source_timezone: 'Europe/London', conversation_origin: 'tpp',
      schedule: '', timing_mode: 'condition_watch', model_selection: { model_slug: 'test-model', thinking_effort: 'high', token: 'excluded' }, analysis: 'excluded' } };
  const { management, calls } = setup(data);
  assert.deepEqual(await management.shared({ postId: 'post-1' }), { post: { id: 'post-1', title: 'Daily news', permissions: { can_read: true, can_write: false } },
    automation: { title: 'News', prompt: 'Summarize', source_automation_id: 'source-1', source_timezone: 'Europe/London', conversation_origin: 'tpp',
      schedule: '', timing_mode: 'condition_watch', model_selection: { model_slug: 'test-model', thinking_effort: 'high' } } });
  assert.equal(calls[0][1], '/backend-api/share/post/post-1/automation');
});

test('shared metadata cannot be returned for a different post', async () => {
  const { management } = setup({ post: { id: 'wrong' }, automation: {} });
  await assert.rejects(management.shared({ postId: 'post-1' }), code('INVALID_RESPONSE'));
});

test('import prompt preparation forwards exact fields and never claims creation', async () => {
  const { management, calls } = setup({ prompt: 'Generated creation prompt', internal: 'excluded' });
  const result = await management.creationPrompt({ postId: 'post-1', title: ' News ', prompt: ' Summarize ', schedule: '', timingMode: 'condition_watch' });
  assert.deepEqual(result, { prompt: 'Generated creation prompt', postId: 'post-1', created: false });
  assert.deepEqual(calls, [['POST', '/backend-api/automations/generate_creation_prompt', {
    body: { title: 'News', prompt: 'Summarize', schedule: '', timing_mode: 'condition_watch', post_id: 'post-1' }, signal: undefined
  }]]);
});

test('import prompt uses native string timing enums for both string and numeric input', async () => {
  const { management, calls } = setup(...Array.from({ length: 6 }, () => ({ prompt: 'Prepared only' })));
  const modes = ['exact_schedule', 'flexible_schedule', 'condition_watch'];
  for (const timingMode of [...modes, 0, 1, 2]) await management.creationPrompt({ postId: 'p', title: 'Fixture', prompt: 'Marker', schedule: '', timingMode });
  assert.deepEqual(calls.map(call => call[2].body.timing_mode), [...modes, ...modes]);
});

test('import prompt preparation validates required data before sending', async () => {
  const { management, calls } = setup();
  const valid = { postId: 'p', title: 'News', prompt: 'Summarize', schedule: '', timingMode: 2 };
  for (const patch of [{ title: '' }, { prompt: '' }, { schedule: null }, { timingMode: 'bad' }, { timingMode: -1 }, { postId: '../p' }]) {
    await assert.rejects(management.creationPrompt({ ...valid, ...patch }), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('import prompt preparation rejects missing acknowledgement', async () => {
  const { management, calls } = setup({ prompt: '' });
  await assert.rejects(management.creationPrompt({ postId: 'p', title: 'News', prompt: 'Summarize', schedule: '', timingMode: 2 }), code('INVALID_RESPONSE'));
  assert.equal(calls.length, 1);
});

test('all ID-taking operations fail closed on path or query injection', async () => {
  const { management, calls } = setup();
  for (const bad of ['.', '..', 'a/b', '%2e%2e', 'a?b', 'a#b', 'a\\b']) {
    for (const method of ['currentShare', 'createShare', 'refreshShare', 'revokeShare']) await assert.rejects(management[method]({ routineId: bad }), code('INVALID_ARGUMENT'));
    await assert.rejects(management.shared({ postId: bad }), code('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('authorization failures propagate without retries or fallback endpoints', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'FORBIDDEN' });
  const { management, calls } = setup(denied);
  await assert.rejects(management.createShare({ routineId: 'r' }), code('FORBIDDEN'));
  assert.equal(calls.length, 1);
});

test('command descriptors resolve to real methods and distinguish import preparation', () => {
  const { client } = setup();
  const service = createClient(client);
  for (const descriptor of Object.values(commands)) assert.equal(typeof service[descriptor.method], 'function');
  assert.match(commands['routine import-prompt'].description, /does not create or run/);
  assert.ok(commands['routine import-prompt'].specFields.includes('timingMode'));
  assert.throws(() => new RoutineManagement({}), TypeError);
});
