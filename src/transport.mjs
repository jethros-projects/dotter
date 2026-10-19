import { loadAuth } from './auth.mjs';
import { DotError } from './errors.mjs';
import { createNodeFetch } from './node-http.mjs';
import { randomUUID } from 'node:crypto';
import { USER_AGENT } from './version.mjs';

const ORIGIN = 'https://chatgpt.com';
const MAX_BODY = 10 * 1024 * 1024;
const MAX_UPLOAD_FILE = 512 * 1024 * 1024;
const MAX_AZURE_BLOCKS = 50_000;
function timeoutDuration(value) {
  if (!Number.isInteger(value) || value < 1 || value > 600000) throw new DotError('INVALID_ARGUMENT', 'Request timeout must be from 1 to 600000 milliseconds.');
  return value;
}

export function apiUrl(route, query = {}) {
  if (typeof route !== 'string' || !route.startsWith('/backend-api/') || /[\\\s?#]/.test(route)
      || route.split('/').some(part => ['.', '..'].includes(part) || /%2e|%2f|%5c/i.test(part))) {
    throw new DotError('INVALID_ROUTE', 'Only fixed ChatGPT API routes are allowed.');
  }
  const url = new URL(route, ORIGIN);
  if (url.origin !== ORIGIN) throw new DotError('INVALID_ROUTE', 'API origin cannot be changed.');
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const part of Array.isArray(value) ? value : [value]) {
      if (!['string', 'number', 'boolean'].includes(typeof part) || typeof part === 'number' && !Number.isFinite(part)) throw new DotError('INVALID_QUERY', 'Query values must be scalars or arrays of scalars.');
      url.searchParams.append(key, String(part));
    }
  }
  return url;
}

function rangeHeader(value) {
  if (value === undefined) return {};
  const match = typeof value === 'string' && /^bytes=(\d+)-(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))
    || Number(match[2]) < Number(match[1]) || Number(match[2]) - Number(match[1]) + 1 > 100 * 1024 * 1024) {
    throw new DotError('INVALID_RANGE', 'Use a bounded byte range of at most 100 MiB, such as bytes=0-1023.');
  }
  return { Range: value };
}

function responseEnvelope(response, body) {
  const headers = new Headers();
  for (const name of ['content-type', 'content-encoding', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'location', 'openai-root-thread-id', 'x-request-id']) {
    const value = response.headers.get(name); if (value !== null) headers.set(name, value);
  }
  return { status: response.status, headers, body };
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : undefined;
}

const STORAGE_UPLOAD_HEADERS = new Set([
  'content-type', 'content-md5', 'x-ms-blob-type', 'x-ms-version',
  'x-ms-blob-content-type', 'x-ms-blob-content-disposition', 'x-ms-blob-content-encoding',
  'x-ms-blob-content-language', 'x-ms-blob-cache-control',
  'x-amz-content-sha256', 'x-amz-checksum-sha256', 'x-amz-checksum-crc32', 'x-amz-checksum-crc32c',
]);
function uploadHeaders(defaults, required) {
  if (required === undefined) return defaults;
  if (!required || typeof required !== 'object' || Array.isArray(required) || Object.keys(required).length > 32) {
    throw new DotError('INVALID_HEADERS', 'Storage upload headers must be a bounded object.');
  }
  const result = { ...defaults }, seen = new Set();
  for (const [name, value] of Object.entries(required)) {
    const lower = name.toLowerCase();
    if (!STORAGE_UPLOAD_HEADERS.has(lower) || seen.has(lower) || typeof value !== 'string'
        || value.length < 1 || value.length > 8192 || /[\x00-\x1f\x7f-\x9f\u0100-\uffff]/.test(value)) {
      throw new DotError('INVALID_HEADERS', 'The storage reservation requires an unsupported or invalid upload header.');
    }
    seen.add(lower);
    const existing = Object.keys(result).find(key => key.toLowerCase() === lower);
    result[existing ?? lower] = value;
  }
  return result;
}

export function validateStorageUploadHeaders(required) {
  return uploadHeaders({}, required);
}

