import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';
import { projectTaskRecord, taskHidden, taskPageCursor } from './task-records.mjs';
import { MCP_CATALOG_MAX_BYTES, readNativeToolCatalog, nativeToolBinding } from './mcp-catalog.mjs';
import { callNativeTool, hasNativeWidgetTemplate, nativeToolIdentityGuard, readNativeResource } from './mcp-native-call.mjs';

// Contracts inspected in ChatGPT.app webview assets on 2026-10-17:
// app-initial-90eb42395b7d.js, state-b2361df7fe66.js,
// open-panel-7f472afb4ef2.js, run-results-state-72c9013bb90d.js,
// schedule-draft-5f0d7248f792.js, workspace-agent-apps-b82f2b0b4c25.js.
const ID = /^[a-zA-Z0-9_.~:-]{1,1024}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMING_MODES = { exact_schedule: 0, flexible_schedule: 1, condition_watch: 2 };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(message) { throw new DotError('INVALID_ARGUMENT', message); }
function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${name} must be an ID returned by the API.`);
  return value;
}
function string(value, name, max = 64000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${name} must be a nonempty string of at most ${max} characters without NUL bytes.`);
  return value;
}
function boolean(value, name) { if (typeof value !== 'boolean') fail(`${name} must be true or false.`); return value; }
function optionalId(value, name) { return value == null ? undefined : id(value, name); }
function pageOptions({ limit = 25, cursor } = {}, max = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) fail(`limit must be an integer from 1 to ${max}.`);
  if (cursor != null) string(cursor, 'cursor', 8192);
  return { limit, cursor: cursor ?? undefined };
}
function object(value, name) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be a JSON object.`);
  return value;
}
function timeZone(value) {
  string(value, 'timeZone', 200);
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail('timeZone must be an IANA time zone, such as Europe/London.'); }
  return value;
}
function timingMode(value) {
  const mode = typeof value === 'string' ? TIMING_MODES[value] : value;
  if (![0, 1, 2].includes(mode)) fail('timingMode must be exact_schedule, flexible_schedule, or condition_watch.');
  return mode;
}
function schedule(value) {
  const text = string(value, 'schedule', 16384).trim().replace(/\r\n/g, '\n');
  // The service accepts an iCalendar VEVENT, not a Unix cron expression.
  if (!/^(?:BEGIN:VEVENT\n|RRULE:|DTSTART[:;]|RDATE[:;])/.test(text)
      || !/(?:^|\n)(?:RRULE:|DTSTART[:;]|RDATE[:;])/.test(text)) {
    fail('schedule must contain an iCalendar RRULE, DTSTART, or RDATE; Unix cron expressions are not accepted.');
  }
  if (text.startsWith('BEGIN:VEVENT\n')) {
    if (!text.endsWith('\nEND:VEVENT')) fail('An iCalendar VEVENT must end with END:VEVENT.');
    return text;
  }
  return `BEGIN:VEVENT\n${text}\nEND:VEVENT`;
}
function nullableString(value, name, max = 256) { return value === null ? null : string(value, name, max); }
function enumValue(value, values, name) {
  if (!values.includes(value)) fail(`${name} must be ${values.join(', ')}.`);
  return value;
}
function rejectEventTriggerAuthoring(options) {
  if (own(options, 'triggers')) throw new DotError('UNSUPPORTED', 'Event-trigger authoring is unavailable: the live service does not retain native trigger requests. Existing trigger data remains readable.');
}
function validatedRoutine(data, expectedId, mutation = false) {
  if (data == null || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string'
      || !ID.test(data.id) || data.id === '.' || data.id === '..' || expectedId !== undefined && data.id !== expectedId) {
    throw new DotError('INVALID_RESPONSE', 'The routine response did not identify the requested routine. Check routines before retrying a mutation.', mutation ? { delivery: 'unknown' } : {});
  }
  return data;
}
function responseList(data, key = 'items') {
  if (!data || !Array.isArray(data[key])) throw new DotError('INVALID_RESPONSE', `The response did not contain a ${key} array.`);
  return data;
}
function hidden(value) {
  return Boolean(value?.is_hidden || value?.hidden || value?.is_visually_hidden_from_conversation
    || value?.metadata?.is_hidden || value?.metadata?.hidden || value?.metadata?.is_visually_hidden_from_conversation);
}
function scalarFields(value, fields) {
  object(value, 'response item');
  return Object.fromEntries(fields.filter(key => own(value, key)
    && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])))
    .map(key => [key, value[key]]));
}
function runSummary(run) {
  if (hidden(run) || run?.deleted_at != null || run?.metadata?.deleted_at != null) return null;
  const result = scalarFields(run, ['id', 'status', 'scheduled_for', 'started_at', 'completed_at', 'finished_at', 'created_at', 'updated_at', 'is_unread']);
  if (run.chat_ref && ['chatgpt', 'codex'].includes(run.chat_ref.type) && typeof run.chat_ref.id === 'string') {
    result.chat_ref = { type: run.chat_ref.type, id: run.chat_ref.id };
  }
  return result;
}
function routineContentVisible(value) {
  return !hidden(value) && value?.deleted_at == null && value?.metadata?.deleted_at == null
    && [value?.channel, value?.metadata?.channel].every(channel => channel == null || ['final', 'commentary'].includes(channel))
    && [value?.recipient, value?.metadata?.recipient].every(recipient => recipient == null || recipient === 'all');
}
function runResult(data) {
  object(data, 'run result');
  const result = {};
  if (data.last_run != null) result.last_run = runSummary(data.last_run);
  const update = data.run ? data : data.latest_update;
  const visibleRun = update?.run == null ? null : runSummary(update.run);
  if (visibleRun) {
    result.latest_update = { run: visibleRun };
    const content = update.latest_update;
    if (content) {
      const needsAction = content.metadata?.automation_requires_user_action === true;
      result.latest_update.requires_user_action = needsAction;
      // The app displays content_text only when no private action is pending.
      if (!needsAction && routineContentVisible(content) && typeof content.content_text === 'string'
          && content.content_text.trim() !== '::SKIP_COMPLETION::') {
        result.latest_update.content_text = content.content_text;
        if (typeof content.created_at === 'string') result.latest_update.created_at = content.created_at;
      }
    }
  }
  return result;
}
function connector(options) {
  const connectorId = options.connectorId ?? (typeof options.appUri === 'string' && options.appUri.startsWith('connectors://') ? options.appUri.slice(13) : undefined);
  id(connectorId, 'connectorId');
  if (options.appUri !== undefined && options.appUri !== `connectors://${connectorId}`) fail('appUri must identify one connector using connectors://ID.');
  return { connectorId, appUri: `connectors://${connectorId}` };
}
function mcpMeta(options, action) {
  const { connectorId } = connector(options);
  return { 'openai/connector_id': connectorId,
    ...(options.linkId == null ? {} : { 'openai/link_id': id(options.linkId, 'linkId') }),
    ...(action == null ? {} : { 'openai/action_name': action }) };
}
function syntheticToolLink(descriptor, name) {
  const native = nativeToolBinding(descriptor);
  if (native) return native.syntheticSelection;
  if (!own(descriptor.inputSchema?.properties ?? {}, 'link_id')) return false;
  const actions = descriptor._meta?.connector?.actions;
  if (!Array.isArray(actions)) return false;
  const matching = actions.filter(action => action?.name === name);
  if (matching.length !== 1) return false;
  const params = matching[0].params;
  // Only the original, fully described action schema can establish that the
  // catalog added link_id for account selection rather than as an action input.
  if (!params || params.type !== 'object' || !params.properties || typeof params.properties !== 'object'
      || Array.isArray(params.properties) || ['$ref', 'allOf', 'anyOf', 'oneOf'].some(key => own(params, key))) return false;
  if (params.required !== undefined && !Array.isArray(params.required)) return false;
  return !own(params.properties, 'link_id') && !params.required?.includes('link_id');
}
function connectorLink(link) {
  object(link, 'connector link');
  if (typeof link.id !== 'string' || typeof link.connector_id !== 'string') throw new DotError('INVALID_RESPONSE', 'A connector link did not identify its account and connector.');
  const result = { id: link.id, connectorId: link.connector_id, appUri: `connectors://${link.connector_id}` };
  for (const [input, output] of [
    ['name', 'name'], ['auth_type', 'authType'], ['auth_status', 'authStatus'],
    ['connector_status', 'connectorStatus'], ['unavailable_reason', 'unavailableReason'], ['created_at', 'createdAt']
  ]) if (typeof link[input] === 'string' || link[input] === null) result[output] = link[input];
  const label = link.owner_profile?.email ?? link.owner_profile?.name ?? link.name;
  if (typeof label === 'string') result.accountLabel = label;
  if (Array.isArray(link.actions)) result.actions = link.actions.filter(action => typeof action === 'string');
  return result;
}

