import { randomUUID } from 'node:crypto';
import { VERSION } from './version.mjs';
import { lstat, open, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DotClient, validateSendContext } from './client.mjs';
import { DotError } from './errors.mjs';
import { uploadFile, downloadFile, listArtifacts, MAX_UPLOAD_BYTES } from './files.mjs';
import { actionManifest, listActions, readElicitation, respondElicitation, reactToMessage, markRoomRead, readEmail } from './actions.mjs';
import { DotOperations, capabilities as operationCapabilities } from './operations.mjs';
import { readPrivateJson, writePrivate } from './store.mjs';
import { DotLifecycle } from './lifecycle.mjs';
import { DotChannels } from './channels.mjs';
import { RoutineExtras } from './routine-extras.mjs';
import { DotLive } from './live.mjs';
import { DotConnections } from './connections.mjs';
import { DotLibrary, libraryCapabilities } from './library.mjs';
import { uploadRecoverable } from './uploads.mjs';
import { DotAccount, ACCOUNT_SETTING_FEATURES } from './account.mjs';
import { AccountProjects, accountProjectCapabilities } from './account-projects.mjs';
import { ProjectFiles, projectFileCapabilities } from './project-files.mjs';
import { ProjectSharing, projectSharingCapabilities } from './project-sharing.mjs';
import { ProjectSources, projectSourceCapabilities } from './project-sources.mjs';
import { ProjectSaves, projectSaveCapabilities } from './project-saves.mjs';
import { ProjectMemory, projectMemoryCapabilities } from './project-memory.mjs';
import { ProjectUpload, projectUploadCapabilities } from './project-upload.mjs';
import { ProjectConnections, projectConnectionCapabilities } from './project-connections.mjs';
import { ConversationClient, conversationCapabilities } from './conversations.mjs';
import { DotExtras } from './dot-extras.mjs';
import { DotMessageWorkflows } from './message-workflows.mjs';
import { DotMail } from './mail.mjs';
import { LibraryContent, libraryContentCapabilities } from './library-content.mjs';
import { LibraryUpload } from './library-upload.mjs';
import { LibrarySharing, sharingCapabilities } from './sharing.mjs';
import { LibraryProviders, libraryProviderCapabilities } from './library-providers.mjs';
import { RoutineManagement } from './routine-management.mjs';
import { DotConnectorAdmin } from './connectors-admin.mjs';
import { DotPlugins } from './plugins.mjs';
import { DotRemoteControl, remoteControlCapabilities } from './remote-control.mjs';
import { DotBrowserAuth, browserAuthCapabilities } from './browser-auth.mjs';
import { DotBrowserAuthNative, browserAuthNativeCapabilities } from './browser-auth-native.mjs';
import { DotBrowserExtras, browserExtrasCapabilities } from './browser-extras.mjs';
import { DotNativeActions, nativeActionCapabilities } from './native-actions.mjs';
import { DotOnboarding } from './onboarding.mjs';
import { SavedEntities, savedEntityCapabilities } from './saved-entities.mjs';
import { allocateVoiceCall, attachVoiceCall, stopVoiceCall, runVoiceChat, voiceCapabilities } from './voice.mjs';

const ID = /^[A-Za-z0-9_.~:-]{1,1024}$/;
function id(value, name = 'ID') {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') throw new DotError('INVALID_ARGUMENT', `${name} must be an ID returned by the API.`);
  return value;
}
function pages(value) { if (!Number.isInteger(value) || value < 1 || value > 100) throw new DotError('INVALID_ARGUMENT', 'Pages must be from 1 to 100.'); return value; }
function date(value, name) {
  if (value == null) return null;
  const result = Date.parse(value); if (!Number.isFinite(result)) throw new DotError('INVALID_ARGUMENT', `${name} must be an ISO date or timestamp.`); return result;
}
function publicProfile(data) {
  return { id: data.id, name: data.display_name ?? 'Dot', roomId: data.messaging_room_id ?? null,
    threadId: data.active_root_thread_id ?? null, kind: data.aeon_kind ?? null, status: data.status ?? null };
}