function storageUploadUrl(value, azureOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new DotError('INVALID_FILE_URL', 'Invalid signed upload URL.'); }
  const azure = /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname);
  const regionalAzure = /^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname);
  const aws = /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
  const host = azure || regionalAzure || !azureOnly && (url.hostname === 'files.oaiusercontent.com' || aws);
  const signed = azureOnly ? Boolean(url.searchParams.get('sig'))
    : ['sig', 'X-Amz-Signature', 'x-amz-signature', 'Signature'].some(key => !!url.searchParams.get(key));
  if (url.protocol !== 'https:' || !host || url.port || url.username || url.password || url.hash || !signed) {
    throw new DotError('UNSUPPORTED_FILE_HOST', 'The API did not return a recognized signed storage upload URL.');
  }
  return url;
}

function fileBody(source, { offset = 0, length = source?.sizeBytes, sha256 = source?.sha256 } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.path !== 'string' || !source.path.startsWith('/') || source.path.length > 8192 || /[\0\r\n]/.test(source.path)
      || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > MAX_UPLOAD_FILE
      || !['dev', 'ino'].every(key => typeof source[key] === 'string' && /^(?:0|[1-9]\d*)$/.test(source[key]))
      || !['mtimeMs', 'ctimeMs'].every(key => typeof source[key] === 'number' && Number.isFinite(source[key]))
      || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || offset + length > source.sizeBytes
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new DotError('INVALID_FILE', 'File-backed uploads require a verified regular file of 1 byte to 512 MiB and an exact range hash.');
  }
  return { path: source.path, sizeBytes: source.sizeBytes, dev: source.dev, ino: source.ino,
    mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs, offset, length, sha256 };
}

function azureBlockIndex(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{11}=$/.test(value)) throw new DotError('INVALID_ARGUMENT', 'Azure block IDs must encode a zero-based index padded to eight decimal digits.');
  const text = Buffer.from(value, 'base64').toString('ascii');
  if (!/^\d{8}$/.test(text) || Buffer.from(text, 'ascii').toString('base64') !== value) throw new DotError('INVALID_ARGUMENT', 'Azure block IDs must encode a zero-based index padded to eight decimal digits.');
  return Number(text);
}

const KNOWN_API_CODES = new Set([
  'cloud_aeon_deletion_pending', 'cloud_aeon_recovery_required',
  'cloud_aeon_onboarding_config_unavailable', 'cloud_aeon_creation_state_unavailable'
]);
function apiErrorDetails(contentType, text) {
  if (!/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) return {};
  let value;
  try { value = JSON.parse(text); } catch { return {}; }
  const objects = [value, value?.extra, value?.error, value?.detail, value?.detail?.error, value?.error?.error];
  const candidates = objects.flatMap(entry => [entry?.error_code, entry?.file_parse_error_code, entry?.code]);
  if (typeof value?.detail === 'string') candidates.push(value.detail);
  // Retain only observed public machine codes, never arbitrary server text.
  const code = candidates.find(candidate => KNOWN_API_CODES.has(candidate));
  const cloudAeon = candidates.some(candidate => typeof candidate === 'string' && candidate.startsWith('cloud_aeon_'));
  return { ...(code ? { apiCode: code } : {}), ...(cloudAeon ? { apiErrorFamily: 'cloud_aeon' } : {}) };
}

export function classifyResponse(status, headers, text) {
  const contentType = headers.get('content-type') || '';
  const requestId = safeId(headers.get('x-request-id') || headers.get('x-openai-request-id'));
  const cfRay = safeId(headers.get('cf-ray'));
  const details = { status, ...(requestId ? { requestId } : {}), ...(cfRay ? { cfRay } : {}), ...apiErrorDetails(contentType, text) };
  const challenge = headers.get('cf-mitigated') === 'challenge'
    || /\/cdn-cgi\/challenge-platform\/|_cf_chl_opt|enable javascript and cookies to continue/i.test(text);
  if (challenge) return new DotError('EDGE_CHALLENGE', 'The edge service requires a browser challenge. The CLI will not bypass it. Try again later or use ChatGPT normally.', details);
  if (status === 401) return new DotError('AUTH_REJECTED', 'The server rejected this Codex login. Run dotter auth login.', details);
  if (status === 403 && /text\/html/i.test(contentType)) return new DotError('FORBIDDEN_HTML', 'The server returned an HTML 403. This may be an edge rejection; it does not prove the login is invalid. Try again later.', details);
  if (status === 403) return new DotError('FORBIDDEN', 'This request is not permitted. Reads and sends may have different requirements.', details);
  if (status === 429) return new DotError('RATE_LIMITED', 'The service rate-limited this request. Wait before trying again.', details);
  if (status >= 300 && status < 400) return new DotError('REDIRECT_BLOCKED', 'The API redirected the request. Credentials were not forwarded.', details);
  return new DotError('HTTP_ERROR', `The API returned HTTP ${status}.`, details);
}

