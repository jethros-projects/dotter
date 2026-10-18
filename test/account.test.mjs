import test from 'node:test';
import assert from 'node:assert/strict';
import { DotAccount, ACCOUNT_SETTING_FEATURES, ACCOUNT_VOICE_LANGUAGES } from '../src/account.mjs';
import { commands, createClient } from '../src/command-sets/account.mjs';
import { DotError } from '../src/errors.mjs';
import { Transport } from '../src/transport.mjs';
import { streamSSE } from '../src/stream-http.mjs';

const accountId = 'account-1';
const scoped = { accountId };
const isCode = code => error => error.code === code;
const s1 = { id: 'section-1', title: 'Preferences', description: 'Likes coffee.' };
const summary = { sections: [s1], generated_at_iso: '2026-10-18T12:00:00Z', source_checksum: 'checksum' };
function setup(...replies) {
  const calls = [], streams = [];
  const transport = {
    authLoader: async () => ({ accessToken: 'private', accountId }),
    request: async (...args) => { calls.push(args); const result = replies.shift(); if (result instanceof Error) throw result; return result; },
  };
  const api = new DotAccount({ transport }, { streamImpl: async (pinned, method, route, options) => {
    await pinned.authLoader({}); streams.push({ method, route, options });
    const events = replies.shift();
    if (events instanceof Error) throw events;
    await options.onReady?.({ connected: true });
    for (const event of events ?? []) await options.onEvent(event);
  } });
  return { api, calls, streams, transport };
}
const done = data => ({ event: 'done', data: JSON.stringify(data) });

test('account API and command manifest expose only real methods', () => {
  assert.throws(() => new DotAccount({}), isCode('INVALID_ARGUMENT'));
  const { api } = setup();
  assert.equal(api.capabilities().scope, 'account');
  assert.equal(createClient({ transport: { request() {} } }) instanceof DotAccount, true);
  for (const spec of Object.values(commands)) assert.equal(typeof api[spec.method], 'function', spec.method);
});