export function capabilities() {
  return {
    source: 'Static contracts in the installed ChatGPT app; availability is enforced by the service.',
    evidence: { inspectedOn: '2026-10-17', archive: '/Applications/ChatGPT.app/Contents/Resources/app.asar',
      assets: ['app-initial-90eb42395b7d.js', 'state-b2361df7fe66.js', 'open-panel-7f472afb4ef2.js',
        'run-results-state-72c9013bb90d.js', 'run-results-c9a2d3d3c498.js', 'schedule-draft-5f0d7248f792.js', 'workspace-agent-apps-b82f2b0b4c25.js',
        'account-linking-c17d937b28f1.js', 'app-connection-actions-ffc2c7fdde45.js'] },
    routines: { supported: ['list', 'get', 'create', 'update', 'pause', 'resume', 'delete', 'run', 'runs', 'run-result'],
      scope: 'Dot-associated list by default; all-account list and account-scoped cloud schedule creation are explicit options.',
      scheduleFormat: 'iCalendar VEVENT', liveVerified: false },
    tasks: { supported: ['list', 'get'], scope: 'selected Dot', liveVerified: false },
    threads: { supported: ['list'], scope: 'selected Dot; hidden threads excluded', liveVerified: false },
    tools: { supported: ['connectors', 'list', 'call', 'connector-actions'], scope: 'explicit connected app and account, using the app MCP proxy', liveVerified: false },
    resources: { supported: ['list', 'templates', 'read', 'prompts'], scope: 'explicit connected app, using the app MCP proxy', liveVerified: false },
    liveReadVerification: { date: '2026-10-17', successful: ['Dot-associated routine list', 'Dot thread list', 'connected account discovery'],
      blocked: ['task list: intermittent edge challenge'], writes: 'not exercised' },
    unavailable: [
      { feature: 'Event-trigger routine authoring', reason: 'The live service drops native trigger requests; existing trigger metadata remains readable.' },
      { feature: 'Grok hosted events and webhooks', reason: 'No equivalent public or installed-app subscription contract established.' },
      { feature: 'Dot runtime internal tool catalog and arbitrary native IPC', reason: 'Connected-app MCP tools are separate from Dot runtime internals.' },
      { feature: 'Local Codex automation execution', reason: 'Requires the desktop automation owner and runtime; this client manages cloud API schedules.' }
    ]
  };
}

