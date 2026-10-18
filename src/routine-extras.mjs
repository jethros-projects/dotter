import { randomUUID } from 'node:crypto';
import { DotError } from './errors.mjs';

// Observed in the installed ChatGPT app, 2026-10-17: cloud-automation-detail-panel,
// run-results-state, detail-panel, editor-dialog, configuration-schedule, and
// app-initial. These are service-enforced internal contracts, not API guarantees.
const ID = /^[a-zA-Z0-9_.~:-]{1,1024}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const invalid = message => { throw new DotError('INVALID_ARGUMENT', message); };
const malformed = message => { throw new DotError('INVALID_RESPONSE', message); };
function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') invalid(`${name} must be an ID returned by the API.`);
  return encodeURIComponent(value);
}
function object(value, name) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) malformed(`The ${name} response was not an object.`);
  return value;
}
function scalarFields(value, fields) {
  object(value, 'item');
  return Object.fromEntries(fields.filter(key => own(value, key)
    && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])))
    .map(key => [key, value[key]]));
}
function hidden(value) {
  return Boolean(value?.is_hidden || value?.hidden || value?.is_visually_hidden_from_conversation
    || value?.deleted_at != null || value?.metadata?.is_hidden || value?.metadata?.hidden
    || value?.metadata?.is_visually_hidden_from_conversation || value?.metadata?.deleted_at != null);
}
function visible(value) {
  if (hidden(value)) return false;
  return [value?.channel, value?.metadata?.channel].every(channel => channel == null || channel === 'final' || channel === 'commentary')
    && [value?.recipient, value?.metadata?.recipient].every(recipient => recipient == null || recipient === 'all');
}
function pagination(limit, cursor) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit must be an integer from 1 to 100.');
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || cursor.includes('\0'))) invalid('cursor must be a nonempty string of at most 8192 characters.');
  return { limit, cursor: cursor ?? undefined };
}
function responseCursor(value) {
  if (value != null && typeof value !== 'string') malformed('The response cursor was not a string.');
  return value ?? null;
}
function runSummary(run) {
  object(run, 'run');
  if (hidden(run)) return null;
  const result = scalarFields(run, ['id', 'status', 'scheduled_for', 'started_at', 'completed_at', 'finished_at', 'created_at', 'updated_at', 'is_unread']);
  if (run.chat_ref && ['chatgpt', 'codex'].includes(run.chat_ref.type) && typeof run.chat_ref.id === 'string') result.chat_ref = { type: run.chat_ref.type, id: run.chat_ref.id };
  return result;
}
function updateSummary(update) {
  if (update == null) return null;
  object(update, 'latest update');
  if (!visible(update)) return null;
  const requiresAction = update.metadata?.automation_requires_user_action === true;
  const result = { ...scalarFields(update, ['id', 'created_at', 'updated_at']), requires_user_action: requiresAction };
  if (!requiresAction && typeof update.content_text === 'string' && update.content_text.trim() !== '::SKIP_COMPLETION::') result.content_text = update.content_text;
  if (update.metadata?.automation_last_backing_run_failed === true) result.last_run_failed = true;
  return result;
}
function linkSummary(link, expectedId) {
  if (link == null) return null;
  object(link, 'connector link');
  if (typeof link.id !== 'string' || link.connector_id !== expectedId) malformed('The connector link did not match the requested connector.');
  const result = scalarFields(link, ['id', 'connector_id', 'name', 'auth_type', 'auth_status', 'auth_status_reason', 'connector_status', 'unavailable_reason', 'created_at']);
  const label = link.owner_profile?.email ?? link.owner_profile?.name ?? link.name;
  if (typeof label === 'string') result.account_label = label;
  return result;
}
const CONNECTOR_HEADERS = { 'OAI-Product-Sku': 'CODEX', 'X-Codex-Surface': 'other' };