// Python exposes encoded wire bytes. Call before interpreting any response as
// text or an SSE stream; successful binary reads keep bytes and metadata intact.
export function assertResponseEncoding(status, headers, { binary = false } = {}) {
  if (headers.get('cf-mitigated') === 'challenge') throw classifyResponse(status, headers, '');
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (!binary && ![204, 205, 304].includes(status) && encoding && encoding !== 'identity') {
    if (status === 401 || status === 403) throw classifyResponse(status, headers, '');
    throw new DotError('INVALID_RESPONSE', 'The response uses a content encoding that cannot be safely inspected.', { status });
  }
}

async function readBounded(response, maxBytes = MAX_BODY, bytes = false, classifyIncomplete) {
  try { assertResponseEncoding(response.status, response.headers, { binary: bytes }); }
  catch (error) {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
    throw error;
  }
  if (!response.body) return bytes ? Buffer.alloc(0) : '';
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DotError('RESPONSE_TOO_LARGE', 'The response exceeded the configured size limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    // Only the requesting owner may interpret a bounded prefix of a refusal.
    // It stays out of the emitted error details and is never a successful body.
    throw classifyIncomplete ? classifyIncomplete(Buffer.concat(chunks)) : error;
  }
  finally { reader.releaseLock(); }
  const buffer = Buffer.concat(chunks);
  return bytes ? buffer : buffer.toString('utf8');
}