export class DotOperations {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotOperations requires a DotClient.');
    this.client = client;
    this.transport = client.transport;
  }
  async resolveDot(dotId, signal) {
    if (dotId != null) return id(dotId, 'dotId');
    const primary = await this.client.primary({ signal });
    if (!primary?.id) throw new DotError('DOT_UNAVAILABLE', 'The primary Dot response did not contain a Dot ID. Use --dot with an ID from dots.');
    return id(primary.id, 'dotId');
  }
  async listRoutines({ dotId, all = false, limit = 25, cursor, filter, signal } = {}) {
    boolean(all, 'all');
    const query = pageOptions({ limit, cursor });
    if (filter != null && !['scheduled', 'paused', 'finished'].includes(filter)) fail('filter must be scheduled, paused, or finished.');
    if (filter != null && !all) fail('filter requires the all-account routines list.');
    if (all && dotId != null) fail('Use either dotId or all, not both.');
    if (filter != null) query.filter = filter;
    const route = all ? '/backend-api/automations' : `/backend-api/tbo/${await this.resolveDot(dotId, signal)}/automations`;
    return responseList(await this.transport.request('GET', route, { query, signal }));
  }
  async getRoutine({ routineId, signal } = {}) {
    return validatedRoutine(await this.transport.request('GET', `/backend-api/automation/${id(routineId, 'routineId')}`, { signal }), routineId);
  }
  async createRoutine(options = {}) {
    rejectEventTriggerAuthoring(options);
    const { title, prompt, schedule: inputSchedule, timeZone: inputTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled = true, notificationsEnabled = true, emailEnabled = false, timingMode: inputMode = 'exact_schedule',
      model = null, reasoningEffort = null, emoji, threadMode, teamId, signal } = options;
    if (options.dotId != null) fail('Creating a schedule does not attach it to a Dot; omit dotId.');
    const body = { title: string(title, 'title', 500).trim(), prompt: string(prompt, 'prompt').trim(),
      schedule: schedule(inputSchedule), default_timezone: timeZone(inputTimeZone), jawbone_id: null,
      is_enabled: boolean(enabled, 'enabled'), notifications_enabled: boolean(notificationsEnabled, 'notificationsEnabled'),
      email_enabled: boolean(emailEnabled, 'emailEnabled'), timing_mode: timingMode(inputMode),
      model: nullableString(model, 'model'), reasoning_effort: nullableString(reasoningEffort, 'reasoningEffort') };
    if (teamId !== undefined) body.team_id = id(teamId, 'teamId');
    if (emoji !== undefined) body.emoji = nullableString(emoji, 'emoji', 128);
    if (threadMode !== undefined) {
      body.thread_mode = enumValue(threadMode, ['new_chat', 'existing_chat'], 'threadMode');
    }
    return validatedRoutine(await this.transport.request('POST', '/backend-api/automations/save', { body, signal }), undefined, true);
  }
  async updateRoutine(options = {}) {
    rejectEventTriggerAuthoring(options);
    const { routineId, signal } = options;
    id(routineId, 'routineId');
    const fields = ['title', 'prompt', 'schedule', 'timeZone', 'enabled', 'notificationsEnabled', 'emailEnabled', 'timingMode', 'model', 'reasoningEffort', 'emoji', 'threadMode'];
    if (!fields.some(key => own(options, key))) fail('Specify at least one routine field to update.');
    // Save is a full update; preserve the existing server configuration rather
    // than silently resetting notification, timing, or model preferences.
    const existing = await this.getRoutine({ routineId, signal });
    if (existing.executor === 'local') throw new DotError('UNSUPPORTED', 'Local automation edits require the desktop automation runtime.');
    const existingEvents = Array.isArray(existing.webhook_triggers) && existing.webhook_triggers.length > 0;
    if (existingEvents && ((own(options, 'schedule') && options.schedule !== '') || (own(options, 'timingMode') && timingMode(options.timingMode) !== 2))) throw new DotError('UNSUPPORTED', 'Changing the schedule of an existing event-trigger routine is unavailable. Existing trigger data remains readable.');
    const body = { jawbone_id: routineId,
      title: own(options, 'title') ? string(options.title, 'title', 500).trim() : string(existing.title, 'existing title', 500),
      prompt: own(options, 'prompt') ? string(options.prompt, 'prompt').trim() : string(existing.prompt, 'existing prompt'),
      schedule: existingEvents ? '' : schedule(own(options, 'schedule') ? options.schedule : existing.schedule),
      default_timezone: timeZone(own(options, 'timeZone') ? options.timeZone : existing.default_timezone),
      is_enabled: boolean(own(options, 'enabled') ? options.enabled : existing.is_enabled, 'enabled'),
      notifications_enabled: boolean(own(options, 'notificationsEnabled') ? options.notificationsEnabled : existing.notifications_enabled, 'notificationsEnabled'),
      email_enabled: boolean(own(options, 'emailEnabled') ? options.emailEnabled : existing.email_enabled, 'emailEnabled'),
      timing_mode: existingEvents ? 2 : timingMode(own(options, 'timingMode') ? options.timingMode : existing.timing_mode) };
    // Native ordinary edits omit triggers and import/share metadata. These are
    // server-managed fields; omission preserves both without replaying stale IDs.
    if (existing.team_id != null) body.team_id = id(existing.team_id, 'existing teamId');
    if (own(options, 'threadMode')) body.thread_mode = enumValue(options.threadMode, ['new_chat', 'existing_chat'], 'threadMode');
    else if (existing.thread_mode != null) body.thread_mode = enumValue(existing.thread_mode, ['new_chat', 'existing_chat'], 'existing threadMode');
    if (own(options, 'model')) body.model = nullableString(options.model, 'model');
    else if (existing.model !== undefined) body.model = nullableString(existing.model, 'existing model');
    if (own(options, 'reasoningEffort')) body.reasoning_effort = nullableString(options.reasoningEffort, 'reasoningEffort');
    else if (existing.reasoning_effort !== undefined) body.reasoning_effort = nullableString(existing.reasoning_effort, 'existing reasoningEffort');
    if (own(options, 'emoji')) body.emoji = nullableString(options.emoji, 'emoji', 128);
    else if (existing.display_emoji !== undefined) body.emoji = nullableString(existing.display_emoji, 'existing emoji', 128);
    return validatedRoutine(await this.transport.request('POST', '/backend-api/automations/save', { body, signal }), routineId, true);
  }
  async setRoutineEnabled({ routineId, enabled, signal } = {}) {
    const body = { jawbone_id: id(routineId, 'routineId'), is_enabled: boolean(enabled, 'enabled') };
    return validatedRoutine(await this.transport.request('POST', '/backend-api/automations/set_status', { body, signal }), routineId, true);
  }
  async deleteRoutine({ routineId, signal } = {}) {
    id(routineId, 'routineId');
    await this.transport.request('POST', '/backend-api/automations/remove', { body: { automation_id: routineId }, signal });
    return { deleted: true, routineId };
  }
  async runRoutine({ routineId, idempotencyKey = randomUUID(), signal } = {}) {
    id(routineId, 'routineId');
    if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) fail('idempotencyKey must be a UUID.');
    const routine = await this.getRoutine({ routineId, signal });
    if (routine.executor === 'local') throw new DotError('UNSUPPORTED', 'Local automation runs require the desktop automation runtime.');
    const data = await this.transport.request('POST', `/backend-api/automation/${routineId}/run`, { body: { idempotency_key: idempotencyKey }, idempotencyKey, signal });
    if (data == null || typeof data !== 'object' || Array.isArray(data) || typeof data.run_id !== 'string'
        || !ID.test(data.run_id) || data.run_id === '.' || data.run_id === '..') throw new DotError('INVALID_RESPONSE', 'The API did not return a run ID. Check routine runs before retrying.', { delivery: 'unknown', idempotencyKey });
    return { ...data, idempotencyKey, resultLookup: { command: 'routine runs', idField: 'runs[].id', note: 'The accepted run_id may differ from the persisted result ID. Use a run ID returned by routine runs with routine result.' } };
  }
  async routineRuns({ routineId, limit = 25, cursor, signal } = {}) {
    const data = responseList(await this.transport.request('GET', `/backend-api/automation/${id(routineId, 'routineId')}/runs`, { query: { ...pageOptions({ limit, cursor }), include_chat_ref: true }, signal }), 'runs');
    return { runs: data.runs.map(runSummary).filter(Boolean), cursor: data.cursor ?? null };
  }
  async routineRun({ routineId, runId, signal } = {}) {
    const suffix = runId == null ? 'latest' : id(runId, 'runId');
    const data = await this.transport.request('GET', `/backend-api/automation/${id(routineId, 'routineId')}/runs/${suffix}`, { signal });
    if (runId != null) {
      const selected = data?.run ?? data?.latest_update?.run;
      if (!selected || selected.id !== runId) throw new DotError('INVALID_RESPONSE', 'The result did not identify the requested routine run.');
    }
    return runResult(data);
  }
  async listTasks({ dotId, limit = 25, cursor, signal } = {}) {
    const query = pageOptions({ limit, cursor });
    dotId = await this.resolveDot(dotId, signal);
    const data = responseList(await this.transport.request('GET', `/backend-api/tbo/${dotId}/tasks`, { query, signal }), 'data');
    return { data: data.data.map(task => projectTaskRecord(task, { dotId })).filter(Boolean), next_cursor: taskPageCursor(data.next_cursor) };
  }
  async getTask({ dotId, taskId, signal } = {}) {
    id(taskId, 'taskId');
    dotId = await this.resolveDot(dotId, signal);
    const value = await this.transport.request('GET', `/backend-api/tbo/${dotId}/tasks/${taskId}`, { signal });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DotError('INVALID_RESPONSE', 'The API returned an invalid task summary.');
    if (taskHidden(value)) throw new DotError('NOT_VISIBLE', 'This task is not a visible user record.');
    if (value?.id !== taskId) throw new DotError('IDENTITY_MISMATCH', 'The API returned a different task than the requested one.');
    return projectTaskRecord(value, { dotId });
  }
  async listThreads({ dotId, limit = 100, cursor, signal } = {}) {
    const query = { ...pageOptions({ limit, cursor }), include_hidden: false };
    const data = responseList(await this.transport.request('GET', `/backend-api/tbo/${await this.resolveDot(dotId, signal)}/threads`, { query, signal }));
    return { items: data.items.filter(thread => !hidden(thread)).map(thread => scalarFields(thread,
      ['thread_id', 'title', 'kind', 'status', 'created_at', 'updated_at'])), cursor: data.cursor ?? null };
  }
  async connectorActions({ connectorId, signal } = {}) {
    return responseList(await this.transport.request('GET', `/backend-api/aip/connectors/${id(connectorId, 'connectorId')}/actions`, { signal }), 'actions');
  }
  async listConnectors({ connectorId, signal } = {}) {
    if (connectorId != null) id(connectorId, 'connectorId');
    // NONE is an observed read-only refresh strategy: discover the existing
    // accessible account links without initiating provider token refreshes.
    const data = responseList(await this.transport.request('POST', '/backend-api/aip/connectors/links/list_accessible', {
      body: { principals: [], link_refresh_strategy: 'NONE' },
      headers: { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' }, signal
    }), 'links');
    return { links: data.links.filter(link => connectorId == null || link?.connector_id === connectorId).map(connectorLink) };
  }
  async mcpRequest(method, params, options) {
    if (!['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list'].includes(method)) fail('Unsupported MCP method.');
    const { appUri } = connector(options);
    if (method === 'tools/list') {
      const result = await readNativeToolCatalog(this.transport, { ...connector(options), linkId: options.linkId, cursor: params.cursor,
        conversationId: optionalId(options.conversationId, 'conversationId'), threadId: optionalId(options.threadId, 'threadId'), signal: options.signal });
      if (result.resultType === 'input_required') throw new DotError('MCP_INPUT_REQUIRED', 'The tool catalog requires interactive input; no response was guessed.');
      return result;
    }
    const body = { app_uri: appUri, launcher_host: 'chatgpt',
      conversation_id: optionalId(options.conversationId, 'conversationId'),
      thread_id: optionalId(options.threadId, 'threadId'), message_id: optionalId(options.messageId, 'messageId'),
      method, params: { ...params, _meta: mcpMeta(options, method === 'tools/call' ? params.name : undefined) } };
    return this.transport.request('POST', '/backend-api/ecosystem/call_mcp', { body, signal: options.signal,
      ...(['resources/list', 'resources/templates/list', 'prompts/list'].includes(method) ? { maxBytes: MCP_CATALOG_MAX_BYTES } : {}) });
  }
  async toolList(options = {}) {
    if (options.cursor != null) string(options.cursor, 'cursor', 8192);
    return responseList(await this.mcpRequest('tools/list', { ...(options.cursor == null ? {} : { cursor: options.cursor }) }, options), 'tools');
  }
  async toolCall(options = {}) {
    const { name, arguments: args = {} } = options;
    string(name, 'tool name', 256);
    if (/[\s/]/.test(name)) fail('Use an exact unqualified tool name returned by tools list.');
    object(args, 'arguments');
    const selectedConnector = connector(options).connectorId;
    const assertCurrent = await nativeToolIdentityGuard(this.transport, options.expectedAccountId);
    // A caller cannot invoke an invented tool by bypassing the catalog.
    let cursor; const seen = new Set(); let descriptor;
    for (let page = 0; page < 100; page++) {
      const data = await this.toolList({ ...options, cursor });
      const matches = data.tools.filter(tool => tool?.name === name);
      if (matches.length > 1 || descriptor && matches.length) throw new DotError('INVALID_RESPONSE', 'The tool catalog contains an ambiguous action name.');
      if (matches.length) descriptor = matches[0];
      if (!data.nextCursor) break;
      if (typeof data.nextCursor !== 'string' || seen.has(data.nextCursor)) throw new DotError('CURSOR_LOOP', 'The tool catalog repeated a cursor.');
      seen.add(data.nextCursor); cursor = data.nextCursor;
      if (page === 99) throw new DotError('PAGE_LIMIT', 'The tool catalog exceeded 100 pages.');
    }
    if (!descriptor) throw new DotError('TOOL_UNAVAILABLE', 'The requested tool is not in this connected app’s catalog.');
    if (descriptor.is_enabled === false) throw new DotError('TOOL_UNAVAILABLE', 'This connected-app tool is disabled.');
    const syntheticLink = syntheticToolLink(descriptor, name);
    const argumentLink = syntheticLink && own(args, 'link_id') ? id(args.link_id, 'arguments.link_id') : undefined;
    const selectedLink = options.linkId ?? argumentLink;
    const native = nativeToolBinding(descriptor);
    if (native && selectedLink !== undefined && !native.linkIds.includes(selectedLink)) fail('The selected link was not returned by this tool catalog.');
    if (argumentLink !== undefined && selectedLink !== argumentLink) fail('arguments.link_id and linkId must select the same connected account.');
    const routedOptions = { ...options, ...(selectedLink === undefined ? {} : { linkId: selectedLink }) };
    // The legacy action registry does not necessarily contain UI-producing
    // tools returned by the native catalog. Use their published native name
    // and metadata directly; never retry a failed invocation on another route.
    if (native && hasNativeWidgetTemplate(descriptor)) return callNativeTool(this.transport, {
      descriptor, connectorId: selectedConnector, linkId: selectedLink, arguments: args,
      expectedAccountId: options.expectedAccountId ?? assertCurrent.accountId, signal: options.signal, assertCurrent,
    });
    for (const key of descriptor.inputSchema?.required ?? []) {
      if (key === 'link_id' && syntheticLink && selectedLink !== undefined) continue;
      if (!own(args, key)) fail(`Tool arguments are missing required field: ${key}`);
    }
    const actionArguments = syntheticLink ? { ...args } : args;
    if (syntheticLink) delete actionArguments.link_id;
    return this.mcpRequest('tools/call', { name, arguments: actionArguments }, routedOptions);
  }
  async resourceList(options = {}) {
    if (options.cursor != null) string(options.cursor, 'cursor', 8192);
    return responseList(await this.mcpRequest('resources/list', { ...(options.cursor == null ? {} : { cursor: options.cursor }) }, options), 'resources');
  }
  async resourceTemplates(options = {}) {
    if (options.cursor != null) string(options.cursor, 'cursor', 8192);
    return responseList(await this.mcpRequest('resources/templates/list', { ...(options.cursor == null ? {} : { cursor: options.cursor }) }, options), 'resourceTemplates');
  }
  async resourceRead(options = {}) {
    const uri = string(options.uri, 'uri', 8192);
    if (uri.startsWith('ui:')) return readNativeResource(this.transport, {
      connectorId: connector(options).connectorId, linkId: options.linkId, uri,
      expectedAccountId: options.expectedAccountId, signal: options.signal,
    });
    return responseList(await this.mcpRequest('resources/read', { uri }, options), 'contents');
  }
  async promptList(options = {}) {
    if (options.cursor != null) string(options.cursor, 'cursor', 8192);
    return responseList(await this.mcpRequest('prompts/list', { ...(options.cursor == null ? {} : { cursor: options.cursor }) }, options), 'prompts');
  }
}
