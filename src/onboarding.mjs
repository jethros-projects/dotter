import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { DotError } from './errors.mjs';
import { withOperationLock } from './operation-lock.mjs';

// Current native flow: cloud-aeon-onboarding-2e6570831113.js (J):
// POST /tbo with should_initialize:true, ensure its room, resume returned root.
// The unused /onboarding/initialize adapter lacks a request constructor in this
// build. Do not invent its greeting/prompt payload or send a second first turn.
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const STATES = new Set(['create-pending', 'create-unknown', 'create-rejected', 'created', 'room-pending', 'room-unknown', 'ready']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new DotError('INVALID_ARGUMENT', message); };
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') fail(`${label} must be an ID returned by the API.`);
  return value;
}
function options({ name = '', avatar = 'default', createAdditional = true } = {}) {
  if (typeof name !== 'string' || name.length > 100 || /[\0\r\n]/.test(name)) fail('name must be at most 100 characters without line breaks.');
  if (typeof avatar !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(avatar)) fail('avatar must be a legacy avatar name, such as default.');
  if (typeof createAdditional !== 'boolean') fail('createAdditional must be true or false.');
  return { display_name: name.trim(), avatar, create_thread: true, create_additional: createAdditional, should_initialize: true };
}
function filePath(value) {
  if (typeof value !== 'string' || !value || value === '-' || value.includes('\0')) fail('operationFile must be a local file path.');
  return resolve(value);
}
function identity(auth) {
  const accountId = auth?.accountId;
  let subject = auth?.userId;
  if (typeof subject !== 'string') {
    try { subject = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub; } catch { /* Fail below. */ }
  }
  if (typeof accountId !== 'string' || !ID.test(accountId) || typeof subject !== 'string' || !subject) throw new DotError('AUTH_IDENTITY_MISSING', 'Onboarding requires a Codex login with an account and user identity.');
  return { accountId, subjectHash: createHash('sha256').update(subject).digest('hex') };
}
function profile(value, expectedId) {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id) || expectedId != null && value.id !== expectedId) throw new DotError('INVALID_RESPONSE', 'The Dot profile did not match the requested identity.');
  id(value.id, 'Dot');
  const root = value.active_root_thread_id ?? value.root_thread_id;
  if (root != null) id(root, 'root thread');
  if (value.messaging_room_id != null) id(value.messaging_room_id, 'messaging room');
  return { id: value.id, rootThreadId: root ?? null, roomId: value.messaging_room_id ?? null,
    name: typeof value.display_name === 'string' ? value.display_name : null,
    avatar: typeof value.avatar === 'string' ? value.avatar : null,
    status: typeof value.status === 'string' ? value.status : null };
}
function validateJournal(value) {
  if (!object(value) || value.version !== 1 || value.kind !== 'dot-onboarding' || !STATES.has(value.state)
      || typeof value.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.operationId)
      || !object(value.identity) || typeof value.identity.subjectHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity.subjectHash)
      || !Array.isArray(value.beforeIds) || value.beforeIds.length > 2500 || !object(value.request)
      || Object.keys(value.request).some(key => !['display_name', 'avatar', 'create_thread', 'create_additional', 'should_initialize'].includes(key))) throw new DotError('INVALID_OPERATION_FILE', 'This is not a supported Dot onboarding operation file.');
  id(value.identity.accountId, 'operation account');
  for (const item of value.beforeIds) id(item, 'prior Dot');
  const expected = options({ name: value.request.display_name, avatar: value.request.avatar, createAdditional: value.request.create_additional });
  if (JSON.stringify(expected) !== JSON.stringify(value.request)) throw new DotError('INVALID_OPERATION_FILE', 'The onboarding request in the operation file is invalid.');
  if (value.dotId != null) id(value.dotId, 'operation Dot');
  if (value.rootThreadId != null) id(value.rootThreadId, 'operation root');
  if (value.roomId != null) id(value.roomId, 'operation room');
  if (['created', 'room-pending', 'room-unknown', 'ready'].includes(value.state) && (!value.dotId || !value.rootThreadId)) throw new DotError('INVALID_OPERATION_FILE', 'The operation file is missing its confirmed Dot and root identities.');
  return value;
}
async function readJournal(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new DotError('INVALID_OPERATION_FILE', 'The operation file must be a private regular file of at most 1 MiB.');
    const bytes = Buffer.alloc(1024 * 1024 + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new DotError('INVALID_OPERATION_FILE', 'The onboarding operation file changed while being read.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    return validateJournal(JSON.parse(text));
  } catch (error) {
    if (error instanceof DotError) throw error;
    throw new DotError('INVALID_OPERATION_FILE', 'Could not read a valid private, non-symlink onboarding operation file.');
  } finally { await handle?.close(); }
}
async function saveJournal(file, journal) {
  // Replace atomically in the same directory so an interrupted save leaves a
  // complete earlier state. No credentials or full server responses are saved.
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, file);
  } catch { throw new DotError('OPERATION_FILE_FAILED', 'Could not persist the onboarding result. Preserve this file and use onboarding status to reconcile before taking further action.', { delivery: 'unknown' }); }
  finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}
