import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectSources } from '../src/project-sources.mjs';
import { commands, createClient } from '../src/command-sets/project-sources.mjs';
import { DotError } from '../src/errors.mjs';

const accountId = 'acct';
const projectId = 'g-p-abc';
const scopeId = 'scope-1';
const scoped = { accountId, projectId };
const selected = { ...scoped, scopeId };
const DRIVE = 'connector_5f3c8c41a1e54ad7a76272c89e2554fa';
const SLACK = 'asdk_app_69a1d78e929881919bba0dbda1f6436d';
const LINEAR = 'asdk_app_69a089a326dc8191b32a3f2553f5be2c';
const sourceRoot = `/backend-api/projects/${projectId}/connector_scopes`;
const membership = () => ({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } });
const authentication = (subject = 'user-1', account = accountId) => ({ accountId: account, accessToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature` });
function resource(overrides = {}, outer = {}) {
  return { gizmo: { id: projectId, gizmo_type: 'snorlax', display: { name: 'X', emoji: null, theme: null }, instructions: '', share_recipient: 'private', sharing: { subjects: [] }, author: { user_id: 'user-1' }, current_user_permission: { can_read: true, can_write: true, can_delete: true }, memory_scope: 'global', ...overrides }, files: [], ...outer };
}
function source(overrides = {}) {
  return { scope_id: scopeId, connector_type: 'google_drive', scope_type: 'google_drive_file', original_url: 'https://drive.google.com/file/d/file-1/view', display_name: 'Example', canonical_handle: 'file-1', is_connector_syncable: true, last_sync_status: 'completed', last_synced_at: '2026-10-18T10:00:00Z', last_sync_detail_message: null, created_at: '2026-10-18T09:00:00Z', ...overrides };
}
const page = (items = [source()], cursor = null) => ({ items, cursor });
const code = expected => error => error.code === expected;
function setup(...responses) {
  const calls = [];
  let auth = authentication(), member = membership(), project = resource();
  const transport = {
    authLoader: async () => auth,
    request: async (method, path, options) => {
      const call = { method, path, options }; calls.push(call);
      if (path === '/backend-api/accounts/check/v4-2023-04-27') return member;
      if (path === `/backend-api/gizmos/${projectId}`) return project;
      const response = responses.shift();
      if (typeof response === 'function') return response(call);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { api: new ProjectSources({ transport }), transport, calls,
    setAuth: value => { auth = value; }, setMembership: value => { member = value; }, setProject: value => { project = value; },
    get operations() { return calls.filter(call => !call.path.includes('/accounts/check/') && !call.path.startsWith('/backend-api/gizmos/')); } };
}

test('project source manifest exposes scoped operations and explicit accounts', () => {
  assert.throws(() => new ProjectSources({}), TypeError);
  assert.ok(createClient({ transport: { request() {} } }) instanceof ProjectSources);
  const expected = ['sourcesList', 'sourceGet', 'sourceProviders', 'sourceAdd', 'sourceRemove', 'sourceSync', 'sourceWait'];
  assert.deepEqual(Object.values(commands).map(value => value.method).sort(), expected.sort());
  for (const command of Object.values(commands)) {
    assert.equal(typeof setup().api[command.method], 'function');
    assert.ok(command.required.includes('accountId'));
    assert.equal(command.flags['--account'].target, 'accountId');
  }
});

test('all project source operations reject absent account before making a request', async () => {
  const h = setup();
  for (const method of ['sourcesList', 'sourceGet', 'sourceProviders', 'sourceAdd', 'sourceRemove', 'sourceSync', 'sourceWait']) {
    await assert.rejects(h.api[method]({ projectId, scopeId, connectorType: 'google_drive', url: source().original_url, confirm: scopeId }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('project source reads pin account and revalidate membership on each invocation', async () => {
  const h = setup(page(), page());
  await h.api.sourcesList(scoped); await h.api.sourceGet(selected);
  assert.equal(h.calls.filter(call => call.path.includes('/accounts/check/')).length, 2);
  assert.ok(h.calls.every(call => call.options.expectedAccountId === accountId));
  assert.ok(h.calls.filter(call => call.path === `/backend-api/gizmos/${projectId}`).length >= 2);
});

for (const [label, value] of [
  ['missing membership', {}],
  ['inaccessible account', { accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: false } } }],
  ['mismatched account', { accounts: { acct: { account: { account_id: 'other', account_user_id: 'user-1__acct', structure: 'personal' }, can_access_with_session: true } } }],
]) test(`project source reads reject ${label} before reading a resource`, async () => {
  const h = setup(); h.setMembership(value);
  await assert.rejects(h.api.sourcesList(scoped), code('ACCOUNT_MEMBERSHIP_UNVERIFIED'));
  assert.equal(h.operations.length, 0);
  assert.equal(h.calls.length, 1);
});

test('identity changes during fresh membership stop project source reads', async () => {
  const h = setup(); const request = h.transport.request;
  h.transport.request = async (...args) => { const value = await request(...args); h.setAuth(authentication('user-2')); return value; };
  await assert.rejects(h.api.sourcesList(scoped), code('AUTH_IDENTITY_CHANGED'));
  assert.equal(h.calls.length, 1);
});

test('source list follows opaque cursors and deduplicates identities without emitting opaque fields', async () => {
  const h = setup(page([source({ access_token: 'private-token', download_url: 'https://secret.invalid?signature=x', metadata: { credential: 'private-token' } })], 'page+1/='), page([source(), source({ scope_id: 'scope-2' })]));
  const result = await h.api.sourcesList({ ...scoped, pages: 3 });
  assert.deepEqual(result.items.map(item => item.scopeId), [scopeId, 'scope-2']);
  assert.equal(result.pagesRead, 2); assert.equal(result.cursor, null); assert.equal(result.accountId, accountId); assert.equal(result.projectId, projectId);
  assert.equal(result.items[0].connectorType, 'google_drive'); assert.equal(result.items[0].displayName, 'Example');
  assert.equal(Object.getOwnPropertySymbols(result.items).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-token|secret\.invalid|credential/);
  assert.deepEqual(h.operations.map(call => [call.method, call.path, call.options.query]), [
    ['GET', sourceRoot, { cursor: null, limit: 100 }], ['GET', sourceRoot, { cursor: 'page+1/=', limit: 100 }],
  ]);
});

test('source list returns bounded continuation and accepts opaque starting cursor', async () => {
  const h = setup(page([], 'next'));
  assert.deepEqual(await h.api.sourcesList({ ...scoped, cursor: 'start' }), { accountId, projectId, items: [], cursor: 'next', pagesRead: 1 });
  assert.deepEqual(h.operations[0].options.query, { cursor: 'start', limit: 100 });
});

test('source list cannot loop indefinitely on repeated cursors', async () => {
  const h = setup(page([], 'same'), page([], 'same'));
  await assert.rejects(h.api.sourcesList({ ...scoped, pages: 100 }), code('INVALID_RESPONSE'));
  assert.equal(h.operations.length, 2);
});

test('invalid project and pagination arguments are rejected before account or source requests', async () => {
  const h = setup();
  for (const extra of [{ projectId: 'g-ordinary' }, { projectId: '../escape' }, { pages: 0 }, { pages: 101 }, { pages: 1.5 }, { cursor: {} }, { cursor: 'next\npage' }]) {
    await assert.rejects(h.api.sourcesList({ ...scoped, ...extra }), code('INVALID_ARGUMENT'));
  }
  for (const invalid of [undefined, '../scope', '', 'scope\nprivate']) {
    await assert.rejects(h.api.sourceGet({ ...scoped, scopeId: invalid }), code('INVALID_ARGUMENT'));
  }
  assert.equal(h.calls.length, 0);
});

test('aborted source reads stop before fresh membership is requested', async () => {
  const h = setup(), controller = new AbortController(); controller.abort();
  await assert.rejects(h.api.sourcesList({ ...scoped, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0);
});

for (const [label, value] of [
  ['missing envelope', {}], ['non-array items', { items: {}, cursor: null }],
  ['object cursor', page([], { token: 'private-token' })], ['control cursor', page([], 'next\npage')],
  ['oversized page', page(Array.from({ length: 101 }, (_, n) => source({ scope_id: `scope-${n}` })))],
  ['invalid scope ID', page([source({ scope_id: '../escape' })])],
  ['numeric scope ID', page([source({ scope_id: 1 })])],
  ['single-dot scope ID', page([source({ scope_id: '.' })])],
  ['double-dot scope ID', page([source({ scope_id: '..' })])],
  ['missing connector type', page([source({ connector_type: undefined })])],
  ['missing scope type', page([source({ scope_type: undefined })])],
]) test(`source list rejects ${label}`, async () => {
  const h = setup(value);
  await assert.rejects(h.api.sourcesList(scoped), code('INVALID_RESPONSE'));
});

test('source list suppresses hidden, deleted and internal rows before projection', async () => {
  const h = setup(page([
    source(), source({ scope_id: 'hidden', hidden: true }), source({ scope_id: 'deleted', deleted_at: '2026-10-18' }),
    source({ scope_id: 'internal', internal: true }), source({ scope_id: 'metadata-hidden', metadata: { is_hidden: true } }),
  ]));
  assert.deepEqual((await h.api.sourcesList(scoped)).items.map(item => item.scopeId), [scopeId]);
});

test('source detail scans later pages for the exact requested source', async () => {
  const h = setup(page([source({ scope_id: 'other' })], 'next'), page());
  const result = await h.api.sourceGet(selected);
  assert.equal(result.source.scopeId, scopeId); assert.equal(h.operations.length, 2);
});

test('source detail reports absence rather than returning a different or hidden source', async () => {
  for (const items of [[], [source({ scope_id: 'other' })], [source({ is_hidden: true })]]) {
    const h = setup(page(items));
    await assert.rejects(h.api.sourceGet(selected), error => /NOT_FOUND/.test(error.code));
  }
});

for (const [label, value] of [
  ['hidden project', { hidden: true }], ['unreadable project', { current_user_permission: { can_read: false } }],
  ['wrong project type', { gizmo_type: 'gpt' }], ['wrong identity', { id: 'g-p-other' }],
]) test(`source reads cannot cross ${label}`, async () => {
  const h = setup(); h.setProject(resource(value));
  await assert.rejects(h.api.sourcesList(scoped)); assert.equal(h.operations.length, 0);
});

test('source mutations require exact current native write permission', async () => {
  for (const can_write of [false, 'yes', 1, null, undefined]) {
    for (const method of ['sourceAdd', 'sourceRemove', 'sourceSync']) {
      const h = setup(); h.setProject(resource({ current_user_permission: { can_read: true, can_write } }));
      await assert.rejects(h.api[method]({ ...selected, connectorType: 'google_drive', url: source().original_url, confirm: scopeId }), error => ['PROJECT_PERMISSION_DENIED', 'PROJECT_SCOPE_UNSUPPORTED'].includes(error.code));
      assert.equal(h.operations.filter(call => ['POST', 'DELETE'].includes(call.method)).length, 0);
    }
  }
});

test('source removal requires an exact scope confirmation before any request', async () => {
  const h = setup();
  for (const confirm of [undefined, 'other', `${scopeId} `]) await assert.rejects(h.api.sourceRemove({ ...selected, confirm }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('source deletion performs one request and confirms exact source absence', async () => {
  const h = setup(page(), {}, page([]));
  const result = await h.api.sourceRemove({ ...selected, confirm: scopeId });
  assert.equal(result.confirmed, true);
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', sourceRoot], ['DELETE', `${sourceRoot}/${scopeId}`], ['GET', sourceRoot]]);
});

test('source deletion does not replay an accepted delete when readback fails', async () => {
  const h = setup(page(), {}, new DotError('HTTP_ERROR', 'edge blocked', { status: 403 }));
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('unknown delivery on source deletion is surfaced and not retried', async () => {
  const h = setup(page(), new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' }));
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), error => error.code === 'NETWORK_ERROR' && error.details.delivery === 'unknown');
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('source deletion cannot claim success while the exact source persists', async () => {
  const h = setup(page(), {}, page());
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('source deletion cannot mistake hidden membership for absence', async () => {
  const h = setup(page(), {}, page([source({ hidden: true })]));
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('source deletion cannot prove absence from malformed hidden membership', async () => {
  const h = setup(page(), {}, page([source({ hidden: true, scope_id: undefined })]));
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
});

test('source projection rejects cross-project identity and malformed metadata', async () => {
  for (const value of [
    source({ project_id: 'g-p-other' }), source({ display_name: {} }), source({ canonical_handle: ['file'] }),
    source({ last_sync_status: 'running\nsecret' }), source({ is_connector_syncable: 'true' }),
    source({ original_url: 'javascript:alert(1)' }), source({ original_url: 'https://user:password@example.com/path' }),
  ]) await assert.rejects(setup(page([value])).api.sourcesList(scoped), code('INVALID_RESPONSE'));
});

test('numeric source creation timestamps follow native seconds and milliseconds normalization', async () => {
  const millis = Date.parse('2026-10-18T09:00:00Z');
  for (const created_at of [millis / 1000, millis]) {
    const result = await setup(page([source({ created_at })])).api.sourcesList(scoped);
    assert.equal(result.items[0].createdAt, '2026-10-18T09:00:00.000Z');
  }
  for (const created_at of [NaN, Infinity, -Infinity, 9e18]) {
    await assert.rejects(setup(page([source({ created_at })])).api.sourcesList(scoped), code('INVALID_RESPONSE'));
  }
});

test('conflicting duplicate source identities cannot be used as a successful complete scan', async () => {
  const h = setup(page([source()], 'next'), page([source({ original_url: 'https://drive.google.com/file/d/other/view' })]));
  await assert.rejects(h.api.sourceGet(selected), code('INVALID_RESPONSE'));
});

test('bounded full source scans refuse mutation when more pages remain', async () => {
  const h = setup(...Array.from({ length: 100 }, (_, n) => page([], `page-${n + 1}`)));
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), code('SOURCE_SCAN_INCOMPLETE'));
  assert.equal(h.operations.length, 100); assert.ok(h.operations.every(call => call.method === 'GET'));
});

test('providers use native project product headers and expose only connection status', async () => {
  const links = [
    { id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE', connector_status: 'ENABLED', owner_profile: { email: 'private@example.test' }, access_token: 'secret-token' },
    { id: 'slack-link', connector_id: SLACK, auth_status: 'EXPIRED', connector_status: 'ENABLED' },
    { id: 'unrelated', connector_id: 'unrelated', auth_status: 'ACTIVE' },
  ];
  const h = setup({ links }, { id: DRIVE, status: 'ENABLED' }, { id: SLACK, status: 'ENABLED' }, { id: LINEAR, status: 'DISABLED_BY_ADMIN' });
  const result = await h.api.sourceProviders(scoped);
  assert.deepEqual(result.providers.map(value => [value.connectorType, value.available, value.connected]), [['google_drive', true, true], ['slack', true, false], ['linear', false, false]]);
  assert.equal(result.providers[0].links[0].linkId, 'drive-link');
  assert.doesNotMatch(JSON.stringify(result), /private@example|secret-token|unrelated/);
  assert.deepEqual(h.operations[0].options.body, { principals: [], link_refresh_strategy: 'BLOCKING' });
  assert.ok(h.operations.every(call => call.options.headers['OAI-Product-Sku'] === 'CHATGPT_PROJECTS'));
  assert.equal(h.operations[0].options.headers['X-Codex-Surface'], 'other');
  assert.ok(h.operations.slice(1).every(call => call.options.headers['X-Codex-Surface'] === 'connector_setup'));
  assert.deepEqual(h.operations.slice(1).map(call => call.options.query), [{ include_actions: false }, { include_actions: false }, { include_actions: false }]);
});

test('provider checks reject a different connector and a malformed link list', async () => {
  const mismatch = setup({ links: [] }, { id: SLACK, status: 'ENABLED' });
  await assert.rejects(mismatch.api.sourceProviders({ ...scoped, connectorType: 'google_drive' }), code('INVALID_RESPONSE'));
  await assert.rejects(setup({ links: {} }).api.sourceProviders(scoped), code('INVALID_RESPONSE'));
});

test('hidden provider links cannot authorize a new project source or leak connection IDs', async () => {
  const h = setup({ links: [
    { id: 'hidden-link', connector_id: DRIVE, auth_status: 'ACTIVE', hidden: true },
    { id: 'internal-link', connector_id: DRIVE, auth_status: 'ACTIVE', metadata: { internal: true } },
  ] }, { id: DRIVE, status: 'ENABLED' });
  const result = await h.api.sourceProviders({ ...scoped, connectorType: 'google_drive' });
  assert.equal(result.providers[0].connected, false);
  assert.deepEqual(result.providers[0].links, []);
});

test('provider connector identity accepts the native asdk-to-connector alias only', async () => {
  const canonicalSlack = SLACK.replace(/^asdk_app_/, 'connector_');
  const h = setup({ links: [{ id: 'slack-link', connector_id: canonicalSlack, auth_status: 'ACTIVE' }] }, { id: canonicalSlack, status: 'ENABLED' });
  const result = await h.api.sourceProviders({ ...scoped, connectorType: 'slack' });
  assert.equal(result.providers[0].connected, true);
  assert.equal(result.providers[0].links[0].linkId, 'slack-link');
});

test('implicit and malformed provider link identities cannot become connections', async () => {
  const h = setup({ links: [
    { id: 'implicit_link::drive', connector_id: DRIVE, auth_status: 'ACTIVE' },
    { id: '../escape', connector_id: DRIVE, auth_status: 'ACTIVE' },
    { link_id: 'legacy-name-only', connector_id: DRIVE, auth_status: 'ACTIVE' },
    { id: 'hidden-visibility', connector_id: DRIVE, auth_status: 'ACTIVE', visibility: 'HIDDEN' },
  ] }, { id: DRIVE, status: 'ENABLED' });
  const provider = (await h.api.sourceProviders({ ...scoped, connectorType: 'google_drive' })).providers[0];
  assert.equal(provider.connected, false); assert.deepEqual(provider.links, []);
});

test('hidden connector detail cannot yield an available project provider', async () => {
  const h = setup({ links: [] }, { id: DRIVE, status: 'ENABLED', metadata: { is_hidden: true } });
  await assert.rejects(h.api.sourceProviders({ ...scoped, connectorType: 'google_drive' }), code('INVALID_RESPONSE'));
});

test('website creation uses native URL normalization and verifies one new persisted source', async () => {
  const website = source({ connector_type: 'website', scope_type: 'website', original_url: 'https://example.com/a/b', is_connector_syncable: false });
  const h = setup(page([]), {}, page([website]));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'website', url: ' example.com/a//b/?query=discard#fragment ', wait: true });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: false, status: 'not_applicable', completed: false });
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', sourceRoot], ['POST', sourceRoot], ['GET', sourceRoot]]);
  assert.deepEqual(h.operations[1].options.body, { connector_type: 'website', original_url: 'https://example.com/a/b' });
});

test('website duplicate detection compares normalized source URLs before any write', async () => {
  const website = source({ connector_type: 'website', scope_type: 'website', original_url: 'https://example.com/a/?old=1', is_connector_syncable: false });
  const h = setup(page([website]));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'website', url: 'https://example.com/a?new=2' }), code('SOURCE_ALREADY_EXISTS'));
  assert.ok(h.operations.every(call => call.method === 'GET'));
});

test('ambiguous website readback never claims successful creation or retries the write', async () => {
  const website = source({ connector_type: 'website', scope_type: 'website', original_url: 'https://example.com/a', is_connector_syncable: false });
  const h = setup(page([]), {}, page([website, { ...website, scope_id: 'other-new-source' }]));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'website', url: 'example.com/a' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('invalid provider and website inputs fail before authentication or network', async () => {
  const h = setup();
  for (const options of [
    { connectorType: 'unknown', url: 'https://example.com' }, { connectorType: 'website', url: 'localhost' },
    { connectorType: 'website', url: 'https://127.0.0.1/' }, { connectorType: 'website', url: 'file:///etc/passwd' },
    { connectorType: 'google_drive', url: 'drive.google.com/file/d/file-1/view' },
    { connectorType: 'google_drive', url: 'https://user:secret@drive.google.com/file/d/file-1/view' },
    { connectorType: 'google_drive', url: 'https://drive.google.com/\nprivate' },
    { connectorType: 'website', url: 'https://example.com', wait: 'yes' },
    { connectorType: 'website', url: 'https://example.com', timeout: 999 },
    { connectorType: 'website', url: 'https://example.com', interval: 99 },
  ]) await assert.rejects(h.api.sourceAdd({ ...scoped, ...options }), code('INVALID_ARGUMENT'));
  assert.equal(h.calls.length, 0);
});

test('connector source creation verifies limit and existing connection, then starts sync once', async () => {
  const current = source(), updated = source({ last_synced_at: '2026-10-18T10:01:00Z' });
  const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]), {}, page([updated]));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: ` ${current.original_url} ` });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: true, status: 'completed', completed: true, detail: null });
  assert.deepEqual(h.operations.filter(call => call.method === 'POST' && call.path === sourceRoot)[0].options.body, { connector_type: 'google_drive', original_url: current.original_url });
  assert.equal(h.operations.filter(call => call.path.endsWith(`/${scopeId}/sync`)).length, 1);
});

test('malformed provider source limit blocks creation before provider checks or writes', async () => {
  const h = setup(page([]));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: '10' } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), code('SOURCE_LIMIT_UNVERIFIED'));
  assert.deepEqual(h.operations.map(call => call.method), ['GET']);
});

test('missing and null native source limits are uncapped without inventing a plan limit', async () => {
  const current = source({ is_connector_syncable: false });
  for (const outer of [{}, { project_connector_scope_limits: { max_connector_scope_limit: null } }]) {
    const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]));
    h.setProject(resource({}, outer));
    assert.equal((await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url })).confirmed, true);
    assert.equal(h.operations.filter(call => call.method === 'POST' && call.path === sourceRoot).length, 1);
  }
});

test('full provider source capacity blocks another source before provider checks or writes', async () => {
  const h = setup(page([source({ original_url: 'https://drive.google.com/file/d/other/view' })]));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 1 } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), code('SOURCE_LIMIT_REACHED'));
  assert.deepEqual(h.operations.map(call => call.method), ['GET']);
});

test('hidden connector sources still count against native source capacity', async () => {
  const h = setup(page([source({ hidden: true, original_url: 'https://drive.google.com/file/d/hidden/view' })]));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 1 } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), code('SOURCE_LIMIT_REACHED'));
  assert.deepEqual(h.operations.map(call => call.method), ['GET']);
});

test('disconnected provider cannot cause a connector source creation write', async () => {
  const h = setup(page([]), { links: [] }, { id: DRIVE, status: 'ENABLED' });
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), code('CONNECTION_UNAVAILABLE'));
  assert.equal(h.operations.filter(call => call.path === sourceRoot && call.method === 'POST').length, 0);
});

test('successful source creation remains discoverable when its separate initial sync fails', async () => {
  const current = source();
  const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]), new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' }));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: false, status: 'unverified', completed: false, errorCode: 'NETWORK_ERROR', delivery: 'unknown' });
  assert.equal(h.operations.filter(call => call.method === 'POST' && call.path === sourceRoot).length, 1);
  assert.equal(h.operations.filter(call => call.path.endsWith(`/${scopeId}/sync`)).length, 1);
});

test('accepted initial sync with failed readback retains the already-created source identity', async () => {
  const current = source();
  const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]), {}, new DotError('HTTP_ERROR', 'edge', { status: 403 }));
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: true, status: 'unverified', completed: false, errorCode: 'MUTATION_UNCONFIRMED', delivery: 'accepted' });
  assert.equal(h.operations.filter(call => call.path.endsWith(`/${scopeId}/sync`)).length, 1);
});

test('creation cannot relabel a previously existing source as newly created', async () => {
  const previous = source({ original_url: 'https://drive.google.com/file/d/previous/view' });
  const h = setup(page([previous]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, source());
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'POST' && call.path === sourceRoot).length, 1);
  assert.equal(h.operations.filter(call => call.path.endsWith('/sync')).length, 0);
});

test('creation cannot relabel a previously hidden source ID as newly created', async () => {
  const previous = source({ hidden: true, original_url: 'https://drive.google.com/file/d/hidden/view' });
  const h = setup(page([previous]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, source());
  h.setProject(resource({}, { project_connector_scope_limits: { max_connector_scope_limit: 10 } }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: source().original_url }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'POST' && call.path === sourceRoot).length, 1);
  assert.equal(h.operations.filter(call => call.path.endsWith('/sync')).length, 0);
});

test('source creation does not replay accepted writes when readback returns an edge failure', async () => {
  const h = setup(page([]), {}, new DotError('HTTP_ERROR', 'edge', { status: 403 }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'website', url: 'https://example.com' }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('source add rechecks native permission immediately before its creation request', async () => {
  const h = setup(() => { h.setProject(resource({ current_user_permission: { can_read: true, can_write: false } })); return page([]); });
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'website', url: 'https://example.com' }), code('PROJECT_PERMISSION_DENIED'));
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 0);
  assert.equal(h.calls.filter(call => call.path === `/backend-api/gizmos/${projectId}`).length, 2);
});

test('unknown creation outcome cannot be converted into success or retried automatically', async () => {
  const h = setup(page([]), new DotError('NETWORK_ERROR', 'unknown', { delivery: 'unknown' }));
  await assert.rejects(h.api.sourceAdd({ ...scoped, connectorType: 'website', url: 'https://example.com' }), code('NETWORK_ERROR'));
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('sync acknowledgement does not reuse completion from before the new request', async () => {
  const h = setup(page(), {}, page());
  const result = await h.api.sourceSync(selected);
  assert.deepEqual(result.synchronization, { accepted: true, status: 'pending', completed: false, detail: null });
  assert.deepEqual(h.operations.filter(call => call.method === 'POST').map(call => call.path), [`${sourceRoot}/${scopeId}/sync`]);
  assert.equal(h.operations.find(call => call.method === 'POST').options.body, undefined);
});

test('sync acknowledgement does not reuse failure from before the new request', async () => {
  const previous = source({ last_sync_status: 'failed', last_sync_detail_message: 'Previous attempt failed.' });
  const h = setup(page([previous]), {}, page([previous]));
  const result = await h.api.sourceSync(selected);
  assert.deepEqual(result.synchronization, { accepted: true, status: 'pending', completed: false, detail: 'Previous attempt failed.' });
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('new synchronization can report an explicit changed failure', async () => {
  const h = setup(page(), {}, page([source({ last_sync_status: 'failed', last_sync_detail_message: 'Current provider failure.' })]));
  const result = await h.api.sourceSync(selected);
  assert.deepEqual(result.synchronization, { accepted: true, status: 'failed', completed: false, detail: 'Current provider failure.' });
});

test('waiting after new sync observes running then a fresh complete state without replaying', async () => {
  const h = setup(page(), {}, page([source({ last_sync_status: 'running' })]), page([source({ last_synced_at: '2026-10-18T10:01:00Z' })]));
  const result = await h.api.sourceSync({ ...selected, wait: true, interval: 100, timeout: 1000 });
  assert.equal(result.synchronization.completed, true); assert.equal(result.synchronization.accepted, true);
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('source wait reports existing completed, partially completed and failed states without a mutation', async () => {
  for (const [status, detail, expected, completed] of [['completed', null, 'completed', true], ['completed', 'Some documents could not be indexed.', 'partial', true], ['failed', 'Provider unavailable.', 'failed', false]]) {
    const current = source({ last_sync_status: status, last_sync_detail_message: detail });
    const h = setup(page([current]), page([current]));
    const result = await h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 });
    assert.deepEqual(result.synchronization, { status: expected, completed, detail });
    assert.ok(h.operations.every(call => call.method === 'GET'));
  }
});

test('website wait rejects after the initial verified source lookup without polling or writes', async () => {
  for (const status of [null, 'running', 'completed']) {
    const website = source({ connector_type: 'website', scope_type: 'website', is_connector_syncable: false, last_sync_status: status });
    const h = setup(page([website]));
    await assert.rejects(h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 }), code('SOURCE_NOT_SYNCABLE'));
    assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', sourceRoot]]);
  }
});

test('connector wait can still observe status when manual synchronization is unavailable', async () => {
  const current = source({ is_connector_syncable: false });
  const h = setup(page([current]), page([current]));
  const result = await h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 });
  assert.equal(result.synchronization.status, 'completed');
  assert.equal(result.synchronization.completed, true);
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', sourceRoot], ['GET', sourceRoot]]);
});

test('source wait cannot silently accept an identity switch between polls', async () => {
  const h = setup(page(), page([source({ canonical_handle: 'another-file' })]));
  await assert.rejects(h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 }), code('INVALID_RESPONSE'));
});

test('bounded wait returns an explicit timeout without starting or repeating sync', async () => {
  const current = source({ last_sync_status: 'running' });
  const h = setup(...Array.from({ length: 20 }, () => page([current])));
  const result = await h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 });
  assert.deepEqual(result.synchronization, { status: 'running', completed: false, detail: null, timedOut: true });
  assert.ok(h.operations.every(call => call.method === 'GET'));
  assert.ok(h.operations.length >= 3 && h.operations.length <= 20);
});

test('non-syncable and already-running sources cannot receive an additional sync request', async () => {
  for (const [current, expected] of [
    [source({ connector_type: 'website', scope_type: 'website' }), 'SOURCE_NOT_SYNCABLE'],
    [source({ is_connector_syncable: false }), 'SOURCE_NOT_SYNCABLE'],
    [source({ last_sync_status: 'running' }), 'SOURCE_SYNC_IN_PROGRESS'],
    [source({ last_sync_status: 'pending' }), 'SOURCE_SYNC_IN_PROGRESS'],
  ]) {
    const h = setup(page([current]));
    await assert.rejects(h.api.sourceSync(selected), code(expected));
    assert.ok(h.operations.every(call => call.method === 'GET'));
  }
});

test('sync readback edge failure preserves accepted delivery and does not restart sync', async () => {
  const h = setup(page(), {}, new DotError('HTTP_ERROR', 'edge', { status: 403 }));
  await assert.rejects(h.api.sourceSync(selected), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted' && error.details.scopeId === scopeId);
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('source synchronization polling is cancellable without replaying the request', async () => {
  const controller = new AbortController();
  const h = setup(page(), {}, () => { controller.abort(); return page([source({ last_sync_status: 'running' })]); });
  await assert.rejects(h.api.sourceSync({ ...selected, wait: true, interval: 100, timeout: 1000, signal: controller.signal }), error => error.code === 'MUTATION_UNCONFIRMED' && error.details.delivery === 'accepted');
  assert.equal(h.operations.filter(call => call.method === 'POST').length, 1);
});

test('source mutations permit shared native writers and require acknowledgement on removal', async () => {
  const shared = resource({ author: { user_id: 'another' }, share_recipient: 'workspace', sharing: { subjects: [{ id: 'member-1' }] }, current_user_permission: { can_read: true, can_write: true, can_delete: false } });
  const denied = setup(); denied.setProject(shared);
  await assert.rejects(denied.api.sourceRemove({ ...selected, confirm: scopeId }), code('SHARED_PROJECT_CONFIRMATION_REQUIRED'));
  assert.equal(denied.operations.length, 0);
  const allowed = setup(page(), {}, page([])); allowed.setProject(shared);
  assert.equal((await allowed.api.sourceRemove({ ...selected, confirm: scopeId, shared: true })).confirmed, true);
});

test('workspace account policy can deny a source change despite project write permission', async () => {
  const h = setup({ permissions: [] });
  h.setMembership({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1', structure: 'workspace' }, can_access_with_session: true } } });
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), code('PROJECT_PERMISSION_DENIED'));
  assert.deepEqual(h.operations.map(call => [call.method, call.path]), [['GET', '/backend-api/accounts/acct/settings']]);
});

test('workspace source reads do not require mutation-policy privilege', async () => {
  const h = setup(page());
  h.setMembership({ accounts: { acct: { account: { account_id: accountId, account_user_id: 'user-1', structure: 'workspace' }, can_access_with_session: true } } });
  assert.equal((await h.api.sourceGet(selected)).source.scopeId, scopeId);
  assert.ok(h.operations.every(call => !call.path.endsWith('/settings')));
});

test('same-source concurrent deletions are rejected without a second DELETE', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = setup(page(), async () => { entered(); return pending; }, page([]));
  const first = h.api.sourceRemove({ ...selected, confirm: scopeId });
  await started;
  await assert.rejects(h.api.sourceRemove({ ...selected, confirm: scopeId }), code('SOURCE_OPERATION_IN_PROGRESS'));
  release({});
  assert.equal((await first).confirmed, true);
  assert.equal(h.operations.filter(call => call.method === 'DELETE').length, 1);
});

test('completed sync with whitespace-only detail remains completed rather than partial', async () => {
  const current = source({ last_sync_detail_message: '   ' });
  const h = setup(page([current]), page([current]));
  const result = await h.api.sourceWait({ ...selected, interval: 100, timeout: 1000 });
  assert.deepEqual(result.synchronization, { status: 'completed', completed: true, detail: '   ' });
});

test('new source already running or pending never receives a duplicate initial-sync request', async () => {
  for (const status of ['running', 'pending']) {
    const current = source({ last_sync_status: status });
    const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]));
    const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url });
    assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
    assert.deepEqual(result.synchronization, { accepted: false, alreadyRunning: true, status, completed: false, detail: null });
    assert.equal(h.operations.filter(call => call.path.endsWith('/sync')).length, 0);
  }
});

test('new source wait observes existing synchronization without starting another', async () => {
  const current = source({ last_sync_status: 'running' }), completed = source({ last_synced_at: '2026-10-18T10:02:00Z' });
  const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]), page([completed]));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url, wait: true, interval: 100, timeout: 1000 });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: false, alreadyRunning: true, status: 'completed', completed: true, detail: null });
  assert.equal(h.operations.filter(call => call.path.endsWith('/sync')).length, 0);
});

test('failed observation of automatic initial sync preserves confirmed source and no-attempt status', async () => {
  const current = source({ last_sync_status: 'running' });
  const h = setup(page([]), { links: [{ id: 'drive-link', connector_id: DRIVE, auth_status: 'ACTIVE' }] }, { id: DRIVE, status: 'ENABLED' }, current, page([current]), new DotError('HTTP_ERROR', 'edge', { status: 403 }));
  const result = await h.api.sourceAdd({ ...scoped, connectorType: 'google_drive', url: current.original_url, wait: true, interval: 100, timeout: 1000 });
  assert.equal(result.confirmed, true); assert.equal(result.source.scopeId, scopeId);
  assert.deepEqual(result.synchronization, { accepted: false, alreadyRunning: true, status: 'unverified', completed: false, errorCode: 'HTTP_ERROR', delivery: 'not_attempted' });
  assert.equal(h.operations.filter(call => call.path.endsWith('/sync')).length, 0);
});
