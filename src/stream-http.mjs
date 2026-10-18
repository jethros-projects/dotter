import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { DotError } from './errors.mjs';
import { apiUrl, classifyResponse, assertResponseEncoding } from './transport.mjs';
import { USER_AGENT } from './version.mjs';

const helper = fileURLToPath(new URL('./stream-http.py', import.meta.url));
const MAX_EVENT = 1024 * 1024;
const MAX_RECORD = 131072;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abortReason = signal => 'reason' in signal ? signal.reason : new DOMException('Aborted', 'AbortError');
const invalidStream = () => new DotError('INVALID_STREAM', 'Invalid streaming transport record.');

// Internal adapters may perform authenticated reads or validate stream data.
// Keep those failures distinct from application callbacks supplied by a caller.
const internalCallbacks = new WeakSet();
export const isInternalStreamCallback = callback => internalCallbacks.has(callback);
export function internalStreamCallback(callback) {
  internalCallbacks.add(callback);
  return callback;
}
export function streamConsumerCallback(callback, code = 'STREAM_CALLBACK_ERROR') {
  return internalStreamCallback(async (...args) => {
    try { return await callback(...args); }
    catch { throw new DotError(code, 'A stream consumer callback failed.'); }
  });
}

function streamHeaders(value) {
  if (!record(value)) throw invalidStream();
  const names = new Set();
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string' || names.has(name.toLowerCase())) throw invalidStream();
    names.add(name.toLowerCase());
  }
  try { return new Headers(value); } catch { throw invalidStream(); }
}

function streamBytes(value, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
      || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalidStream();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) throw invalidStream();
  return bytes;
}

// A bounded SSE parser. Values remain private until the caller projects them.
export class SSEParser {
  constructor({ maxEventBytes = MAX_EVENT, onEvent = () => {} } = {}) {
    this.maxEventBytes = maxEventBytes; this.onEvent = onEvent;
    this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.data = []; this.started = false;
    this.event = ''; this.id = undefined; this.retry = undefined; this.size = 0;
  }
  async push(chunk) {
    let text = this.decoder.write(Buffer.from(chunk));
    if (!this.started && text) { this.started = true; if (text.startsWith('\uFEFF')) text = text.slice(1); }
    this.buffer += text;
    await this.lines();
  }
  async lines(final = false) {
    let index;
    while ((index = this.buffer.search(/[\r\n]/)) >= 0) {
      const end = this.buffer[index];
      if (!final && end === '\r' && index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + (end === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1));
      if (Buffer.byteLength(line) > this.maxEventBytes) throw new DotError('STREAM_TOO_LARGE', 'A stream event exceeded 1 MiB.');
      await this.line(line);
    }
    const pending = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    const pendingSize = Buffer.byteLength(pending);
    if (pendingSize > this.maxEventBytes || !pending.startsWith(':') && pendingSize + this.size > this.maxEventBytes) {
      throw new DotError('STREAM_TOO_LARGE', 'A stream event exceeded 1 MiB.');
    }
  }
  async line(line) {
    if (!line) {
      if (this.data.length) await this.onEvent({ event: this.event || 'message', data: this.data.join('\n'),
        ...(this.id !== undefined ? { id: this.id } : {}), ...(this.retry !== undefined ? { retry: this.retry } : {}) });
      this.data = []; this.event = ''; this.retry = undefined; this.size = 0; return;
    }
    if (line.startsWith(':')) return;
    this.size += Buffer.byteLength(line);
    if (this.size > this.maxEventBytes) throw new DotError('STREAM_TOO_LARGE', 'A stream event exceeded 1 MiB.');
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (name === 'data') this.data.push(value);
    else if (name === 'event') this.event = value;
    else if (name === 'id' && !value.includes('\0')) this.id = value;
    else if (name === 'retry' && /^\d{1,7}$/.test(value)) this.retry = Math.min(Number(value), 30000);
  }
  async end() { // SSE requires a blank separator; never dispatch partial events.
    this.buffer += this.decoder.end(); await this.lines(true); this.buffer = ''; this.data = [];
  }
}

