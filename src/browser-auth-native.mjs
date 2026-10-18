import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { DotError } from './errors.mjs';
import { writePrivate } from './store.mjs';
import { withOperationLock } from './operation-lock.mjs';

// Native contracts: app-initial-90eb42395b7d.js (G6t/E8t, RKc/BKc/jKc),
// app-primary-b4ce9e46e8cf.js (iCt), app-shared-52443cbe9ac4.js (s8e).
const ROOT = '/backend-api/flora/browser';
const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
const FIELD = /^[A-Za-z0-9_-]{1,48}$/;
const BLOCKED = ['__proto__', 'constructor', 'prototype'];
const FILL = ['submitted', 'declined', 'cancelled', 'unavailable', 'expired', 'origin_changed', 'page_changed', 'locator_invalid', 'submission_failed', 'unknown'];
const SAVE = ['not_requested', 'saved', 'failed', 'unknown'];
const MANAGER = ['waiting', 'approved', 'declined', 'denied', 'expired', 'failed', 'cancelled'];
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new DotError(code, message, details); };
function id(value, name) { if (typeof value !== 'string' || !ID.test(value) || ['.', '..'].includes(value)) fail('INVALID_ARGUMENT', `Use a valid ${name}.`); return value; }
function origin(value) { let url; try { url = new URL(value); } catch {} if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) fail('INVALID_ARGUMENT', 'Use the exact canonical web origin shown by the current sign-in request.'); return value; }
function path(value) { if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) fail('INVALID_ARGUMENT', 'Choose a private operation state file.'); return resolve(value); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bounded(value, max = 4096) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function fieldId(value) { return typeof value === 'string' && FIELD.test(value) && !BLOCKED.includes(value); }
function safeStatus(value, expected, defaultSave = 'not_requested', requireEcho = false) {
  if (!record(value) || requireEcho && value.operation_id !== expected || value.operation_id != null && value.operation_id !== expected || !FILL.includes(value.fill_status ?? value.status) || value.save_status != null && !SAVE.includes(value.save_status)) fail('INVALID_RESPONSE', 'The browser-auth operation response is invalid or belongs to another operation.');
  return { fillStatus: value.fill_status ?? value.status, saveStatus: value.save_status ?? defaultSave };
}
function approvalUrl(value) {
  let url; try { url = new URL(value); } catch {}
  if (!url || value.length > 32768 || url.protocol !== 'onepassword:' || url.hostname !== 'grant-brokered-access' || url.username || url.password || url.port || url.pathname || url.hash
    || [...url.searchParams.keys()].length !== 1 || !/^[A-Za-z0-9_-]+$/.test(url.searchParams.get('access_request_reference') ?? '')) fail('INVALID_RESPONSE', 'The password manager returned an unsupported approval link.');
  return url.href;
}
async function inspectDefault(client, options) { const { inspectBrowserChallenge } = await import('./native-actions.mjs'); return inspectBrowserChallenge(client, options); }
async function openDefault(url) {
  return new Promise((accept, reject) => {
    const child = spawn('open', [url], { stdio: 'ignore' }); child.once('error', () => reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the password manager.')));
    child.once('exit', code => code === 0 ? accept() : reject(new DotError('BROWSER_OPEN_FAILED', 'Could not open the password manager.')));
  });
}
async function boundedRead(handle, limit = 65536, signal) {
  const buffer = Buffer.alloc(limit + 1); let length = 0;
  try {
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const value = await handle.read(buffer, length, buffer.length - length, length);
      signal?.throwIfAborted();
      if (value.bytesRead === 0) break; length += value.bytesRead;
    }
    return buffer.subarray(0, length);
  } catch (error) { buffer.fill(0); throw error; }
}
async function privateInput(file, input, signal) {
  signal?.throwIfAborted();
  if (!bounded(file)) fail('INVALID_ARGUMENT', 'Provide a private credential file or pipe via -.');
  let bytes, handle; const chunks = [];
  try {
    if (file === '-') {
      if (!input || input.isTTY || typeof input[Symbol.asyncIterator] !== 'function') fail('PRIVATE_INPUT_REQUIRED', 'Pipe credentials from a private source; terminal input can echo them.');
      let iterator, length = 0, finished = false, rejectAbort;
      const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
      interrupted.catch(() => {});
      const abort = () => { rejectAbort(signal.reason); try { input.destroy?.(); } catch {} };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        iterator = input[Symbol.asyncIterator]();
        while (true) {
          signal?.throwIfAborted();
          const next = await (signal ? Promise.race([iterator.next(), interrupted]) : iterator.next());
          signal?.throwIfAborted();
          if (next.done) { finished = true; break; }
          // Buffer.from(ArrayBuffer) aliases the caller's memory. Keep an
          // owned copy so wiping private input never changes source chunks.
          const value = Buffer.from(Buffer.from(next.value)); chunks.push(value); length += value.length;
          if (length > 65536) fail('PRIVATE_INPUT_INVALID', 'Private input exceeds 64 KiB.');
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        // Arbitrary iterators can stall in return() as well as next(). Release
        // their input without allowing cleanup to delay cancellation.
        if (!finished) { try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {} }
      }
      bytes = Buffer.concat(chunks);
    } else {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); signal?.throwIfAborted();
      const stat = await handle.stat(); signal?.throwIfAborted();
      if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('PRIVATE_INPUT_REQUIRED', 'Credential input must be a small owner-only regular file.');
      bytes = await boundedRead(handle, 65536, signal); if (bytes.length > 65536) fail('PRIVATE_INPUT_INVALID', 'Private input exceeds 64 KiB.');
      const after = await handle.stat(); signal?.throwIfAborted();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('PRIVATE_INPUT_INVALID', 'Private credential input changed while it was read.');
    }
    signal?.throwIfAborted();
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('PRIVATE_INPUT_INVALID', 'Credential input must be valid UTF-8 JSON.'); }
    if (!record(value) || Object.keys(value).length > 6 || Object.entries(value).some(([key, field]) => !fieldId(key) || typeof field !== 'string' || field.length > 16384 || field.includes('\0'))) fail('PRIVATE_INPUT_INVALID', 'Credential input must map up to six offered field IDs to string values.');
    return value;
  } catch (error) { if (signal?.aborted) throw signal.reason; if (error instanceof DotError) throw error; fail('PRIVATE_INPUT_UNREADABLE', 'Cannot read the selected private credential input.'); }
  finally {
    bytes?.fill(0); for (const chunk of chunks) chunk.fill(0);
    try { await handle?.close(); }
    catch { if (signal?.aborted) throw signal.reason; fail('PRIVATE_INPUT_UNREADABLE', 'Cannot close the selected private credential input.'); }
  }
}
async function lock(file, fn) { return withOperationLock(path(file), fn); }
async function privateJson(file, { allowMissing = false } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.mode & 0o077 || before.size > 65536 || process.getuid && before.uid !== process.getuid()) fail('INVALID_STATE', 'Operation state must be a small owner-only regular file.');
    const bytes = await boundedRead(handle); const after = await handle.stat();
    if (bytes.length > 65536 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('INVALID_STATE', 'The private operation state changed while being read.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; if (error instanceof DotError) throw error; fail('INVALID_STATE', 'Cannot read the private operation state.'); }
  finally { await handle?.close(); }
}
async function load(file, options) {
  const state = await privateJson(file, options); if (state == null && options?.allowMissing) return null;
  if (!record(state) || state.version !== 1 || !record(state.identity) || !record(state.context) || !ID.test(state.operationId ?? '')
    || !['claimed', 'submitting', 'settled', 'manager_starting', 'manager_waiting', 'manager_approved', 'manager_terminal'].includes(state.phase)
    || !bounded(state.identity.accountId) || !bounded(state.identity.subject) || !bounded(state.context.requestFingerprint)) fail('INVALID_STATE', 'The operation state is invalid.');
  origin(state.context.origin); return state;
}
async function canonical(file) { file = path(file); return join(await realpath(dirname(file)), basename(file)); }
function defaultLedger() { return (process.env.DOTTER_STATE_DIR || process.env.DOT_CLI_STATE_DIR) ? join(process.env.DOTTER_STATE_DIR || process.env.DOT_CLI_STATE_DIR, 'browser-auth-claims') : platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'dot-cli', 'browser-auth-claims') : join(homedir(), '.local', 'state', 'dot-cli', 'browser-auth-claims'); }
function claimKey(state) { return digest([state.identity.accountId, state.identity.subject, state.context.origin, state.context.threadId, state.context.challengeId]); }
function output(state, file) {
  return { stateFile: file, operationId: state.operationId, accountId: state.identity.accountId, conversationId: state.context.threadId,
    challengeId: state.context.challengeId, origin: state.context.origin, phase: state.phase, fillStatus: state.fillStatus ?? 'unknown', saveStatus: state.saveStatus ?? 'not_requested',
    ...(state.manager ? { provider: state.manager.provider, managerStatus: state.manager.status, approvalAvailable: Boolean(state.manager.approvalUrl), expiresAt: state.manager.expiresAt } : {}),
    recoveryAvailable: state.recoveryAvailable === true,
    ...(state.phase === 'manager_starting' ? { recovery: { supported: false, reason: 'manager_receipt_missing', requestMayHaveStarted: true, canResubmit: false, nextAction: 'Review the original request in the native app or password manager. Start again only for a new browser-auth challenge.' } } : {}) };
}
function context(value) {
  if (!record(value) || !bounded(value.requestFingerprint) || !ID.test(value.requestId ?? '') || !ID.test(value.threadId ?? '') || !/^[A-Za-z0-9_-]{32,128}$/.test(value.challengeId ?? '')
    || !Array.isArray(value.fields) || value.fields.length > 6 || value.fields.some(field => !record(field) || !fieldId(field.id) || !['email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(field.type) || typeof field.required !== 'boolean')) fail('INVALID_RESPONSE', 'The current request does not contain a supported browser-auth challenge.');
  origin(value.origin);
  const fields = value.fields.map(field => ({ id: field.id, type: field.type, required: field.required }));
  if (new Set(fields.map(field => field.id)).size !== fields.length) fail('INVALID_RESPONSE', 'The challenge has duplicate field IDs.');
  const options = value.options ?? [];
  if (!Array.isArray(options) || options.length > 10 || options.some(option => !record(option) || !fieldId(option.id) || !Array.isArray(option.fieldIds) || option.fieldIds.length > 6 || option.fieldIds.some(name => !fields.some(field => field.id === name)))) fail('INVALID_RESPONSE', 'The challenge has invalid field options.');
  return { roomId: id(value.roomId, 'room ID'), messageId: id(value.messageId, 'message ID'), requestId: value.requestId, threadId: value.threadId, challengeId: value.challengeId,
    requestFingerprint: value.requestFingerprint, origin: value.origin, fields, options: options.map(option => ({ id: option.id, fieldIds: option.fieldIds })),
    hasWebauthn: value.hasWebauthn === true, qrCodeRequiresApp: value.qrCodeRequiresApp === true };
}
function currentMatches(state, current) { if (digest(state.context) !== digest(context(current))) fail('STALE_ACTION', 'The sign-in challenge, origin, or field bindings changed. Inspect and claim the new request.'); }
function chosenFields(state, values, selectedOption) {
  const { fields, options } = state.context;
  const choice = selectedOption == null ? null : options.find(option => option.id === selectedOption);
  if (options.length && !choice || selectedOption != null && !choice) fail('INVALID_ARGUMENT', 'Choose an option offered by this sign-in request.');
  const active = choice ? fields.filter(field => choice.fieldIds.includes(field.id)) : fields;
  if (!active.length) fail('NATIVE_HANDOFF_REQUIRED', 'This sign-in request requires its native or QR handoff; it has no credential fields.');
  if (Object.keys(values).some(name => !active.some(field => field.id === name)) || active.some(field => field.required && (!Object.hasOwn(values, field.id) || values[field.id] === ''))) fail('PRIVATE_INPUT_INVALID', 'Private input must include the required fields and only fields for the selected option.');
  return active;
}

export class DotBrowserAuthNative {
  constructor(client, { inspect = inspectDefault, now = Date.now, openApproval = openDefault, ledgerDirectory = defaultLedger() } = {}) { this.client = client; this.transport = client.transport; this.inspect = inspect; this.now = now; this.openApproval = openApproval; this.ledgerDirectory = resolve(ledgerDirectory); }
  async ledgerPath(state) {
    await mkdir(this.ledgerDirectory, { recursive: true, mode: 0o700 }); const stat = await lstat(this.ledgerDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail('INVALID_STATE', 'The shared claim directory must be a private directory owned by this user.');
    return join(await realpath(this.ledgerDirectory), `${claimKey(state)}.json`);
  }
  async ledger(state, file) {
    const ledgerFile = await this.ledgerPath(state), value = await privateJson(ledgerFile);
    if (!record(value) || value.version !== 1 || value.scope !== claimKey(state) || value.operationId !== state.operationId && value.previousOperationId !== state.operationId || value.stateFile !== await canonical(file)) fail('CHALLENGE_ALREADY_CLAIMED', 'This challenge is bound to a different private operation state.', { stateFile: record(value) && bounded(value.stateFile) ? value.stateFile : undefined });
    return { file: ledgerFile, value };
  }
  async loadState(file, options) {
    const state = await load(file, options); if (!state) return null;
    const { value } = await this.ledger(state, file), hash = digest(state);
    if (value.stateHash !== hash && value.pendingHash !== hash) fail('INVALID_STATE', 'The private operation state does not match its independent claim ledger.');
    return state;
  }
  async identity(expectedAccountId) {
    if (typeof this.transport?.authLoader !== 'function') fail('AUTH_REQUIRED', 'Browser sign-in requires an authenticated Codex identity.');
    const auth = await this.transport.authLoader({ authFile: this.transport.authFile });
    if (!record(auth) || !bounded(auth.accessToken, 65536)) fail('AUTH_REQUIRED', 'Browser sign-in requires an authenticated Codex identity.');
    this.transport.assertIdentity?.(auth);
    if (!auth.accountId || expectedAccountId != null && auth.accountId !== expectedAccountId) fail('ACCOUNT_CHANGED', 'The selected browser-auth account differs from the current login.');
    let claims; try { claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); } catch {}
    const authClaims = claims?.['https://api.openai.com/auth'];
    if (!bounded(claims?.sub)) fail('AUTH_IDENTITY_REQUIRED', 'Browser sign-in requires a verifiable signed-in user identity.');
    return { accountId: auth.accountId, subject: claims.sub, accountUserId: authClaims?.chatgpt_account_user_id ?? authClaims?.account_user_id ?? null };
  }
  async checkIdentity(state, expected) { const identity = await this.identity(expected ?? state.identity.accountId); if (identity.accountId !== state.identity.accountId || identity.subject !== state.identity.subject || identity.accountUserId !== state.identity.accountUserId) fail('ACCOUNT_CHANGED', 'This sign-in operation belongs to another signed-in identity.'); return identity; }
  async inspectChallenge(options = {}) { const identity = await this.identity(options.expectedAccountId); const result = await this.inspect(this.client, { ...options, expectedAccountId: identity.accountId }); context(result); return result; }
  async current(state, signal) { await this.checkIdentity(state); const value = await this.inspect(this.client, { ...state.context, expectedAccountId: state.identity.accountId, signal }); currentMatches(state, value); return value; }
  async request(state, method, route, options = {}) { await this.checkIdentity(state); return this.transport.request(method, ROOT + route, { ...options, expectedAccountId: state.identity.accountId }); }
  async save(file, state, { previousOperationId } = {}) {
    const ledger = await this.ledger(previousOperationId ? { ...state, operationId: previousOperationId } : state, file), next = { ...ledger.value, operationId: state.operationId, ...(previousOperationId ? { previousOperationId } : {}), pendingHash: digest(state) };
    await writePrivate(ledger.file, JSON.stringify(next), { overwrite: true });
    await writePrivate(file, JSON.stringify(state), { overwrite: true });
    await writePrivate(ledger.file, JSON.stringify({ ...next, previousOperationId: null, stateHash: next.pendingHash, pendingHash: null }), { overwrite: true });
  }
  async saveReceipt(file, state, options = {}) {
    try { await this.save(file, state, options); }
    catch {
      let recoveryStateFile;
      try {
        let ledger; try { ledger = await this.ledger(state, file); } catch { ledger = await this.ledger({ ...state, operationId: options.previousOperationId }, file); }
        const backup = `${file}.recovery-${randomUUID()}`;
        await writePrivate(backup, JSON.stringify(state));
        await writePrivate(ledger.file, JSON.stringify({ ...ledger.value, operationId: state.operationId, stateFile: await canonical(backup), stateHash: digest(state), pendingHash: null }), { overwrite: true });
        recoveryStateFile = backup;
      } catch { /* Never expose a received credential capability as a fallback. */ }
      fail('AUTH_RECEIPT_NOT_SAVED', 'The service replied, but its private receipt could not be saved at the requested path. Continue from the recovery state file if supplied; do not repeat the submission.', {
        operationId: state.operationId, phase: state.phase, fillStatus: state.fillStatus, saveStatus: state.saveStatus, delivery: 'received', ...(recoveryStateFile ? { recoveryStateFile } : { nativeReviewRequired: true }) });
    }
  }
  async claim(options = {}) {
    if (!bounded(options.requestFingerprint)) fail('INVALID_ARGUMENT', 'Use the fingerprint from inspecting this request.'); origin(options.expectedOrigin);
    return lock(options.stateFile, async file => {
      let existing = await this.loadState(file, { allowMissing: true });
      if (existing) { await this.checkIdentity(existing, options.expectedAccountId); await this.current(existing, options.signal); if (existing.context.requestFingerprint !== options.requestFingerprint || existing.context.origin !== options.expectedOrigin || existing.context.roomId !== options.roomId || existing.context.messageId !== options.messageId) fail('INVALID_STATE', 'This operation state belongs to another request.'); return output(existing, file); }
      const identity = await this.identity(options.expectedAccountId), inspected = await this.inspect(this.client, { ...options, expectedAccountId: identity.accountId });
      const selected = context(inspected);
      if (selected.requestFingerprint !== options.requestFingerprint || selected.origin !== options.expectedOrigin) fail('STALE_ACTION', 'The request fingerprint or origin changed.');
      const prepared = await this.transport.request('POST', ROOT + '/auth/prepare', { body: { conversation_id: selected.threadId, challenge_id: selected.challengeId }, expectedAccountId: identity.accountId, signal: options.signal });
      if (!record(prepared) || typeof prepared.manual_fill_recovery_supported !== 'boolean' || !Array.isArray(prepared.password_managers)) fail('INVALID_RESPONSE', 'The service did not prepare the current browser-auth challenge.');
      let state = { version: 1, identity, context: selected, operationId: randomUUID(), phase: 'claimed', createdAt: this.now(), fillStatus: 'unknown', saveStatus: 'not_requested', recoveryAvailable: false };
      if (prepared?.operation != null) {
        id(prepared.operation_id, 'existing operation ID');
        const previous = safeStatus(prepared.operation, prepared.operation_id, 'not_requested', true);
        state = { ...state, operationId: prepared.operation_id, ...previous, phase: previous.fillStatus === 'unknown' ? 'submitting' : 'settled', recoveryAvailable: true };
      }
      await this.checkIdentity(state);
      const ledgerFile = await this.ledgerPath(state), stateFile = await canonical(file);
      try {
        // writePrivate fully writes and syncs an O_EXCL temporary file, then
        // links it into place without overwrite. Competing readers therefore
        // see a complete claim, never a partially written lock record.
        await writePrivate(ledgerFile, JSON.stringify({ version: 1, scope: claimKey(state), operationId: state.operationId, stateFile, stateHash: digest(state), pendingHash: null }));
      } catch (error) {
        if (!['EEXIST', 'OUTPUT_EXISTS'].includes(error.code)) throw error;
        const prior = await privateJson(ledgerFile);
        if (prior.stateFile !== stateFile) fail('CHALLENGE_ALREADY_CLAIMED', 'This challenge already has a durable operation. Continue using its original state file.', { stateFile: prior.stateFile, operationId: prior.operationId });
        fail('CLAIM_RECOVERY_REQUIRED', 'A durable claim already exists but its state file is missing. Recover that original operation instead of creating another.', { stateFile: prior.stateFile, operationId: prior.operationId });
      }
      await writePrivate(file, JSON.stringify(state)); return output(state, file);
    });
  }
  async state({ stateFile, expectedAccountId } = {}) { const file = path(stateFile), state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); return output(state, file); }
  async availability(state, signal) {
    const value = await this.request(state, 'GET', '/credential-availability', { query: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId }, headers: { 'X-OpenAI-Cloud-Vault-Check-Trigger': 'explicit_recheck', 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2' }, signal });
    if (!record(value) || !['available', 'save_enabled', 'reuse_enabled'].every(key => typeof value[key] === 'boolean') || !Array.isArray(value.items)) fail('INVALID_RESPONSE', 'The service did not return current credential availability.');
    return value;
  }
  assertClaimed(state) { if (state.phase !== 'claimed') fail('OPERATION_ALREADY_ATTEMPTED', 'This operation has already been attempted. Inspect its status or recover it; do not resend credentials.'); }
  async submit(file, state, body, signal) {
    state = { ...state, phase: 'submitting', submittedAt: this.now() }; await this.save(file, state);
    let result;
    try { result = await this.request(state, 'POST', '/form-fill', { body, signal, timeoutMs: body.password_manager_access ? 130000 : 30000 }); await this.checkIdentity(state); result = safeStatus(result, state.operationId, state.saveStatus); }
    catch { fail('AUTH_SUBMISSION_UNCONFIRMED', 'The sign-in request may have been delivered. Inspect or recover this operation before another attempt.', { operationId: state.operationId, delivery: 'unknown' }); }
    state = { ...state, phase: 'settled', ...result }; if (state.manager) state.manager = { provider: state.manager.provider, status: state.manager.status, expiresAt: state.manager.expiresAt };
    await this.saveReceipt(file, state); return output(state, file);
  }
  async fill({ stateFile, credentialsFile, selectedOption, remember = false, input = process.stdin, expectedAccountId, signal } = {}) {
    if (typeof remember !== 'boolean') fail('INVALID_ARGUMENT', 'remember must be boolean.');
    const values = await privateInput(credentialsFile, input, signal); signal?.throwIfAborted();
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); this.assertClaimed(state); await this.current(state, signal);
      chosenFields(state, values, selectedOption); const available = await this.availability(state, signal);
      let saveFields;
      if (remember) { saveFields = available?.manual_save_fields; if (available?.available !== true || available.save_enabled !== true || available.manual_save_supported !== true || !record(saveFields) || !fieldId(saveFields.password) || !Object.hasOwn(values, saveFields.password) || saveFields.username != null && (!fieldId(saveFields.username) || !Object.hasOwn(values, saveFields.username)) || saveFields.username === saveFields.password) fail('SAVE_UNAVAILABLE', 'The current challenge does not permit saving these exact credential fields.'); }
      state = { ...state, recoveryAvailable: remember || available?.available === true && available.manual_fill_recovery_supported === true, saveStatus: remember ? 'unknown' : 'not_requested' };
      const body = { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, fields: values,
        ...(selectedOption == null ? {} : { selected_option: selectedOption }), ...(state.recoveryAvailable ? { operation_id: state.operationId } : {}), ...(remember ? { remember: true, save_fields: { ...(saveFields.username == null ? {} : { username: saveFields.username }), password: saveFields.password } } : {}) };
      return this.submit(file, state, body, signal);
    });
  }
  async reuse({ stateFile, credentialId, expectedAccountId, signal } = {}) {
    id(credentialId, 'credential ID');
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); this.assertClaimed(state); await this.current(state, signal);
      let data = await this.availability(state, signal), match, cursor; const seen = new Set();
      if (data?.available !== true || data.reuse_enabled !== true) fail('REUSE_UNAVAILABLE', 'Saved credential reuse is unavailable for this challenge.');
      for (let page = 0; page < 100; page++) {
        if (!Array.isArray(data.items)) fail('INVALID_RESPONSE', 'The service did not return credential candidates.');
        for (const candidate of data.items) if (candidate.credential_id === credentialId) { if (match) fail('CREDENTIAL_AMBIGUOUS', 'This credential ID has multiple selections; refresh the candidate list.'); match = candidate; }
        cursor = data.next_cursor; if (cursor == null) break; if (!bounded(cursor) || seen.has(cursor)) fail('INVALID_RESPONSE', 'Credential pagination returned an invalid cursor.'); seen.add(cursor);
        if (page === 99) fail('CANDIDATE_LIMIT', 'Credential selection exceeded the bounded page limit.');
        data = await this.request(state, 'POST', '/credential-candidates', { body: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, cursor }, headers: { 'X-OpenAI-Cloud-Vault-Credential-Fields-Version': '2' }, signal });
      }
      if (!match || match.origin !== state.context.origin || !bounded(match.selection_id) || !Number.isFinite(match.expires_at) || match.expires_at * 1000 <= this.now()) fail('CREDENTIAL_UNAVAILABLE', 'That credential has no current selection for the exact challenge origin.');
      state = { ...state, selectionId: match.selection_id, recoveryAvailable: true }; await this.current(state, signal);
      return this.submit(file, state, { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, operation_id: state.operationId, saved_credential_selection_id: match.selection_id }, signal);
    });
  }
  async recover({ stateFile, expectedAccountId, signal } = {}) {
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId);
      // iCt starts without an operation id; its status endpoint requires the returned access_handle.
      // LKc auth/prepare exposes fill status only, not a lost manager-start receipt.
      if (state.phase === 'manager_starting') fail('PASSWORD_MANAGER_RECOVERY_UNAVAILABLE', 'The 1Password access request may have started, but its private server receipt was not saved. The status API requires that receipt, so this request cannot be safely resumed or started again. Review it in the native app or password manager; start again only for a new browser-auth challenge.', { operationId: state.operationId, phase: state.phase, delivery: 'unknown', requestMayHaveStarted: true, remoteOperationIdKnown: false, canResubmit: false, nativeReviewRequired: true });
      if (!['submitting', 'settled'].includes(state.phase)) fail('INVALID_STATE', 'Only an attempted fill can be reconciled.');
      if (!state.recoveryAvailable) fail('RECOVERY_UNAVAILABLE', 'The service did not enable recovery for this manual fill. It will not be resubmitted.');
      const result = safeStatus(await this.request(state, 'POST', `/credential-operations/${encodeURIComponent(state.operationId)}/reconcile`, { body: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, ...(state.selectionId ? { selection_id: state.selectionId } : {}) }, signal }), state.operationId, state.saveStatus, true);
      state = { ...state, phase: 'settled', fillStatus: result.fillStatus === 'unknown' ? state.fillStatus : result.fillStatus, saveStatus: result.saveStatus === 'unknown' ? state.saveStatus : result.saveStatus };
      await this.save(file, state); return output(state, file);
    });
  }
  managerResponse(value, state, initial = false) {
    const expiresAt = value?.expires_at ?? (!initial ? state.manager?.expiresAt : undefined);
    if (!record(value) || value.provider !== 'onepassword' || !MANAGER.includes(value.state) || !bounded(value.access_handle) || !ID.test(value.operation_id ?? '') || !Number.isFinite(expiresAt)
      || !initial && (value.access_handle !== state.manager.accessHandle || value.operation_id !== state.operationId)) fail('INVALID_RESPONSE', 'The password-manager response belongs to another request or has an invalid status.');
    return { provider: 'onepassword', status: value.state, accessHandle: value.access_handle, expiresAt, ...(value.state === 'waiting' ? { approvalUrl: approvalUrl(value.approval_url ?? (!initial ? state.manager.approvalUrl : undefined)) } : {}) };
  }
  async startManager({ stateFile, expectedAccountId, signal } = {}) {
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); this.assertClaimed(state); await this.current(state, signal);
      if (!bounded(state.identity.accountUserId)) fail('ACCOUNT_USER_REQUIRED', 'The Codex token does not expose the account-user identity required by this password manager.');
      const prepare = await this.request(state, 'POST', '/auth/prepare', { body: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId }, signal });
      if (!prepare?.password_managers?.some(manager => manager.provider === 'onepassword' && manager.interaction === 'external' && manager.state === 'connected')) fail('PASSWORD_MANAGER_UNAVAILABLE', '1Password is not connected for this challenge.');
      state = { ...state, phase: 'manager_starting' }; await this.save(file, state);
      let value, manager; try { value = await this.request(state, 'POST', '/password-managers/onepassword/access-requests', { body: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, expected_account_user_id: state.identity.accountUserId }, signal, timeoutMs: 65000 }); manager = this.managerResponse(value, state, true); }
      catch { fail('AUTH_SUBMISSION_UNCONFIRMED', 'The password-manager request may have started. Its private server receipt is unavailable; inspect this operation and review the original request in the native app or password manager. Do not start it again.', { delivery: 'unknown', operationId: state.operationId, phase: 'manager_starting', remoteOperationIdKnown: false, canResubmit: false, nativeReviewRequired: true }); }
      const previousOperationId = state.operationId;
      state = { ...state, manager, operationId: value.operation_id, recoveryAvailable: true, phase: manager.status === 'approved' ? 'manager_approved' : manager.status === 'waiting' ? 'manager_waiting' : 'manager_terminal' };
      await this.saveReceipt(file, state, { previousOperationId }); return output(state, file);
    });
  }
  async managerStatusInternal(file, state, signal) {
    if (state.phase === 'manager_terminal') return state;
    if (state.phase === 'manager_starting') fail('PASSWORD_MANAGER_RECOVERY_UNAVAILABLE', 'This password-manager request may have started, but the private receipt required for its status is missing. Review the original request in the native app or password manager; do not start it again.', { phase: state.phase, delivery: 'unknown', remoteOperationIdKnown: false, canResubmit: false, nativeReviewRequired: true });
    if (!['manager_waiting', 'manager_approved'].includes(state.phase)) fail('INVALID_STATE', 'This operation has no active password-manager access request.');
    await this.current(state, signal);
    if (state.manager.expiresAt * 1000 <= this.now()) { state = { ...state, phase: 'manager_terminal', manager: { provider: state.manager.provider, expiresAt: state.manager.expiresAt, status: 'expired' } }; await this.save(file, state); return state; }
    const value = await this.request(state, 'POST', '/password-managers/onepassword/access-requests/status', { body: { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, expected_account_user_id: state.identity.accountUserId, access_handle: state.manager.accessHandle }, signal, timeoutMs: 65000 });
    const manager = this.managerResponse(value, state); state = { ...state, manager, phase: manager.status === 'approved' ? 'manager_approved' : manager.status === 'waiting' ? 'manager_waiting' : 'manager_terminal' };
    if (state.phase === 'manager_terminal') state.manager = { provider: manager.provider, status: manager.status, expiresAt: manager.expiresAt };
    await this.save(file, state); return state;
  }
  async managerStatus({ stateFile, expectedAccountId, signal } = {}) { return lock(stateFile, async file => { let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); return output(await this.managerStatusInternal(file, state, signal), file); }); }
  async openManagerApproval({ stateFile, expectedAccountId, signal } = {}) {
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); state = await this.managerStatusInternal(file, state, signal);
      if (state.phase !== 'manager_waiting' || state.manager.expiresAt * 1000 <= this.now()) fail('APPROVAL_UNAVAILABLE', 'This password-manager approval is no longer pending.');
      await this.openApproval(approvalUrl(state.manager.approvalUrl)); return { ...output(state, file), approvalOpened: true };
    });
  }
  async useManager({ stateFile, expectedAccountId, signal } = {}) {
    return lock(stateFile, async file => {
      let state = await this.loadState(file); await this.checkIdentity(state, expectedAccountId); state = await this.managerStatusInternal(file, state, signal);
      if (state.phase !== 'manager_approved') fail('APPROVAL_REQUIRED', 'Approve this exact request in 1Password before using it.');
      return this.submit(file, state, { conversation_id: state.context.threadId, challenge_id: state.context.challengeId, operation_id: state.operationId, password_manager_access: { provider: 'onepassword', access_handle: state.manager.accessHandle } }, signal);
    });
  }
}

export function browserAuthNativeCapabilities() {
  return { browserAuthNative: ['verified challenge inspection', 'private operation claim/state/reconcile', 'private manual form fill', 'explicit credential saving', 'saved credential reuse', '1Password access request/status/approval/fill'],
    abandonedLocks: 'Verified same-host locks are reclaimed only after their owner PID is confirmed absent; unknown or interrupted recovery guards require review.',
    passwordManagerRecovery: 'An interrupted start without its private access-handle receipt cannot be resumed or replayed; review it in the native app.',
    nativeProofs: 'Passkeys, hardware assertions and SIWC proofs must be completed by the native provider; no fabricated or imported proofs.', browserAuthNativeLiveTested: false };
}
