import type { FullDotClient } from './advanced.js';

/** JSON values retain their provider-defined keys and content. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type ErrorCode =
  | 'INVALID_ARGUMENT' | 'AUTH_REQUIRED' | 'AUTH_FAILED' | 'UNSUPPORTED_OPERATION'
  | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'CLOSED' | 'RESYNC_REQUIRED'
  | 'OPERATION_FAILED';
export const ErrorCode: Readonly<{ [Code in ErrorCode]: Code }>;

export interface ErrorDetails {
  status?: number;
  requestId?: string;
  nativeCode?: string;
  receipt?: SendResult;
  deliveryState?: 'unknown' | 'accepted' | 'not_sent';
}

/** Safe, stable SDK errors. A receipt means acceptance, never task completion. */
export class DotterError extends Error {
  constructor(code: ErrorCode, message?: string, details?: ErrorDetails);
  readonly code: ErrorCode;
  readonly details: Readonly<ErrorDetails>;
  readonly status?: number;
  readonly requestId?: string;
  readonly nativeCode?: string;
  readonly receipt?: SendResult;
  readonly deliveryState?: 'unknown' | 'accepted' | 'not_sent';
  toJSON(): { error: { code: ErrorCode; message: string } & ErrorDetails };
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Deadline for the entire operation, including authentication and queues. */
  timeoutMs?: number;
}

/** Credentials stay in the Node host. Never pass them to a browser renderer. */
export interface AuthCredentials {
  accessToken: string;
  accountId?: string | null;
  expiresAt?: number | null;
  authFile?: string;
}
export interface AuthProvider {
  load(options: { authFile?: string; signal?: AbortSignal }): Promise<AuthCredentials>;
}
export interface AuthStatus {
  status: 'ready';
  mode: 'chatgpt';
  hasAccountSelector: boolean;
  accountId: string | null;
  expiresAt: string | null;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];