export async function* pythonStream(url, options = {}, { spawnImpl = spawn } = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);
  let input;
  try {
    input = JSON.stringify({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    if (Buffer.byteLength(input) > MAX_EVENT) throw new Error();
  } catch { throw new DotError('INVALID_ARGUMENT', 'The streaming HTTPS request could not be serialized within its size limit.'); }
  if (signal?.aborted) throw abortReason(signal);
  let child;
  try { child = spawnImpl('python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (error) { throw new DotError(error?.code === 'ENOENT' ? 'PYTHON_REQUIRED' : 'NETWORK_ERROR', 'Could not start the streaming HTTPS transport.'); }
  let exited = false, exitCode, stopped = false, failure;
  let close, interrupt;
  const closed = new Promise(resolve => { close = resolve; });
  const interrupted = new Promise(resolve => { interrupt = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.stdin?.destroy(); } catch {}
    try { child.stdout?.destroy(); } catch {}
    if (!exited) try { child.kill(); } catch {}
  };
  const fail = error => { failure ??= error; interrupt(); stop(); };
  const abort = () => { interrupt(); stop(); };
  let buffer = '', iterator, exhausted = false;
  const decoder = new StringDecoder('utf8');
  try {
    child.on('error', error => fail(new DotError(error?.code === 'ENOENT' ? 'PYTHON_REQUIRED' : 'NETWORK_ERROR', 'The streaming HTTPS transport stopped unexpectedly.')));
    child.on('close', code => { exited = true; exitCode = code; close(); });
    child.stdin.on('error', () => fail(new DotError('NETWORK_ERROR', 'The streaming HTTPS request pipe failed.')));
    child.stdout.on('error', () => fail(new DotError('NETWORK_ERROR', 'The streaming HTTPS response pipe failed.')));
    signal?.addEventListener('abort', abort, { once: true });
    // A custom spawn hook or synchronous event can abort before listener setup.
    if (signal?.aborted) throw abortReason(signal);
    try { child.stdin.end(input); }
    catch { throw new DotError('NETWORK_ERROR', 'The streaming HTTPS request pipe failed.'); }
    iterator = child.stdout[Symbol.asyncIterator]();
    while (true) {
      // Destroying stdout in stop() interrupts the pending read. Do not race
      // every chunk against one long-lived promise: its retained reactions
      // would grow for the lifetime of a healthy subscription.
      const next = await iterator.next();
      if (signal?.aborted) throw abortReason(signal);
      if (failure) throw failure;
      if (next.done) { exhausted = true; break; }
      buffer += decoder.write(Buffer.from(next.value));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (Buffer.byteLength(buffer.slice(0, index)) > MAX_RECORD) throw new DotError('STREAM_TOO_LARGE', 'The streaming transport exceeded its record limit.');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { throw new DotError('INVALID_STREAM', 'The streaming transport returned invalid data.'); }
        if (!record(value)) throw invalidStream();
        yield value;
        if (signal?.aborted) throw abortReason(signal);
        if (failure) throw failure;
      }
      if (Buffer.byteLength(buffer) > MAX_RECORD) throw new DotError('STREAM_TOO_LARGE', 'The streaming transport exceeded its record limit.');
    }
    buffer += decoder.end();
    await Promise.race([closed, interrupted]);
    if (signal?.aborted) throw abortReason(signal);
    if (failure) throw failure;
    if (exitCode !== 0 || buffer) throw new DotError('NETWORK_ERROR', 'The streaming HTTPS transport stopped unexpectedly.');
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (failure) throw failure;
    if (error instanceof DotError) throw error;
    throw new DotError('NETWORK_ERROR', 'The streaming HTTPS transport stopped unexpectedly.');
  } finally {
    signal?.removeEventListener('abort', abort);
    stop();
    if (!exhausted) try { await iterator?.return?.(); } catch {}
  }
}

// No retries here: owners decide whether their GET/subscription can reconnect.
export async function streamSSE(transport, method, route, { query, body, signal, onEvent = () => {}, onReady = () => {}, streamImpl = pythonStream } = {}) {
  if (!['GET', 'POST'].includes(method)) throw new DotError('INVALID_METHOD', 'Streams support GET and subscription POST only.');
  const url = apiUrl(route, query);
  const auth = await transport.authLoader({ authFile: transport.authFile });
  transport.assertIdentity?.(auth);
  const headers = { Authorization: `Bearer ${auth.accessToken}`, Accept: 'text/event-stream', 'User-Agent': USER_AGENT,
    ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  const protectCallback = callback => !internalCallbacks.has(callback) ? streamConsumerCallback(callback) : async (...args) => {
    try { return await callback(...args); }
    catch (error) {
      if (error instanceof DotError) throw error;
      throw new DotError('STREAM_CALLBACK_ERROR', 'An internal stream callback failed.');
    }
  };
  const eventCallback = protectCallback(onEvent);
  const readyCallback = protectCallback(onReady);
  const parser = new SSEParser({ onEvent: eventCallback });
  let status, responseHeaders, errorBody = '', receivedErrorBody = false;
  try {
    for await (const item of streamImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })) {
      if (!record(item)) throw invalidStream();
      if (item.type === 'response') {
        if (status !== undefined || !Number.isInteger(item.status) || item.status < 200 || item.status > 599) throw new DotError('INVALID_STREAM', 'Invalid streaming response.');
        status = item.status; responseHeaders = streamHeaders(item.headers);
        // Close the iterator at the header; a later body failure must not turn
        // an explicit edge challenge into a retryable network failure.
        assertResponseEncoding(status, responseHeaders);
        if (status === 200) {
          if (!/^text\/event-stream(?:\s*;|$)/i.test(responseHeaders.get('content-type') ?? '')) throw new DotError('INVALID_STREAM', 'The API response was not an event stream.');
          await readyCallback({ connected: true });
        }
      } else if (item.type === 'error-body') {
        if (status === undefined || status === 200 || receivedErrorBody) throw invalidStream();
        errorBody = streamBytes(item.body, 65536).toString('utf8'); receivedErrorBody = true;
        // This record is the complete bounded error body. Its classification
        // must survive a later bridge/cleanup failure, especially a challenge.
        throw classifyResponse(status, responseHeaders, errorBody);
      } else if (item.type === 'chunk') {
        if (status !== 200 || typeof item.body !== 'string' || item.body.length > 90000) throw new DotError('INVALID_STREAM', 'Invalid streaming data.');
        await parser.push(streamBytes(item.body, 67500));
      } else if (item.type === 'error') throw new DotError('NETWORK_ERROR', 'The streaming HTTPS connection ended unexpectedly.');
      else throw new DotError('INVALID_STREAM', 'Invalid streaming transport record.');
    }
    if (status !== undefined && status !== 200) throw classifyResponse(status, responseHeaders, errorBody);
    if (status === undefined) throw new DotError('NETWORK_ERROR', 'The streaming HTTPS connection did not return a response.');
    await parser.end();
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    // If the bridge breaks after response headers, retain a known HTTP
    // rejection instead of misclassifying it as a retryable network failure.
    if (status !== undefined && status !== 200 && (!(error instanceof DotError) || error.code === 'NETWORK_ERROR')) {
      throw classifyResponse(status, responseHeaders, errorBody);
    }
    if (error instanceof DotError) throw error;
    throw new DotError('NETWORK_ERROR', 'The streaming HTTPS connection ended unexpectedly.');
  }
}