test('every network method requires an explicitly selected account', async () => {
  const { api, calls } = setup();
  for (const method of ['memoryList', 'memoryCapacity', 'personalizationGet', 'personalityTypes', 'personalityTraitTypes', 'notificationGet', 'settingsGet', 'summaryChecksum', 'summaryGet', 'summarySelectionActions', 'summaryStream', 'summaryRegenerate']) {
    await assert.rejects(api[method](), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('saved memory list projects visible entries and reports bounded capacity', async () => {
  const { api, calls } = setup({ memories: [
    { id: 'm1', content: 'Coffee', status: 'warm', token: 'secret', last_updated: { actor: 'user', timestamp: 1, token: 'secret' } },
    { id: 'hidden', content: 'hidden', hidden: true }, { id: 'hidden2', content: 'hidden', metadata: { is_hidden: true } },
    { id: 'malformed' }], memory_num_tokens: 150, memory_max_tokens: 100 });
  assert.deepEqual(await api.memoryList(scoped), { accountId, memories: [{ id: 'm1', content: 'Coffee', status: 'warm', last_updated: { actor: 'user', timestamp: 1 } }], capacity: { usedTokens: 150, maxTokens: 100, usedPercent: 100 } });
  assert.deepEqual(calls[0], ['GET', '/backend-api/memories', { query: { include_memory_entries: true }, expectedAccountId: accountId, signal: undefined }]);
});

test('memory capacity uses no memory entries and handles unknown/zero capacity', async () => {
  const { api, calls } = setup({ memory_num_tokens: 0, memory_max_tokens: 0 }, {});
  assert.equal((await api.memoryCapacity(scoped)).usedPercent, null);
  assert.equal((await api.memoryCapacity(scoped)).usedTokens, null);
  assert.equal(calls[0][2].query.include_memory_entries, false);
});

test('malformed account payloads produce safe response errors', async () => {
  for (const method of ['memoryList', 'memoryCapacity', 'personalizationGet', 'personalityTypes', 'personalityTraitTypes', 'notificationGet', 'settingsGet', 'summaryChecksum', 'summaryGet', 'summarySelectionActions']) {
    const { api } = setup(null);
    await assert.rejects(api[method](scoped), isCode('INVALID_RESPONSE'));
  }
});

test('memory deletions require exact confirmation and reject traversal without a request', async () => {
  const { api, calls } = setup();
  for (const options of [{ memoryId: 'm1' }, { memoryId: '../m1', confirm: '../m1' }, { memoryId: 'm1', confirm: accountId }]) {
    await assert.rejects(api.memoryDelete({ ...scoped, ...options }), isCode('INVALID_ARGUMENT'));
  }
  await assert.rejects(api.memoryClear({ ...scoped, confirm: 'all' }), isCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
});

test('memory writes use exact endpoints/bodies and preserve outcome uncertainty', async () => {
  const { api, calls } = setup({ success: true }, { success: true }, { completed: true }, {});
  assert.equal((await api.memoryDelete({ ...scoped, memoryId: 'm1~part', confirm: 'm1~part' })).status, 'applied');
  assert.equal((await api.memoryWarm({ ...scoped, memoryId: 'm1' })).status, 'applied');
  assert.equal((await api.memoryClear({ ...scoped, confirm: accountId, deleteHistory: true })).status, 'applied');
  assert.equal((await api.memoryWarm({ ...scoped, memoryId: 'm2' })).status, 'unconfirmed');
  assert.equal(calls[0][1], '/backend-api/memories/m1~part');
  assert.deepEqual(calls[1][2].body, { status: 'warm' });
  assert.deepEqual(calls[2][2].body, { delete_history: true });
});

test('memory API rejection is surfaced and never retried', async () => {
  const { api, calls } = setup({ success: false });
  await assert.rejects(api.memoryWarm({ ...scoped, memoryId: 'm1' }), isCode('OPERATION_REJECTED'));
  assert.equal(calls.length, 1);
});

test('personalization and catalogs omit internal fields/deprecated traits', async () => {
  const { api } = setup({ name_user_message: 'Ada', enabled: true, internal_reasoning: 'secret' },
    [{ key: 'default', label: 'Default', secret: 'secret' }],
    { trait_types: [{ key: 'warm', label: 'Warm', levels: [{ key: 'more', option_label: 'More', secret: 'secret' }] }, { key: 'old', deprecated: true }] });
  assert.deepEqual(await api.personalizationGet(scoped), { accountId, name_user_message: 'Ada', enabled: true });
  assert.deepEqual(await api.personalityTypes(scoped), { types: [{ key: 'default', label: 'Default' }] });
  assert.deepEqual(await api.personalityTraitTypes(scoped), { traits: [{ key: 'warm', label: 'Warm', levels: [{ key: 'more', option_label: 'More' }] }] });
});

test('plain instructions patch keeps explicit empty strings and validates before authentication', async () => {
  const { api, calls } = setup({ name_user_message: '', enabled: false });
  for (const update of [{ unexpected: 'x' }, { enabled: 'yes' }, { name_user_message: 'a'.repeat(1501) }, {}]) await assert.rejects(api.personalizationUpdate({ ...scoped, update }), isCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.equal((await api.personalizationUpdate({ ...scoped, update: { name_user_message: '', enabled: false } })).enabled, false);
  assert.deepEqual(calls[0][2].body, { name_user_message: '', enabled: false });
});

test('personality updates validate the fresh catalog and merge traits', async () => {
  const { api, calls } = setup([{ key: 'friendly' }], { trait_types: [{ key: 'warm', levels: [{ key: 'more' }] }] },
    { personality_traits: { concise: 'less' } }, { personality_type_selection: 'friendly', personality_traits: { concise: 'less', warm: 'more' } });
  const result = await api.personalizationUpdate({ ...scoped, update: { personality_type_selection: 'friendly', personality_traits: { warm: 'more' } } });
  assert.equal(result.personality_traits.concise, 'less');
  assert.deepEqual(calls[3][2].body, { personality_type_selection: 'friendly', personality_traits: { concise: 'less', warm: 'more' } });
});

test('unknown personality/trait choices cannot produce a patch', async () => {
  for (const update of [{ personality_type_selection: 'invalid' }, { personality_traits: { warm: 'extreme' } }]) {
    const { api, calls } = setup(update.personality_type_selection ? [] : { trait_types: [{ key: 'warm', levels: [{ key: 'more' }] }] });
    await assert.rejects(api.personalizationUpdate({ ...scoped, update }), isCode('INVALID_ARGUMENT'));
    assert.equal(calls.every(call => call[0] === 'GET'), true);
  }
});

const notifications = { settings: [{ category: 'responses', name: 'Responses', options: [{ channel: 'push', name: 'Push', enabled: true }] }] };
test('notifications validate current categories/channels and return only display data', async () => {
  const { api, calls } = setup(notifications, { ...notifications, secret: 'secret' });
  const updates = { responses: { push: false } };
  await api.notificationUpdate({ ...scoped, updates });
  assert.deepEqual(calls[1][2].body, { updates });
  assert.equal(calls[0][2].expectedAccountId, accountId);
});

test('unknown or disabled notification channels cannot be written', async () => {
  for (const data of [notifications, { settings: [{ category: 'responses', options: [{ channel: 'email', enabled: true, disabled: true }] }] }]) {
    const { api, calls } = setup(data);
    await assert.rejects(api.notificationUpdate({ ...scoped, updates: { responses: { email: true } } }), isCode('INVALID_ARGUMENT'));
    assert.equal(calls.length, 1);
  }
});

test('malformed notification updates fail before a request', async () => {
  const { api, calls } = setup();
  for (const updates of [null, {}, { responses: {} }, { responses: { push: 'true' } }, { '../bad': { push: true } }]) {
    await assert.rejects(api.notificationUpdate({ ...scoped, updates }), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('settings expose only verified features, without arbitrary account flags', async () => {
  const { api } = setup({ settings: { image_gen_enabled: true, birthday: 'private', training_allowed: true, secret: 'secret', response_presentation: { mode: 'rich' } } });
  const result = await api.settingsGet(scoped);
  assert.deepEqual(result.settings, { image_gen_enabled: true, response_presentation: { mode: 'rich' } });
  assert.deepEqual(result.supportedFeatures, [...ACCOUNT_SETTING_FEATURES]);
});

test('voice catalog sends native language/mode query with explicit account and projects only display fields', async () => {
  const { api, calls } = setup({ selected: 'cove', voices: [{ voice: 'cove', name: 'Cove', accent: 'English', description: 'Calm', preview_url: 'https://cdn.openai.com/voice/cove.mp3', internal: 'secret' }], internal: 'secret' });
  assert.deepEqual(await api.voices({ ...scoped, language: 'en' }), {
    accountId, language: 'en', mode: 'advanced', selected: 'cove',
    voices: [{ voice: 'cove', settingValue: 'cove', name: 'Cove', description: 'Calm', accent: 'English', previewUrl: 'https://cdn.openai.com/voice/cove.mp3' }],
  });
  assert.deepEqual(calls, [['GET', '/backend-api/settings/voices', { query: { spoken_language: 'en', voice_mode: 'advanced' }, expectedAccountId: accountId, signal: undefined }]]);
});

test('wingman catalog preserves account selection and provides native account/realtime mappings', async () => {
  const { api } = setup({ selected: 'glimmer', voices: [{ voice: 'fathom' }, { voice: 'sol' }, { voice: 'spruce' }] },
    { selected: 'unavailable', voices: [{ voice: 'arbor' }] });
  const result = await api.voices({ ...scoped, language: 'en', mode: 'wingman' });
  assert.equal(result.selected, 'glimmer'); assert.equal(result.effectiveSelected, 'sol');
  assert.deepEqual(result.voices.map(item => [item.voice, item.settingValue]), [['arbor', 'fathom'], ['sol', 'glimmer'], ['spruce', 'orbit']]);
  assert.equal((await api.voices({ ...scoped, language: 'en', mode: 'wingman' })).effectiveSelected, 'arbor');
});

test('voice names never resolve inherited object properties as aliases', async () => {
  const { api } = setup({ selected: 'constructor', voices: [{ voice: 'constructor' }, { voice: 'toString' }] });
  const result = await api.voices({ ...scoped, language: 'en', mode: 'wingman' });
  assert.equal(result.effectiveSelected, 'constructor');
  assert.deepEqual(result.voices.map(item => item.settingValue), ['constructor', 'toString']);
});

test('voice catalog rejects missing account, auto locale, unsupported modes and unsafe language before a request', async () => {
  const { api, calls } = setup();
  for (const options of [{ language: 'en' }, { ...scoped }, { ...scoped, language: 'auto' }, { ...scoped, language: '../en' }, { ...scoped, language: 'en', mode: 'other' }]) {
    await assert.rejects(api.voices(options), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('voice catalog handles unavailable previews without fetching them and excludes hidden entries', async () => {
  const { api, calls } = setup({ selected: null, voices: [
    { voice: 'a', preview_url: 'http://insecure.example/a.mp3' },
    { voice: 'b', preview_url: 'https://user:password@example.test/secret' },
    { voice: 'c', preview_url: 'file:///tmp/private' },
    { voice: 'hidden', hidden: true },
  ] });
  const result = await api.voices({ ...scoped, language: 'zh-tw', mode: 'standard' });
  assert.equal(result.voices.length, 3); assert.equal(result.voices.some(item => 'previewUrl' in item), false);
  assert.equal(calls.length, 1); assert.equal(calls[0][2].query.voice_mode, 'standard');
});

test('voice catalog rejects malformed, excessive, or duplicate identifiers', async () => {
  for (const value of [{}, { voices: [], selected: {} }, { voices: [{ voice: '../bad' }] }, { voices: [{ voice: 'a' }, { voice: 'a' }] }, { voices: Array.from({ length: 1001 }, (_, i) => ({ voice: `v${i}` })) }]) {
    const { api } = setup(value);
    await assert.rejects(api.voices({ ...scoped, language: 'en' }), isCode('INVALID_RESPONSE'));
  }
});

test('voice language setting accepts native choices including auto and confirms exact server echo', async () => {
  const { api, calls } = setup({ settings: { voice_main_language: 'auto' } }, { voice_main_language: 'zh-hk' });
  assert.equal((await api.settingsSet({ ...scoped, feature: 'voice_main_language', value: 'auto' })).status, 'applied');
  assert.equal((await api.settingsSet({ ...scoped, feature: 'voice_main_language', value: 'zh-hk' })).status, 'applied');
  assert.deepEqual(calls[1][2].query, { feature: 'voice_main_language', value: 'zh-hk' });
  assert.ok(ACCOUNT_VOICE_LANGUAGES.includes('amh'));
  for (const value of ['', 'en-US', 'unknown', null, { language: 'en' }]) await assert.rejects(api.settingsSet({ ...scoped, feature: 'voice_main_language', value }), isCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 2);
});

test('typed settings use fixed query endpoint and verify server echo', async () => {
  const { api, calls } = setup({ voice_enabled: false }, { response_presentation: { mode: 'standard' } }, {});
  assert.equal((await api.settingsSet({ ...scoped, feature: 'voice_enabled', value: false })).status, 'applied');
  assert.equal((await api.settingsSet({ ...scoped, feature: 'response_presentation', value: { mode: 'standard' } })).status, 'applied');
  assert.equal((await api.settingsSet({ ...scoped, feature: 'chat_theme', value: 'green' })).status, 'unconfirmed');
  assert.deepEqual(calls[1][2].query, { feature: 'response_presentation', value: '{"mode":"standard"}' });
});

test('settings reject arbitrary passthrough, unsafe values, invalid pins and themes', async () => {
  const { api, calls } = setup();
  for (const [feature, value] of [['training_allowed', false], ['voice_enabled', 'true'], ['chat_theme', 'other'], ['response_presentation', { mode: 'rich', secret: 1 }], ['sidebar_customization', { pinOverrides: { 'bad': true }, order: [] }], ['accessory_id', '']]) {
    await assert.rejects(api.settingsSet({ ...scoped, feature, value }), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('sidebar customization validates bounded recognized destination IDs', async () => {
  const value = { pinOverrides: { 'builtin:chatgpt': true, 'mcp:test': false }, order: ['builtin:chatgpt', 'mcp:test'] };
  const { api, calls } = setup({ sidebar_customization: value });
  assert.equal((await api.settingsSet({ ...scoped, feature: 'sidebar_customization', value })).status, 'applied');
  assert.equal(calls[0][2].query.value, JSON.stringify(value));
});

test('summary reads use actual POST contract and project no debug/internal content', async () => {
  const { api, calls } = setup({ ...summary, debug_conversation_id: 'secret', hidden_reasoning: 'secret', sections: [{ ...s1, hidden_reasoning: 'secret' }] });
  const result = await api.summaryGet(scoped);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.sections[0].description, 'Likes coffee.');
  assert.equal(calls[0][0], 'POST');
  assert.equal(calls[0][2].body, undefined);
  assert.deepEqual(calls[0][2].query, { source: 'personalization-setting' });
});

test('summary contextual hint forces regeneration with exact field spelling', async () => {
  const { api, calls } = setup(summary);
  const contextualHint = { hints: ['coffee preference'], source: 'dream_citation' };
  await api.summaryGet({ ...scoped, contextualHint, source: 'personalization-setting' });
  assert.deepEqual(calls[0][2].body, { contextual_hint: contextualHint, force_regenerate: true });
});

test('summary checksum normalizes snake case and rejects non-string fields', async () => {
  const { api } = setup({ source_checksum: 'new', cached_source_checksum: 'old', is_stale: true }, { source_checksum: { reasoning: 'secret' } });
  assert.deepEqual(await api.summaryChecksum(scoped), { accountId, sourceChecksum: 'new', cachedSourceChecksum: 'old', cachedGeneratedAtIso: null, isStale: true });
  await assert.rejects(api.summaryChecksum(scoped), isCode('INVALID_RESPONSE'));
});

test('summary changes validate UTF-16 range bounds and prevent unknown sections', async () => {
  for (const section_changes of [[{ section_id: 'other' }], [{ section_id: s1.id, description_ranges: [{ start_utf16: 0, end_utf16: 100 }] }]]) {
    const { api } = setup({ ...summary, section_changes });
    await assert.rejects(api.summaryGet(scoped), isCode('INVALID_RESPONSE'));
  }
});

test('summary stream filters unknown events and returns only visible complete sections', async () => {
  const events = [];
  const { api, streams } = setup([
    { event: 'reasoning', data: '{"secret":"hidden"}' },
    { event: 'started', data: JSON.stringify({ ...summary, sections: undefined }) },
    { event: 'section', data: JSON.stringify({ section: { ...s1, secret: 'hidden' } }) }, done(summary),
    { event: 'section', data: '{"section":{"secret":"after completion"}}' },
  ]);
  const result = await api.summaryStream({ ...scoped, onEvent: event => events.push(event) });
  assert.deepEqual(events.map(event => event.event), ['started', 'section', 'done']);
  assert.equal(JSON.stringify(events).includes('hidden'), false);
  assert.equal(result.sections.length, 1);
  assert.equal(streams[0].route, '/backend-api/memories/about_you/summary/stream');
});

test('native section catalog events may omit their empty sections array', async () => {
  const events = [], { api } = setup([{ event: 'section_types', data: '{}' }, done(summary)]);
  await api.summaryStream({ ...scoped, onEvent: event => events.push(event) });
  assert.deepEqual(events[0], { event: 'section_types', data: { sections: [] } });
});

test('regenerate uses its own route and propagates onReady/signal', async () => {
  let ready = false;
  const signal = new AbortController().signal;
  const { api, streams } = setup([done(summary)]);
  await api.summaryRegenerate({ ...scoped, signal, onReady: () => { ready = true; } });
  assert.equal(ready, true);
  assert.equal(streams[0].route, '/backend-api/memories/about_you/summary/regenerate');
  assert.equal(streams[0].options.signal, signal);
});

test('summary streams reject missing completion/error/malformed events without retry', async () => {
  for (const events of [[], [{ event: 'error', data: '{"error":"private"}' }], [{ event: 'section', data: 'broken' }], [done({ sections: [] })]]) {
    const { api, streams } = setup(events);
    await assert.rejects(api.summaryStream(scoped), error => ['INVALID_RESPONSE', 'SUMMARY_STREAM_FAILED'].includes(error.code));
    assert.equal(streams.length, 1);
  }
});

test('stream auth is pinned to explicitly selected account', async () => {
  const { api, streams, transport } = setup([done(summary)]);
  transport.authLoader = async () => ({ accountId: 'other', accessToken: 'private' });
  await assert.rejects(api.summaryStream(scoped), isCode('ACCOUNT_CHANGED'));
  assert.equal(streams.length, 0);
});

test('summary stream rejects a changed user inside the same selected account before transport starts', async () => {
  const token = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
  const transport = new Transport({ authLoader: async () => ({ accountId, accessToken: token('other-user') }) });
  transport.assertIdentity({ accountId, accessToken: token('original-user') });
  let started = 0;
  const api = new DotAccount({ transport }, { streamImpl: (pinned, method, route, options) => streamSSE(pinned, method, route, {
    ...options, streamImpl: async function* () { started++; throw new Error('The network must not start.'); },
  }) });
  await assert.rejects(api.summaryStream(scoped), isCode('AUTH_IDENTITY_CHANGED'));
  assert.equal(started, 0);
});

test('summary correction preflights current sections and serializes the actual camelCase body', async () => {
  const { api, calls, streams } = setup(summary, [done({ ok: true, updated_sections: [{ ...s1, description: 'Likes tea.' }] })]);
  const result = await api.summaryCorrect({ ...scoped, correction: 'I prefer tea.', targetSectionId: s1.id, targetText: 'coffee' });
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], 'POST');
  assert.equal(streams[0].route, '/backend-api/memories/about_you/correction');
  assert.deepEqual(streams[0].options.body, { conversationId: null, correction: 'I prefer tea.', currentSections: [s1], targetAction: 'correct', targetSection: s1, targetSectionId: s1.id, targetText: 'coffee' });
});

for (const camelCase of [true, false]) test(`correction targets preserve a new section without requiring existing targets (${camelCase ? 'camel' : 'snake'} case)`, async () => {
  const events = [], target = { id: 'new-section', title: 'Test section', hidden_reasoning: 'private' };
  const payload = camelCase ? { createNewSection: true, newSection: target } : { create_new_section: true, new_section: target };
  const { api, streams } = setup(summary, [{ event: 'correction_targets', data: JSON.stringify(payload) }, done({ ok: true })]);
  await api.summaryCorrect({ ...scoped, correction: 'A disposable test correction.', onEvent: event => events.push(event) });
  assert.deepEqual(events[0], { event: 'correction_targets', data: { sections: [], createNewSection: true, newSection: { id: target.id, title: target.title } } });
  assert.equal(streams.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /hidden_reasoning|private/);
});

test('correction rejects stale sections or selections before a correction stream', async () => {
  for (const extra of [{ targetSectionId: 'missing' }, { targetSectionId: s1.id, targetText: 'not in the text' }]) {
    const { api, streams } = setup(summary);
    await assert.rejects(api.summaryCorrect({ ...scoped, correction: 'Change it', ...extra }), isCode('INVALID_ARGUMENT'));
    assert.equal(streams.length, 0);
  }
});

test('forget requires exact scope confirmation before reading or streaming', async () => {
  const { api, calls, streams } = setup();
  for (const extra of [{}, { targetSectionId: s1.id, confirm: accountId }]) {
    await assert.rejects(api.summaryForget({ ...scoped, correction: 'Forget coffee', ...extra }), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
  assert.equal(streams.length, 0);
});

test('forget handles section deletion events and does not leak unknown output', async () => {
  const events = [];
  const { api, streams } = setup(summary, [{ event: 'section_deleted', data: JSON.stringify({ section_id: s1.id, secret: 'hidden' }) }, done({ ok: true, deleted_section_ids: [s1.id], hidden_reasoning: 'hidden' })]);
  const result = await api.summaryForget({ ...scoped, correction: 'Forget this', targetSectionId: s1.id, confirm: s1.id, onEvent: event => events.push(event) });
  assert.deepEqual(result.deletedSectionIds, [s1.id]);
  assert.equal(streams[0].options.body.targetAction, 'forget');
  assert.equal(JSON.stringify(events).includes('hidden'), false);
});

test('correction preserves the visible assistant answer if omitted by done event', async () => {
  const { api } = setup(summary, [{ event: 'assistant_response', data: JSON.stringify({ response: 'Updated.', did_update_summary: true }) }, done({ ok: true })]);
  assert.equal((await api.summaryCorrect({ ...scoped, correction: 'Change it' })).assistantResponse, 'Updated.');
});

test('summary clear disables both memory toggles before clearing cache', async () => {
  const { api, calls } = setup({ m3m: false }, { memory_in_search: false }, { success: true });
  assert.equal((await api.summaryClear({ ...scoped, confirm: accountId })).status, 'applied');
  assert.deepEqual(calls.map(call => call[1]), ['/backend-api/settings/account_user_setting', '/backend-api/settings/account_user_setting', '/backend-api/memories/about_you/summary/cache/delete']);
  assert.deepEqual(calls[2][2].body, { disableMemory: true });
});

test('summary clear stops before deletion if a setting is unconfirmed', async () => {
  const { api, calls } = setup({});
  await assert.rejects(api.summaryClear({ ...scoped, confirm: accountId }), isCode('SETTING_UNCONFIRMED'));
  assert.equal(calls.length, 1);
});

test('network write failure is propagated once, with no fallback or replay', async () => {
  const failure = new DotError('NETWORK_ERROR', 'failure', { delivery: 'unknown' });
  const { api, calls } = setup(failure);
  await assert.rejects(api.summaryGet(scoped), error => error === failure);
  assert.equal(calls.length, 1);
});


test('sidebar setting accepts equivalent echoed objects with reordered keys', async () => {
  const value = { pinOverrides: { 'builtin:chatgpt': true, 'mcp:test': false }, order: ['builtin:chatgpt', 'mcp:test'] };
  const echo = { order: [...value.order], pinOverrides: { 'mcp:test': false, 'builtin:chatgpt': true } };
  const { api, calls } = setup({ settings: { sidebar_customization: echo } });
  assert.equal((await api.settingsSet({ ...scoped, feature: 'sidebar_customization', value })).status, 'applied');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2].query, { feature: 'sidebar_customization', value: JSON.stringify(value) });
});

test('sidebar setting keeps a changed nested echo unconfirmed without retry', async () => {
  const value = { pinOverrides: { 'builtin:chatgpt': true, 'mcp:test': false }, order: ['builtin:chatgpt', 'mcp:test'] };
  const { api, calls } = setup({ sidebar_customization: { order: [...value.order], pinOverrides: { 'mcp:test': true, 'builtin:chatgpt': true } } });
  assert.equal((await api.settingsSet({ ...scoped, feature: 'sidebar_customization', value })).status, 'unconfirmed');
  assert.equal(calls.length, 1);
});

test('sidebar setting retains array order in echoed value comparison', async () => {
  const value = { pinOverrides: { 'builtin:chatgpt': true, 'mcp:test': false }, order: ['builtin:chatgpt', 'mcp:test'] };
  const { api, calls } = setup({ sidebar_customization: { pinOverrides: { ...value.pinOverrides }, order: [...value.order].reverse() } });
  assert.equal((await api.settingsSet({ ...scoped, feature: 'sidebar_customization', value })).status, 'unconfirmed');
  assert.equal(calls.length, 1);
});


const emptySummarySection = { id: 'empty-section', title: 'Empty section', description: '   ' };
const visibleSummaryChange = { sectionId: s1.id, descriptionRanges: [{ startUtf16: 0, endUtf16: 5 }] };
const omittedSummaryChange = { sectionId: emptySummarySection.id, descriptionRanges: [{ startUtf16: 0, endUtf16: 999 }] };
for (const snakeCase of [false, true]) {
  test(`summary omits empty-section changes with ${snakeCase ? 'snake' : 'camel'} case fields`, async () => {
    const change = item => snakeCase ? { section_id: item.sectionId, description_ranges: item.descriptionRanges.map(range => ({ start_utf16: range.startUtf16, end_utf16: range.endUtf16 })) } : item;
    const raw = { ...summary, sections: [s1, emptySummarySection], [snakeCase ? 'section_changes' : 'sectionChanges']: [change(visibleSummaryChange), change(omittedSummaryChange)] };
    const { api, calls } = setup(raw);
    const result = await api.summaryGet(scoped);
    assert.deepEqual(result.sections, [s1]);
    assert.deepEqual(result.sectionChanges, [{ sectionId: s1.id, titleRanges: [], descriptionRanges: [{ startUtf16: 0, endUtf16: 5 }] }]);
    assert.equal(calls.length, 1);
  });
  test(`correction omits empty-section changes with ${snakeCase ? 'snake' : 'camel'} case fields`, async () => {
    const field = snakeCase ? 'updated_sections' : 'updatedSections';
    const changes = snakeCase ? { section_changes: [{ section_id: emptySummarySection.id }] } : { sectionChanges: [omittedSummaryChange] };
    const { api, streams } = setup(summary, [done({ ok: true, [field]: [s1, emptySummarySection], ...changes })]);
    const result = await api.summaryCorrect({ ...scoped, correction: 'A synthetic correction.' });
    assert.deepEqual(result.updatedSections, [s1]);
    assert.deepEqual(result.sectionChanges, []);
    assert.equal(streams.length, 1);
  });
}

test('summary stream completion omits empty sections and their changes', async () => {
  const seen = [], { api, streams } = setup([done({ ...summary, sections: [s1, emptySummarySection], sectionChanges: [omittedSummaryChange] })]);
  const result = await api.summaryStream({ ...scoped, onEvent: event => seen.push(event) });
  assert.deepEqual(result.sections, [s1]); assert.deepEqual(result.sectionChanges, []);
  const { accountId: _accountId, ...payload } = result; assert.deepEqual(seen[0].data, payload);
  assert.equal(streams.length, 1);
});

for (const correction of [false, true]) test(`${correction ? 'correction' : 'summary'} still rejects changes for an unknown section`, async () => {
  const payload = correction ? { ok: true, updatedSections: [s1, emptySummarySection], sectionChanges: [{ sectionId: 'unknown-section' }] } : { ...summary, sections: [s1, emptySummarySection], sectionChanges: [{ sectionId: 'unknown-section' }] };
  const { api } = setup(...(correction ? [summary, [done(payload)]] : [payload]));
  await assert.rejects(correction ? api.summaryCorrect({ ...scoped, correction: 'A synthetic correction.' }) : api.summaryGet(scoped), isCode('INVALID_RESPONSE'));
});

test('hidden empty sections do not exempt their changes from validation', async () => {
  const { api } = setup({ ...summary, sections: [s1, { ...emptySummarySection, hidden: true }], sectionChanges: [omittedSummaryChange] });
  await assert.rejects(api.summaryGet(scoped), isCode('INVALID_RESPONSE'));
});

test('a section with follow-up content retains its valid change record', async () => {
  const section = { ...emptySummarySection, followUps: [{ action: 'auto_send', preview: 'Example', prompt: 'Synthetic prompt' }] };
  const { api } = setup({ ...summary, sections: [section], sectionChanges: [{ sectionId: section.id, titleRanges: [{ startUtf16: 0, endUtf16: 5 }] }] });
  const result = await api.summaryGet(scoped);
  assert.equal(result.sections.length, 1); assert.equal(result.sectionChanges.length, 1);
});


test('an empty duplicate cannot discard a retained section change', async () => {
  const { api } = setup({ ...summary, sections: [s1, { ...emptySummarySection, id: s1.id }], sectionChanges: [visibleSummaryChange] });
  const result = await api.summaryGet(scoped);
  assert.deepEqual(result.sections, [s1]);
  assert.deepEqual(result.sectionChanges, [{ sectionId: s1.id, titleRanges: [], descriptionRanges: [{ startUtf16: 0, endUtf16: 5 }] }]);
});

test('duplicate retained section identities still reject before projecting changes', async () => {
  const { api } = setup({ ...summary, sections: [s1, { ...s1, description: 'Other retained text.' }], sectionChanges: [visibleSummaryChange] });
  await assert.rejects(api.summaryGet(scoped), isCode('INVALID_RESPONSE'));
});