export interface TransportRequestOptions extends RequestOptions {
  query?: Readonly<Record<string, QueryValue>>;
  body?: JsonValue;
  headers?: Readonly<Record<string, string>>;
  expectedAccountId?: string;
  idempotencyKey?: string;
  responseType?: 'json' | 'bytes';
  includeResponse?: boolean;
  allowNull?: boolean;
  range?: string;
  maxBytes?: number;
  bodyBytes?: Uint8Array;
  bodyFile?: unknown;
  contentType?: string;
}
export interface MultipartFile { name: string; mimeType: string; bytes: Uint8Array }
/** Optional methods are required only by operations that use that transport capability. */
export interface TransportLike {
  request(method: HttpMethod, route: string, options?: TransportRequestOptions): Promise<unknown>;
  requestMultipart?(method: 'POST', route: string, options: { file: MultipartFile; signal?: AbortSignal }): Promise<unknown>;
  requestBytes?(method: 'GET', route: string, options?: TransportRequestOptions): Promise<unknown>;
  fetchSigned?(url: string, options?: TransportRequestOptions): Promise<unknown>;
  close?(): void | Promise<void>;
}
export interface ClientOptions {
  authFile?: string;
  auth?: AuthProvider;
  transport?: TransportLike;
  /** Injected transports remain caller-owned unless this is true. */
  ownsTransport?: boolean;
  /** Default timeout for each native network request. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

export interface TargetInput { roomId?: string; dotId?: string }
export interface LocalAttachment { path: string; name?: string; mimeType?: string }

/** Native Page context and browser annotation records retain their wire keys. */
export type PageContext = { page_id: null; thread_id?: never } | { page_id: string; thread_id?: string };
export type BrowserSelection =
  | { kind: 'element'; immediate_text?: string | null; label?: string | null; element_type?: string | null }
  | { kind: 'region'; area_number: number; immediate_text?: null; label?: null; element_type?: null };
export interface BrowserAnnotation {
  comment: string;
  target_label?: string | null;
  screenshot_file_id?: string | null;
  browser_target_immediate_text?: string | null;
  browser_target_element_type?: string | null;
  browser_annotation_kind?: 'element' | 'region' | 'virtual' | 'text' | null;
  attached_browser_region?: boolean | null;
  design_tweak?: boolean | null;
  browser_selections?: BrowserSelection[] | null;
  design_tweak_changes?: { property: string; previous_value?: string | number | boolean | null; next_value: string | number | boolean }[] | null;
}
export interface BrowserAnnotations { version: 1; context_file_id: string; annotations: BrowserAnnotation[] }
export interface MessageMetadata { browser_annotations: BrowserAnnotations }
export interface SendContext {
  replyTo?: string;
  taskId?: string;
  pageContext?: PageContext;
  messageMetadata?: MessageMetadata;
  browserAnnotations?: BrowserAnnotations;
}
export interface SendInput extends TargetInput, SendContext {
  text?: string;
  /** Reply to an existing message. Supply this or the legacy replyTo alias, never both. */
  replyToMessageId?: string;
  /** @deprecated Use replyToMessageId. Supplying both fields is rejected. */
  replyTo?: string;
  attachments?: readonly (string | LocalAttachment)[];
  attachmentIds?: readonly string[];
  /** Defaults to false. Waiting observes replies; it does not establish task completion. */
  wait?: boolean;
  waitTimeoutMs?: number;
  idempotencyKey?: string;
}

export interface FileAttachment {
  type: string;
  attachmentId?: string;
  fileId?: string;
  name?: string;
  mimeType?: string;
  title?: string;
  sizeBytes?: number;
  postId?: string;
  conversationId?: string;
  threadId?: string;
}
export interface CallAttachment {
  type: 'call';
  callId: string;
  durationMs?: number;
  outcome?: 'completed' | 'ended' | 'failed' | 'interrupted' | 'not_connected' | 'unknown';
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string | null;
  updatedAt: string | null;
  replyToMessageId: string | null;
  streaming: boolean;
  attachments: (FileAttachment | CallAttachment)[];
  callHistory?: { calls: CallAttachment[]; summary: string; summarizing: boolean };
  taskId?: string;
  replyRootMessageId?: string;
  requestId?: string;
  senderId?: string;
  senderName?: string;
  isTaskUpdate?: boolean;
  deliveryState?: 'pending' | 'failed' | 'unknown';
  deliveryError?: string;
  reactions?: { emoji: string; count: number; accountUserIds: string[] }[];
}
export interface SendResult {
  accepted: true;
  roomId: string;
  messageId: string;
  idempotencyKey: string;
  createdAt: string | null;
  wait?: { status: 'observed' | 'timeout' | 'interrupted'; messages: Message[]; correlation?: string; error?: string };
}

export interface HistoryInput extends TargetInput {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  taskId?: string;
  replyRootMessageId?: string;
  pages?: number;
}
export interface HistoryPage {
  roomId: string;
  messages: Message[];
  prevCursor: string | null;
  nextCursor: string | null;
  lastItemId?: string | null;
  newestItemId?: string | null;
  pagesRead?: number;
  truncated?: boolean;
  hasMore?: boolean;
}
export interface SearchInput extends TargetInput {
  query: string;
  all?: boolean;
  pages?: number;
  since?: string;
  until?: string;
}
export interface SearchResult {
  query: string;
  matches: (Message & { roomId: string })[];
  scanned: number;
  rooms: number;
  truncated: boolean;
}
export interface WatchInput extends TargetInput {
  all?: boolean;
  intervalMs?: number;
  fromStart?: boolean;
  resumeAfter?: string;
  cursorFile?: string;
  /** Bounded event capacity. Overflow requires an explicit resync. */
  bufferSize?: number;
}
export type WatchEvent =
  | { type: 'message'; message: Message; roomId?: string; dotId?: string }
  | { type: 'ready'; roomId: string; initialCount: number; resumed?: boolean; replayed?: boolean; dotId?: string; dotCount?: number }
  | { type: 'cursor'; roomId: string; anchor: string | null };
export interface Subscription<Event = WatchEvent> extends AsyncIterable<Event> {
  readonly done: Promise<void>;
  readonly ready: Promise<void>;
  readonly cursor: string | null;
  cancel(): Promise<void>;
}

export interface UploadInput extends TargetInput, LocalAttachment { stateFile?: string }
export interface UploadedAttachment {
  type: 'file';
  fileId: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: string;
}
export interface FileInfo {
  roomId: string;
  fileId: string;
  libraryFileId?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: string;
}
export interface UploadResult extends FileInfo {
  attachment: UploadedAttachment;
  uploadId?: string;
  stateFile?: string;
}
export interface DownloadInput extends TargetInput { fileId: string; output?: string; overwrite?: boolean }
export interface DownloadResult extends FileInfo {
  output: string;
  /** @deprecated Use output for the saved file path. */
  path: string;
  sizeBytes: number;
}
export interface ArtifactsInput extends TargetInput { pages?: number }
export interface Artifact extends FileAttachment {
  messageId: string;
  createdAt: string | null;
  description?: string;
  status?: string;
  width?: number;
  height?: number;
}
export interface ArtifactsPage { roomId: string; artifacts: Artifact[]; pagesRead: number; nextCursor: string | null; truncated: boolean }
export interface DotProfile { id: string | null; name: string; roomId: string | null; threadId: string | null; kind?: string | null; status?: string | null }
export interface PrimaryDot extends DotProfile { roomId: string; available: true; generation?: unknown }

/** Stable supported operations. Provider-specific metadata remains explicitly opaque. */
export interface Capabilities {
  readonly service: 'dot';
  readonly send: true;
  readonly history: true;
  readonly watch: true;
  readonly search: true;
  readonly upload: boolean;
  readonly download: boolean;
  readonly artifacts: true;
  readonly targets: readonly ['roomId', 'dotId'];
  readonly maxAttachments: 10;
  readonly maxUploadBytes: number;
  readonly watchDelivery: 'at-least-once';
  readonly native: Readonly<Record<string, unknown>>;
}

/** SDK construction is offline. Authentication begins with an explicit operation. */
export class DotterClient {
  constructor(options?: ClientOptions);
  readonly advanced: FullDotClient;
  readonly auth: { status(options?: RequestOptions): Promise<AuthStatus> };
  capabilities(): Capabilities;
  send(input: SendInput, options?: RequestOptions): Promise<SendResult>;
  history(input?: HistoryInput, options?: RequestOptions): Promise<HistoryPage>;
  search(input: SearchInput, options?: RequestOptions): Promise<SearchResult>;
  watch(input?: WatchInput, options?: RequestOptions): Promise<Subscription>;
  upload(input: UploadInput, options?: RequestOptions): Promise<UploadResult>;
  download(input: DownloadInput, options?: RequestOptions): Promise<DownloadResult>;
  artifacts(input?: ArtifactsInput, options?: RequestOptions): Promise<ArtifactsPage>;
  primary(options?: RequestOptions): Promise<PrimaryDot>;
  listDots(options?: RequestOptions): Promise<DotProfile[]>;
  /** Idempotent cleanup. Never logs the account out. */
  close(): Promise<void>;
}
export function createClient(options?: ClientOptions): DotterClient;
