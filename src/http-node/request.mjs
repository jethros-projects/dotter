import { validateHeaderName, validateHeaderValue } from 'node:http';
import { DotError } from '../errors.mjs';

export const MAX_BODY = 100 * 1024 * 1024;
export const MAX_HEADERS = 64 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mime = value => typeof value === 'string' && value.length <= 200 && /^[\w.+-]+\/[\w.+-]+$/.test(value);
const signature = url => [...url.searchParams].some(([key, value]) => /^(?:sig|x-amz-signature|signature)$/i.test(key) && value);
const azure = host => /^(?:[a-z0-9-]+\.blob\.core\.windows\.net|sdmntpr[a-z0-9-]+\.oaiusercontent\.com)$/.test(host);
const storage = host => host === 'files.oaiusercontent.com' || azure(host)
  || /^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
export const invalid = message => new DotError('INVALID_ARGUMENT', message, { delivery: 'not_sent' });

function target(value) {
  let text;
  try { text = String(value); } catch { throw invalid('Invalid HTTPS request URL.'); }
  if (text.length > 32 * 1024 || /[\x00-\x20\x7f\\]/.test(text)) throw invalid('Invalid HTTPS request URL.');
  let url;
  try { url = new URL(text); } catch { throw invalid('Invalid HTTPS request URL.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw invalid('Invalid HTTPS request origin.');
  return url;
}

function headers(value = {}) {
  if (!record(value) || Object.keys(value).length > 64) throw invalid('HTTPS request headers must be a bounded object.');
  const result = {}, lower = {}, names = new Set();
  let size = 0;
  for (const [name, field] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (typeof field !== 'string' || names.has(key) || /[\x00-\x1f\x7f-\x9f\u0100-\uffff]/.test(field)) throw invalid('Invalid HTTPS request header.');
    try { validateHeaderName(name); validateHeaderValue(name, field); } catch { throw invalid('Invalid HTTPS request header.'); }
    size += name.length + field.length + 4;
    if (size > MAX_HEADERS || ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'upgrade', 'expect', 'trailer', 'te', 'transfer-encoding'].includes(key)) throw invalid('Invalid HTTPS request header.');
    names.add(key); result[name] = field; lower[key] = field;
  }
  return { values: result, lower };
}

function azureMultipart(url, options, lower, body) {
  const kind = options.azureMultipart;
  if (kind === undefined) return;
  const pairs = [...url.searchParams], count = key => pairs.filter(([name]) => name === key).length;
  const allowed = ['content-type', 'x-ms-version', ...(kind === 'blocklist' ? ['x-ms-blob-content-type'] : [])];
  if (options.signedUpload !== true || !azure(url.hostname) || !url.searchParams.get('sig') || !['block', 'blocklist'].includes(kind)
      || url.searchParams.get('comp') !== kind || count('comp') !== 1 || Object.keys(lower).some(key => !allowed.includes(key))
      || lower['x-ms-version'] !== '2020-04-08' || !mime(lower['content-type'])) throw invalid('Invalid Azure multipart request.');
  if (kind === 'block') {
    const id = url.searchParams.get('blockid') ?? '', decoded = Buffer.from(id, 'base64');
    if (count('blockid') !== 1 || !/^\d{8}$/.test(decoded.toString('ascii')) || decoded.toString('base64') !== id) throw invalid('Invalid Azure block ID.');
  } else {
    if (count('blockid') || lower['content-type'] !== 'application/xml'
        || lower['x-ms-blob-content-type'] !== undefined && !mime(lower['x-ms-blob-content-type'])
        || !body || body.length > 2 * 1024 * 1024 || options.bodyFile != null || body.some(byte => byte > 127)) throw invalid('Invalid Azure block commit.');
    const lines = body.toString('ascii').split('\n');
    if (lines.length < 5 || lines.length > 50003 || lines[0] !== '<?xml version="1.0" encoding="utf-8"?>'
        || lines[1] !== '<BlockList>' || lines.at(-1) !== '</BlockList>'
        || lines.slice(2, -1).some((line, index) => line !== `  <Latest>${Buffer.from(String(index).padStart(8, '0')).toString('base64')}</Latest>`)) throw invalid('Invalid ordered Azure block list.');
  }
}

function multipart(url, options, lower, signedUpload) {
  if (options.bodyFile == null || signedUpload) return { prefix: Buffer.alloc(0), suffix: Buffer.alloc(0) };
  const metadata = options.bodyFile.multipart;
  if (url.hostname !== 'chatgpt.com' || url.pathname !== '/backend-api/estuary/upload_content_bytes' || options.method !== 'POST'
      || lower['x-openai-attach-auth'] !== '1' || !record(metadata) || url.searchParams.size !== 1
      || url.searchParams.get('upload_url') !== metadata.uploadUrl || typeof metadata.boundary !== 'string'
      || !/^dot-library-[a-f0-9-]{36}$/.test(metadata.boundary) || typeof metadata.name !== 'string'
      || !metadata.name || [...metadata.name].length > 240 || /[\x00-\x1f\x7f/\\]/.test(metadata.name)
      || !mime(metadata.mimeType) || lower['content-type'] !== `multipart/form-data; boundary=${metadata.boundary}`) throw invalid('Invalid authenticated file upload.');
  if (typeof metadata.uploadUrl !== 'string' || metadata.uploadUrl.length > 16384) throw invalid('Invalid signed storage URL.');
  const upstream = target(metadata.uploadUrl);
  if (!storage(upstream.hostname) || !signature(upstream)) throw invalid('Invalid signed storage URL.');
  const { boundary, mimeType, uploadUrl } = metadata, name = metadata.name.replaceAll('"', '%22');
  return {
    prefix: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    suffix: Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload_url"\r\n\r\n${uploadUrl}\r\n--${boundary}--\r\n`),
  };
}

export function requestOptions(value, options) {
  if (!record(options)) throw invalid('HTTPS request options must be an object.');
  options = { ...options };
  const maximum = options.maxBytes === undefined ? 10 * 1024 * 1024 : options.maxBytes;
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BODY || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw invalid('Invalid HTTPS response limit or timeout.');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method)) throw invalid('Invalid HTTPS request method.');
  if (options.body != null && options.bodyFile != null) throw invalid('Only one HTTPS request body may be supplied.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw invalid('Invalid HTTPS request signal.');
  const url = target(value), checked = headers(options.headers), { lower } = checked;
  const signedFile = options.signedFile === true && (url.hostname === 'files.oaiusercontent.com'
    || /^sdmntpr[a-z0-9-]+\.oaiusercontent\.com$/.test(url.hostname) && !!url.searchParams.get('sig'));
  const signedUpload = options.signedUpload === true && storage(url.hostname) && signature(url);
  const realtime = options.realtimeSdp === true && url.hostname === 'realtime.chatgpt.com' && url.pathname === '/v1/cua';
  if (!signedFile && !signedUpload && !realtime && (url.hostname !== 'chatgpt.com' || !url.pathname.startsWith('/backend-api/'))) throw invalid('Invalid HTTPS request origin.');
  if ((signedFile || signedUpload) && (signedFile && signedUpload || options.method !== (signedUpload ? 'PUT' : 'GET')
      || ['authorization', 'cookie', 'chatgpt-account-id'].some(key => Object.hasOwn(lower, key)))) throw invalid('Credentials are forbidden for signed storage requests.');
  if (realtime) {
    const fields = [...url.searchParams], source = url.searchParams.get('source');
    const expected = source === 'aeon' ? ['source', 'thread_id', 'aeon_id'] : source === 'flora' ? ['source', 'cid'] : [];
    if (options.method !== 'POST' || lower['content-type'] !== 'application/sdp' || !expected.length || fields.length !== expected.length
        || expected.some(key => fields.filter(([name]) => name === key).length !== 1)
        || fields.some(([key, field]) => !expected.includes(key) || !/^[A-Za-z0-9_.~:-]{1,1024}$/.test(field) || ['.', '..'].includes(field))) throw invalid('Invalid realtime negotiation.');
  }
  let body;
  if (options.body != null) {
    if (typeof options.body !== 'string' && !Buffer.isBuffer(options.body) && !ArrayBuffer.isView(options.body) && !(options.body instanceof ArrayBuffer)) throw invalid('Invalid HTTPS request body.');
    const size = typeof options.body === 'string' ? Buffer.byteLength(options.body) : options.body.byteLength;
    if (size > MAX_BODY) throw invalid('The HTTPS request body exceeded its size limit.');
    body = typeof options.body === 'string' ? Buffer.from(options.body)
      : Buffer.from(options.body instanceof ArrayBuffer ? new Uint8Array(options.body) : new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength));
  }
  if (Object.hasOwn(lower, 'content-length') && (options.bodyFile != null || !/^\d+$/.test(lower['content-length'])
      || BigInt(lower['content-length']) !== BigInt(body?.length ?? 0))) throw invalid('Invalid HTTPS request framing.');
  azureMultipart(url, options, lower, body);
  return { url, method: options.method, headers: checked.values, maximum, timeoutMs, body,
    signal: options.signal, bodyFile: options.bodyFile, ...multipart(url, options, lower, signedUpload) };
}
