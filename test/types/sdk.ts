import {
  createClient, DotterClient, DotterError, ErrorCode,
  type ArtifactsInput, type AuthProvider, type AuthStatus, type Capabilities,
  type ClientOptions, type DownloadInput, type ErrorDetails, type HistoryInput,
  type HistoryPage, type JsonObject, type JsonValue, type LocalAttachment,
  type Message, type RequestOptions, type SearchInput, type SearchResult,
  type SendInput, type SendResult, type Subscription, type TransportLike,
  type UploadInput, type WatchEvent, type WatchInput,
} from '@jethros-projects/dotter';
import {
  DotClient, FullDotClient, DotError, Transport, DotAccount, AccountProjects,
  ConversationClient, DotConnections, DotLibrary, DotOperations, DotLifecycle,
  DotChannels, DotLive, RoutineExtras, DotPlugins, DotConnectorAdmin,
  ProjectFiles, ProjectSharing, ProjectSources, ProjectSaves, ProjectMemory,
  ProjectUpload, ProjectConnections, LibraryContent, LibraryUpload,
  LibraryProviders, LibrarySharing, SavedEntities, RoutineManagement,
  DotMail, DotExtras, DotMessageWorkflows, DotRemoteControl, DotBrowserAuth,
  DotBrowserAuthNative, DotBrowserExtras, DotNativeActions, DotOnboarding,
  normalizeMessage, validateSendContext, validateActionForm,
  allocateVoiceCall, attachVoiceCall, stopVoiceCall, createVoiceSessionServer,
  runVoiceChat, negotiateRemoteControl, createRemoteControlServer,
  runRemoteControl, uploadRecoverable, resolveBrowserAuthChallenge,
  ACCOUNT_SETTING_FEATURES, PROJECT_THEMES, accountProjectCapabilities,
  projectFileCapabilities, projectSharingCapabilities, projectSourceCapabilities,
  projectSaveCapabilities, projectMemoryCapabilities, projectUploadCapabilities,
  projectConnectionCapabilities, normalizeProjectWebsiteUrl,
  buildSavedEntityRequest,
} from '@jethros-projects/dotter/advanced';

const nativeTransport = new Transport();
nativeTransport.close() satisfies Promise<void>;

const transport: TransportLike = {
  async request(method, route, options) {
    method satisfies 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    route satisfies string;
    options?.signal?.throwIfAborted();
    return { items: [] };
  },
  async close() {},
};
const auth: AuthProvider = {
  async load({ authFile, signal }) {
    authFile satisfies string | undefined;
    signal?.throwIfAborted();
    return { accessToken: 'host-owned-token', accountId: 'account-id', expiresAt: null };
  },
};
const options: ClientOptions = { transport, auth, ownsTransport: false, requestTimeoutMs: 30_000 };
const dot: DotterClient = createClient(options);
const constructed: DotterClient = new DotterClient();
const request: RequestOptions = { signal: new AbortController().signal, timeoutMs: 1000 };
const local: LocalAttachment = { path: './note.txt', name: 'note.txt', mimeType: 'text/plain' };
const send: SendInput = { roomId: 'room-id', text: 'Hello', attachments: [local], wait: true, waitTimeoutMs: 1000 };
const readonlyAttachments = ['./note.txt', local] as const;
dot.send({ text: 'Hello', attachments: readonlyAttachments }, request) satisfies Promise<SendResult>;
dot.send(send) satisfies Promise<SendResult>;
dot.send({ text: 'Hello', dotId: 'dot-id', pageContext: { page_id: null } });
dot.send({ text: 'Reply', replyToMessageId: 'message-id' });
dot.send({ text: 'Legacy reply', replyTo: 'message-id' });
dot.send({ text: 'Hello', pageContext: { page_id: 'page-id', thread_id: 'thread-id' } });
const input: HistoryInput = { dotId: 'dot-id', limit: 20, pages: 2, before: 'native-cursor' };
dot.history(input, request) satisfies Promise<HistoryPage>;
const search: SearchInput = { query: 'release', all: true, since: '2026-01-01' };
dot.search(search) satisfies Promise<SearchResult>;
const watch: WatchInput = { roomId: 'room-id', intervalMs: 1000, bufferSize: 8, fromStart: true };
dot.watch(watch, request) satisfies Promise<Subscription<WatchEvent>>;
const upload: UploadInput = { path: './note.txt', stateFile: './state.json', dotId: 'dot-id' };
dot.upload(upload);
const download: DownloadInput = { fileId: 'file-id' };
const downloaded = await dot.download(download);
downloaded.output satisfies string;
downloaded.path satisfies string;
const artifacts: ArtifactsInput = { dotId: 'dot-id', pages: 2 };
dot.artifacts(artifacts);
dot.auth.status(request) satisfies Promise<AuthStatus>;
dot.primary(request);
dot.listDots(request);
const capabilities: Capabilities = dot.capabilities();
capabilities.service satisfies 'dot';
capabilities.targets satisfies readonly ['roomId', 'dotId'];
capabilities.upload satisfies boolean;
capabilities.download satisfies boolean;
dot.close() satisfies Promise<void>;
constructed.close();