export class FullDotClient extends DotClient {
  constructor(options = {}) {
    super(options);
    this.operations = new DotOperations(this);
    this.lifecycle = new DotLifecycle(this);
    this.channels = new DotChannels(this);
    this.extras = new RoutineExtras(this);
    this.live = new DotLive(this);
    this.connections = new DotConnections(this);
    this.library = new DotLibrary(this);
    this.account = new DotAccount(this);
    this.projects = new AccountProjects(this);
    this.projectFiles = new ProjectFiles(this);
    this.projectSharing = new ProjectSharing(this);
    this.projectSources = new ProjectSources(this);
    this.projectSaves = new ProjectSaves(this);
    this.projectMemory = new ProjectMemory(this);
    this.projectUpload = new ProjectUpload(this);
    this.projectConnections = new ProjectConnections(this);
    this.conversations = new ConversationClient(this);
    this.dotExtras = new DotExtras(this);
    this.messageWorkflows = new DotMessageWorkflows(this);
    this.mail = new DotMail(this);
    this.libraryContent = new LibraryContent(this);
    this.libraryUpload = new LibraryUpload(this);
    this.sharing = new LibrarySharing(this);
    this.libraryProviders = new LibraryProviders(this);
    this.routineManagement = new RoutineManagement(this);
    this.connectorAdmin = new DotConnectorAdmin(this);
    this.plugins = new DotPlugins(this);
    this.remoteControl = new DotRemoteControl(this);
    this.browserAuth = new DotBrowserAuth(this);
    this.browserAuthNative = new DotBrowserAuthNative(this);
    this.browserExtras = new DotBrowserExtras(this);
    this.nativeActions = new DotNativeActions(this);
    this.onboarding = new DotOnboarding(this);
    this.savedEntities = new SavedEntities(this);
  }
  static capabilities() {
    return { version: VERSION, history: ['pages', 'search', 'thread', 'outline', 'export', 'task filter', 'around message'],
      messaging: ['text', 'file attachments', 'existing file IDs', 'reply', 'task targeting', 'Page/browser context', 'Page-comment thread replies', 'structured call history', 'reactions and delivery metadata', 'wait for observed replies', 'interactive chat', 'resumable watch', 'native event streams', 'typing presence'],
      files: ['upload', 'recoverable upload', 'download', 'artifacts'], profile: ['inspect', 'rename', 'pause', 'resume', 'create', 'delete', 'set/clear primary', 'avatar', 'ensure room', 'root thread'],
      actions: actionManifest, ...operationCapabilities(),
      runtime: ['activity', 'reboot', 'environment health/recreate', 'computer connections', 'doctor workflows', 'explicitly reviewed safety resume'],
      channels: ['email address options/claim/link/unlink', 'Google Meet invitation'],
      routineExtras: ['execution threads', 'latest visible run', 'mark read', 'pending event batches', 'schedule policy'],
      connections: ['health', 'OAuth start/complete/reauthorize', 'API-key/no-auth linking', 'unlink', 'account pinning'],
      accountLibrary: libraryCapabilities(), libraryContent: libraryContentCapabilities(), libraryProviders: libraryProviderCapabilities(),
      accountProjects: accountProjectCapabilities(),
      projectFiles: projectFileCapabilities(), projectSharing: projectSharingCapabilities(),
      projectSources: projectSourceCapabilities(), projectSaves: projectSaveCapabilities(), projectMemory: projectMemoryCapabilities(),
      projectUpload: projectUploadCapabilities(),
      projectConnections: projectConnectionCapabilities(),
      savedEntities: savedEntityCapabilities(),
      libraryUpload: ['standalone account upload', 'private upload journal', 'status', 'read-only reconciliation'],
      librarySharing: sharingCapabilities(), conversations: conversationCapabilities(),
      account: { scope: 'Signed-in account; explicit account selector required.', settings: ACCOUNT_SETTING_FEATURES,
        supported: ['saved memories', 'personalization', 'notification settings', 'typed settings', 'memory summary and streaming'] },
      dotExtras: ['hidden thread metadata', 'conditional avatar', 'deletion recovery', 'legacy primary selection', 'reference photos'],
      messageWorkflows: ['plugin suggestions and continuation', 'bound OAuth request completion'],
      mail: ['linked provider accounts', 'send', 'status', 'undo', 'contacts'],
      plugins: ['discovery', 'canonical app lookup', 'installation', 'skills', 'sharing', 'archive import/export', 'team installs'],
      connectorAdmin: ['metadata and policies', 'MCP create/update and action refresh', 'service-account links and settings'],
      taskEvents: ['global task-state subscription', 'Dot and task filters', 'explicit resync markers'],
      routineManagement: ['queries', 'sharing', 'shared import'],
      ...voiceCapabilities(), ...remoteControlCapabilities(), browserAuth: browserAuthCapabilities(),
      browserAuthNative: browserAuthNativeCapabilities(), browserExtras: browserExtrasCapabilities(), nativeActions: nativeActionCapabilities(),
      onboarding: { supported: ['native create with initialization', 'private recovery journal', 'status', 'explicit reconciliation'], standaloneInitializePayload: 'No request constructor exists in the inspected native build.' },
      forms: { validation: ['JSON Schema 2020-12', '2019-09', 'draft-07', 'local references', 'conditionals', 'complex patterns'], isolated: true, remoteReferences: false },
      liveReadVerificationV3: { date: '2026-10-17', successful: ['room', 'root thread', 'activity', 'email options', 'environment status', 'computers', 'schedule policy', 'library usage'] },
      parityGaps: [
        'Grok group rooms and bot-to-bot handoff have no verified Dot equivalent.',
        'Grok gateway/webhook keys and hosted event workers have no verified Dot equivalent.',
        'Email draft writes have no verified contract.',
        'Passkey, biometric, device-location, wallet and Sign in with ChatGPT proofs use the first-party human review workflow.',
        'The installed Dot Messages client rejects local file-picker handback; advertised resource selections are supported.',
        'Current onboarding initializes during creation; the orphan standalone initialize adapter has no verified request constructor.',
        'Event-trigger authoring was removed after live saves discarded the native trigger payload. Existing trigger data remains readable.',
        'Deep-research export is structured JSON; binary PDF export is not verified.'
      ], liveMutationsTested: false };
  }
  capabilities() { return FullDotClient.capabilities(); }
  async profile({ dotId, signal } = {}) {
    if (!dotId) return this.primary({ signal });
    return publicProfile(await this.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(id(dotId, 'Dot ID'))}`, { signal }));
  }
  async renameDot({ dotId, name, signal } = {}) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) throw new DotError('INVALID_ARGUMENT', 'A Dot name must be 1 to 100 characters without controls.');
    dotId ??= (await this.primary({ signal })).id;
    const result = await this.transport.request('PATCH', `/backend-api/tbo/${encodeURIComponent(id(dotId))}`, { body: { display_name: name.trim() }, signal });
    return publicProfile(result);
  }
  async runtimeAction(action, { dotId, signal } = {}) {
    dotId ??= (await this.primary({ signal })).id;
    const result = await this.transport.request('POST', `/backend-api/tbo/${encodeURIComponent(id(dotId))}/runtime/${action}`, { signal });
    return { dotId, action, status: result.status ?? 'unconfirmed', threadId: result.thread_id ?? null };
  }
  pauseDot(options) { return this.runtimeAction('pause', options); }
  resumeDot(options) { return this.runtimeAction('resume', options); }
  upload(options) { return options?.stateFile ? uploadRecoverable(this, options) : uploadFile(this, options); }
  voiceAllocate(options) { return allocateVoiceCall(this, options); }
  voiceAttach(options) { return attachVoiceCall(this, options); }
  voiceStop(options) { return stopVoiceCall(this, options); }
  voiceChat(options) { return runVoiceChat(this, options); }
  download(options) { return downloadFile(this, options); }
  artifacts(options) { return listArtifacts(this, options); }
  actions(options) { return listActions(this, options); }
  elicitation(options) { return readElicitation(this, options); }
  respond(options) { return respondElicitation(this, options); }
  react(options) { return reactToMessage(this, options); }
  markRead(options) { return markRoomRead(this, options); }
  email(options) { return readEmail(this, options); }
  async historyPages({ pages: maximum = 1, ...options } = {}) {
    pages(maximum);
    const messages = new Map(), cursors = new Set(); let before = options.before, after = options.after, count = 0, last, roomId = options.roomId;
    for (; count < maximum; count++) {
      options.signal?.throwIfAborted();
      last = await super.history({ ...options, roomId, before, after }); roomId = last.roomId;
      options.signal?.throwIfAborted();
      for (const message of last.messages) messages.set(message.id, message);
      const cursor = options.after ? last.nextCursor : last.prevCursor;
      if (!cursor) { count++; break; }
      if (cursors.has(cursor)) throw new DotError('CURSOR_LOOP', 'The API repeated a history cursor.');
      cursors.add(cursor);
      if (options.after) after = cursor; else before = cursor;
    }
    return { roomId, messages: [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      pagesRead: count, prevCursor: last?.prevCursor ?? null, nextCursor: last?.nextCursor ?? null,
      truncated: Boolean(options.after ? last?.nextCursor : last?.prevCursor) };
  }
  async search({ query, all = false, roomId, pages: maximum = 10, since, until, signal } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 4096) throw new DotError('INVALID_ARGUMENT', 'Supply a nonempty search query of at most 4096 characters.');
    if (all && roomId) throw new DotError('INVALID_ARGUMENT', 'Choose --all or one room.');
    const from = date(since, 'since'), to = date(until, 'until');
    if (from !== null && to !== null && from > to) throw new DotError('INVALID_ARGUMENT', 'since must precede until.');
    const targets = [...new Set(all ? (await this.listDots({ signal })).filter(dot => dot.roomId).map(dot => dot.roomId) : [await this.resolveRoom(roomId, signal)])];
    const matches = []; let scanned = 0, truncated = false;
    for (const target of new Set(targets)) {
      const batch = await this.historyPages({ roomId: target, pages: maximum, signal }); scanned += batch.messages.length; truncated ||= batch.truncated;
      for (const message of batch.messages) {
        const time = Date.parse(message.createdAt);
        if (message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (from === null || time >= from) && (to === null || time <= to)) matches.push({ roomId: target, ...message });
      }
    }
    return { query, matches, scanned, rooms: targets.length, truncated };
  }
  async thread({ messageId, ...options } = {}) {
    id(messageId, 'Message ID');
    return this.historyPages({ ...options, replyRootMessageId: messageId });
  }
  async outline(options = {}) {
    const batch = await this.historyPages(options);
    return { ...batch, messages: batch.messages.map(message => ({ id: message.id, replyTo: message.replyTo, role: message.role, createdAt: message.createdAt, preview: message.text.slice(0, 200), attachments: message.attachments.length })) };
  }
  async exportHistory({ output, format = 'json', overwrite = false, ...options } = {}) {
    if (!['json', 'md'].includes(format)) throw new DotError('INVALID_ARGUMENT', 'Export format must be json or md.');
    const batch = await this.historyPages(options);
    const content = format === 'json' ? JSON.stringify(batch, null, 2) + '\n'
      : batch.messages.map(message => `## ${message.role} — ${message.createdAt ?? ''}\n\n${message.text}\n`).join('\n');
    if (Buffer.byteLength(content) > 50 * 1024 * 1024) throw new DotError('EXPORT_TOO_LARGE', 'The export exceeds 50 MiB; reduce --pages.');
    const saved = await writePrivate(output, content, { overwrite, signal: options.signal });
    return { path: saved, format, messageCount: batch.messages.length, pagesRead: batch.pagesRead, truncated: batch.truncated };
  }
  async send({ files = [], waitSeconds = 0, ...options } = {}) {
    validateSendContext(options);
    if (!Array.isArray(files) || files.length > 10 || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) throw new DotError('INVALID_ARGUMENT', 'Use up to ten files and a wait time from 0 to 300 seconds.');
    if ((files.length + (options.attachmentIds?.length ?? 0)) > 10 || typeof (options.text ?? '') !== 'string'
      || (options.text?.length ?? 0) > 64000 || options.text?.includes('\0')
      || (!(options.text ?? '').trim() && !files.length && !options.attachmentIds?.length)) throw new DotError('INVALID_MESSAGE', 'Supply text or up to ten attachments; text must be at most 64,000 characters without NUL bytes.');
    if (options.attachmentIds != null && (!Array.isArray(options.attachmentIds) || options.attachmentIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)))) throw new DotError('INVALID_FILE', 'Use file IDs returned by upload.');
    if (options.idempotencyKey != null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.idempotencyKey)) throw new DotError('INVALID_KEY', 'The request key must be a UUID.');
    if (options.replyTo != null) id(options.replyTo, 'Reply message ID');
    options.signal?.throwIfAborted();
    for (const file of files) {
      const stat = await lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_UPLOAD_BYTES) throw new DotError('INVALID_FILE', 'All attachments must be regular files of 1 byte to 20 MiB.');
    }
    const roomId = await this.resolveRoom(options.roomId, options.signal);
    const attachmentIds = [...(options.attachmentIds ?? [])];
    for (const file of files) attachmentIds.push((await this.upload({ roomId, file, signal: options.signal })).fileId);
    options.signal?.throwIfAborted();
    const receipt = await super.send({ ...options, roomId, attachmentIds });
    options.onAccepted?.(receipt);
    if (!waitSeconds) return receipt;
    const deadline = Date.now() + waitSeconds * 1000, observed = new Map(), controller = new AbortController();
    const interrupt = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort', interrupt, { once: true });
    if (options.signal?.aborted) interrupt();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(new DOMException('Reply wait deadline reached.', 'TimeoutError')); }, Math.max(1, Math.ceil(waitSeconds * 1000)));
    let rejectOnAbort;
    const cancelled = new Promise((_, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
      if (controller.signal.aborted) rejectOnAbort();
    });
    // A signal can already be aborted between acceptance and wait setup.
    // Keep that rejection handled even if throwIfAborted wins before the race.
    cancelled.catch(() => {});
    try {
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted();
        // Race cancellation as well as forwarding it, so even an injected
        // transport that ignores AbortSignal cannot hold the receipt forever.
        const batch = await Promise.race([this.historyPages({ roomId, after: receipt.messageId, pages: 100, signal: controller.signal, ...(options.taskId ? { taskId: options.taskId } : {}) }), cancelled]);
        controller.signal.throwIfAborted();
        if (Date.now() >= deadline) return { ...receipt, wait: { status: 'timeout', messages: [...observed.values()] } };
        if (batch.truncated) throw new DotError('PAGE_LIMIT', 'Reply wait exceeded 100 history pages in one poll.');
        for (const message of batch.messages) if (message.role === 'assistant') observed.set(message.id, message);
        if ([...observed.values()].some(message => !message.inProgress)) return { ...receipt, wait: { status: 'observed', messages: [...observed.values()], correlation: 'messages after accepted send in this room' } };
        await delay(Math.min(2000, Math.max(0, deadline - Date.now())), undefined, { signal: controller.signal });
      }
      return { ...receipt, wait: { status: 'timeout', messages: [...observed.values()] } };
    } catch (error) {
      if (timedOut && !options.signal?.aborted) return { ...receipt, wait: { status: 'timeout', messages: [...observed.values()] } };
      return { ...receipt, wait: { status: 'interrupted', error: typeof error?.code === 'string' ? error.code : 'INTERRUPTED', messages: [...observed.values()] } };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', rejectOnAbort);
      controller.abort();
      options.signal?.removeEventListener('abort', interrupt);
    }
  }
  async watch({ cursorFile, ...options } = {}) {
    if (!cursorFile) return super.watch(options);
    const roomId = await this.resolveRoom(options.roomId, options.signal);
    const state = await readPrivateJson(cursorFile);
    if (state && (state.version !== 1 || state.roomId !== roomId || typeof state.anchor !== 'string' || !ID.test(state.anchor))) throw new DotError('INVALID_STATE', 'Cursor file does not match this room or format.');
    if (state && options.fromStart) throw new DotError('INVALID_ARGUMENT', 'Do not combine an existing cursor with --from-start.');
    const lock = `${cursorFile}.lock`; let handle;
    try { handle = await open(lock, 'wx', 0o600); } catch { throw new DotError('CURSOR_LOCKED', 'The cursor file is already in use. Remove a stale .lock file only after checking no watcher is running.'); }
    try {
      return await super.watch({ ...options, roomId, resumeAfter: state?.anchor,
        onCursor: async value => { if (value.anchor) await writePrivate(cursorFile, JSON.stringify({ version: 1, ...value }) + '\n', { overwrite: true }); await options.onCursor?.(value); } });
    } finally { await handle.close(); await unlink(lock).catch(() => {}); }
  }
  async watchAll({ cursorFile, roomId, ...options } = {}) {
    if (cursorFile || roomId) throw new DotError('INVALID_ARGUMENT', 'Use either all Dots or one room/cursor file.');
    const dots = await this.listDots({ signal: options.signal });
    const rooms = new Map(dots.filter(dot => dot.roomId).map(dot => [dot.roomId, dot]));
    if (!rooms.size) throw new DotError('ROOM_UNAVAILABLE', 'No Dot rooms are available to watch.');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      await Promise.all([...rooms.values()].map(dot => this.watch({ ...options, roomId: dot.roomId, signal,
        onMessage: message => options.onMessage?.({ ...message, roomId: dot.roomId, dotId: dot.id }),
        onReady: ready => options.onReady?.({ ...ready, dotId: dot.id, dotCount: rooms.size }) })));
    } finally { controller.abort(); }
  }
}
