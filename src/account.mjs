import { isDeepStrictEqual } from 'node:util';
import { DotError } from './errors.mjs';
import { streamSSE, internalStreamCallback, streamConsumerCallback } from './stream-http.mjs';

// Contracts observed in ChatGPT.app's app-initial, app-primary,
// personalization-settings, saved-memories, notifications-settings and
// about-you-summary assets (2026-10-18). This is account data, not Dot data.
const ROOT = '/backend-api';
const BOOL_SETTINGS = Object.freeze([
  'image_gen_enabled', 'instant_answers_enabled', 'task_suggestions_enabled',
  'm3m', 'm3m_opted_out', 'memory_in_search', 'moonshine', 'sunshine',
  'hive_referenced_in_internal_knowledge', 'voice_enabled',
  'file_library_auto_reference', 'connector_search_enabled',
  'tpp_work_mode_quick_send_by_default', 'enable_flora_network_access',
]);
export const ACCOUNT_SETTING_FEATURES = Object.freeze([...BOOL_SETTINGS,
  'chat_theme', 'response_presentation', 'voice_name', 'voice_main_language', 'accessory_id', 'sidebar_customization']);
// Native R4u/F4u voice-language choices, including the persisted auto-detect value.
export const ACCOUNT_VOICE_LANGUAGES = Object.freeze('auto.en.es.pt.fr.de.ja.id.ru.it.tr.ar.hi.ko.nl.pl.vi.uk.sv.da.nb.no.th.ro.ms.bn.mr.ta.te.gu.ur.ml.kn.sw.zh.af.hy.az.be.bs.bg.ca.hr.cs.et.fi.gl.ka.el.he.hu.is.kk.lv.lt.mk.mi.ne.fa.sr.sk.sl.tl.cy.amh.mya.yue.fil.gle.mon.som.zh-cn.zh-tw.zh-hk'.split('.'));
const VOICE_MODES = Object.freeze(['standard', 'advanced', 'wingman']);
const ACCOUNT_TO_REALTIME_VOICE = Object.freeze({ fathom: 'arbor', glimmer: 'sol', orbit: 'spruce' });
const REALTIME_TO_ACCOUNT_VOICE = Object.freeze(Object.fromEntries(Object.entries(ACCOUNT_TO_REALTIME_VOICE).map(([account, realtime]) => [realtime, account])));
const TEXT_FIELDS = ['name_user_message', 'role_user_message', 'traits_model_message', 'other_user_message'];
const PERSONAL_FIELDS = [...TEXT_FIELDS, 'enabled', 'personality_type_selection', 'personality_traits'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,1023}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw new DotError(code, message); }
function argument(message) { fail('INVALID_ARGUMENT', message); }
function response(message) { fail('INVALID_RESPONSE', message); }
function id(value, label = 'ID') {
  if (typeof value !== 'string' || !ID.test(value)) argument(`${label} must be a nonempty ID returned by the API.`);
  return value;
}
function text(value, label, max = 16000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) argument(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
}
function fields(value, allowed, label) {
  if (!record(value) || Object.keys(value).length === 0 || Object.keys(value).some(key => !allowed.includes(key))) argument(`${label} contains unknown fields or is empty.`);
}
function scalars(value, keys) {
  if (!record(value)) return {};
  return Object.fromEntries(keys.filter(key => own(value, key) && (value[key] === null || ['string', 'boolean', 'number'].includes(typeof value[key]))).map(key => [key, value[key]]));
}
function visible(value) {
  return record(value) && value.hidden !== true && value.is_hidden !== true && value.is_visually_hidden_from_conversation !== true && !value.deleted_at
    && value.metadata?.hidden !== true && value.metadata?.is_hidden !== true && value.metadata?.is_visually_hidden_from_conversation !== true;
}
function confirm(value, expected) { if (value !== expected) argument(`Confirm this destructive operation with the exact target ID: ${expected}.`); }
function receipt(value, label) {
  if (!record(value)) response(`${label} returned an invalid response.`);
  if (value.success === false || value.ok === false) fail('OPERATION_REJECTED', `${label} was not applied.`);
  return { status: value.success === true || value.ok === true || value.completed === true ? 'applied' : 'unconfirmed' };
}
function capacity(value) {
  const used = value?.memory_num_tokens, max = value?.memory_max_tokens;
  return { usedTokens: Number.isFinite(used) && used >= 0 ? used : null,
    maxTokens: Number.isFinite(max) && max >= 0 ? max : null,
    usedPercent: Number.isFinite(used) && used >= 0 && Number.isFinite(max) && max > 0 ? Math.min(100, Math.floor(100 * used / max)) : null };
}
function memory(value) {
  if (!visible(value) || typeof value.id !== 'string' || typeof value.content !== 'string') return null;
  const out = scalars(value, ['id', 'content', 'status', 'created_timestamp', 'updated_at']);
  if (record(value.last_updated)) out.last_updated = scalars(value.last_updated, ['actor', 'timestamp']);
  if (Array.isArray(value.labels)) out.labels = value.labels.filter(item => typeof item === 'string');
  return out;
}
function personalization(value) {
  if (!record(value)) response('Personalization response must be an object.');
  const out = scalars(value, [...TEXT_FIELDS, 'enabled', 'personality_type_selection']);
  if (record(value.personality_traits)) out.personality_traits = Object.fromEntries(Object.entries(value.personality_traits).filter(([key, level]) => ID.test(key) && typeof level === 'string'));
  return out;
}
function voiceLanguage(value, allowAuto = true) {
  if (!ACCOUNT_VOICE_LANGUAGES.includes(value) || !allowAuto && value === 'auto') argument(allowAuto
    ? 'Choose a supported voice language code or auto from account capabilities.'
    : 'Voice catalogs require an explicit supported language code; auto is a saved setting that the native UI resolves to its own locale.');
  return value;
}
function voiceCatalog(value, mode) {
  if (!record(value) || !Array.isArray(value.voices) || value.voices.length > 1000
    || value.selected != null && (typeof value.selected !== 'string' || !/^[A-Za-z0-9_.~-]{1,128}$/.test(value.selected))) response('Voice catalog must contain bounded voices and a valid selected voice.');
  const voices = value.voices.filter(visible).map(item => {
    if (typeof item.voice !== 'string' || !/^[A-Za-z0-9_.~-]{1,128}$/.test(item.voice)) response('Voice catalog contains an invalid voice ID.');
    const voice = mode === 'wingman' && own(ACCOUNT_TO_REALTIME_VOICE, item.voice) ? ACCOUNT_TO_REALTIME_VOICE[item.voice] : item.voice;
    const out = { voice, settingValue: mode === 'wingman' && own(REALTIME_TO_ACCOUNT_VOICE, voice) ? REALTIME_TO_ACCOUNT_VOICE[voice] : voice,
      name: typeof item.name === 'string' && item.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(item.name) ? item.name : item.voice,
      description: typeof item.description === 'string' && item.description.length <= 4096 && !item.description.includes('\0') ? item.description : '' };
    if (typeof item.accent === 'string' && item.accent.length <= 256 && !/[\x00-\x1f\x7f]/.test(item.accent)) out.accent = item.accent;
    if (typeof item.preview_url === 'string' && item.preview_url.length <= 8192) {
      try { const url = new URL(item.preview_url); if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) out.previewUrl = url.href; } catch { /* Only safe preview pointers are returned; no media is fetched. */ }
    }
    return out;
  });
  if (new Set(voices.map(item => item.voice)).size !== voices.length) response('Voice catalog contains duplicate voice IDs.');
  const selected = value.selected ?? null;
  const realtimeSelected = own(ACCOUNT_TO_REALTIME_VOICE, selected) ? ACCOUNT_TO_REALTIME_VOICE[selected] : selected;
  return { selected, voices, ...(mode === 'wingman' ? { effectiveSelected: voices.find(item => item.voice === realtimeSelected)?.voice ?? voices[0]?.voice ?? null } : {}) };
}
function notificationSettings(value) {
  if (!record(value) || !Array.isArray(value.settings)) response('Notification settings response must contain settings.');
  return { settings: value.settings.filter(visible).filter(item => typeof item.category === 'string' && Array.isArray(item.options)).map(item => ({
    ...scalars(item, ['category', 'name', 'description', 'disabled']),
    options: item.options.filter(visible).filter(option => typeof option.channel === 'string' && typeof option.enabled === 'boolean')
      .map(option => scalars(option, ['channel', 'name', 'enabled', 'disabled', 'available'])),
  })) };
}
function section(value) {
  if (!visible(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || (value.description !== undefined && typeof value.description !== 'string')) response('Memory summary contains an invalid section.');
  const out = { id: value.id, title: value.title, description: value.description ?? '' };
  const followUps = value.followUps ?? value.follow_ups;
  if (Array.isArray(followUps)) out.followUps = followUps.filter(visible)
    .filter(item => ['auto_send', 'targeted_reply', 'fill_composer'].includes(item.action) && typeof item.preview === 'string' && typeof item.prompt === 'string')
    .map(item => scalars(item, ['action', 'preview', 'prompt']));
  return out;
}
function sections(value) {
  if (!Array.isArray(value)) response('Memory summary response must contain sections.');
  const parsed = value.filter(visible).map(section);
  const hasContent = item => item.description.trim() || item.followUps?.length;
  const items = parsed.filter(hasContent);
  const retainedIds = new Set(items.map(item => item.id));
  if (retainedIds.size !== items.length) response('Memory summary contains duplicate sections.');
  return { items, omittedIds: new Set(parsed.filter(item => !hasContent(item) && !retainedIds.has(item.id)).map(item => item.id)) };
}
function checksum(value) {
  if (!record(value)) response('Invalid summary checksum.');
  const nullableString = item => { if (item != null && typeof item !== 'string') response('Invalid summary checksum.'); return item ?? null; };
  return { sourceChecksum: nullableString(value.sourceChecksum ?? value.source_checksum),
    cachedSourceChecksum: nullableString(value.cachedSourceChecksum ?? value.cached_source_checksum),
    cachedGeneratedAtIso: nullableString(value.cachedGeneratedAtIso ?? value.cached_generated_at_iso),
    isStale: value.isStale === true || value.is_stale === true };
}
function changes(value, items, omittedIds = new Set()) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) response('Memory summary contains invalid changes.');
  const seen = new Set();
  // Native Pt/Ft removes change records for sections omitted as empty.
  // Unknown and hidden section targets still reach the strict validator below.
  return value.filter(change => !omittedIds.has(change?.sectionId ?? change?.section_id)).map(change => {
    if (!record(change)) response('Memory summary contains invalid changes.');
    const sectionId = change.sectionId ?? change.section_id;
    const item = items.find(item => item.id === sectionId);
    if (!item || seen.has(sectionId)) response('Memory summary changes target a missing or duplicate section.');
    seen.add(sectionId);
    const ranges = (raw, text) => {
      if (!Array.isArray(raw)) response('Memory summary contains invalid text ranges.');
      let end = 0;
      return raw.map(range => {
        const startUtf16 = range?.startUtf16 ?? range?.start_utf16, endUtf16 = range?.endUtf16 ?? range?.end_utf16;
        if (!Number.isInteger(startUtf16) || !Number.isInteger(endUtf16) || startUtf16 < end || endUtf16 <= startUtf16 || endUtf16 > text.length) response('Memory summary contains invalid text ranges.');
        end = endUtf16;
        return { startUtf16, endUtf16 };
      });
    };
    return { sectionId, titleRanges: ranges(change.titleRanges ?? change.title_ranges ?? [], item.title),
      descriptionRanges: ranges(change.descriptionRanges ?? change.description_ranges ?? [], item.description) };
  });
}
function summary(value, requireDate = false) {
  if (!record(value)) response('Invalid memory summary.');
  const { items, omittedIds } = sections(value.sections);
  const generatedAtIso = value.generatedAtIso ?? value.generated_at_iso ?? '';
  if (typeof generatedAtIso !== 'string' || (requireDate && !generatedAtIso)) response('Memory summary is missing its completion timestamp.');
  const sourceChecksum = value.sourceChecksum ?? value.source_checksum ?? null;
  if (sourceChecksum !== null && typeof sourceChecksum !== 'string') response('Invalid memory summary checksum.');
  return { sections: items, generatedAtIso, sourceChecksum,
    emptyStateMessage: typeof (value.emptyStateMessage ?? value.empty_state_message) === 'string' ? (value.emptyStateMessage ?? value.empty_state_message) : '',
    sectionChanges: changes(value.sectionChanges ?? value.section_changes, items, omittedIds) };
}
function correctionResult(value, assistantResponse) {
  if (!record(value) || value.ok !== true) response('The memory correction did not complete successfully.');
  const { items, omittedIds } = sections(value.updatedSections ?? value.updated_sections ?? (value.updatedSection ?? value.updated_section ? [value.updatedSection ?? value.updated_section] : []));
  const deleted = value.deletedSectionIds ?? value.deleted_section_ids ?? [];
  if (!Array.isArray(deleted) || deleted.some(item => typeof item !== 'string')) response('The memory correction returned invalid deleted sections.');
  const output = { ok: true, updatedSections: items, deletedSectionIds: deleted,
    sectionChanges: changes(value.sectionChanges ?? value.section_changes, items, omittedIds),
    assistantResponse: value.assistantResponse ?? value.assistant_response ?? assistantResponse ?? null,
    conversationId: value.conversationId ?? value.conversation_id ?? null };
  if (output.assistantResponse !== null && typeof output.assistantResponse !== 'string') response('Invalid memory correction response.');
  if (output.conversationId !== null && typeof output.conversationId !== 'string') response('Invalid memory correction conversation.');
  const rawChecksum = value.summaryChecksum ?? value.summary_checksum;
  if (rawChecksum) output.summaryChecksum = checksum(rawChecksum);
  return output;
}

