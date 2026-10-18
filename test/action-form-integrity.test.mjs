import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { validateActionForm } from '../src/action-forms.mjs';
import { readElicitation, respondElicitation } from '../src/actions.mjs';

const schema = { type: 'object', properties: { choice: { type: 'string', enum: ['offered'] } }, required: ['choice'], additionalProperties: false };

for (const reason of [false, 0, '', null]) {
  test(`form validation rejects cancellation with ${JSON.stringify(reason)} as its exact reason`, async () => {
    const worker = new EventEmitter();
    let terminated = 0;
    worker.terminate = async () => { terminated++; };
    const controller = new AbortController();
    const pending = validateActionForm({ choice: 'offered' }, schema, { signal: controller.signal, workerFactory: () => worker });
    controller.abort(reason);
    const result = await pending.then(value => ({ resolved: value }), error => ({ rejected: true, error }));
    assert.equal(result.rejected, true);
    assert.equal(result.error, reason);
    assert.equal(terminated, 1);
    worker.emit('message', { valid: true });
    assert.equal(terminated, 1);
  });
}

test('the submitted form is the validated snapshot even if the caller mutates its object before POST', async () => {
  const content = { choice: 'offered' };
  const posted = [];
  let authReads = 0;
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'subject-1' })).toString('base64url')}.signature`;
  const client = {
    resolveRoom: async () => 'room-1',
    transport: {
      authLoader: async () => {
        if (++authReads === 2) content.choice = 'never-offered';
        return { accountId: 'account-1', accessToken: token };
      },
      request: async (method, path, options) => {
        if (method === 'POST') { posted.push(options.body.result.content); return { status: 'applied' }; }
        if (path.endsWith('/elicitation')) return {
          request_fingerprint: 'fingerprint-1', can_respond: true, runtime_status: 'pending',
          elicitation: { request_id: 'request-1', thread_id: 'thread-1', turn_id: 'turn-1', status: 'pending',
            params: { threadId: 'thread-1', turnId: 'turn-1', mode: 'form', requestedSchema: schema } }
        };
        return { items: [{ id: 'message-1', content: { text: 'Choose' } }] };
      }
    }
  };
  await respondElicitation(client, { messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', action: 'accept', content });
  assert.equal(content.choice, 'never-offered');
  assert.deepEqual(posted, [{ choice: 'offered' }]);
  assert.notEqual(posted[0], content);
});

const siteConnector = 'connector_20205bf7d4e99a89d7154bb849718324';
const updateSummary = '{"approval_version":1,"binding_name":"db","column":"name","deployment_id":"dep","new_value":"new","old_value":"old","primary_key_column":"id","primary_key_value":"row","project_id":"project","table_name":"people"}';
const insertSummary = '{"approval_version":1,"binding_name":"db","deployment_id":"dep","operation":"insert","primary_key_column":"id","primary_key_value":"row","project_id":"project","table_name":"people","values":{"id":"row","name":"new"}}';
const deleteSummary = '{"approval_version":1,"binding_name":"db","deployment_id":"dep","operation":"delete","primary_key_column":"id","primary_key_value":"3","project_id":"project","table_name":"people","values":{"id":3,"name":null}}';
const actionOptions = { messageId: 'message-1', requestId: 'request-1', requestFingerprint: 'fingerprint-1', action: 'accept', content: {} };
function siteClient({ tool = 'sites.execute_database_update', summary = updateSummary, args, metadata, params } = {}) {
  const calls = [];
  return { calls, resolveRoom: async () => 'room-1', transport: { request: async (method, path, options) => {
    calls.push({ method, path, options });
    if (method === 'POST') return { status: 'applied' };
    if (!path.endsWith('/elicitation')) return { items: [{ id: 'message-1', content: { text: 'Approve this change' } }] };
    return { request_fingerprint: 'fingerprint-1', can_respond: true, runtime_status: 'pending', elicitation: {
      request_id: 'request-1', thread_id: 'thread-1', turn_id: 'turn-1', status: 'pending',
      params: { threadId: 'thread-1', turnId: 'turn-1', mode: 'form', serverName: 'codex_apps',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: siteConnector, tool_name: tool,
          tool_params: args ?? { confirmation_summary: summary, plan_token: 'private-plan-token' }, ...metadata }, ...params }
    } };
  } } };
}

test('Sites approval inspection exposes the exact reviewable change without exposing its plan token', async () => {
  const view = await readElicitation(siteClient(), { messageId: 'message-1' });
  assert.equal(view.executionBound, true);
  assert.equal(view.approvalDisabled, false);
  assert.deepEqual(view.approvalDetails, { toolName: 'sites.execute_database_update', summary: JSON.parse(updateSummary) });
  assert.ok(!JSON.stringify(view).includes('private-plan-token'));
});

test('Sites database acceptance rejects unreviewable native approval details before any POST', async () => {
  const cases = [
    { summary: 'not-json' },
    { summary: updateSummary.replace(':1', ': 1') },
    { args: { confirmation_summary: updateSummary, plan_token: 'token', extra: 'unbound' } },
    { args: { confirmation_summary: updateSummary, plan_token: '  ' } },
    { summary: updateSummary.replace('"approval_version":1', '"approval_version":2') },
    { summary: updateSummary.replace('"new_value":"new"', '"new_value":"' + 'x'.repeat(500) + '"') },
    { tool: 'sites.execute_database_insert', summary: insertSummary.replace('"values":{"id":"row"', '"values":{"id":"other"') },
    { tool: 'sites.execute_database_delete', summary: deleteSummary.replace('"id":3', '"id":9007199254740992') },
    { tool: undefined, args: { confirmation_summary: 'not-json', plan_token: 'token' }, metadata: { tool_name: null } }
  ];
  for (const value of cases) {
    const client = siteClient(value);
    await assert.rejects(respondElicitation(client, actionOptions), { code: 'ACTION_UNAVAILABLE' });
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('execution-bound Sites approvals cannot persist even when generic metadata offers persistence', async () => {
  for (const persist of ['session', 'always']) {
    const client = siteClient({ metadata: { persist: ['session', 'always'] } });
    await assert.rejects(respondElicitation(client, { ...actionOptions, persist }), { code: 'INVALID_ARGUMENT' });
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('valid Sites update, insert and delete approvals retain fingerprint-bound acceptance', async () => {
  for (const [tool, summary] of [['sites.execute_database_update', updateSummary], ['sites.execute_database_insert', insertSummary], ['sites.execute_database_delete', deleteSummary]]) {
    const client = siteClient({ tool, summary });
    assert.equal((await respondElicitation(client, actionOptions)).applied, true);
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(client.calls.at(-1).options.body, { request_fingerprint: 'fingerprint-1', result: { action: 'accept', content: {}, _meta: null } });
  }
});

test('Sites approval accepts native Unicode canonicalization and the inclusive 500-character bound', async () => {
  // Captured from the installed native $6t serializer, including code-point
  // ordering (U+E000 before U+10000) rather than JavaScript's UTF-16 ordering.
  const unicodeUpdate = '{"approval_version":1,"binding_name":"db","column":"name","deployment_id":"dep","new_value":"\\u00e9\\ud83d\\ude00\\n","old_value":null,"primary_key_column":"id","primary_key_value":"row","project_id":"project","table_name":"people"}';
  const unicodeDelete = '{"approval_version":1,"binding_name":"db","deployment_id":"dep","operation":"delete","primary_key_column":"id","primary_key_value":"3","project_id":"project","table_name":"people","values":{"id":3,"\\ue000":"BMP","\\ud800\\udc00":"supplementary"}}';
  const maxSummary = updateSummary.replace('"new_value":"new"', `"new_value":"${'x'.repeat(500 - updateSummary.length + 3)}"`);
  assert.equal(maxSummary.length, 500);
  for (const [tool, summary] of [['sites.execute_database_update', unicodeUpdate], ['sites.execute_database_delete', unicodeDelete], ['sites.execute_database_update', maxSummary]]) {
    const client = siteClient({ tool, summary });
    assert.equal((await respondElicitation(client, actionOptions)).applied, true);
  }
  const denied = siteClient({ summary: maxSummary.replace('"new_value":"', '"new_value":"x') });
  await assert.rejects(respondElicitation(denied, actionOptions), { code: 'ACTION_UNAVAILABLE' });
  assert.equal(denied.calls.filter(call => call.method === 'POST').length, 0);
});

test('unreviewable Sites approvals can still be declined or canceled, and unrelated tools retain generic behavior', async () => {
  for (const action of ['decline', 'cancel']) {
    const client = siteClient({ summary: 'not-json' });
    assert.equal((await respondElicitation(client, { ...actionOptions, action, content: undefined })).applied, true);
    assert.deepEqual(client.calls.at(-1).options.body.result, { action, content: null, _meta: null });
  }
  for (const value of [{ metadata: { connector_id: 'another-connector' } }, { tool: 'sites.read_database' }, { params: { serverName: 'another-server' } }]) {
    const client = siteClient({ ...value, summary: 'not-json' });
    assert.equal((await respondElicitation(client, actionOptions)).applied, true);
  }
});

test('an accepted empty form sends the native empty object when content is omitted', async () => {
  const client = siteClient();
  await respondElicitation(client, { ...actionOptions, content: undefined });
  assert.deepEqual(client.calls.at(-1).options.body.result.content, {});
});

test('explicit OpenAI form modes validate their direct schema instead of legacy metadata', async () => {
  for (const mode of ['openaiForm', 'openai/form']) {
    const client = siteClient({ params: { mode, requestedSchema: schema, _meta: { 'openai/elicitation': { requestedSchema: { type: 'object' } } } } });
    await assert.rejects(respondElicitation(client, { ...actionOptions, content: { choice: 'never-offered' } }), { code: 'INVALID_ARGUMENT' });
    assert.equal(client.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('ordinary form mode honors its legacy schema and rejects malformed selected schemas', async () => {
  const client = siteClient({ params: { mode: 'form', requestedSchema: { type: 'object' }, _meta: { 'openai/elicitation': { requestedSchema: schema } } } });
  await assert.rejects(respondElicitation(client, { ...actionOptions, content: { choice: 'never-offered' } }), { code: 'INVALID_ARGUMENT' });
  for (const selected of [null, false, 'invalid', undefined]) {
    const invalid = siteClient({ params: { requestedSchema: { type: 'object' }, _meta: { 'openai/elicitation': { requestedSchema: selected } } } });
    await assert.rejects(respondElicitation(invalid, { ...actionOptions, content: undefined }), { code: 'UNSUPPORTED_ACTION' });
    assert.equal(invalid.calls.filter(call => call.method === 'POST').length, 0);
  }
});

test('Sites approvals reject a nonempty native approval schema and ignore legacy schema overrides', async () => {
  const invalid = siteClient({ params: { requestedSchema: schema } });
  await assert.rejects(respondElicitation(invalid, { ...actionOptions, content: { choice: 'offered' } }), { code: 'ACTION_UNAVAILABLE' });
  assert.equal(invalid.calls.filter(call => call.method === 'POST').length, 0);
  const valid = siteClient({ metadata: { 'openai/elicitation': { requestedSchema: schema } } });
  assert.equal((await respondElicitation(valid, actionOptions)).applied, true);
});

test('omitted form mode cannot bypass Sites inspection or execution-bound checks', async () => {
  const view = await readElicitation(siteClient({ params: { mode: undefined } }), { messageId: 'message-1' });
  assert.equal(view.mode, 'form');
  assert.equal(view.executionBound, true);
  const invalid = siteClient({ params: { mode: undefined }, summary: 'invalid' });
  await assert.rejects(respondElicitation(invalid, actionOptions), { code: 'ACTION_UNAVAILABLE' });
  assert.equal(invalid.calls.filter(call => call.method === 'POST').length, 0);
  const persisted = siteClient({ params: { mode: undefined }, metadata: { persist: 'always' } });
  await assert.rejects(respondElicitation(persisted, { ...actionOptions, persist: 'always' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(persisted.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal((await respondElicitation(siteClient({ params: { mode: undefined } }), actionOptions)).applied, true);
});

test('all native MCP and tool-suggestion approvals require empty forms while retaining decline and cancel', async () => {
  for (const kind of ['mcp_tool_call', 'tool_suggestion']) {
    for (const requestedSchema of [schema, { type: 'object', properties: {}, required: ['choice'] }]) {
      const fixture = { metadata: { codex_approval_kind: kind, connector_id: 'other-connector' }, params: { requestedSchema } };
      const view = await readElicitation(siteClient(fixture), { messageId: 'message-1' });
      assert.equal(view.approvalDisabled, true);
      const client = siteClient(fixture);
      await assert.rejects(respondElicitation(client, { ...actionOptions, content: { choice: 'offered' } }), { code: 'ACTION_UNAVAILABLE' });
      assert.equal(client.calls.filter(call => call.method === 'POST').length, 0);
      for (const action of ['decline', 'cancel']) {
        assert.equal((await respondElicitation(siteClient(fixture), { ...actionOptions, action, content: undefined })).applied, true);
      }
    }
    assert.equal((await respondElicitation(siteClient({ metadata: { codex_approval_kind: kind, connector_id: 'other-connector' } }), actionOptions)).applied, true);
  }
});