async function locked(file, work) {
  return withOperationLock(file, work, { busyCode: 'OPERATION_LOCKED', failedCode: 'OPERATION_FILE_FAILED', label: 'onboarding operation' });
}
function summary(journal, extra = {}) {
  return { operationId: journal.operationId, state: journal.state, dotId: journal.dotId ?? null,
    rootThreadId: journal.rootThreadId ?? null, roomId: journal.roomId ?? null,
    initialization: 'requested-with-create', ...(journal.failure ? { failure: failureDetails(journal.failure) } : {}), ...extra };
}
const CAUSE_CODES = new Set(['EDGE_CHALLENGE', 'AUTH_REJECTED', 'FORBIDDEN_HTML', 'FORBIDDEN', 'RATE_LIMITED', 'REDIRECT_BLOCKED', 'HTTP_ERROR', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE']);
const API_CODES = new Set(['cloud_aeon_deletion_pending', 'cloud_aeon_recovery_required', 'cloud_aeon_onboarding_config_unavailable', 'cloud_aeon_creation_state_unavailable']);
function failureDetails(error) {
  const details = error instanceof DotError ? error.details : error;
  const causeCode = error instanceof DotError ? error.code : error?.causeCode;
  return {
    ...(CAUSE_CODES.has(causeCode) ? { causeCode } : {}),
    ...(Number.isInteger(details?.status) && details.status >= 100 && details.status <= 599 ? { status: details.status } : {}),
    ...(API_CODES.has(details?.apiCode) ? { apiCode: details.apiCode } : {}),
    ...(details?.apiErrorFamily === 'cloud_aeon' ? { apiErrorFamily: 'cloud_aeon' } : {})
  };
}
const knownRejection = error => error instanceof DotError && (error.details?.delivery === 'not-sent'
  || [400, 401, 403, 404, 422, 429].includes(error.details?.status) && error.details?.apiErrorFamily !== 'cloud_aeon' && !error.details?.apiCode?.startsWith('cloud_aeon_')
  || error.details?.status === 409 && ['cloud_aeon_deletion_pending', 'cloud_aeon_recovery_required'].includes(error.details?.apiCode)
  || error.details?.status === 503 && ['cloud_aeon_onboarding_config_unavailable', 'cloud_aeon_creation_state_unavailable'].includes(error.details?.apiCode));

export class DotOnboarding {
  constructor(client) {
    if (typeof client?.transport?.request !== 'function') throw new TypeError('DotOnboarding requires a DotClient.');
    this.client = client; this.transport = client.transport;
  }
  async context(expected) {
    if (typeof this.transport.authLoader !== 'function') throw new DotError('AUTH_IDENTITY_MISSING', 'Onboarding requires a transport with a Codex authentication loader.');
    const load = () => this.transport.authLoader({ authFile: this.transport.authFile });
    const initial = identity(await load());
    if (expected && (expected.accountId !== initial.accountId || expected.subjectHash !== initial.subjectHash)) throw new DotError('ACCOUNT_CHANGED', 'This onboarding operation belongs to a different signed-in account or user.');
    const assert = async () => {
      const auth = await load(), current = identity(auth);
      if (current.accountId !== initial.accountId || current.subjectHash !== initial.subjectHash) throw new DotError('ACCOUNT_CHANGED', 'The signed-in account or user changed during onboarding.');
      this.transport.assertIdentity?.(auth);
    };
    return { identity: initial, request: async (method, route, options = {}) => {
      await assert(); options.signal?.throwIfAborted();
      return this.transport.request(method, route, { ...options, expectedAccountId: initial.accountId });
    }, assert };
  }
  async readEligibility(context, signal) {
    const result = await context.request('GET', '/backend-api/accounts/check/v4-2023-04-27', { signal });
    await context.assert();
    const selected = result?.accounts?.[context.identity.accountId]?.account;
    if (!object(selected)) throw new DotError('ACCOUNT_UNAVAILABLE', 'The selected Codex account was not returned by the eligibility check.');
    const config = selected.tbo_config;
    if (!object(config) || typeof config.tbo_available !== 'boolean') throw new DotError('INVALID_RESPONSE', 'The selected account did not return a valid Dot availability flag.');
    return { accountId: context.identity.accountId, available: config.tbo_available,
      planEligible: typeof config.plan_eligible === 'boolean' ? config.plan_eligible : null,
      waitlist: config.waitlist_info === 'NO_WAITLIST' ? 'none' : 'unknown',
      creationAuthorizationVerified: false };
  }
  async eligibility({ signal } = {}) {
    return this.readEligibility(await this.context(), signal);
  }
  async inventory(context, signal) {
    const values = [], ids = new Set(), cursors = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const value = await context.request('GET', '/backend-api/tbo', { query: { limit: 25, include_room_preview: false, cursor }, signal });
      if (!object(value) || !Array.isArray(value.items) || value.items.length > 100) throw new DotError('INVALID_RESPONSE', 'The Dot inventory response is invalid.');
      for (const item of value.items) {
        const candidate = profile(item);
        if (ids.has(candidate.id)) continue;
        ids.add(candidate.id); values.push(candidate);
      }
      if (!value.cursor) return values;
      if (typeof value.cursor !== 'string' || value.cursor.length > 8192 || /[\0\r\n]/.test(value.cursor) || cursors.has(value.cursor)) throw new DotError('CURSOR_LOOP', 'The Dot inventory returned an invalid or repeated cursor.');
      cursors.add(value.cursor); cursor = value.cursor;
    }
    throw new DotError('PAGE_LIMIT', 'The Dot inventory exceeded 100 pages.');
  }
  async create({ operationFile, signal, input: _stdin, ...input } = {}) {
    const request = options(input), file = filePath(operationFile);
    if (Object.keys(input).some(key => !['name', 'avatar', 'createAdditional'].includes(key))) fail('Unsupported onboarding option.');
    return locked(file, async () => {
      // Reserve the destination before even loading authentication or inventory.
      // A failed preflight can never create a Dot the operator cannot reconcile.
      let reservation;
      try { reservation = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
      catch (error) { throw new DotError(error?.code === 'EEXIST' ? 'OPERATION_EXISTS' : 'OPERATION_FILE_FAILED', 'Use a new writable operation file; existing files must be resumed instead of overwritten.'); }
      let journal;
      try {
        const context = await this.context();
        const eligibility = await this.readEligibility(context, signal);
        if (!eligibility.available) throw new DotError('DOT_UNAVAILABLE', 'Dot is not currently available for the selected account. No creation request was sent.');
        const before = await this.inventory(context, signal);
        journal = { version: 1, kind: 'dot-onboarding', operationId: randomUUID(), identity: context.identity,
          state: 'create-pending', request, beforeIds: before.map(value => value.id), createdAt: new Date().toISOString() };
        await reservation.writeFile(`${JSON.stringify(journal, null, 2)}\n`); await reservation.sync(); await reservation.close(); reservation = null;
        let result;
        try {
          result = profile(await context.request('POST', '/backend-api/tbo', { body: request, timeoutMs: 540000, signal }));
          if (!result.rootThreadId || journal.beforeIds.includes(result.id)) throw new DotError('INVALID_RESPONSE', 'Creation did not return a new Dot and its root thread.');
        } catch (error) {
          journal.state = knownRejection(error) ? 'create-rejected' : 'create-unknown';
          journal.failure = failureDetails(error);
          await saveJournal(file, journal);
          throw new DotError(journal.state === 'create-rejected' ? 'ONBOARDING_REJECTED' : 'ONBOARDING_CREATE_UNKNOWN', journal.state === 'create-rejected' ? 'The server rejected onboarding. The operation file is retained; creation was not retried.' : 'The creation result is uncertain. Use onboarding status and resume with an explicitly confirmed candidate; do not create another Dot.', { ...journal.failure, delivery: journal.state === 'create-rejected' ? 'rejected' : 'unknown', operationId: journal.operationId });
        }
        journal = { ...journal, state: 'created', dotId: result.id, rootThreadId: result.rootThreadId, roomId: result.roomId };
        await saveJournal(file, journal);
        return this.finish(context, file, journal, { signal });
      } finally {
        if (reservation) { await reservation.close(); if (!journal) await unlink(file).catch(() => {}); }
      }
    });
  }
  async current(context, journal, signal) {
    const value = profile(await context.request('GET', `/backend-api/tbo/${encodeURIComponent(journal.dotId)}`, { signal }), journal.dotId);
    if (!value.rootThreadId || value.rootThreadId !== journal.rootThreadId || journal.roomId && value.roomId && value.roomId !== journal.roomId) throw new DotError('STALE_TARGET', 'The Dot root or room changed since this onboarding operation.');
    return value;
  }
  async finish(context, file, journal, { signal } = {}) {
    let current = await this.current(context, journal, signal);
    if (!current.roomId) {
      journal = { ...journal, state: 'room-pending' }; await saveJournal(file, journal);
      try {
        const value = await context.request('POST', `/backend-api/tbo/${encodeURIComponent(journal.dotId)}/messaging-room`, { signal });
        if (!object(value) || value.id != null && value.id !== journal.dotId || value.root_thread_id != null && value.root_thread_id !== journal.rootThreadId || value.active_root_thread_id != null && value.active_root_thread_id !== journal.rootThreadId) throw new DotError('INVALID_RESPONSE', 'The room response did not confirm the created Dot.');
        journal.roomId = id(value.messaging_room_id, 'messaging room');
        await saveJournal(file, journal);
        current = await this.current(context, journal, signal);
        if (current.roomId !== journal.roomId) throw new DotError('INVALID_RESPONSE', 'The created messaging room is not reflected by the Dot profile yet.');
      } catch {
        journal.state = 'room-unknown'; await saveJournal(file, journal);
        throw new DotError('ONBOARDING_ROOM_UNKNOWN', 'The Dot exists, but its messaging room could not be confirmed. Use onboarding status or resume; creation will not be repeated.', { delivery: 'unknown', dotId: journal.dotId, rootThreadId: journal.rootThreadId });
      }
    }
    await context.assert();
    journal = { ...journal, state: 'ready', roomId: current.roomId, updatedAt: new Date().toISOString() };
    await saveJournal(file, journal);
    return summary(journal, { profileStatus: current.status, status: 'accepted', note: 'Server initialization was requested with creation. Messaging is available; no additional greeting or first turn was sent.' });
  }
  async status({ operationFile, signal } = {}) {
    const journal = await readJournal(filePath(operationFile)), context = await this.context(journal.identity);
    if (journal.dotId) {
      const current = await this.current(context, journal, signal);
      return summary(journal, { currentRoomId: current.roomId, profileStatus: current.status, canResume: journal.state !== 'ready' || current.roomId == null });
    }
    const candidates = (await this.inventory(context, signal)).filter(item => !journal.beforeIds.includes(item.id)).map(item => ({ dotId: item.id, rootThreadId: item.rootThreadId, roomId: item.roomId,
      name: item.name, avatar: item.avatar, matchesRequest: (!journal.request.display_name || item.name === journal.request.display_name) && item.avatar === journal.request.avatar }));
    return summary(journal, { candidates, canResume: candidates.some(item => item.matchesRequest && item.rootThreadId != null), creationWillNotBeReplayed: true });
  }
  async resume({ operationFile, dotId, confirmDotId, retryRoom = false, signal } = {}) {
    const file = filePath(operationFile);
    if (typeof retryRoom !== 'boolean') fail('retryRoom must be true or false.');
    if (dotId != null) id(dotId, 'dotId');
    if (dotId != null && confirmDotId !== dotId || dotId == null && confirmDotId != null) fail('An uncertain creation candidate requires dotId and exact confirmDotId.');
    return locked(file, async () => {
      let journal = await readJournal(file); const context = await this.context(journal.identity);
      if (!journal.dotId) {
        if (dotId == null) throw new DotError('ONBOARDING_CONFIRM_REQUIRED', 'Inspect onboarding status, then resume with the new Dot ID and exact confirmation. Creation is never replayed.');
        const candidate = (await this.inventory(context, signal)).find(item => item.id === dotId && !journal.beforeIds.includes(item.id));
        if (!candidate || !candidate.rootThreadId || journal.request.display_name && candidate.name !== journal.request.display_name || candidate.avatar !== journal.request.avatar) throw new DotError('ONBOARDING_CANDIDATE_MISMATCH', 'The confirmed Dot is not a new candidate matching this onboarding operation.');
        journal = { ...journal, state: 'created', dotId, rootThreadId: candidate.rootThreadId, roomId: candidate.roomId };
        await saveJournal(file, journal);
      } else if (dotId != null && dotId !== journal.dotId) throw new DotError('IDENTITY_MISMATCH', 'This operation already belongs to a different Dot.');
      const current = await this.current(context, journal, signal);
      if (['room-pending', 'room-unknown'].includes(journal.state) && !current.roomId && !retryRoom) throw new DotError('ONBOARDING_ROOM_RETRY_REQUIRED', 'The prior room request is uncertain and no room is visible yet. Inspect again, or explicitly enable retryRoom to request room creation once more.');
      return this.finish(context, file, journal, { signal });
    });
  }
}