export class DotAccount {
  constructor(client, { streamImpl = streamSSE } = {}) {
    if (!client?.transport?.request) argument('DotAccount requires a client transport.');
    this.client = client; this.transport = client.transport; this.stream = streamImpl;
  }
  capabilities() { return { scope: 'account', accountIdRequired: true, settings: [...ACCOUNT_SETTING_FEATURES],
    savedMemories: true, personalization: true, notifications: true, summary: true, summaryStreaming: true,
    voiceCatalog: { modes: [...VOICE_MODES], languages: ACCOUNT_VOICE_LANGUAGES.filter(language => language !== 'auto'), settingLanguages: [...ACCOUNT_VOICE_LANGUAGES] }, automaticRetries: false }; }
  _options(options = {}) {
    return { expectedAccountId: id(options.accountId, 'accountId'), signal: options.signal };
  }
  async _request(method, path, options, extra = {}) {
    const value = await this.transport.request(method, ROOT + path, { ...extra, ...this._options(options) });
    if (value === null || typeof value !== 'object') response('The account API returned an invalid response.');
    return value;
  }
  async memoryList(options = {}) {
    const value = await this._request('GET', '/memories', options, { query: { include_memory_entries: true } });
    if (!Array.isArray(value.memories)) response('Saved memories response must contain memories.');
    return { accountId: options.accountId, memories: value.memories.map(memory).filter(Boolean), capacity: capacity(value) };
  }
  async memoryCapacity(options = {}) {
    const value = await this._request('GET', '/memories', options, { query: { include_memory_entries: false } });
    return { accountId: options.accountId, ...capacity(value) };
  }
  async memoryDelete(options = {}) {
    const memoryId = id(options.memoryId, 'memoryId'); confirm(options.confirm, memoryId);
    const value = await this._request('DELETE', `/memories/${encodeURIComponent(memoryId)}`, options);
    return { accountId: options.accountId, memoryId, ...receipt(value, 'Memory deletion') };
  }
  async memoryWarm(options = {}) {
    const memoryId = id(options.memoryId, 'memoryId');
    const value = await this._request('PATCH', `/memories/${encodeURIComponent(memoryId)}/status`, options, { body: { status: 'warm' } });
    return { accountId: options.accountId, memoryId, ...receipt(value, 'Memory prioritization') };
  }
  async memoryClear(options = {}) {
    this._options(options); confirm(options.confirm, options.accountId);
    if (options.deleteHistory !== undefined && typeof options.deleteHistory !== 'boolean') argument('deleteHistory must be boolean.');
    const value = await this._request('DELETE', '/settings/clear_account_user_memory', options,
      { body: options.deleteHistory === undefined ? {} : { delete_history: options.deleteHistory } });
    return { accountId: options.accountId, ...receipt(value, 'Memory clearing') };
  }
  async personalizationGet(options = {}) {
    return { accountId: options.accountId, ...personalization(await this._request('GET', '/user_system_messages', options)) };
  }
  async personalityTypes(options = {}) {
    const value = await this._request('GET', '/personality_types', options);
    if (!Array.isArray(value)) response('Personality catalog must be an array.');
    return { types: value.filter(visible).filter(item => typeof item.key === 'string').map(item => scalars(item, ['key', 'label', 'description'])) };
  }
  async personalityTraitTypes(options = {}) {
    const value = await this._request('GET', '/personality_trait_types', options);
    if (!Array.isArray(value.trait_types)) response('Personality trait catalog must contain trait_types.');
    return { traits: value.trait_types.filter(visible).filter(item => item.deprecated !== true && typeof item.key === 'string').map(item => ({
      ...scalars(item, ['key', 'label', 'description']),
      levels: Array.isArray(item.levels) ? item.levels.filter(visible).filter(level => typeof level.key === 'string').map(level => scalars(level, ['key', 'option_label', 'description'])) : [],
    })) };
  }
  async personalizationUpdate(options = {}) {
    const update = options.update; fields(update, PERSONAL_FIELDS, 'Personalization update'); this._options(options);
    const body = {};
    for (const key of TEXT_FIELDS) if (own(update, key)) body[key] = text(update[key], key, key === 'traits_model_message' ? 12000 : 1500, true);
    if (own(update, 'enabled')) { if (typeof update.enabled !== 'boolean') argument('enabled must be boolean.'); body.enabled = update.enabled; }
    if (own(update, 'personality_type_selection')) {
      const key = id(update.personality_type_selection, 'personality_type_selection');
      const { types } = await this.personalityTypes(options);
      if (!types.some(item => item.key === key)) argument('Choose a personality from the current catalog.');
      body.personality_type_selection = key;
    }
    if (own(update, 'personality_traits')) {
      if (!record(update.personality_traits) || Object.keys(update.personality_traits).length > 100) argument('personality_traits must be an object of trait levels.');
      const { traits } = await this.personalityTraitTypes(options);
      const patch = {};
      for (const [key, level] of Object.entries(update.personality_traits)) {
        const trait = traits.find(item => item.key === key);
        if (!trait || !trait.levels.some(item => item.key === level)) argument('Choose trait names and levels from the current catalog.');
        patch[key] = level;
      }
      const current = await this.personalizationGet(options);
      // The app submits the whole trait map; merge a partial CLI update first.
      body.personality_traits = { ...current.personality_traits, ...patch };
    }
    return { accountId: options.accountId, ...personalization(await this._request('PATCH', '/user_system_messages', options, { body })) };
  }
  async notificationGet(options = {}) {
    return { accountId: options.accountId, ...notificationSettings(await this._request('GET', '/notifications/settings', options)) };
  }
  async voices(options = {}) {
    const language = voiceLanguage(options.language, false), mode = options.mode ?? 'advanced';
    if (!VOICE_MODES.includes(mode)) argument('Voice mode must be standard, advanced, or wingman.');
    const value = await this._request('GET', '/settings/voices', options, { query: { spoken_language: language, voice_mode: mode } });
    return { accountId: options.accountId, language, mode, ...voiceCatalog(value, mode) };
  }
  async notificationUpdate(options = {}) {
    fields(options.updates, Object.keys(options.updates ?? {}), 'Notification updates'); this._options(options);
    for (const [category, channels] of Object.entries(options.updates)) {
      id(category, 'notification category'); fields(channels, Object.keys(channels ?? {}), 'Notification channels');
      for (const [channel, enabled] of Object.entries(channels)) { id(channel, 'notification channel'); if (typeof enabled !== 'boolean') argument('Notification values must be boolean.'); }
    }
    const current = await this.notificationGet(options);
    for (const [category, channels] of Object.entries(options.updates)) for (const channel of Object.keys(channels)) {
      const setting = current.settings.find(item => item.category === category);
      const option = setting?.options.find(item => item.channel === channel);
      if (!setting || !option || setting.disabled === true || option.disabled === true || option.available === false) argument('The notification category/channel is not currently available.');
    }
    return { accountId: options.accountId, ...notificationSettings(await this._request('PATCH', '/notifications/settings', options, { body: { updates: options.updates } })) };
  }
  async settingsGet(options = {}) {
    const value = await this._request('GET', '/settings/user', options);
    if (!record(value.settings)) response('Account settings response must contain settings.');
    const result = scalars(value.settings, ACCOUNT_SETTING_FEATURES.filter(key => !['sidebar_customization', 'response_presentation'].includes(key)));
    for (const key of ['sidebar_customization', 'response_presentation']) if (own(value.settings, key)) {
      try { result[key] = validateSetting(key, value.settings[key]); } catch { /* Unknown server variants are not exposed as arbitrary data. */ }
    }
    return { accountId: options.accountId, settings: result, supportedFeatures: [...ACCOUNT_SETTING_FEATURES] };
  }
  async settingsSet(options = {}) {
    const value = validateSetting(options.feature, options.value); this._options(options);
    const queryValue = record(value) ? JSON.stringify(value) : value;
    const result = await this._request('PATCH', '/settings/account_user_setting', options, { query: { feature: options.feature, value: queryValue } });
    const actual = record(result.settings) ? result.settings[options.feature] : result[options.feature];
    return { accountId: options.accountId, feature: options.feature, value,
      status: isDeepStrictEqual(actual, value) ? 'applied' : 'unconfirmed' };
  }
  async summaryChecksum(options = {}) {
    return { accountId: options.accountId, ...checksum(await this._request('GET', '/memories/about_you/summary/checksum', options, { query: summaryQuery(options) })) };
  }
  async summaryGet(options = {}) {
    const body = summaryBody(options);
    return { accountId: options.accountId, ...summary(await this._request('POST', '/memories/about_you/summary', options, { query: summaryQuery(options), ...(Object.keys(body).length ? { body } : {}) })) };
  }
  async summarySelectionActions(options = {}) {
    const value = await this._request('GET', '/memories/about_you/selection_correction_actions', options);
    if ((value.schemaVersion ?? value.schema_version) !== 1 || !Array.isArray(value.actions)) response('Unsupported memory selection action schema.');
    return { actions: value.actions.filter(visible).filter(item => ['make_correction', 'dont_mention_again'].includes(item.id))
      .map(item => ({ ...scalars(item, ['id', 'label']), action: scalars(item.action, ['type', 'targetAction', 'target_action', 'submissionText', 'submission_text']) })) };
  }
  summaryStream(options = {}) { return this._summaryStream('/memories/about_you/summary/stream', options); }
  summaryRegenerate(options = {}) { return this._summaryStream('/memories/about_you/summary/regenerate', options); }
  async _summaryStream(route, options) {
    options = { ...options, onEvent: streamConsumerCallback(options.onEvent ?? (() => {})),
      onReady: streamConsumerCallback(options.onReady ?? (() => {})) };
    this._options(options); const body = summaryBody(options), query = summaryQuery(options);
    let result;
    await this._runStream(route, options, { body, query, onEvent: async (event, value) => {
      if (event === 'started') await options.onEvent?.({ event, data: summary({ ...value, sections: [] }) });
      else if (event === 'section') { const item = section(value.section); if (item.description.trim() || item.followUps?.length) await options.onEvent?.({ event, data: { section: item, changes: changes(value.changes === undefined ? [] : [value.changes], [item]) } }); }
      else if (event === 'section_types') await options.onEvent?.({ event, data: { sections: sectionTypes(value) } });
      else if (event === 'done') { result = summary(value, true); await options.onEvent?.({ event, data: result }); }
    } });
    if (!result) response('The memory summary stream ended without a completed result.');
    return { accountId: options.accountId, ...result };
  }
  summaryCorrect(options = {}) { return this._correct('correct', options); }
  summaryForget(options = {}) { return this._correct('forget', options); }
  async _correct(action, options) {
    options = { ...options, onEvent: streamConsumerCallback(options.onEvent ?? (() => {})),
      onReady: streamConsumerCallback(options.onReady ?? (() => {})) };
    this._options(options); const correction = text(options.correction, 'correction');
    if (options.targetSectionId !== undefined) id(options.targetSectionId, 'targetSectionId');
    if (options.targetText !== undefined) text(options.targetText, 'targetText');
    if (options.conversationId !== undefined) id(options.conversationId, 'conversationId');
    if (action === 'forget') confirm(options.confirm, options.targetSectionId ?? options.accountId);
    const current = await this.summaryGet({ accountId: options.accountId, signal: options.signal, source: options.source });
    const target = options.targetSectionId === undefined ? null : current.sections.find(item => item.id === options.targetSectionId);
    if (options.targetSectionId && !target) argument('The target summary section is not in the current visible summary.');
    if (options.targetText && (!target || ![target.title, target.description].some(content => content.includes(options.targetText)))) argument('targetText must occur in the selected current section.');
    const wireSection = item => ({ id: item.id, title: item.title, description: item.description });
    const body = { conversationId: options.conversationId ?? null, correction,
      currentSections: current.sections.filter(item => item.description.trim()).map(wireSection), targetAction: action,
      targetSection: target ? wireSection(target) : null, targetSectionId: target?.id ?? null, targetText: options.targetText ?? null };
    let result, assistantResponse;
    await this._runStream('/memories/about_you/correction', options, { body, onEvent: async (event, value) => {
      if (event === 'correction_targets') await options.onEvent?.({ event, data: correctionTargets(value) });
      else if (event === 'assistant_response') {
        if (typeof value.response !== 'string') response('Invalid memory assistant response.');
        assistantResponse = value.response.trim();
        await options.onEvent?.({ event, data: { response: assistantResponse, didUpdateSummary: value.didUpdateSummary === true || value.did_update_summary === true } });
      } else if (event === 'section') { const item = section(value.section); await options.onEvent?.({ event, data: { section: item, changes: changes(value.changes === undefined ? [] : [value.changes], [item]) } }); }
      else if (event === 'section_deleted') { const sectionId = value.sectionId ?? value.section_id; if (typeof sectionId !== 'string') response('Invalid deleted section.'); await options.onEvent?.({ event, data: { sectionId } }); }
      else if (event === 'done') { result = correctionResult(value, assistantResponse); await options.onEvent?.({ event, data: result }); }
    } });
    if (!result) response('The memory correction stream ended without a completed result.');
    return { accountId: options.accountId, ...result };
  }
  async _runStream(route, options, { body, query, onEvent }) {
    const accountId = id(options.accountId, 'accountId');
    // streamSSE predates expectedAccountId; pin its credential read explicitly.
    const pinned = Object.create(this.transport);
    pinned.authLoader = async args => {
      const auth = await this.transport.authLoader(args);
      if (auth.accountId !== accountId) fail('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
      this.transport.assertIdentity?.(auth);
      return auth;
    };
    let done = false;
    await this.stream(pinned, 'POST', ROOT + route, { body, query, signal: options.signal,
      onReady: options.onReady, onEvent: internalStreamCallback(async event => {
        if (done) return;
        if (event.event === 'error') fail('SUMMARY_STREAM_FAILED', 'The memory stream reported an error.');
        if (!['started', 'section', 'section_types', 'done', 'correction_targets', 'assistant_response', 'section_deleted'].includes(event.event)) return;
        let value;
        try { value = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { response('The memory stream returned invalid JSON.'); }
        if (!record(value)) response('The memory stream returned an invalid event.');
        await onEvent(event.event, value);
        if (event.event === 'done') done = true;
      }) });
  }
  async summaryClear(options = {}) {
    this._options(options); confirm(options.confirm, options.accountId);
    // The native UI explicitly turns off both memory toggles before deleting.
    // Each step is one-shot; a partial failure is surfaced, never retried.
    for (const feature of ['m3m', 'memory_in_search']) {
      const update = await this.settingsSet({ ...options, feature, value: false });
      if (update.status !== 'applied') fail('SETTING_UNCONFIRMED', `The ${feature} setting was not confirmed; memory summary deletion was not attempted.`);
    }
    const value = await this._request('POST', '/memories/about_you/summary/cache/delete', options, { body: { disableMemory: true } });
    return { accountId: options.accountId, memoryDisabled: true, ...receipt(value, 'Memory summary clearing') };
  }
}

function sectionTypes(value) {
  const items = value.sections === undefined ? [] : value.sections;
  if (!Array.isArray(items)) response('Invalid summary section catalog.');
  return items.filter(visible).filter(item => typeof item.id === 'string' && typeof item.title === 'string').map(item => scalars(item, ['id', 'title']));
}
function correctionTargets(value) {
  const candidate = value.newSection ?? value.new_section ?? null;
  if (candidate !== null && (!record(candidate) || typeof candidate.id !== 'string' || typeof candidate.title !== 'string')) response('Invalid new summary section.');
  return { sections: sectionTypes(value), createNewSection: value.createNewSection === true || value.create_new_section === true,
    newSection: candidate !== null && visible(candidate) ? scalars(candidate, ['id', 'title']) : null };
}
function summaryQuery(options) { return { source: text(options.source ?? 'personalization-setting', 'source', 100) }; }
function summaryBody(options) {
  if (options.contextualHint === undefined) return {};
  const value = options.contextualHint;
  fields(value, ['hints', 'source'], 'contextualHint');
  if (value.source !== 'dream_citation' || !Array.isArray(value.hints) || value.hints.length === 0 || value.hints.length > 100) argument('contextualHint must contain source dream_citation and a nonempty hints array.');
  const hints = value.hints.map(item => text(item, 'contextualHint hint', 16000));
  if (hints.join('').length > 64000) argument('contextualHint exceeds the size limit.');
  return { contextual_hint: { source: 'dream_citation', hints }, force_regenerate: true };
}
function validateSetting(feature, value) {
  if (!ACCOUNT_SETTING_FEATURES.includes(feature)) argument('Choose a feature from the supported account setting list.');
  if (BOOL_SETTINGS.includes(feature)) { if (typeof value !== 'boolean') argument(`${feature} must be boolean.`); return value; }
  if (feature === 'voice_main_language') return voiceLanguage(value);
  if (feature === 'chat_theme') {
    if (!['default', 'blue', 'green', 'yellow', 'pink', 'orange', 'purple', 'black'].includes(value)) argument('Unknown chat theme.'); return value;
  }
  if (feature === 'response_presentation') {
    fields(value, ['mode'], 'response_presentation'); if (!['rich', 'standard'].includes(value.mode)) argument('response_presentation.mode must be rich or standard.'); return { mode: value.mode };
  }
  if (feature === 'sidebar_customization') {
    fields(value, ['pinOverrides', 'order'], 'sidebar_customization');
    if (!record(value.pinOverrides) || !Array.isArray(value.order) || Object.keys(value.pinOverrides).length > 256 || value.order.length > 256) argument('Sidebar customization requires bounded pinOverrides and order.');
    const valid = item => typeof item === 'string' && /^(builtin|mcp):\S{1,504}$/.test(item);
    if (Object.entries(value.pinOverrides).some(([key, enabled]) => !valid(key) || typeof enabled !== 'boolean') || Object.values(value.pinOverrides).filter(Boolean).length > 8 || value.order.some(item => !valid(item)) || new Set(value.order).size !== value.order.length) argument('Invalid sidebar destinations or more than eight pinned destinations.');
    return { pinOverrides: { ...value.pinOverrides }, order: [...value.order] };
  }
  return text(value, feature, 128);
}