export class Transport {
  constructor({ authFile, fetchImpl, authLoader = loadAuth, timeoutMs = 30_000 } = {}) {
    this._closed = false;
    this._ownedFetch = fetchImpl === undefined ? createNodeFetch() : undefined;
    this.authFile = authFile; this.fetchImpl = fetchImpl ?? this._ownedFetch; this.authLoader = authLoader; this.timeoutMs = timeoutMs;
  }
  _assertOpen() { if (this._closed) throw new DotError('CLOSED', 'The transport is closed.', { delivery: 'not_sent' }); }
  async close() { this._closed = true; await this._ownedFetch?.close(); }
  assertIdentity(auth) {
    let subject = null;
    try { const payload = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); if (typeof payload.sub === 'string') subject = payload.sub; } catch {}
    const identity = { accountId: auth.accountId ?? null, subject };
    if (this.sessionIdentity && (this.sessionIdentity.accountId !== identity.accountId || this.sessionIdentity.subject !== identity.subject)) throw new DotError('AUTH_IDENTITY_CHANGED', 'The signed-in user or account changed during this client session. Start a new command with the intended login.');
    this.sessionIdentity ??= identity;
  }
  async request(method, route, { query, body, bodyBytes, bodyFile, contentType, headers: extraHeaders = {}, expectedAccountId, signal, idempotencyKey, responseType = 'json', includeResponse = false, allowNull = false, range, maxBytes = MAX_BODY, timeoutMs } = {}) {
    this._assertOpen();
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new DotError('INVALID_METHOD', 'Unsupported HTTP method.');
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new DotError('INVALID_ARGUMENT', 'Response limit must be 1 byte to 100 MiB.');
    const duration = timeoutDuration(timeoutMs ?? this.timeoutMs);
    const url = apiUrl(route, query);
    if (!['json', 'bytes', 'text'].includes(responseType)) throw new DotError('INVALID_ARGUMENT', 'Unsupported response type.');
    if (typeof allowNull !== 'boolean' || allowNull && (method !== 'GET' || responseType !== 'json' || !/^\/backend-api\/automation\/[^/]+\/latest_backing_run$/.test(route))) {
      throw new DotError('INVALID_ARGUMENT', 'A null JSON response is only supported for the latest routine backing-run read.');
    }
    const allowedHeader = (name, value) => name === 'OAI-Product-Sku' ? value === 'CODEX' || value === 'aeon' && route === '/backend-api/ecosystem/call_mcp'
        || value === 'TPP' && method === 'POST' && ['/backend-api/ps/mcp', '/backend-api/ecosystem/call_mcp'].includes(route)
        || value === 'CHATGPT_PROJECTS' && (method === 'POST' && [
          '/backend-api/aip/connectors/links/list_accessible', '/backend-api/aip/connectors/links/oauth',
          '/backend-api/aip/connectors/links/oauth/reauth', '/backend-api/aip/connectors/links/oauth/callback',
          '/backend-api/aip/connectors/links/noauth', '/backend-api/aip/connectors/links/api_key'
        ].includes(route) || method === 'GET' && /^\/backend-api\/aip\/connectors\/[^/]+(?:\/(?:link|tos))?$/.test(route))
      : name === 'X-Codex-Surface' ? ['other', 'connector_setup', 'settings', 'writing_blocks', 'plugin_management', 'skill_details', 'workspace_agents'].includes(value)
      : name === 'Idempotency-Key' ? typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
      : name === 'x-openai-use-sheep' ? value === '1' && method === 'POST'
        && ['/backend-api/chat/frontend/v1/saved-entities', '/backend-api/chat/frontend/v1/saved-entities/status', '/backend-api/chat/frontend/v1/saved-entities/remove'].includes(route)
      : name.toLowerCase() === 'x-oai-library-access-request-ids' ? typeof value === 'string' && /^[A-Za-z0-9_.~:-]+(?:,[A-Za-z0-9_.~:-]+)*$/.test(value) && value.length <= 8192 && route.startsWith('/backend-api/files/library/')
      : name === 'X-OpenAI-Attach-Auth' ? value === '1' && (/^\/backend-api\/files\/library\/files\/[^/]+\/(?:content|download)_redirect$/.test(route)
        || method === 'POST' && route === '/backend-api/estuary/upload_content_bytes')
      : name === 'X-OpenAI-Cloud-Vault-Credential-Fields-Version' ? value === '2' && route.startsWith('/backend-api/flora/browser/')
      : name === 'X-OpenAI-Cloud-Vault-Check-Trigger' ? ['explicit_recheck', 'other_refetch'].includes(value) && route.startsWith('/backend-api/flora/browser/')
      : name === 'chatgpt-project-id' ? typeof value === 'string' && /^g-p-[A-Za-z0-9_-]{1,200}$/.test(value)
        && method === 'POST' && ['/backend-api/files', '/backend-api/files/process_upload_stream'].includes(route)
        && body?.gizmo_id === value && body?.use_case === 'gizmo'
      : name === 'Cache-Control' ? value === 'no-store' && route === '/backend-api/flora/browser/qr-code' : false;
    if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)
      || Object.entries(extraHeaders).some(([name, value]) => !allowedHeader(name, value))) {
      throw new DotError('INVALID_HEADERS', 'Only verified product/surface headers and UUID idempotency keys are supported.');
    }
    let streamingBody;
    if (bodyFile !== undefined) {
      const metadata = bodyFile?.multipart;
      if (method !== 'POST' || route !== '/backend-api/estuary/upload_content_bytes' || body !== undefined || bodyBytes !== undefined
          || extraHeaders['X-OpenAI-Attach-Auth'] !== '1' || !metadata || typeof metadata !== 'object'
          || typeof metadata.boundary !== 'string' || !/^dot-library-[a-f0-9-]{36}$/.test(metadata.boundary)
          || typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(metadata.name)
          || typeof metadata.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(metadata.mimeType)
          || contentType !== `multipart/form-data; boundary=${metadata.boundary}`
          || url.searchParams.size !== 1 || url.searchParams.get('upload_url') !== metadata.uploadUrl) {
        throw new DotError('INVALID_FILE', 'File-backed authenticated requests require the exact native Estuary multipart contract.');
      }
      storageUploadUrl(metadata.uploadUrl);
      streamingBody = { ...fileBody(bodyFile), multipart: { boundary: metadata.boundary, name: metadata.name, mimeType: metadata.mimeType, uploadUrl: metadata.uploadUrl } };
    }
    signal?.throwIfAborted();
    const auth = await this.authLoader({ authFile: this.authFile, signal });
    this._assertOpen();
    signal?.throwIfAborted();
    if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !expectedAccountId || expectedAccountId !== auth.accountId)) {
      throw new DotError('ACCOUNT_CHANGED', 'The current Codex account differs from the selected account.');
    }
    this.assertIdentity(auth);
    if (range !== undefined && method !== 'GET') throw new DotError('INVALID_RANGE', 'Byte ranges require GET.');
    const headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: responseType === 'text' ? 'text/plain' : 'application/json', 'User-Agent': USER_AGENT, ...extraHeaders, ...rangeHeader(range) };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    if (body !== undefined || bodyBytes !== undefined || streamingBody !== undefined) headers['Content-Type'] = contentType ?? 'application/json';
    const timeout = AbortSignal.timeout(duration);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, text;
    try {
      // No automatic retries, particularly for POST: an error can occur after
      // the server has accepted a message. Never forward credentials on redirect.
      response = await this.fetchImpl(url, { method, headers, ...(streamingBody ? { bodyFile: streamingBody } : { body: bodyBytes ?? (body === undefined ? undefined : JSON.stringify(body)) }), redirect: 'manual', signal: requestSignal, maxBytes, timeoutMs: duration });
      if (response.headers.get('cf-mitigated') === 'challenge') {
        // A definitive challenge header wins even if its body is incomplete.
        // Request cancellation without waiting on a broken body's cleanup.
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
        throw classifyResponse(response.status, response.headers, '');
      }
      // A broken refusal body does not make its known auth status transient.
      // Keep any received bounded prefix so a confirmed body challenge wins.
      const classifyIncomplete = response.status === 401 || response.status === 403
        ? prefix => classifyResponse(response.status, response.headers, prefix.toString('utf8')) : undefined;
      text = await readBounded(response, maxBytes, responseType === 'bytes' && response.ok, classifyIncomplete);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const details = method !== 'GET' ? { delivery: 'unknown', idempotencyKey } : {};
      if (error instanceof DotError) throw new DotError(error.code, error.message, { ...error.details, ...details, ...(method !== 'GET' && error.details?.delivery ? { delivery: error.details.delivery } : {}) });
      throw new DotError('NETWORK_ERROR', timeout.aborted ? 'The API request timed out.' : 'The API request failed before a complete response was received.', details);
    }
    if (!response.ok) {
      const error = classifyResponse(response.status, response.headers, text);
      if (method !== 'GET') error.details = { ...error.details, delivery: 'unknown', idempotencyKey };
      throw error;
    }
    const envelope = value => includeResponse ? responseEnvelope(response, value) : value;
    if (responseType === 'bytes' || responseType === 'text') return envelope(text);
    if (response.status === 204) return envelope({ completed: true });
    let result;
    try { result = JSON.parse(text); }
    catch { throw new DotError('INVALID_RESPONSE', 'The API returned a successful response that was not JSON.', method !== 'GET' ? { delivery: 'unknown', idempotencyKey } : {}); }
    if (result === null && allowNull) return envelope(null);
    if (!result || typeof result !== 'object') throw new DotError('INVALID_RESPONSE', 'The API returned an unexpected JSON shape.', method !== 'GET' ? { delivery: 'unknown', idempotencyKey } : {});
    return envelope(result);
  }
  async requestMultipart(method, route, { file, signal } = {}) {
    if (method !== 'POST' || !file || !Buffer.isBuffer(file.bytes) || file.bytes.length > 20 * 1024 * 1024
      || typeof file.name !== 'string' || /[\r\n\0]/.test(file.name)
      || typeof file.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) throw new DotError('INVALID_FILE', 'Invalid multipart file; maximum size is 20 MiB.');
    const boundary = `dot-cli-${randomUUID()}`;
    const name = file.name.replaceAll('"', '%22');
    const bodyBytes = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`), file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return this.request(method, route, { bodyBytes, contentType: `multipart/form-data; boundary=${boundary}`, signal });
  }
  requestBytes(method, route, options = {}) {
    if (method !== 'GET') throw new DotError('INVALID_METHOD', 'Binary reads require GET.');
    return this.request(method, route, { ...options, responseType: 'bytes' });
  }
  async fetchSigned(value, { signal, range, includeResponse = false, maxBytes = 20 * 1024 * 1024 } = {}) {
    this._assertOpen();
    let url;
    try { url = new URL(value); } catch { throw new DotError('INVALID_FILE_URL', 'Invalid file download URL.'); }
    const regionalAzure = /^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname) && !!url.searchParams.get('sig');
    if (url.protocol !== 'https:' || url.hostname !== 'files.oaiusercontent.com' && !regionalAzure || url.port || url.username || url.password || url.hash) {
      throw new DotError('UNSUPPORTED_FILE_HOST', 'The API returned an unrecognized file host. No request was made.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) throw new DotError('INVALID_ARGUMENT', 'Response limit must be 1 byte to 100 MiB.');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(url, { method: 'GET', headers: { Accept: '*/*', 'User-Agent': USER_AGENT, ...rangeHeader(range) }, redirect: 'manual', signal: combined, maxBytes, signedFile: true });
      const body = await readBounded(response, maxBytes, response.ok);
      if (!response.ok) throw classifyResponse(response.status, response.headers, body);
      return includeResponse ? responseEnvelope(response, body) : body;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DotError) throw error;
      throw new DotError('NETWORK_ERROR', 'The file download failed.');
    }
  }

  async uploadSigned(value, { bytes, contentType = 'application/octet-stream', requiredHeaders, signal, timeoutMs } = {}) {
    const url = storageUploadUrl(value);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 100 * 1024 * 1024 || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new DotError('INVALID_FILE', 'Signed uploads require 1 byte to 100 MiB and a valid MIME type.');
    const headers = uploadHeaders({ 'Content-Type': contentType,
      ...(![...url.searchParams.keys()].some(key => key.toLowerCase() === 'x-amz-algorithm') ? { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2020-04-08', 'x-ms-blob-content-type': contentType } : {}) }, requiredHeaders);
    return this._uploadStorage(url, { bytes, headers, signal, timeoutMs });
  }

  async uploadSignedFile(value, { source, contentType = 'application/octet-stream', requiredHeaders, signal, timeoutMs } = {}) {
    const url = storageUploadUrl(value), bodyFile = fileBody(source);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new DotError('INVALID_FILE', 'Signed uploads require a valid MIME type.');
    const headers = uploadHeaders({ 'Content-Type': contentType,
      ...(![...url.searchParams.keys()].some(key => key.toLowerCase() === 'x-amz-algorithm') ? { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2020-04-08', 'x-ms-blob-content-type': contentType } : {}) }, requiredHeaders);
    return this._uploadStorage(url, { bodyFile, headers, signal, timeoutMs });
  }

  async uploadEstuaryFile(value, { source, expectedAccountId, signal, timeoutMs } = {}) {
    signal?.throwIfAborted();
    const upstream = storageUploadUrl(value).href;
    const boundary = `dot-library-${randomUUID()}`;
    return this.request('POST', '/backend-api/estuary/upload_content_bytes', {
      bodyFile: { ...fileBody(source), multipart: { boundary, name: source.name, mimeType: source.mimeType, uploadUrl: upstream } },
      contentType: `multipart/form-data; boundary=${boundary}`, query: { upload_url: upstream },
      headers: { 'X-OpenAI-Attach-Auth': '1' }, expectedAccountId, signal, timeoutMs,
    });
  }

  async uploadAzureBlock(value, { bytes, source, offset, length, sha256, blockId, contentType = 'application/octet-stream', signal, timeoutMs } = {}) {
    const url = storageUploadUrl(value, true);
    azureBlockIndex(blockId);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType) || bytes !== undefined && source !== undefined) throw new DotError('INVALID_FILE', 'Azure blocks require one byte source and a valid MIME type.');
    const bodyFile = source === undefined ? undefined : fileBody(source, { offset, length, sha256 });
    if (!bodyFile && (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 100 * 1024 * 1024)) throw new DotError('INVALID_FILE', 'In-memory Azure blocks must contain 1 byte to 100 MiB.');
    url.searchParams.set('comp', 'block'); url.searchParams.set('blockid', blockId);
    return this._uploadStorage(url, { bytes, bodyFile, headers: { 'Content-Type': contentType, 'x-ms-version': '2020-04-08' }, signal, timeoutMs, azureMultipart: 'block' });
  }

  async commitAzureBlocks(value, { blockIds, contentType, signal, timeoutMs } = {}) {
    const url = storageUploadUrl(value, true);
    if (!Array.isArray(blockIds) || blockIds.length < 2 || blockIds.length > MAX_AZURE_BLOCKS
        || Array.from(blockIds).some((id, index) => azureBlockIndex(id) !== index)
        || contentType !== undefined && !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
      throw new DotError('INVALID_ARGUMENT', 'Azure block commits require 2 to 50000 ordered, contiguous block IDs and a valid optional MIME type.');
    }
    url.searchParams.set('comp', 'blocklist'); url.searchParams.delete('blockid');
    const bytes = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<BlockList>\n${blockIds.map(id => `  <Latest>${id}</Latest>`).join('\n')}\n</BlockList>`, 'utf8');
    const headers = { 'Content-Type': 'application/xml', 'x-ms-version': '2020-04-08', ...(contentType === undefined ? {} : { 'x-ms-blob-content-type': contentType }) };
    return this._uploadStorage(url, { bytes, headers, signal, timeoutMs, azureMultipart: 'blocklist' });
  }

  async _uploadStorage(url, { bytes, bodyFile, headers, signal, timeoutMs, azureMultipart } = {}) {
    this._assertOpen();
    signal?.throwIfAborted();
    const duration = timeoutDuration(timeoutMs ?? this.timeoutMs);
    const timeout = AbortSignal.timeout(duration), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(url, { method: 'PUT', headers,
        ...(bodyFile ? { bodyFile } : { body: bytes }), redirect: 'manual', signal: combined, maxBytes: 65536,
        timeoutMs: duration, signedUpload: true, ...(azureMultipart ? { azureMultipart } : {}) });
      const body = await readBounded(response, 65536);
      if (!response.ok) throw classifyResponse(response.status, response.headers, body);
      return { uploaded: true, sizeBytes: bodyFile?.length ?? bytes.length };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DotError) { error.details = { ...error.details, delivery: error.details?.delivery ?? 'unknown' }; throw error; }
      throw new DotError('NETWORK_ERROR', 'The signed upload failed; delivery is uncertain.', { delivery: 'unknown' });
    }
  }

  async requestRealtimeSdp({ source, threadId, aeonId, conversationId, sdp, expectedAccountId, signal } = {}) {
    this._assertOpen();
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.~:-]{1,1024}$/.test(value) && !['.', '..'].includes(value);
    if (!['aeon', 'flora'].includes(source) || source === 'aeon' && (!validId(threadId) || !validId(aeonId)) || source === 'flora' && !validId(conversationId)
      || typeof sdp !== 'string' || !/^v=0\r?\n/.test(sdp) || sdp.includes('\0') || Buffer.byteLength(sdp) > 256 * 1024) throw new DotError('INVALID_ARGUMENT', 'Realtime control requires a verified target and bounded SDP offer.');
    const auth = await this.authLoader({ authFile: this.authFile });
    this._assertOpen();
    if (!expectedAccountId || expectedAccountId !== auth.accountId) throw new DotError('ACCOUNT_CHANGED', 'Realtime control requires the pinned Codex account.');
    this.assertIdentity(auth);
    const url = new URL('https://realtime.chatgpt.com/v1/cua'); url.searchParams.set('source', source);
    if (source === 'aeon') { url.searchParams.set('thread_id', threadId); url.searchParams.set('aeon_id', aeonId); }
    else url.searchParams.set('cid', conversationId);
    const timeout = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.accountId, 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
        body: sdp, redirect: 'manual', signal: combined, maxBytes: 256 * 1024, realtimeSdp: true });
      const body = await readBounded(response, 256 * 1024);
      if (!response.ok) throw classifyResponse(response.status, response.headers, body);
      if (!/^v=0\r?\n/.test(body)) throw new DotError('INVALID_RESPONSE', 'Realtime control did not return a valid SDP answer.');
      return responseEnvelope(response, body);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof DotError) throw error;
      throw new DotError('NETWORK_ERROR', 'Realtime control negotiation failed.');
    }
  }
}