async function consume(subscription: Subscription) {
  await subscription.ready;
  const cursor: string | null = subscription.cursor;
  void cursor;
  for await (const event of subscription) {
    switch (event.type) {
      case 'message': {
        const message: Message = event.message;
        message.id satisfies string;
        message.createdAt satisfies string | null;
        message.streaming satisfies boolean;
        message.replyToMessageId satisfies string | null;
        message.attachments.forEach(part => {
          if ('callId' in part) part.callId satisfies string;
          if ('fileId' in part) part.fileId satisfies string | undefined;
        });
        break;
      }
      case 'ready': event.initialCount satisfies number; break;
      case 'cursor': event.anchor satisfies string | null; break;
      default: event satisfies never;
    }
  }
  await subscription.cancel();
  await subscription.done;
}
void consume;

const details: ErrorDetails = { status: 503, deliveryState: 'unknown' };
const error = new DotterError(ErrorCode.NETWORK_ERROR, undefined, details);
error.code satisfies 'INVALID_ARGUMENT' | 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'UNSUPPORTED_OPERATION' |
  'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'CLOSED' | 'RESYNC_REQUIRED' | 'OPERATION_FAILED';
error.details.status satisfies number | undefined;
new DotterError('CLOSED');

// Canonical APIs reject wrong provider targets, legacy names, and scalar input.
// @ts-expect-error Bot identifiers belong to Botter.
dot.send({ botId: 'bot-id', text: 'Hello' });
// @ts-expect-error Send uses an object input.
dot.send('Hello');
// @ts-expect-error The SDK uses `text`, never an inferred `prompt` alias.
dot.send({ prompt: 'Hello' });
// @ts-expect-error Waiting must be a boolean.
dot.send({ text: 'Hello', wait: 'yes' });
// @ts-expect-error Reply targets remain service message IDs.
dot.send({ text: 'Reply', replyToMessageId: 123 });
// @ts-expect-error Attachments require a path.
dot.send({ attachments: [{ name: 'missing-path.txt' }] });
// @ts-expect-error Page thread context requires a page ID.
dot.send({ text: 'Hello', pageContext: { page_id: null, thread_id: 'thread-id' } });
// @ts-expect-error SDK request signals use the second argument.
dot.history({ signal: new AbortController().signal });
// @ts-expect-error Native `files` moved to `attachments` in the SDK.
dot.send({ text: 'Hello', files: ['./note.txt'] });
// @ts-expect-error Cursors preserve string precision.
dot.history({ before: 42 });
// @ts-expect-error Request options have typed deadlines.
dot.history({}, { timeoutMs: '1000' });
// @ts-expect-error Search requires a query.
dot.search({ all: true });
// @ts-expect-error Upload requires a local path.
dot.upload({ file: './note.txt' });
// @ts-expect-error Download requires a service file ID.
dot.download({ output: './file.txt' });
// @ts-expect-error Authentication must provide a host-side load operation.
createClient({ auth: { token: 'inline-token' } });
// @ts-expect-error Stable error codes reject arbitrary strings.
new DotterError('BROKEN');

const native = new FullDotClient({ transport });
const minimal = new DotClient({ transport });
minimal.history({ roomId: 'room-id', signal: new AbortController().signal });
native.send({ roomId: 'room-id', text: 'Hello', files: ['./note.txt'], waitSeconds: 2 });
native.upload({ file: './note.txt', stateFile: './state.json' });
const nativeDownload = await native.download({ fileId: 'file-id' });
nativeDownload.path satisfies string;
// @ts-expect-error Advanced downloads preserve the native path field.
nativeDownload.output;
native.projects.get({ accountId: 'account-id', projectId: 'project-id' }) satisfies Promise<unknown>;
native.conversations.get({ conversationId: 'conversation-id' }) satisfies Promise<unknown>;
native.connections.status({ connectorId: 'connector-id', linkId: 'link-id' }) satisfies Promise<unknown>;
native.live.watch({ roomId: 'room-id', onEvent: event => { event satisfies unknown; } });
dot.advanced satisfies FullDotClient;
// @ts-expect-error Native IDs are still typed.
native.projects.get({ accountId: 'account-id', projectId: 123 });
// @ts-expect-error Advanced native results are opaque rather than unsafe `any`.
(await native.projects.get({ accountId: 'account-id', projectId: 'project-id' })).arbitrary;

// All documented legacy values remain available from the explicit subpath.
void [DotError, Transport, DotAccount, AccountProjects, ConversationClient,
  DotConnections, DotLibrary, DotOperations, DotLifecycle, DotChannels, DotLive,
  RoutineExtras, DotPlugins, DotConnectorAdmin, ProjectFiles, ProjectSharing,
  ProjectSources, ProjectSaves, ProjectMemory, ProjectUpload, ProjectConnections,
  LibraryContent, LibraryUpload, LibraryProviders, LibrarySharing, SavedEntities,
  RoutineManagement, DotMail, DotExtras, DotMessageWorkflows, DotRemoteControl,
  DotBrowserAuth, DotBrowserAuthNative, DotBrowserExtras, DotNativeActions,
  DotOnboarding, normalizeMessage, validateSendContext, validateActionForm,
  allocateVoiceCall, attachVoiceCall, stopVoiceCall, createVoiceSessionServer,
  runVoiceChat, negotiateRemoteControl, createRemoteControlServer,
  runRemoteControl, uploadRecoverable, resolveBrowserAuthChallenge,
  ACCOUNT_SETTING_FEATURES, PROJECT_THEMES, accountProjectCapabilities,
  projectFileCapabilities, projectSharingCapabilities, projectSourceCapabilities,
  projectSaveCapabilities, projectMemoryCapabilities, projectUploadCapabilities,
  projectConnectionCapabilities, normalizeProjectWebsiteUrl, buildSavedEntityRequest];
const json: JsonObject = { content: ['original_keys', { nested_key: true }] };
json satisfies JsonValue;
