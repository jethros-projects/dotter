import type {
  ArtifactsPage, AuthCredentials, BrowserAnnotations, DotProfile,
  DownloadResult, HistoryInput, HistoryPage, HttpMethod, JsonObject, JsonValue,
  Message, MultipartFile, PageContext, PrimaryDot, QueryValue, SearchInput,
  SearchResult, SendContext, SendResult, TransportLike, TransportRequestOptions,
  UploadResult,
} from './index.js';

/** Native APIs deliberately retain provider-specific names and response shapes. */
export interface NativeOptions {
  signal?: AbortSignal;
  expectedAccountId?: string;
  /** Additional provider-specific values are opaque; narrow before using them. */
  [key: string]: unknown;
}
export interface NativeClientOptions {
  transport?: TransportLike;
  authFile?: string;
  timeoutMs?: number;
  authLoader?: (options: { authFile?: string; signal?: AbortSignal }) => Promise<AuthCredentials>;
  fetchImpl?: (url: URL, options: NativeOptions) => Promise<unknown>;
}
export class DotError extends Error {
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>);
  code: string;
  details: Readonly<Record<string, unknown>>;
  toJSON(): { error: { code: string; message: string; [key: string]: unknown } };
}

export interface ResponseEnvelope<Body = unknown> { status: number; headers: Headers; body: Body }
export interface NativeTransportOptions extends TransportRequestOptions { query?: Readonly<Record<string, QueryValue>> }
export interface VerifiedFileSource { path: string; sizeBytes: number; sha256: string; [key: string]: unknown }
export class Transport implements TransportLike {
  constructor(options?: Omit<NativeClientOptions, 'transport'>);
  timeoutMs: number;
  /** Close this transport and its owned Node connection pool. Injected fetch functions remain caller-owned. */
  close(): Promise<void>;
  request(method: HttpMethod, route: string, options?: NativeTransportOptions): Promise<unknown>;
  requestMultipart(method: 'POST', route: string, options: { file: MultipartFile; signal?: AbortSignal }): Promise<unknown>;
  requestBytes(method: 'GET', route: string, options?: NativeTransportOptions): Promise<Uint8Array | ResponseEnvelope<Uint8Array>>;
  fetchSigned(url: string, options?: NativeTransportOptions): Promise<Uint8Array | ResponseEnvelope<Uint8Array>>;
  uploadSigned(url: string, options: { bytes: Uint8Array; contentType?: string; requiredHeaders?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  uploadSignedFile(url: string, options: { source: VerifiedFileSource; contentType?: string; requiredHeaders?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  uploadEstuaryFile(url: string, options: { source: VerifiedFileSource; expectedAccountId?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  uploadAzureBlock(url: string, options: NativeOptions & { blockId: string; bytes?: Uint8Array; source?: VerifiedFileSource; offset?: number; length?: number; sha256?: string; contentType?: string; timeoutMs?: number }): Promise<unknown>;
  commitAzureBlocks(url: string, options: { blockIds: string[]; contentType: string; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  requestRealtimeSdp(options: NativeOptions & { sdp: string; source?: string; threadId?: string; aeonId?: string; conversationId?: string }): Promise<unknown>;
}

export interface NativeHistoryInput extends HistoryInput { signal?: AbortSignal }
export interface NativeMessage extends Omit<Message, 'streaming' | 'replyToMessageId'> {
  inProgress: boolean;
  replyTo: string | null;
}
export interface NativeHistoryPage extends Omit<HistoryPage, 'messages'> { messages: NativeMessage[] }
export interface NativeSendResult extends Omit<SendResult, 'wait'> {
  wait?: { status: 'observed' | 'timeout' | 'interrupted'; messages: NativeMessage[]; correlation?: string; error?: string };
}
export interface NativeSearchResult extends Omit<SearchResult, 'matches'> { matches: (NativeMessage & { roomId: string })[] }
export interface NativeUploadResult extends Omit<UploadResult, 'attachment'> {
  attachment: { type: 'file'; file_id: string; name?: string; mime_type?: string; size_bytes?: number; status?: string };
}
export interface NativeDownloadResult extends Omit<DownloadResult, 'output'> {}
export interface NativeSendInput extends SendContext {
  roomId?: string;
  text?: string;
  attachmentIds?: readonly string[];
  idempotencyKey?: string;
  signal?: AbortSignal;
}
export interface RoomMember { id: string; aeonId: string | null; name: string; username: string }
export interface Room {
  id: string;
  type: 'DM';
  name: string;
  aeonId: string | null;
  updatedAt: string | null;
  lastReadAt: string | null;
  members: RoomMember[];
  messages: NativeMessage[];
}
export interface NativeWatchOptions {
  roomId?: string;
  intervalMs?: number;
  fromStart?: boolean;
  resumeAfter?: string;
  signal?: AbortSignal;
  onMessage?: (message: NativeMessage & { roomId?: string; dotId?: string | null }) => void | Promise<void>;
  onReady?: (ready: { roomId: string; initialCount: number; resumed?: boolean; replayed?: boolean; dotId?: string | null; dotCount?: number }) => void | Promise<void>;
  onCursor?: (cursor: { roomId: string; anchor: string | null | undefined }) => void | Promise<void>;
}
export class DotClient {
  constructor(options?: NativeClientOptions);
  readonly transport: TransportLike;
  primary(options?: { signal?: AbortSignal; expectedAccountId?: string }): Promise<PrimaryDot>;
  resolveRoom(roomId?: string, signal?: AbortSignal): Promise<string>;
  listDots(options?: { signal?: AbortSignal }): Promise<DotProfile[]>;
  history(options?: NativeHistoryInput): Promise<NativeHistoryPage>;
  send(options?: NativeSendInput): Promise<NativeSendResult>;
  room(options?: { roomId?: string; signal?: AbortSignal }): Promise<Room>;
  typing(options?: { roomId?: string; signal?: AbortSignal }): Promise<{ roomId: string; completed: true }>;
  prepare(options?: { roomId?: string; signal?: AbortSignal }): Promise<{ roomId: string; completed: true }>;
  taskSubscription(options: { roomId?: string; taskId: string; signal?: AbortSignal }): Promise<{ roomId: string; taskId: string; topicId: string }>;
  /** Native callback stream. Prefer the root SDK's bounded async subscription. */
  watch(options?: NativeWatchOptions): Promise<void>;
}
export function normalizeMessage(item: unknown, options?: { assistantSenderIds?: ReadonlySet<string> }): NativeMessage | null;
export function validateSendContext(input?: SendContext): { pageContext?: PageContext; taskId?: string; messageMetadata?: { browser_annotations: BrowserAnnotations } };

export interface NativeUploadInput { roomId?: string; file: string; stateFile?: string; signal?: AbortSignal }
export interface NativeDownloadInput { roomId?: string; fileId: string; output?: string; overwrite?: boolean; signal?: AbortSignal }
export interface NativeTarget { dotId?: string; signal?: AbortSignal }
export class FullDotClient extends DotClient {
  static capabilities(): NativeCapabilities;
  capabilities(): NativeCapabilities;
  readonly operations: DotOperations;
  readonly lifecycle: DotLifecycle;
  readonly channels: DotChannels;
  readonly extras: RoutineExtras;
  readonly live: DotLive;
  readonly connections: DotConnections;
  readonly library: DotLibrary;
  readonly account: DotAccount;
  readonly projects: AccountProjects;
  readonly projectFiles: ProjectFiles;
  readonly projectSharing: ProjectSharing;
  readonly projectSources: ProjectSources;
  readonly projectSaves: ProjectSaves;
  readonly projectMemory: ProjectMemory;
  readonly projectUpload: ProjectUpload;
  readonly projectConnections: ProjectConnections;
  readonly conversations: ConversationClient;
  readonly dotExtras: DotExtras;
  readonly messageWorkflows: DotMessageWorkflows;
  readonly mail: DotMail;
  readonly libraryContent: LibraryContent;
  readonly libraryUpload: LibraryUpload;
  readonly sharing: LibrarySharing;
  readonly libraryProviders: LibraryProviders;
  readonly routineManagement: RoutineManagement;
  readonly connectorAdmin: DotConnectorAdmin;
  readonly plugins: DotPlugins;
  readonly remoteControl: DotRemoteControl;
  readonly browserAuth: DotBrowserAuth;
  readonly browserAuthNative: DotBrowserAuthNative;
  readonly browserExtras: DotBrowserExtras;
  readonly nativeActions: DotNativeActions;
  readonly onboarding: DotOnboarding;
  readonly savedEntities: SavedEntities;
  profile(options?: NativeTarget): Promise<DotProfile>;
  renameDot(options: NativeTarget & { name: string }): Promise<DotProfile>;
  runtimeAction(action: 'pause' | 'resume', options?: NativeTarget): Promise<{ dotId: string; action: string; status: string; threadId: string | null }>;
  pauseDot(options?: NativeTarget): Promise<{ dotId: string; action: string; status: string; threadId: string | null }>;
  resumeDot(options?: NativeTarget): Promise<{ dotId: string; action: string; status: string; threadId: string | null }>;
  upload(options: NativeUploadInput): Promise<NativeUploadResult>;
  download(options: NativeDownloadInput): Promise<NativeDownloadResult>;
  artifacts(options?: { roomId?: string; pages?: number; signal?: AbortSignal }): Promise<ArtifactsPage>;
  historyPages(options?: NativeHistoryInput): Promise<NativeHistoryPage & { pagesRead: number; truncated: boolean }>;
  search(options: SearchInput & { signal?: AbortSignal }): Promise<NativeSearchResult>;
  thread(options: NativeHistoryInput & { messageId: string }): Promise<NativeHistoryPage>;
  outline(options?: NativeHistoryInput): Promise<unknown>;
  exportHistory(options: NativeHistoryInput & { output: string; format?: 'json' | 'md'; overwrite?: boolean }): Promise<{ path: string; format: 'json' | 'md'; messageCount: number; pagesRead: number; truncated: boolean }>;
  send(options?: NativeSendInput & { files?: string[]; waitSeconds?: number }): Promise<NativeSendResult>;
  watch(options?: NativeWatchOptions & { cursorFile?: string }): Promise<void>;
  watchAll(options?: NativeWatchOptions): Promise<void>;
  voiceAllocate(options: VoiceAllocateInput): Promise<unknown>;
  voiceAttach(options: VoiceCallInput): Promise<unknown>;
  voiceStop(options: VoiceCallInput): Promise<unknown>;
  voiceChat(options?: NativeOptions): Promise<unknown>;
  actions(options?: NativeOptions & { roomId?: string; limit?: number; before?: string; after?: string }): Promise<unknown>;
  elicitation(options: NativeOptions & { roomId?: string; messageId: string }): Promise<unknown>;
  respond(options: NativeOptions & { roomId?: string; messageId: string; action: string; content?: JsonValue; persist?: boolean; requestFingerprint?: string; requestId?: string }): Promise<unknown>;
  react(options: NativeOptions & { roomId?: string; messageId: string; reaction: string }): Promise<unknown>;
  markRead(options: NativeOptions & { roomId?: string; messageId?: string }): Promise<unknown>;
  email(options: NativeOptions & { roomId?: string; messageId: string }): Promise<unknown>;
}

/** A native capability document describes supported and unverified provider operations. */
export type NativeCapabilities = Readonly<Record<string, unknown>>;
export interface NativePageInput extends NativeOptions { limit?: number; pages?: number; cursor?: string }
export interface NativeProjectInput extends NativePageInput { accountId: string; projectId: string }
export interface NativeFileInput extends NativePageInput { fileId: string }
export interface NativeConnectorInput extends NativeOptions { connectorId: string; linkId?: string }
export interface NativeConversationInput extends NativeOptions { conversationId: string }
export interface NativeRoutineInput extends NativePageInput { routineId: string }

export class DotLifecycle {
  constructor(client: DotClient);
  target(options?: NativeTarget & { threadId?: string }): Promise<unknown>;
  create(options?: NativeOptions & { name?: string; createThread?: boolean; createAdditional?: boolean; shouldInitialize?: boolean }): Promise<unknown>;
  remove(options: NativeTarget & { confirmDotId: string }): Promise<unknown>;
  setPrimary(options: NativeTarget): Promise<unknown>;
  clearPrimary(options: NativeOptions & { generation: string; confirm: true }): Promise<unknown>;
  avatar(options?: NativeTarget & { name?: string }): Promise<unknown>;
  uploadAvatarSnapshot(options: NativeOptions & { file: string; avatarManifest: JsonObject }): Promise<unknown>;
  ensureRoom(options?: NativeTarget): Promise<unknown>;
  rootThread(options?: NativeTarget): Promise<unknown>;
  reboot(options: NativeTarget & { confirmDotId: string }): Promise<unknown>;
  environmentStatus(options?: NativeOptions): Promise<unknown>;
  recreateEnvironment(options?: NativeOptions): Promise<unknown>;
  listComputers(options?: NativeOptions): Promise<unknown>;
  connectComputer(options: NativeOptions): Promise<unknown>;
  replaceComputer(options: NativeOptions): Promise<unknown>;
  disconnectComputer(options: NativeOptions): Promise<unknown>;
  activity(options?: NativePageInput & NativeTarget): Promise<unknown>;
  doctorCheckIn(options: NativeOptions & { threadId: string }): Promise<unknown>;
  doctorSetup(options: NativeOptions & { threadId: string; confirm: true }): Promise<unknown>;
  safetyReview(options?: NativeTarget): Promise<unknown>;
  resumeReviewed(options: NativeOptions): Promise<unknown>;
}
export class DotChannels {
  constructor(client: DotClient);
  emailStatus(options?: NativeTarget): Promise<unknown>;
  emailOptions(options?: NativeTarget): Promise<unknown>;
  claimEmail(options: NativeTarget & { localPart: string; domain: string; acceptedConsent: boolean }): Promise<unknown>;
  linkEmail(options: NativeTarget & { inboxId: string; acceptedConsent: boolean }): Promise<unknown>;
  removeEmail(options?: NativeTarget): Promise<unknown>;
  startMeeting(options: NativeTarget & { meetingUrl: string; idempotencyKey?: string }): Promise<unknown>;
}
export class DotOperations {
  constructor(client: DotClient);
  listRoutines(options?: NativePageInput & NativeTarget & { all?: boolean; filter?: string }): Promise<unknown>;
  getRoutine(options: NativeRoutineInput): Promise<unknown>;
  createRoutine(options: NativeOptions): Promise<unknown>;
  updateRoutine(options: NativeRoutineInput): Promise<unknown>;
  setRoutineEnabled(options: NativeRoutineInput & { enabled: boolean }): Promise<unknown>;
  deleteRoutine(options: NativeRoutineInput): Promise<unknown>;
  runRoutine(options: NativeRoutineInput & { idempotencyKey?: string }): Promise<unknown>;
  routineRuns(options: NativeRoutineInput): Promise<unknown>;
  routineRun(options: NativeRoutineInput & { runId: string }): Promise<unknown>;
  listTasks(options?: NativePageInput & NativeTarget): Promise<unknown>;
  getTask(options: NativeTarget & { taskId: string }): Promise<unknown>;
  listThreads(options?: NativePageInput & NativeTarget): Promise<unknown>;
  connectorActions(options: NativeConnectorInput): Promise<unknown>;
  listConnectors(options?: NativeOptions & { connectorId?: string }): Promise<unknown>;
  mcpRequest(method: string, params: JsonObject, options?: NativeOptions): Promise<unknown>;
  toolList(options?: NativeOptions): Promise<unknown>;
  toolCall(options: NativeOptions): Promise<unknown>;
  resourceList(options?: NativeOptions): Promise<unknown>;
  resourceTemplates(options?: NativeOptions): Promise<unknown>;
  resourceRead(options: NativeOptions): Promise<unknown>;
  promptList(options?: NativeOptions): Promise<unknown>;
}
export class RoutineExtras {
  constructor(client: DotClient);
  executionThreads(options: NativeRoutineInput): Promise<unknown>;
  markRunRead(options: NativeRoutineInput & { runId: string }): Promise<unknown>;
  latestRun(options: NativeRoutineInput): Promise<unknown>;
  batchStatus(options: NativeRoutineInput): Promise<unknown>;
  flushBatch(options: NativeRoutineInput & { requestId?: string }): Promise<unknown>;
  schedulePolicy(options?: NativeOptions & { serviceAccountId?: string }): Promise<unknown>;
  connectorDetails(options: NativeConnectorInput): Promise<unknown>;
  connectorHealth(options: NativeConnectorInput & { linkId: string }): Promise<unknown>;
}
export interface NativeStreamOptions extends NativeOptions {
  reconnect?: boolean;
  onEvent?: (event: unknown) => void | Promise<void>;
  onReady?: (event: unknown) => void | Promise<void>;
}
export class DotLive {
  constructor(client: DotClient, options?: NativeOptions);
  listActivity(options?: NativePageInput & NativeTarget): Promise<unknown>;
  taskEvents(options?: NativeStreamOptions & NativeTarget & { taskId?: string }): Promise<void>;
  watch(options?: NativeStreamOptions & { roomId?: string; all?: boolean; taskId?: string }): Promise<void>;
  activity(options?: NativeStreamOptions & NativeTarget): Promise<void>;
  roomLive(options?: NativeStreamOptions & { roomId?: string }): Promise<void>;
}
export class DotConnections {
  constructor(client: DotClient, options?: NativeOptions & { productSku?: string; assertCurrent?: () => void | Promise<void> });
  get(options: NativeConnectorInput): Promise<unknown>;
  status(options: NativeConnectorInput): Promise<unknown>;
  startOAuth(options: NativeConnectorInput & { actionNames?: string[]; requestedScopes?: string[]; linkParams?: JsonObject }): Promise<unknown>;
  reauthorize(options: NativeConnectorInput & { linkId: string; requestedScopes?: string[] }): Promise<unknown>;
  completeOAuth(options: NativeConnectorInput & { redirectFile?: string; input?: unknown }): Promise<unknown>;
  linkApiKey(options: NativeConnectorInput & { keyFile?: string; input?: unknown; actionNames?: string[]; linkParams?: JsonObject }): Promise<unknown>;
  linkNoAuth(options: NativeConnectorInput): Promise<unknown>;
  unlink(options: NativeConnectorInput & { linkId: string }): Promise<unknown>;
}
export class DotLibrary {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  browse(options?: NativePageInput & { directoryId?: string | null; query?: string; foldersOnly?: boolean }): Promise<unknown>;
  search(options: NativePageInput & { query: string; trash?: boolean }): Promise<unknown>;
  get(options: NativeFileInput & { includeTrashed?: boolean }): Promise<unknown>;
  directoryPath(options?: NativeOptions & { directoryId?: string | null }): Promise<unknown>;
  rename(options: NativeFileInput & { name: string }): Promise<unknown>;
  renameDirectory(options: NativeOptions & { directoryId: string; name: string }): Promise<unknown>;
  move(options: NativeFileInput & { directoryId: string | null }): Promise<unknown>;
  moveDirectory(options: NativeOptions & { directoryId: string; parentDirectoryId: string | null }): Promise<unknown>;
  trash(options: NativeFileInput & { confirm: string }): Promise<unknown>;
  restore(options: NativeFileInput): Promise<unknown>;
  versions(options: NativeFileInput): Promise<unknown>;
  restoreVersion(options: NativeFileInput & { version: number; expectedCurrentVersion: number; confirm: string }): Promise<unknown>;
  favorites(options?: NativePageInput): Promise<unknown>;
  favorite(options: NativeFileInput): Promise<unknown>;
  unfavorite(options: NativeOptions & { favoriteId: string }): Promise<unknown>;
  favoriteStatus(options: NativeOptions & { fileIds: string[] }): Promise<unknown>;
  storageUsage(options?: NativeOptions): Promise<unknown>;
}

export const ACCOUNT_SETTING_FEATURES: readonly string[];
export interface NativeAccountInput extends NativeOptions { accountId: string }
export class DotAccount {
  constructor(client: DotClient, options?: NativeOptions);
  capabilities(): NativeCapabilities;
  memoryList(options: NativeAccountInput): Promise<unknown>;
  memoryCapacity(options: NativeAccountInput): Promise<unknown>;
  memoryDelete(options: NativeAccountInput): Promise<unknown>;
  memoryWarm(options: NativeAccountInput): Promise<unknown>;
  memoryClear(options: NativeAccountInput): Promise<unknown>;
  personalizationGet(options: NativeAccountInput): Promise<unknown>;
  personalityTypes(options: NativeAccountInput): Promise<unknown>;
  personalityTraitTypes(options: NativeAccountInput): Promise<unknown>;
  personalizationUpdate(options: NativeAccountInput): Promise<unknown>;
  notificationGet(options: NativeAccountInput): Promise<unknown>;
  voices(options: NativeAccountInput): Promise<unknown>;
  notificationUpdate(options: NativeAccountInput): Promise<unknown>;
  settingsGet(options: NativeAccountInput): Promise<unknown>;
  settingsSet(options: NativeAccountInput): Promise<unknown>;
  summaryChecksum(options: NativeAccountInput): Promise<unknown>;
  summaryGet(options: NativeAccountInput): Promise<unknown>;
  summarySelectionActions(options: NativeAccountInput): Promise<unknown>;
  summaryStream(options: NativeAccountInput & NativeStreamOptions): Promise<unknown>;
  summaryRegenerate(options: NativeAccountInput & NativeStreamOptions): Promise<unknown>;
  summaryCorrect(options: NativeAccountInput): Promise<unknown>;
  summaryForget(options: NativeAccountInput): Promise<unknown>;
  summaryClear(options: NativeAccountInput): Promise<unknown>;
}
export const PROJECT_THEMES: Readonly<{ black: null; blue: '#0285ff'; green: '#04b84c'; orange: '#fb6a22'; pink: '#ff66ad'; purple: '#924ff7'; red: '#fa423e'; yellow: '#ffc300' }>;
export type ProjectTheme = keyof typeof PROJECT_THEMES;
export class AccountProjects {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  get(options: NativeProjectInput): Promise<unknown>;
  list(options: NativeAccountInput & NativePageInput & { ownedOnly?: boolean }): Promise<unknown>;
  conversations(options: NativeProjectInput & { ownedOnly?: boolean }): Promise<unknown>;
  create(options: NativeAccountInput & { name: string; emoji?: string | null; theme?: ProjectTheme; memoryScope?: string }): Promise<unknown>;
  update(options: NativeProjectInput & { name?: string; emoji?: string | null; theme?: ProjectTheme; instructions?: string; memoryScope?: string; clearEmoji?: boolean; clearTheme?: boolean }): Promise<unknown>;
  delete(options: NativeProjectInput & { confirm: string; deleteChats: true }): Promise<unknown>;
  pinned(options: NativeAccountInput): Promise<unknown>;
  pin(options: NativeProjectInput): Promise<unknown>;
  unpin(options: NativeProjectInput): Promise<unknown>;
}
/** Each project domain shares the native constructor and explicit account scope. */
export class ProjectFiles {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  list(options: NativeProjectInput): Promise<unknown>;
  attachLibrary(options: NativeProjectInput & { libraryFileIds: string[] }): Promise<unknown>;
  remove(options: NativeProjectInput & { fileId: string; confirm: string }): Promise<unknown>;
}
export class ProjectSharing {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  get(options: NativeProjectInput): Promise<unknown>;
  access(options: NativeProjectInput): Promise<unknown>;
  invite(options: NativeProjectInput): Promise<unknown>;
  role(options: NativeProjectInput & { subject: string; role: string }): Promise<unknown>;
  remove(options: NativeProjectInput & { subject: string }): Promise<unknown>;
}
export class ProjectSources {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  sourcesList(options: NativeProjectInput): Promise<unknown>;
  sourceGet(options: NativeProjectInput & { scopeId: string }): Promise<unknown>;
  sourceProviders(options: NativeProjectInput & { connectorType?: string }): Promise<unknown>;
  sourceAdd(options: NativeProjectInput & { connectorType: string; url: string; wait?: boolean; timeout?: number; interval?: number }): Promise<unknown>;
  sourceRemove(options: NativeProjectInput & { scopeId: string; confirm: string; shared?: boolean }): Promise<unknown>;
  sourceSync(options: NativeProjectInput & { scopeId: string; wait?: boolean; timeout?: number; interval?: number }): Promise<unknown>;
  sourceWait(options: NativeProjectInput & { scopeId: string; timeout?: number; interval?: number }): Promise<unknown>;
}
export class ProjectSaves {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  list(options: NativeProjectInput): Promise<unknown>;
  get(options: NativeProjectInput & { saveId: string }): Promise<unknown>;
  create(options: NativeProjectInput & { conversationId: string; messageId: string }): Promise<unknown>;
  rename(options: NativeProjectInput & { saveId: string; title: string }): Promise<unknown>;
  remove(options: NativeProjectInput & { saveId: string; confirm: string }): Promise<unknown>;
}
export class ProjectMemory {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  get(options: NativeProjectInput): Promise<unknown>;
  set(options: NativeProjectInput & { scope: string; confirm: string }): Promise<unknown>;
}
export class ProjectUpload {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  status(options: NativeAccountInput & { stateFile: string }): Promise<unknown>;
  upload(options: NativeProjectInput & { file: string; stateFile: string; mimeType?: string; resumeParts?: boolean }): Promise<unknown>;
  reconcile(options: NativeAccountInput & { stateFile: string }): Promise<unknown>;
}
export class ProjectConnections {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  connectionGet(options: NativeProjectInput): Promise<unknown>;
  connectionStatus(options: NativeProjectInput): Promise<unknown>;
  connectionTos(options: NativeProjectInput): Promise<unknown>;
  connectionStart(options: NativeProjectInput): Promise<unknown>;
  connectionReauthorize(options: NativeProjectInput): Promise<unknown>;
  connectionNoAuth(options: NativeProjectInput): Promise<unknown>;
  connectionComplete(options: NativeAccountInput & { stateFile: string; redirectFile?: string; input?: unknown }): Promise<unknown>;
  connectionOperation(options: NativeAccountInput & { stateFile: string }): Promise<unknown>;
}
export function accountProjectCapabilities(): NativeCapabilities;
export function projectFileCapabilities(): NativeCapabilities;
export function projectSharingCapabilities(): NativeCapabilities;
export function projectSourceCapabilities(): NativeCapabilities;
export function projectSaveCapabilities(): NativeCapabilities;
export function projectMemoryCapabilities(): NativeCapabilities;
export function projectUploadCapabilities(): NativeCapabilities;
export function projectConnectionCapabilities(): NativeCapabilities;
export function normalizeProjectWebsiteUrl(value: string): string;

export class ConversationClient {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  list(options?: NativePageInput & { offset?: number; order?: string; archived?: boolean; starred?: boolean; expand?: boolean }): Promise<unknown>;
  search(options: NativePageInput & { query: string }): Promise<unknown>;
  batch(options: NativeOptions & { conversationIds: string[] }): Promise<unknown>;
  get(options: NativeConversationInput): Promise<unknown>;
  history(options: NativeConversationInput & { before?: string; numTurns?: number }): Promise<unknown>;
  historyPages(options: NativeConversationInput & { pages?: number }): Promise<unknown>;
  rename(options: NativeConversationInput & { title: string }): Promise<unknown>;
  setArchived(options: NativeConversationInput & { archived: boolean }): Promise<unknown>;
  archive(options: NativeConversationInput): Promise<unknown>;
  unarchive(options: NativeConversationInput): Promise<unknown>;
  delete(options: NativeConversationInput & { confirm: string }): Promise<unknown>;
  selectResponse(options: NativeConversationInput & { nodeId: string }): Promise<unknown>;
  responses(options: NativeConversationInput): Promise<unknown>;
  setPinned(options: NativeConversationInput & { pinned: boolean }): Promise<unknown>;
  pin(options: NativeConversationInput): Promise<unknown>;
  unpin(options: NativeConversationInput): Promise<unknown>;
  moveProject(options: NativeConversationInput & { projectId?: string; root?: boolean }): Promise<unknown>;
  inbox(options?: NativePageInput & { unreadOnly?: boolean }): Promise<unknown>;
  markRead(options: NativeOptions & { itemIds: string[] }): Promise<unknown>;
  clearAsyncStatus(options: NativeConversationInput): Promise<unknown>;
  shareList(options?: NativeOptions): Promise<unknown>;
  shareGet(options: NativeOptions & { shareId: string }): Promise<unknown>;
  shareCreate(options: NativeConversationInput & { nodeId: string; publish?: boolean; confirm: string }): Promise<unknown>;
  shareUpdate(options: NativeOptions & { shareId: string; nodeId?: string; title?: string; publish?: boolean; visible?: boolean; confirm: string }): Promise<unknown>;
  shareRevoke(options: NativeOptions & { shareId: string; confirm: string }): Promise<unknown>;
}
export class DotExtras {
  constructor(client: DotClient);
  listThreads(options?: NativeTarget & NativePageInput & { includeHidden?: boolean }): Promise<unknown>;
  avatar(options?: NativeTarget & { onlyIfDefault?: boolean }): Promise<unknown>;
  recoverDeletions(options: NativeOptions & { confirm: boolean }): Promise<unknown>;
  setPrimaryThread(options: NativeOptions & { threadId: string }): Promise<unknown>;
  listReferencePhotos(options?: NativeOptions): Promise<unknown>;
  uploadReferencePhoto(options: NativeOptions & { file: string; kind?: string }): Promise<unknown>;
  updateReferencePhoto(options: NativeOptions & { file: string; imageTagId: string }): Promise<unknown>;
  removeReferencePhoto(options: NativeOptions & { imageTagId: string; confirmImageTagId: string }): Promise<unknown>;
}
export class DotMessageWorkflows {
  constructor(client: DotClient, options?: { now?: () => number });
  pluginSuggestions(options: NativeOptions & { reference: unknown }): Promise<unknown>;
  continuePlugins(options: NativeOptions & { reference: unknown; pluginIds: string[]; requestFingerprint: string }): Promise<unknown>;
  connectorAuth(options: NativeOptions & { reference: unknown; connect?: boolean }): Promise<unknown>;
  startConnectorAuth(options: NativeOptions & { reference: unknown; connect?: boolean; requestFingerprint: string; sessionFile: string }): Promise<unknown>;
  completeConnectorAuth(options: NativeOptions): Promise<unknown>;
}
export class DotMail {
  constructor(client: DotClient, options?: { now?: () => number });
  accounts(options?: NativeOptions): Promise<unknown>;
  send(options: NativeOptions & { provider: string; linkId: string; to: unknown; subject: string; body: string; cc?: unknown; bcc?: unknown; sendId?: string; replyTo?: unknown; sourceId?: string; sourceType?: string }): Promise<unknown>;
  status(options: NativeOptions & { sendId: string }): Promise<unknown>;
  undo(options: NativeOptions & { sendId: string; unsendExpiresAt: unknown }): Promise<unknown>;
  contacts(options: NativeOptions & { linkId: string; query: string }): Promise<unknown>;
}

export class LibraryContent {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  createDirectory(options: NativeOptions & { name: string; parentDirectoryId?: string | null }): Promise<unknown>;
  deleteDirectory(options: NativeOptions & { directoryId: string; confirm: string }): Promise<unknown>;
  registerUpload(options: NativeFileInput & { fileName: string; mimeType?: string | null; parentDirectoryId?: string | null }): Promise<unknown>;
  createInline(options: NativeOptions & { content: string; fileName: string; createKey?: string; directoryId?: string | null }): Promise<unknown>;
  updateInline(options: NativeFileInput & { content: string; fileName: string; confirm: string }): Promise<unknown>;
  recents(options?: NativePageInput & { providers?: string[]; externalAccountKeys?: string[] }): Promise<unknown>;
  markOpened(options: NativeFileInput): Promise<unknown>;
  download(options: NativeFileInput & { output?: string; overwrite?: boolean }): Promise<unknown>;
  content(options: NativeFileInput & { output?: string; overwrite?: boolean }): Promise<unknown>;
  thumbnail(options: NativeFileInput & { output?: string; overwrite?: boolean }): Promise<unknown>;
  planSummary(options: NativeFileInput): Promise<unknown>;
  deepResearch(options: NativeFileInput): Promise<unknown>;
  deepResearchState(options: NativeFileInput): Promise<unknown>;
  deepResearchImages(options: NativeFileInput): Promise<unknown>;
  deepResearchExport(options: NativeFileInput & { output?: string; overwrite?: boolean }): Promise<unknown>;
  permanentDelete(options: NativeFileInput & { confirm: string }): Promise<unknown>;
  deleteBatch(options: NativeOptions & { fileIds: string[]; confirmFileIds: string[] }): Promise<unknown>;
  emptyTrash(options: NativeOptions & { confirm: 'EMPTY LIBRARY TRASH' }): Promise<unknown>;
}
export class LibraryUpload {
  constructor(client: DotClient);
  status(options: NativeOptions & { stateFile: string }): Promise<unknown>;
  upload(options: NativeOptions & { file: string; stateFile: string; directoryId?: string | null; mimeType?: string; resumeParts?: boolean }): Promise<unknown>;
  reconcile(options: NativeOptions & { stateFile: string }): Promise<unknown>;
}
export interface SavedEntityBase {
  name: string;
  imageUrl?: string;
  origin?: { conversationId: string; messageId: string };
}
export interface SavedProductSpec extends SavedEntityBase {
  kind: 'product';
  productId: string;
  url: string;
  query: string;
  provider: string;
  productLookupKey?: JsonObject;
  rewrittenQueries?: string[];
}
export interface SavedLocalBusinessSpec extends SavedEntityBase {
  kind: 'local-business';
  category?: string;
  entityKey?: string;
  entityLookupId?: string;
  businessId?: string;
  provider?: string;
}
export type SavedEntitySpec = SavedProductSpec | SavedLocalBusinessSpec;
export function buildSavedEntityRequest(spec: SavedEntitySpec): JsonObject;
export class SavedEntities {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  status(options: NativeAccountInput & { specs: SavedEntitySpec[] }): Promise<unknown>;
  get(options: NativeAccountInput & { fileId: string }): Promise<unknown>;
  save(options: NativeAccountInput & { spec: SavedEntitySpec }): Promise<unknown>;
  remove(options: NativeAccountInput & { fileId: string; confirm: string }): Promise<unknown>;
  move(options: NativeAccountInput & { fileId: string; directoryId?: string; root?: boolean }): Promise<unknown>;
}
export class LibrarySharing {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  identity(options?: NativeOptions): Promise<unknown>;
  state(options: NativeOptions): Promise<unknown>;
  shares(options: NativeOptions): Promise<unknown>;
  effectiveAccess(options: NativeOptions): Promise<unknown>;
  collaborators(options: NativeOptions): Promise<unknown>;
  resolveRecipient(options: NativeOptions): Promise<unknown>;
  createShare(options: NativeOptions): Promise<unknown>;
  removeShare(options: NativeOptions): Promise<unknown>;
  updateLinkAccess(options: NativeOptions): Promise<unknown>;
  previewAccessChange(options: NativeOptions): Promise<unknown>;
  applyAccessChange(options: NativeOptions): Promise<unknown>;
  accessRequests(options: NativeOptions): Promise<unknown>;
  createAccessRequest(options: NativeOptions): Promise<unknown>;
  decideAccessRequest(options: NativeOptions): Promise<unknown>;
  invitations(options?: NativePageInput): Promise<unknown>;
  invitation(options: NativeOptions): Promise<unknown>;
  acceptInvitation(options: NativeOptions): Promise<unknown>;
  declineInvitation(options: NativeOptions): Promise<unknown>;
  removeReceivedShare(options: NativeOptions): Promise<unknown>;
}
export class LibraryProviders {
  constructor(client: DotClient);
  capabilities(): NativeCapabilities;
  browse(options?: NativePageInput & { directoryId?: string | null; query?: string }): Promise<unknown>;
  librarySearch(options: NativePageInput & { query: string }): Promise<unknown>;
  mountedCapabilities(options: NativeOptions & { provider: string; linkId?: string }): Promise<unknown>;
  oneDriveCapability(options?: NativeOptions): Promise<unknown>;
  search(options: NativePageInput & { query: string; providers?: string[] }): Promise<unknown>;
  searchCache(options: NativePageInput & { query: string; provider?: string }): Promise<unknown>;
  recents(options?: NativePageInput & { providers?: string[]; externalAccountKeys?: string[] }): Promise<unknown>;
  materialize(options: NativeFileInput & { name: string; mimeType?: string | null; indexForRetrieval?: boolean }): Promise<unknown>;
  fileMetadata(options: NativeFileInput & { provider: string }): Promise<unknown>;
  resolve(options: NativeOptions & { provider: string; url?: string; nativeFileId?: string }): Promise<unknown>;
  preview(options: NativeFileInput & { provider: string }): Promise<unknown>;
  sharedSearch(options: NativeOptions & { query: string }): Promise<unknown>;
  globalSearch(options: NativePageInput & { query: string }): Promise<unknown>;
  referenceImages(options?: NativePageInput): Promise<unknown>;
  createReferenceImage(options: NativeOptions & { entityName: string; entityType: string; assetPointer: unknown }): Promise<unknown>;
  updateReferenceImage(options: NativeOptions & { referenceImageId: string; entityName: string; entityType: string }): Promise<unknown>;
  deleteReferenceImage(options: NativeOptions & { referenceImageId: string; confirm: string }): Promise<unknown>;
  referenceThumbnail(options: NativeOptions & { referenceImageId: string; output?: string; overwrite?: boolean }): Promise<unknown>;
  imageFavorite(options: NativeOptions & { source: unknown }): Promise<unknown>;
  imageFavoriteStatus(options: NativeOptions & { sources: unknown[] }): Promise<unknown>;
  /** No verified constructor exists; this operation rejects without writing. */
  saveChatMessage(): Promise<never>;
  conversationFavorites(options: NativePageInput & { conversationId: string }): Promise<unknown>;
}
export class RoutineManagement {
  constructor(client: DotClient);
  query(options?: NativePageInput & { scope?: string; query?: string; status?: string; sort?: string }): Promise<unknown>;
  currentShare(options: NativeRoutineInput): Promise<unknown>;
  createShare(options: NativeRoutineInput): Promise<unknown>;
  refreshShare(options: NativeRoutineInput): Promise<unknown>;
  revokeShare(options: NativeRoutineInput): Promise<unknown>;
  shared(options: NativeOptions & { postId: string }): Promise<unknown>;
  creationPrompt(options: NativeOptions & { postId: string; title?: string; prompt?: string; schedule?: JsonValue; timingMode?: string }): Promise<unknown>;
}

export class DotConnectorAdmin extends DotConnections {
  tos(options: NativeConnectorInput): Promise<unknown>;
  mfaRequirement(options: NativeConnectorInput): Promise<unknown>;
  setPrivacy(options: NativeConnectorInput & { linkId: string; policy: string }): Promise<unknown>;
  unlinkAll(options: NativeConnectorInput & { confirmConnectorId: string }): Promise<unknown>;
  tunnels(options?: NativeOptions): Promise<unknown>;
  discoverOAuth(options: NativeOptions & { target: unknown }): Promise<unknown>;
  oauthClients(options: NativeOptions & { service: string }): Promise<unknown>;
  oauthCallback(options: NativeOptions & { target: unknown }): Promise<unknown>;
  createMcp(options: NativeOptions & { name: string; description?: string; target: unknown; authRequest?: unknown; clientSecretFile?: string; logoFile?: string; input?: unknown }): Promise<unknown>;
  updateMcp(options: NativeConnectorInput & { field: string; value?: unknown; logoFile?: string; input?: unknown }): Promise<unknown>;
  refreshActions(options: NativeConnectorInput): Promise<unknown>;
  /** Deletion has no verified native contract and rejects without writing. */
  deleteMcp(): Promise<never>;
  serviceAccountLinks(options: NativeOptions & { serviceAccountUserId: string }): Promise<unknown>;
  serviceAccountOAuth(options: NativeConnectorInput & { serviceAccountUserId: string }): Promise<unknown>;
  serviceAccountApiKey(options: NativeConnectorInput & { serviceAccountUserId: string; keyFile?: string; input?: unknown }): Promise<unknown>;
  serviceAccountNoAuth(options: NativeConnectorInput & { serviceAccountUserId: string }): Promise<unknown>;
  serviceAccountUnlink(options: NativeConnectorInput & { serviceAccountUserId: string; linkId: string; confirmLinkId: string }): Promise<unknown>;
  serviceAccountConnections(options: NativeOptions & { serviceAccountUserId: string; teamId: string }): Promise<unknown>;
  setServiceAccountConnection(options: NativeOptions & { serviceAccountUserId: string; teamId: string; linkId: string; enabled: boolean }): Promise<unknown>;
  setServiceAccountReadOnly(options: NativeOptions & { serviceAccountUserId: string; linkId: string; readOnly: boolean }): Promise<unknown>;
}
export class DotPlugins {
  constructor(client: DotClient);
  list(options?: NativePageInput & { view?: string; scope?: string; q?: string; includeExtensions?: boolean }): Promise<unknown>;
  resolveApp(options: NativeOptions & { appId: string }): Promise<unknown>;
  home(options?: NativeOptions): Promise<unknown>;
  get(options: NativeOptions & { pluginId: string }): Promise<unknown>;
  batch(options: NativeOptions & { pluginIds: string[] }): Promise<unknown>;
  skill(options: NativeOptions & { pluginId: string; skillName: string }): Promise<unknown>;
  setSkillEnabled(options: NativeOptions & { pluginId: string; skillName: string; enabled: boolean }): Promise<unknown>;
  install(options: NativeOptions & { pluginId: string; installAttemptId?: string }): Promise<unknown>;
  setEnabled(options: NativeOptions & { pluginId: string; enabled: boolean }): Promise<unknown>;
  uninstall(options: NativeOptions & { pluginId: string; confirmPluginId: string }): Promise<unknown>;
  delete(options: NativeOptions & { pluginId: string; confirmPluginId: string }): Promise<unknown>;
  shares(options: NativeOptions & { pluginId: string }): Promise<unknown>;
  setShares(options: NativeOptions & { pluginId: string; targets: unknown[]; discoverability?: string }): Promise<unknown>;
  exportArchive(options: NativeOptions & { pluginId: string; output: string; overwrite?: boolean }): Promise<unknown>;
  importArchive(options: NativeOptions & { file: string; pluginId?: string; confirmPluginId?: string; stateFile?: string; reservationFile?: string }): Promise<unknown>;
  importStatus(options: NativeOptions & { stateFile: string; reservationFile?: string }): Promise<unknown>;
  teamList(options: NativeOptions & { serviceAccountUserId: string; teamId: string }): Promise<unknown>;
  teamInstall(options: NativeOptions & { serviceAccountUserId: string; teamId: string; pluginId: string }): Promise<unknown>;
  teamUninstall(options: NativeOptions & { serviceAccountUserId: string; teamId: string; pluginId: string; confirmPluginId: string }): Promise<unknown>;
}

export interface VoiceAllocateInput extends NativeTarget { rootThreadId?: string; sdp: string; instantConnect?: boolean; expectedAccountId?: string }
export interface VoiceCallInput extends NativeTarget { callId: string; expectedAccountId?: string }
export function allocateVoiceCall(client: DotClient, options: VoiceAllocateInput): Promise<unknown>;
export function attachVoiceCall(client: DotClient, options: VoiceCallInput): Promise<unknown>;
export function stopVoiceCall(client: DotClient, options: VoiceCallInput): Promise<unknown>;
export function createVoiceSessionServer(client: DotClient, options?: NativeOptions): Promise<unknown>;
export function runVoiceChat(client: DotClient, options?: NativeOptions): Promise<unknown>;
export function negotiateRemoteControl(client: DotClient, options: NativeOptions & { sdp: string }): Promise<unknown>;
export function createRemoteControlServer(client: DotClient, options?: NativeOptions): Promise<unknown>;
export function runRemoteControl(client: DotClient, options?: NativeOptions): Promise<unknown>;
export class DotRemoteControl {
  constructor(client: DotClient);
  negotiate(options: NativeOptions & { sdp: string }): Promise<unknown>;
  server(options?: NativeOptions): Promise<unknown>;
  open(options?: NativeOptions): Promise<unknown>;
}
export class DotBrowserAuth {
  constructor(client: DotClient);
  prepare(options: NativeOptions): Promise<unknown>;
  availability(options: NativeOptions): Promise<unknown>;
  candidates(options: NativeOptions): Promise<unknown>;
  reconcile(options: NativeOptions): Promise<unknown>;
}
export interface NativeStateInput extends NativeOptions { stateFile: string }
export class DotBrowserAuthNative {
  constructor(client: DotClient, options?: NativeOptions);
  inspectChallenge(options: NativeOptions): Promise<unknown>;
  claim(options: NativeOptions): Promise<unknown>;
  state(options: NativeStateInput): Promise<unknown>;
  fill(options: NativeStateInput & { credentialsFile?: string; selectedOption?: string; remember?: boolean; input?: unknown }): Promise<unknown>;
  reuse(options: NativeStateInput & { credentialId: string }): Promise<unknown>;
  recover(options: NativeStateInput): Promise<unknown>;
  startManager(options: NativeStateInput): Promise<unknown>;
  managerStatus(options: NativeStateInput): Promise<unknown>;
  openManagerApproval(options: NativeStateInput): Promise<unknown>;
  useManager(options: NativeStateInput): Promise<unknown>;
}
export class DotBrowserExtras {
  constructor(client: DotClient);
  config(options?: NativeOptions): Promise<unknown>;
  updateConfig(options: NativeOptions & { policy?: string; approvalMode?: string; disableAutoReview?: boolean; confirm: string }): Promise<unknown>;
  origins(options?: NativeOptions): Promise<unknown>;
  setOrigin(options: NativeOptions): Promise<unknown>;
  removeOrigin(options: NativeOptions): Promise<unknown>;
  passkeys(options?: NativeOptions): Promise<unknown>;
  deletePasskey(options: NativeOptions & { credentialId: string; confirm: string }): Promise<unknown>;
  qrStatus(options: NativeOptions): Promise<unknown>;
  handoffStatus(options: NativeOptions): Promise<unknown>;
  cookies(options: NativeOptions): Promise<unknown>;
  deleteCookies(options: NativeOptions): Promise<unknown>;
  clearCookies(options: NativeOptions): Promise<unknown>;
  viewerServer(options?: NativeOptions): Promise<unknown>;
  qrOpen(options: NativeOptions): Promise<unknown>;
  handoffOpen(options: NativeOptions): Promise<unknown>;
}
export class DotNativeActions {
  constructor(client: DotClient, options?: NativeOptions);
  inspect(options: NativeOptions): Promise<unknown>;
  start(options: NativeOptions): Promise<unknown>;
  status(options: NativeOptions): Promise<unknown>;
  complete(options: NativeOptions): Promise<unknown>;
  approveEmailOtp(options: NativeOptions): Promise<unknown>;
}
export class DotOnboarding {
  constructor(client: DotClient);
  eligibility(options?: NativeOptions): Promise<unknown>;
  create(options: NativeOptions & { operationFile: string }): Promise<unknown>;
  status(options: NativeOptions & { operationFile: string }): Promise<unknown>;
  resume(options: NativeOptions & { operationFile: string; dotId: string; confirmDotId: string; retryRoom?: boolean }): Promise<unknown>;
}
export function resolveBrowserAuthChallenge(client: DotClient, options?: NativeOptions): Promise<unknown>;
export function uploadRecoverable(client: DotClient, options: NativeUploadInput & { stateFile: string }): Promise<NativeUploadResult>;
export function validateActionForm(content: JsonObject, schema: JsonObject, options?: { signal?: AbortSignal; timeoutMs?: number; workerFactory?: (url: URL, options: NativeOptions) => unknown }): Promise<JsonObject>;