export class RoutineExtras {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('RoutineExtras requires a DotClient.');
    this.transport = client.transport;
  }
  async executionThreads({ routineId, limit = 25, cursor, signal } = {}) {
    const path = `/backend-api/automation/${id(routineId, 'routineId')}/execution_threads`;
    const data = object(await this.transport.request('GET', path, { query: pagination(limit, cursor), signal }), 'execution threads');
    if (!Array.isArray(data.threads)) malformed('The execution threads response did not contain a threads array.');
    if (data.has_more != null && typeof data.has_more !== 'boolean') malformed('The execution threads pagination flag was not a boolean.');
    return { threads: data.threads.filter(thread => { object(thread, 'execution thread'); return !hidden(thread); })
      .map(thread => {
        if (typeof thread.thread_id !== 'string' || !thread.thread_id) malformed('An execution thread did not contain a thread ID.');
        return scalarFields(thread, ['thread_id', 'created_at']);
      }), cursor: responseCursor(data.cursor), has_more: data.has_more === true };
  }
  async markRunRead({ routineId, runId, signal } = {}) {
    const path = `/backend-api/automation/${id(routineId, 'routineId')}/runs/${id(runId, 'runId')}`;
    const current = object(await this.transport.request('GET', path, { signal }), 'run');
    const run = object(current.run, 'run');
    if (run.id !== runId) malformed('The run response did not match the requested run.');
    if (hidden(run)) throw new DotError('NOT_VISIBLE', 'The selected run is hidden.');
    // The app uses the server run revision as the read marker, never the clock.
    const readAt = run.updated_at;
    if (!(typeof readAt === 'string' && readAt.length > 0 && readAt.length <= 200 && !readAt.includes('\0'))
      && !(typeof readAt === 'number' && Number.isFinite(readAt))) malformed('The run did not include a usable updated_at read marker.');
    await this.transport.request('POST', `${path}/read`, { body: { read_at: readAt }, signal });
    return { read: true, routineId, runId, readAt };
  }
  async latestRun({ routineId, signal } = {}) {
    const path = `/backend-api/automation/${id(routineId, 'routineId')}/latest_backing_run`;
    const response = await this.transport.request('GET', path, { query: { include_snapshot: true }, allowNull: true, signal });
    if (response === null) return { last_backing_run: null, latest_update: null };
    const data = object(response, 'latest backing run');
    if (hidden(data)) return { last_backing_run: null, latest_update: null };
    // Older responses are the update itself; newer ones wrap it with a run.
    return { last_backing_run: data.last_backing_run == null ? null : runSummary(data.last_backing_run),
      latest_update: updateSummary(own(data, 'latest_update') ? data.latest_update : data) };
  }
  async batchStatus({ routineId, signal } = {}) {
    const data = object(await this.transport.request('GET', `/backend-api/automation/${id(routineId, 'routineId')}/webhook_batch_state`, { signal }), 'webhook batch');
    if (!Number.isSafeInteger(data.pending_event_count) || data.pending_event_count < 0
      || (data.is_enabled != null && typeof data.is_enabled !== 'boolean')) malformed('The webhook batch response did not include a valid pending-event count.');
    return scalarFields(data, ['is_enabled', 'pending_event_count']);
  }
  async flushBatch({ routineId, requestId = randomUUID(), signal } = {}) {
    const path = `/backend-api/automation/${id(routineId, 'routineId')}/webhook_batch/run_now`;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) invalid('requestId must be a UUID. Reuse it only for the same batch request.');
    const data = await this.transport.request('POST', path, { body: { request_id: requestId }, idempotencyKey: requestId, signal });
    if (data == null || !Number.isSafeInteger(data.flushed_event_count) || data.flushed_event_count < 0) {
      throw new DotError('INVALID_RESPONSE', 'The batch acknowledgement did not include an event count. Check the batch status before another request.', { delivery: 'unknown', requestId });
    }
    return { requestId, flushedEventCount: data.flushed_event_count };
  }
  async schedulePolicy({ serviceAccountId, signal } = {}) {
    if (serviceAccountId != null) id(serviceAccountId, 'serviceAccountId');
    const data = object(await this.transport.request('GET', '/backend-api/automations/schedule_policy', { query: { service_account_id: serviceAccountId ?? undefined }, signal }), 'schedule policy');
    const result = scalarFields(data, ['minute_schedule_available', 'max_iterations_per_hour']);
    if (typeof result.minute_schedule_available !== 'boolean' || !Number.isInteger(result.max_iterations_per_hour) || result.max_iterations_per_hour < -1) malformed('The schedule policy did not contain valid scheduling limits.');
    return result;
  }
  async connectorDetails({ connectorId, signal } = {}) {
    const data = object(await this.transport.request('GET', `/backend-api/aip/connectors/${id(connectorId, 'connectorId')}`, { query: { include_actions: false }, headers: CONNECTOR_HEADERS, signal }), 'connector');
    if (data.id !== connectorId) malformed('The connector details did not match the requested connector.');
    const result = scalarFields(data, ['id', 'name', 'description', 'status', 'service', 'template_id']);
    if (Array.isArray(data.supported_auth)) result.supported_auth = data.supported_auth.filter(auth => auth && typeof auth.type === 'string').map(auth => ({ type: auth.type }));
    return result;
  }
  async connectorHealth({ connectorId, linkId, signal } = {}) {
    const connectorPath = id(connectorId, 'connectorId');
    if (linkId != null) id(linkId, 'linkId');
    const [details, data] = await Promise.all([
      this.connectorDetails({ connectorId, signal }),
      this.transport.request('GET', `/backend-api/aip/connectors/${connectorPath}/link`, { headers: CONNECTOR_HEADERS, signal })
    ]);
    object(data, 'connector link');
    if (!own(data, 'link')) malformed('The connector link response did not contain a link field.');
    const link = linkSummary(data.link, connectorId);
    if (linkId != null && link?.id !== linkId) throw new DotError('ACCOUNT_MISMATCH', 'The service returned a different connector account. No other account was selected.');
    let state = 'unknown';
    if (details.status === 'DISABLED_BY_ADMIN' || link?.connector_status === 'DISABLED_BY_ADMIN' || link?.unavailable_reason != null) state = 'unavailable';
    else if (link == null) state = 'disconnected';
    else if (link.auth_status === 'REAUTH_REQUIRED') state = 'needs_auth';
    else if (link.auth_status === 'ACTIVE') state = 'connected';
    return { connector: details, link, state };
  }
}
