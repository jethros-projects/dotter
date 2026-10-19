import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FullDotClient } from './advanced.mjs';
import { LibraryContent } from './library-content.mjs';
import { LibraryProviders } from './library-providers.mjs';
import { DotPlugins } from './plugins.mjs';
import { Transport } from './transport.mjs';
import { loadAuth } from './auth.mjs';
import { validateRoom, validateMessageId, validateSendContext } from './client.mjs';
import { DotterError, sdkError } from './sdk-error.mjs';
import { createGuards } from './sdk-guards.mjs';
import { createSubscription } from './subscription.mjs';

const TARGET = ['roomId', 'dotId'];
// These native outputs own an atomic local commit and awaited cleanup. Keep
// their receipts even if cancellation arrives just after that commit.
const ATOMIC_OUTPUTS = new Set([
  FullDotClient.prototype.exportHistory, FullDotClient.prototype.download,
  LibraryContent.prototype.download, LibraryContent.prototype.content,
  LibraryContent.prototype.thumbnail, LibraryContent.prototype._saveAsset,
  LibraryContent.prototype.deepResearchExport,
  LibraryProviders.prototype.referenceThumbnail, DotPlugins.prototype.exportArchive,
]);
function invalid(message) { throw new DotterError('INVALID_ARGUMENT', message); }
function object(value, allowed, name = 'Input') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${name} must be an object.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${name} contains an unsupported field.`);
}
function duration(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) invalid(`${name} must be an integer from 1 to 2147483647 milliseconds.`);
}
function target(input) {
  if (input.roomId !== undefined) validateRoom(input.roomId);
  if (input.dotId !== undefined) validateMessageId(input.dotId, 'Dot ID');
  if (input.roomId !== undefined && input.dotId !== undefined) invalid('Choose roomId or dotId.');
}
function pages(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 100) invalid('pages must be an integer from 1 to 100.'); }
function attachment(value) {
  if (typeof value === 'string') value = { path: value };
  object(value, ['path', 'name', 'mimeType'], 'Attachment');
  if (typeof value.path !== 'string' || !value.path || value.path.includes('\0')) invalid('An attachment path must be a nonempty local path.');
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name || Buffer.byteLength(value.name) > 240 || /^[.]{1,2}$/.test(value.name) || /[\x00-\x1f\x7f/\\]/.test(value.name))) invalid('An attachment name must be a plain filename of at most 240 bytes.');
  if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value.mimeType))) invalid('An attachment mimeType must be a MIME media type.');
  return value;
}
async function preflight(files, signal) {
  for (const file of files) {
    signal.throwIfAborted();
    const stat = await lstat(file.path).catch(() => null);
    signal.throwIfAborted();
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 20 * 1024 * 1024) invalid('All attachments must be regular files of 1 byte to 20 MiB.');
  }
}
function historyInput(input) {
  object(input, [...TARGET, 'limit', 'before', 'after', 'around', 'taskId', 'replyRootMessageId', 'pages']); target(input);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)) invalid('limit must be an integer from 1 to 20.');
  if (input.pages !== undefined) pages(input.pages);
  if (['before', 'after', 'around'].filter(key => input[key] !== undefined).length > 1) invalid('Choose before, after or around.');
  if (input.around !== undefined && input.pages !== undefined) invalid('around selects one history page.');
  for (const key of ['before', 'after']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 4096 || /[\0\r\n]/.test(input[key]))) invalid(`${key} must be a history cursor returned by the API.`);
  for (const key of ['around', 'taskId', 'replyRootMessageId']) if (input[key] !== undefined) validateMessageId(input[key], key);
}
function message(value) {
  const { inProgress, replyTo, ...rest } = value;
  return { ...rest, streaming: Boolean(inProgress), replyToMessageId: replyTo ?? null };
}
function page(value) { return { ...value, messages: value.messages.map(message), hasMore: Boolean(value.truncated ?? (value.prevCursor || value.nextCursor)) }; }
function receipt(value) { return { ...value, ...(value.wait ? { wait: { ...value.wait, messages: value.wait.messages.map(message) } } : {}) }; }

/** The public application API. Construction and capabilities never access auth. */
export class DotterClient {
  constructor(options = {}) {
    object(options, ['authFile', 'auth', 'transport', 'ownsTransport', 'requestTimeoutMs', 'nativeClient'], 'ClientOptions');
    if (options.authFile !== undefined && (typeof options.authFile !== 'string' || !options.authFile || options.authFile.includes('\0'))) invalid('authFile must be a local path.');
    if (options.auth !== undefined && typeof options.auth?.load !== 'function') invalid('auth must provide a load function.');
    if (options.transport !== undefined && typeof options.transport?.request !== 'function') invalid('transport must provide a request method.');
    if (options.ownsTransport !== undefined && typeof options.ownsTransport !== 'boolean') invalid('ownsTransport must be boolean.');
    if (options.requestTimeoutMs !== undefined) { duration(options.requestTimeoutMs, 'requestTimeoutMs'); if (options.requestTimeoutMs > 600_000) invalid('requestTimeoutMs must be at most 600000.'); }
    this._closed = false;
    this._lifetime = new AbortController();
    this._subscriptions = new Set();
    this._options = options;
    this._authLoader = options.auth?.load.bind(options.auth) ?? loadAuth;
    this._transport = options.transport ?? new Transport({ authFile: options.authFile, authLoader: input => this._credentials(input), ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }) });
    this._ownsTransport = options.transport === undefined || options.ownsTransport === true;
    const guards = createGuards({ assertOpen: () => this._assertOpen(), execute: (request, invoke, behavior) => this._execute(request, invoke, behavior), options,
      settleOnAbort: method => ATOMIC_OUTPUTS.has(method) });
    this._native = options.nativeClient ?? new FullDotClient({ transport: guards.transport(this._transport) });
    this._advanced = guards.domain(this._native);
    this.auth = Object.freeze({ status: options => this._execute(options, async signal => {
      const value = await this._credentials({ authFile: this._options.authFile, signal });
      signal.throwIfAborted();
      return { status: 'ready', mode: 'chatgpt', accountId: value.accountId ?? null, hasAccountSelector: Boolean(value.accountId), expiresAt: value.expiresAt == null ? null : new Date(value.expiresAt).toISOString() };
    }) });
  }
  get advanced() { this._assertOpen(); return this._advanced; }
  _assertOpen() { if (this._closed) throw new DotterError('CLOSED'); }
  async _credentials(input) {
    const value = await this._authLoader(input);
    input.signal?.throwIfAborted();
    if (!value || typeof value.accessToken !== 'string' || !value.accessToken || /[\x00-\x20\x7f]/.test(value.accessToken)
      || value.accountId != null && (typeof value.accountId !== 'string' || !value.accountId || /[\x00-\x1f\x7f]/.test(value.accountId))
      || value.expiresAt != null && (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())) throw new DotterError('AUTH_REQUIRED');
    return value;
  }
  async _execute(options = {}, invoke, { settleOnAbort = false } = {}) {
    try {
      this._assertOpen(); object(options, ['signal', 'timeoutMs'], 'RequestOptions');
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid('signal must be an AbortSignal.');
      if (options.timeoutMs !== undefined) duration(options.timeoutMs, 'timeoutMs');
    } catch (error) { throw sdkError(error); }
    const controller = new AbortController();
    const signal = AbortSignal.any([this._lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    let timer, onAbort;
    if (options.timeoutMs !== undefined) timer = setTimeout(() => controller.abort(new DotterError('TIMEOUT')), options.timeoutMs);
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(sdkError(signal.reason, signal));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    cancelled.catch(() => {});
    try {
      signal.throwIfAborted();
      const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return invoke(signal); });
      // Native atomic file operations own their commit and awaited cleanup.
      // Their network requests remain independently guarded and cancellable.
      const result = await (settleOnAbort ? operation : Promise.race([operation, cancelled]));
      if (!settleOnAbort) signal.throwIfAborted();
      return result;
    } catch (error) { throw sdkError(error, signal); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
  async _target(input, signal) {
    if (input.dotId === undefined) return input.roomId;
    const profile = await this._native.profile({ dotId: input.dotId, signal });
    signal.throwIfAborted();
    if (!profile.roomId) throw new DotterError('OPERATION_FAILED', 'The selected Dot has no messaging room.');
    return validateRoom(profile.roomId);
  }
  capabilities() {
    return Object.freeze({ service: 'dot', send: true, history: true, watch: true, search: true,
      upload: this._options.nativeClient ? typeof this._native.upload === 'function' : typeof this._transport.requestMultipart === 'function',
      download: this._options.nativeClient ? typeof this._native.download === 'function' : typeof this._transport.requestBytes === 'function' || typeof this._transport.fetchSigned === 'function',
      artifacts: true, targets: ['roomId', 'dotId'], maxAttachments: 10, maxUploadBytes: 20 * 1024 * 1024, watchDelivery: 'at-least-once', native: FullDotClient.capabilities() });
  }
  primary(options) { return this._execute(options, signal => this._native.primary({ signal })); }
  listDots(options) { return this._execute(options, signal => this._native.listDots({ signal })); }
  send(input, options) {
    let requestId, dispatched = false, accepted;
    return this._execute(options, async signal => {
      object(input, [...TARGET, 'text', 'attachments', 'attachmentIds', 'wait', 'waitTimeoutMs', 'replyToMessageId', 'replyTo', 'taskId', 'pageContext', 'messageMetadata', 'browserAnnotations', 'idempotencyKey']); target(input);
      if (input.replyTo !== undefined && input.replyToMessageId !== undefined) invalid('Choose replyToMessageId or the deprecated replyTo alias.');
      const replyTo = input.replyToMessageId ?? input.replyTo;
      validateSendContext({ ...input, replyTo });
      if (input.wait !== undefined && typeof input.wait !== 'boolean') invalid('wait must be boolean.');
      if (input.waitTimeoutMs !== undefined) { duration(input.waitTimeoutMs, 'waitTimeoutMs'); if (input.waitTimeoutMs > 300_000) invalid('waitTimeoutMs must be at most 300000.'); if (input.wait !== true) invalid('waitTimeoutMs requires wait:true.'); }
      if (input.attachments !== undefined && !Array.isArray(input.attachments)) invalid('attachments must be an array.');
      if (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) || input.attachmentIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)))) invalid('attachmentIds must contain file IDs returned by upload.');
      const files = (input.attachments ?? []).map(attachment), attachmentIds = [...(input.attachmentIds ?? [])];
      if (files.length + attachmentIds.length > 10 || typeof (input.text ?? '') !== 'string' || !(input.text ?? '').trim() && !files.length && !attachmentIds.length || (input.text?.length ?? 0) > 64000 || input.text?.includes('\0')) invalid('Supply text or up to ten attachments; text must be at most 64000 characters without NUL bytes.');
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.idempotencyKey))) invalid('idempotencyKey must be a UUID.');
      if (files.length && !this.capabilities().upload) throw new DotterError('UNSUPPORTED_OPERATION', 'The transport does not support multipart file uploads.');
      requestId = input.idempotencyKey ?? randomUUID();
      await preflight(files, signal);
      const roomId = await this._target(input, signal);
      for (const file of files) {
        signal.throwIfAborted();
        const uploaded = await this._native.upload({ roomId, file: file.path, ...(file.name === undefined ? {} : { name: file.name }), ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }), signal });
        attachmentIds.push(uploaded.fileId);
      }
      signal.throwIfAborted();
      const { dotId, attachments, wait, waitTimeoutMs, replyToMessageId, ...native } = input;
      dispatched = true;
      return receipt(await this._native.send({ ...native, ...(replyTo === undefined ? {} : { replyTo }), roomId, idempotencyKey: requestId, ...(attachmentIds.length ? { attachmentIds } : {}), ...(wait ? { waitSeconds: (waitTimeoutMs ?? 30_000) / 1000 } : {}), signal,
        onAccepted: value => { accepted = receipt(value); } }));
    }).catch(error => {
      if (requestId !== undefined) {
        const deliveryState = accepted ? 'accepted' : error.deliveryState ?? (dispatched && !['INVALID_ARGUMENT', 'AUTH_REQUIRED', 'AUTH_FAILED', 'UNSUPPORTED_OPERATION'].includes(error.code) ? 'unknown' : 'not_sent');
        error.requestId = requestId; error.deliveryState = deliveryState;
        if (accepted) error.receipt = accepted;
        error.details = Object.freeze({ ...error.details, requestId, deliveryState, ...(accepted ? { receipt: accepted } : {}) });
      }
      throw error;
    });
  }
  history(input = {}, options) {
    return this._execute(options, async signal => {
      historyInput(input);
      const { dotId, ...native } = input;
      const roomId = await this._target(input, signal);
      return page(await this._native[input.pages === undefined ? 'history' : 'historyPages']({ ...native, roomId, signal }));
    });
  }
  search(input, options) {
    return this._execute(options, async signal => {
      object(input, [...TARGET, 'query', 'all', 'pages', 'since', 'until']); target(input);
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4096 || input.query.includes('\0')) invalid('query must be a nonempty string of at most 4096 characters.');
      if (input.all !== undefined && typeof input.all !== 'boolean') invalid('all must be boolean.');
      if (input.all && (input.roomId || input.dotId)) invalid('Choose all or a single target.');
      if (input.pages !== undefined) pages(input.pages);
      for (const field of ['since', 'until']) if (input[field] !== undefined && (typeof input[field] !== 'string' || !Number.isFinite(Date.parse(input[field])))) invalid(`${field} must be an ISO date or timestamp.`);
      if (input.since && input.until && Date.parse(input.since) > Date.parse(input.until)) invalid('since must precede until.');
      const { dotId, ...native } = input;
      const result = await this._native.search({ ...native, roomId: await this._target(input, signal), signal });
      return { ...result, matches: result.matches.map(message) };
    });
  }
  upload(input, options) {
    return this._execute(options, async signal => {
      object(input, [...TARGET, 'path', 'name', 'mimeType', 'stateFile']); target(input);
      const file = attachment({ path: input.path, ...(input.name === undefined ? {} : { name: input.name }), ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }) });
      if (!this.capabilities().upload) throw new DotterError('UNSUPPORTED_OPERATION', 'The transport does not support multipart file uploads.');
      if (input.stateFile !== undefined && (typeof input.stateFile !== 'string' || !input.stateFile || input.stateFile.includes('\0'))) invalid('stateFile must be a local path.');
      if (input.stateFile && (input.name !== undefined || input.mimeType !== undefined)) throw new DotterError('UNSUPPORTED_OPERATION', 'Recoverable uploads use the local filename and detected MIME type.');
      await preflight([file], signal);
      const result = await this._native.upload({ roomId: await this._target(input, signal), file: file.path, ...(input.name === undefined ? {} : { name: input.name }), ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }), ...(input.stateFile ? { stateFile: input.stateFile } : {}), signal });
      if (!result.attachment) return result;
      const { file_id, mime_type, size_bytes, ...rest } = result.attachment;
      return { ...result, attachment: { ...rest, fileId: file_id, mimeType: mime_type, sizeBytes: size_bytes } };
    });
  }
  download(input, options) {
    return this._execute(options, async signal => {
      object(input, [...TARGET, 'fileId', 'output', 'overwrite']); target(input); validateRoom(input.fileId);
      if (input.output !== undefined && (typeof input.output !== 'string' || !input.output || input.output.includes('\0'))) invalid('output must be a local path.');
      if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') invalid('overwrite must be boolean.');
      if (!this.capabilities().download) throw new DotterError('UNSUPPORTED_OPERATION', 'The transport does not support binary file downloads.');
      const { dotId, ...native } = input;
      const result = await this._native.download({ ...native, roomId: await this._target(input, signal), signal });
      return { ...result, output: result.path };
    }, { settleOnAbort: this._native.download === FullDotClient.prototype.download });
  }
  artifacts(input = {}, options) {
    return this._execute(options, async signal => {
      object(input, [...TARGET, 'pages']); target(input); if (input.pages !== undefined) pages(input.pages);
      const { dotId, ...native } = input;
      return this._native.artifacts({ ...native, roomId: await this._target(input, signal), signal });
    });
  }
  watch(input = {}, options = {}) {
    const startedAt = Date.now();
    return this._execute(options, async startupSignal => {
      object(input, [...TARGET, 'all', 'intervalMs', 'fromStart', 'resumeAfter', 'cursorFile', 'bufferSize']); target(input);
      for (const key of ['all', 'fromStart']) if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`${key} must be boolean.`);
      if (input.intervalMs !== undefined && (!Number.isFinite(input.intervalMs) || input.intervalMs < 1000 || input.intervalMs > 3_600_000)) invalid('intervalMs must be between 1000 and 3600000.');
      if (input.bufferSize !== undefined && (!Number.isSafeInteger(input.bufferSize) || input.bufferSize < 1 || input.bufferSize > 65536)) invalid('bufferSize must be an integer from 1 to 65536.');
      if (input.resumeAfter !== undefined) validateMessageId(input.resumeAfter, 'resumeAfter');
      if (input.cursorFile !== undefined && (typeof input.cursorFile !== 'string' || !input.cursorFile || input.cursorFile.includes('\0'))) invalid('cursorFile must be a local path.');
      if (input.all && (input.roomId || input.dotId || input.cursorFile || input.resumeAfter)) invalid('Choose all or a single room and cursor.');
      if (input.resumeAfter && input.cursorFile) invalid('Choose resumeAfter or cursorFile.');
      const roomId = await this._target(input, startupSignal);
      startupSignal.throwIfAborted();
      const controller = new AbortController();
      const sources = [this._lifetime.signal, ...(options.signal ? [options.signal] : [])];
      const forward = () => { if (!controller.signal.aborted) controller.abort(sources.find(source => source.aborted)?.reason); };
      let timer;
      if (options.timeoutMs !== undefined) timer = setTimeout(() => controller.abort(new DotterError('TIMEOUT')), Math.max(1, options.timeoutMs - (Date.now() - startedAt)));
      let queue;
      // Let an actual protocol failure in the same turn win over an external
      // cancellation. Explicit subscription.cancel() still settles immediately.
      const finishAbort = () => setImmediate(() => queue.finish(controller.signal.reason instanceof DotterError ? controller.signal.reason : undefined, true));
      queue = createSubscription({ controller, capacity: input.bufferSize, cleanup: () => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', finishAbort);
        for (const source of sources) source.removeEventListener('abort', forward);
        this._subscriptions.delete(queue.subscription);
      } });
      controller.signal.addEventListener('abort', finishAbort, { once: true });
      for (const source of sources) source.addEventListener('abort', forward, { once: true });
      this._subscriptions.add(queue.subscription);
      if (sources.some(source => source.aborted)) forward();
      const { dotId, all, bufferSize, ...native } = input;
      const callbacks = {
        ...native, ...(all ? {} : { roomId }), signal: controller.signal,
        onMessage: value => queue.push({ type: 'message', message: message(value), ...(value.roomId || roomId ? { roomId: value.roomId ?? roomId } : {}), ...(value.dotId ? { dotId: value.dotId } : {}) }),
        onReady: value => queue.push({ type: 'ready', ...value }),
        onCursor: value => queue.push({ type: 'cursor', ...value, anchor: value.anchor ?? null }),
      };
      // Resolve the subscription before a synchronous injected watcher emits
      // callbacks. Startup work then has the same lifecycle as real I/O.
      setImmediate(() => {
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this._native[all ? 'watchAll' : 'watch'](callbacks); }).then(() => queue.finish(), error => {
          if (controller.signal.aborted && (error === controller.signal.reason || error?.name === 'AbortError' || ['ABORTED', 'CLOSED'].includes(error?.code))) finishAbort();
          else queue.finish(sdkError(error));
        });
      });
      return queue.subscription;
    });
  }
  async close() {
    if (this._closing) return this._closing;
    this._closed = true;
    this._closing = (async () => {
      await Promise.all([...this._subscriptions].map(subscription => subscription.cancel()));
      this._lifetime.abort(new DotterError('CLOSED'));
      if (this._ownsTransport && typeof this._transport.close === 'function') await this._transport.close();
    })();
    return this._closing;
  }
}

export function createClient(options) { return new DotterClient(options); }
